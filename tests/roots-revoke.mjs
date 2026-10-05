/**
 * B5, revocation at write time (builds/configurable-roots/plan.md): every
 * mutation re-proves its path against the roots as they are at the moment of
 * the write. Each case removes the edit root AFTER the request was authorized
 * and its history work ran — through the write-check seam, at exactly the
 * point before the filesystem is touched — and the write must 403 and leave
 * the disk as it was.
 *
 * HOME is redirected to a temp directory before anything from lib/ loads.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { snapshotRealHomes, assertRealHomesUnchanged } from './real-home.mjs';

const realHome = os.homedir();
const realBefore = snapshotRealHomes();
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acs-revoke-')));
process.env.HOME = home;
process.env.ACS_SUITE = 'offline';
delete process.env.CODEX_HOME;

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

console.log('\nrevocation at write time');
ok('HOME is redirected away from the real one', os.homedir() === home && home !== realHome);

const work = path.join(home, 'code', 'work');
const app = path.join(work, 'app');
fs.mkdirSync(path.join(app, '.claude', 'skills', 'sk'), { recursive: true });
fs.writeFileSync(path.join(app, 'CLAUDE.md'), '# app\n');
fs.writeFileSync(path.join(app, 'AGENTS.md'), '# agents\n');
fs.writeFileSync(path.join(app, 'doomed.md'), '# doomed\n');

const roots = await import('../lib/roots.js');
const { _setBeforeWriteCheck } = await import('../lib/paths.js');
const { createApp } = await import('../server.js');
const add = () => roots.addRoot({ path: work, access: 'edit', label: 'Work', id: 'work' }, { home });
add();

const { server } = createApp();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://localhost:${server.address().port}`;
const call = async (p, method = 'GET', body) => {
  const r = await fetch(base + p, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
};

/** Arm the seam: the first write check removes the root, then disarms. */
let fired = 0;
const revokeAtWrite = () => _setBeforeWriteCheck(() => {
  _setBeforeWriteCheck(null);
  fired++;
  roots.removeRoot('work', { home });
});

// Save.
{
  const f = path.join(app, 'CLAUDE.md');
  const g = await call(`/api/file?path=${encodeURIComponent(f)}`);
  ok('the root is editable before revocation (the probe works)', g.status === 200, g.text);
  revokeAtWrite();
  const put = await call('/api/file', 'PUT', { path: f, content: '# app\n\nafter revoke\n', mtime: g.json.mtime });
  ok('B5 save: the root removed between authorization and the write makes it 403', fired === 1 && put.status === 403, put.text);
  ok('B5 …and the file is untouched', fs.readFileSync(f, 'utf8') === '# app\n');
  add();
}

// Create a file.
{
  revokeAtWrite();
  const r = await call('/api/create-file', 'POST', { dir: app, name: 'new.md' });
  ok('B5 create: 403 and nothing written', fired === 2 && r.status === 403 && !fs.existsSync(path.join(app, 'new.md')), r.text);
  add();
}

// Delete.
{
  const f = path.join(app, 'doomed.md');
  revokeAtWrite();
  const r = await call('/api/delete', 'POST', { path: f });
  ok('B5 delete: 403 and the file stays where it was', fired === 3 && r.status === 403 && fs.readFileSync(f, 'utf8') === '# doomed\n', r.text);
  add();
}

// History restore.
{
  const f = path.join(app, 'AGENTS.md');
  const g = await call(`/api/file?path=${encodeURIComponent(f)}`);
  const put = await call('/api/file', 'PUT', { path: f, content: '# agents v2\n', mtime: g.json.mtime });
  ok('a save with the root present works (the probe works)', put.status === 200 && put.json.saved, put.text);
  const log = (await call(`/api/history?path=${encodeURIComponent(f)}`)).json.commits;
  const oldest = log[log.length - 1].sha;
  revokeAtWrite();
  const r = await call('/api/history/restore', 'POST', { path: f, sha: oldest, mtime: fs.statSync(f).mtimeMs });
  ok('B5 history restore: 403 and the current bytes stay', fired === 4 && r.status === 403 && fs.readFileSync(f, 'utf8') === '# agents v2\n', r.text);
  add();
}

// Trash restore.
{
  const f = path.join(app, 'doomed.md');
  const del = await call('/api/delete', 'POST', { path: f });
  ok('a delete with the root present works (the probe works)', del.status === 200 && !fs.existsSync(f), del.text);
  revokeAtWrite();
  const r = await call('/api/trash/restore', 'POST', { id: del.json.id });
  ok('B5 trash restore: 403 and nothing is put back', fired === 5 && r.status === 403 && !fs.existsSync(f), r.text);
  const items = (await call('/api/trash')).json.items;
  ok('B5 …and the trashed copy is still there to restore later', items.some((x) => x.id === del.json.id && x.restorable));
  add();
  const again = await call('/api/trash/restore', 'POST', { id: del.json.id });
  ok('…which works once the folder is editable again', again.status === 200 && fs.readFileSync(f, 'utf8') === '# doomed\n', again.text);
}

// Trash restore into a parent folder that no longer exists: revoking at the
// first write check must stop it before the folder is recreated.
{
  const sub = path.join(app, 'gone-sub');
  const f = path.join(sub, 'deep.md');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(f, '# deep\n');
  const del = await call('/api/delete', 'POST', { path: f });
  fs.rmSync(sub, { recursive: true, force: true });
  ok('a file trashed, then its folder removed (the probe works)', del.status === 200 && !fs.existsSync(sub), del.text);
  const firedBefore = fired;
  revokeAtWrite();
  const r = await call('/api/trash/restore', 'POST', { id: del.json.id });
  ok('B5 trash restore into a missing parent under a revoked root: 403, and no folder is created',
     fired === firedBefore + 1 && r.status === 403 && !fs.existsSync(sub), r.text);
  add();
}

// Turning the folder read-only is a revocation too.
{
  const f = path.join(app, 'CLAUDE.md');
  const g = await call(`/api/file?path=${encodeURIComponent(f)}`);
  _setBeforeWriteCheck(() => {
    _setBeforeWriteCheck(null);
    roots.removeRoot('work', { home });
    roots.addRoot({ path: work, access: 'read', label: 'Work', id: 'work' }, { home });
  });
  const put = await call('/api/file', 'PUT', { path: f, content: 'nope\n', mtime: g.json.mtime });
  ok('B5 an edit folder turned read-only mid-save also 403s', put.status === 403 && fs.readFileSync(f, 'utf8') === '# app\n', put.text);
}

await new Promise((r) => server.close(r));
fs.rmSync(home, { recursive: true, force: true });
assertRealHomesUnchanged(realBefore, ok);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
