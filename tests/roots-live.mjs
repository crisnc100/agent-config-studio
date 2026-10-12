/**
 * Live reload of roots.json against a running server (builds/configurable-roots/plan.md):
 *
 *   AC6  `acs roots add` / `acs roots rm` change the Context and registry
 *        payloads within 3 seconds, no restart; removing an edit root makes
 *        writes there 403
 *   B6   a read-root add, an empty edit-root add and a label change each
 *        broadcast `type: 'roots'` to an open event stream
 *   B7   editing .worktrees.conf inside a newly added edit root fires a files event
 *   B2   a root removed under an open file goes out as `revokedPaths`, not a delete
 *
 * One `node server.js` on a temp HOME; the CLI runs as a child with the same HOME.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshotRealHomes, assertRealHomesUnchanged } from './real-home.mjs';
import { seedProjectTree, seedGlobals, startServer } from './fixtures/roots-home.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ACS = path.join(ROOT, 'bin', 'acs');
const realHome = os.homedir();
const realBefore = snapshotRealHomes();

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acs-live-')));
const elsewhere = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acs-live-elsewhere-')));
seedGlobals(home);
const work = path.join(home, 'code', 'work');
const w = seedProjectTree(work, 'work');
const shared = path.join(elsewhere, 'shared');
seedProjectTree(shared, 'shared');
const two = path.join(home, 'code', 'two');
const t = seedProjectTree(two, 'two');
const empty = path.join(home, 'code', 'empty');
fs.mkdirSync(empty, { recursive: true });
fs.mkdirSync(path.join(home, '.agent-config-studio'), { recursive: true });
fs.writeFileSync(path.join(home, '.agent-config-studio', 'roots.json'),
  JSON.stringify({ version: 1, roots: [{ id: 'work', path: work, label: 'Work', access: 'edit' }] }, null, 2));

const acs = (...args) => {
  try { return { code: 0, out: execFileSync('/bin/sh', [ACS, 'roots', ...args], { encoding: 'utf8', env: { ...process.env, HOME: home, NO_COLOR: '1', ACS_NO_UPDATE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] }) }; }
  catch (e) { return { code: e.status, out: `${e.stdout || ''}${e.stderr || ''}` }; }
};

console.log('\nroots live reload');
ok('HOME is redirected away from the real one', home !== realHome);
const srv = await startServer(home, { root: ROOT });
ok('the server boots', srv.up, srv.log().slice(-400));

// The event stream, as an open tab holds it.
const events = [];
const ac = new AbortController();
const stream = await fetch(`${srv.base}/api/events`, { signal: ac.signal });
(async () => {
  const dec = new TextDecoder();
  let buf = '';
  try {
    for await (const chunk of stream.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, i); buf = buf.slice(i + 2);
        const line = frame.split('\n').find((l) => l.startsWith('data: '));
        if (line) { try { events.push({ at: Date.now(), ...JSON.parse(line.slice(6)) }); } catch {} }
      }
    }
  } catch { /* aborted at the end */ }
})();
await sleep(300);

/** Poll until `fn` is truthy or `ms` passes; resolves with the elapsed time, or null. */
async function within(ms, fn) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await fn()) return Date.now() - start;
    await sleep(100);
  }
  return null;
}
const regPaths = async () => (await srv.call('/api/registry')).json.groups.flatMap((g) => g.entries.flatMap((e) => e.files.map((f) => f.path)));
const ctxRoots = async () => new Set((await srv.call('/api/context')).json.groups.map((g) => g.root));
const rootsEventAfter = (since, pred = () => true) => events.find((e) => e.type === 'roots' && e.at >= since && pred(e));

// B6 + AC6: a read root added from the CLI.
{
  const since = Date.now();
  const r = acs('add', shared, '--label', 'Shared');
  ok('the CLI adds a read root against the running server', r.code === 0, r.out);
  const ctxMs = await within(3000, async () => (await ctxRoots()).has('shared'));
  ok('AC6 `acs roots add` changes the Context payload within 3s, no restart', ctxMs !== null, `${ctxMs}ms`);
  const evMs = await within(3000, () => rootsEventAfter(since, (e) => e.roots.some((x) => x.id === 'shared')));
  ok('B6 a read-root add broadcasts type: roots to the open stream, carrying the new list', evMs !== null, JSON.stringify(events.map((e) => e.type)));
  ok('B6 …and /api/roots, which the Folders view fetches, has it', (await srv.call('/api/roots')).json.roots.some((x) => x.id === 'shared' && x.access === 'read'));
  ok('B12 …while the registry still holds nothing from it', !(await regPaths()).some((p) => p.startsWith(shared)));
}

// B6: an empty edit root (no registry delta at all).
{
  const since = Date.now();
  const r = acs('add', empty, '--edit');
  ok('the CLI adds an empty edit root', r.code === 0, r.out);
  const evMs = await within(3000, () => rootsEventAfter(since, (e) => e.roots.some((x) => x.id === 'empty')));
  ok('B6 an empty edit-root add broadcasts type: roots too', evMs !== null, JSON.stringify(events.slice(-3)));
}

// B6: a label change, written by hand the way an editor would (in place).
{
  const since = Date.now();
  const f = path.join(home, '.agent-config-studio', 'roots.json');
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  j.roots.find((x) => x.id === 'shared').label = 'Shared (renamed)';
  fs.writeFileSync(f, JSON.stringify(j, null, 2));
  const evMs = await within(3000, () => rootsEventAfter(since, (e) => e.roots.some((x) => x.label === 'Shared (renamed)')));
  ok('B6 a label change broadcasts type: roots', evMs !== null);
  const ctx = (await srv.call('/api/context')).json;
  ok('B6 …and the views\' fetches return the new label', ctx.groups.find((g) => g.root === 'shared')?.rootLabel === 'Shared (renamed)'
     && (await srv.call('/api/roots')).json.roots.find((x) => x.id === 'shared').label === 'Shared (renamed)');
}

// AC6 + B7: a second edit root with files, then a .worktrees.conf edit inside it.
{
  const r = acs('add', two, '--edit');
  ok('the CLI adds an edit root with files', r.code === 0, r.out);
  const regMs = await within(3000, async () => (await regPaths()).includes(path.join(t.app, 'CLAUDE.md')));
  ok('AC6 `acs roots add --edit` changes the registry payload within 3s', regMs !== null, `${regMs}ms`);
  await sleep(600);   // let the re-aimed watchers settle
  const since = Date.now();
  const conf = path.join(t.app, '.worktrees.conf');
  fs.writeFileSync(conf, `TRUNK="${t.app}"\nCMD=tw\n`);
  const evMs = await within(3000, () => events.find((e) => e.type === 'files' && e.at >= since && (e.changedPaths || []).includes(conf)));
  ok('B7 editing .worktrees.conf inside a newly added edit root fires a files event', evMs !== null, JSON.stringify(events.filter((e) => e.at >= since)));
}

// AC6 + B2: removing an edit root revokes; writes there 403.
{
  const target = path.join(w.app, 'CLAUDE.md');
  const g = await srv.call(`/api/file?path=${encodeURIComponent(target)}`);
  ok('the edit root is writable before removal (the probe works)', g.status === 200);
  const since = Date.now();
  const r = acs('rm', 'work');
  ok('the CLI removes the edit root', r.code === 0, r.out);
  const regMs = await within(3000, async () => !(await regPaths()).some((p) => p.startsWith(work)));
  ok('AC6 `acs roots rm` drops its files from the registry within 3s', regMs !== null, `${regMs}ms`);
  const ctxMs = await within(3000, async () => !(await ctxRoots()).has('work'));
  ok('AC6 …and from the Context payload within 3s', ctxMs !== null, `${ctxMs}ms`);
  const put = await srv.call('/api/file', { method: 'PUT', body: { path: target, content: 'nope\n', mtime: g.json.mtime } });
  ok('AC6 removing an edit root makes writes there 403', put.status === 403 && fs.readFileSync(target, 'utf8') !== 'nope\n', put.text);
  const rev = await within(3000, () => events.find((e) => e.type === 'files' && e.at >= since && (e.revokedPaths || []).includes(target)));
  const evt = events.find((e) => e.type === 'files' && e.at >= since && (e.revokedPaths || []).includes(target));
  ok('B2 the open file\'s root going away is announced as revoked, not removed',
     rev !== null && !(evt.removedPaths || []).includes(target) && fs.existsSync(target), JSON.stringify(evt));
  ok('B2 …and the files event precedes the roots event, so the editor decides first',
     (() => { const ri = events.findIndex((e) => e.type === 'roots' && e.at >= since); const fi = events.indexOf(evt); return fi !== -1 && ri > fi; })());
}

// AC7 live: a corrupt hand edit never takes the server down.
{
  const f = path.join(home, '.agent-config-studio', 'roots.json');
  const since = Date.now();
  fs.writeFileSync(f, '{ "roots": [ broken');
  const evMs = await within(3000, () => rootsEventAfter(since, (e) => e.state === 'error'));
  ok('AC7 a corrupt roots.json is broadcast as an error state', evMs !== null);
  const health = await srv.call('/api/health');
  const reg = await srv.call('/api/registry');
  ok('AC7 …and the server keeps serving, with no project folders active', health.status === 200 && reg.status === 200
     && !(await regPaths()).some((p) => p.startsWith(two)), reg.text.slice(0, 200));
  ok('AC7 …the file is left exactly as written', fs.readFileSync(f, 'utf8') === '{ "roots": [ broken');
}

ac.abort();
await srv.stop();
fs.rmSync(home, { recursive: true, force: true });
fs.rmSync(elsewhere, { recursive: true, force: true });
assertRealHomesUnchanged(realBefore, ok);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
