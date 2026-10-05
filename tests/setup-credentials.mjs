/**
 * Credential contents are never served through an alias (builds/setup-screen
 * criterion 2, grade P1). A real `node server.js` on temp HOMEs; each case
 * plants a marker in a credential file and then reaches it another way:
 *
 *   - a hard link: ~/.codex/auth.json and ~/.codex/AGENTS.md one inode
 *   - a symlink named auth.json that points at an innocently named file
 *   - a chain: AGENTS.md -> auth.json -> tokens-store
 *   - a project CLAUDE.md and a skill file hard-linked to a credential
 *
 * Every content route — the editor's read, search, Context, the skill
 * export, the history mirror — refuses or omits it, and the marker appears in
 * no response and no history commit.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshotRealHomes, assertRealHomesUnchanged } from './real-home.mjs';
import { startServer } from './fixtures/roots-home.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const realBefore = snapshotRealHomes();
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const temps = [];
const mkTemp = (tag) => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `acs-cred-${tag}-`))); temps.push(d); return d; };
const put = (f, body) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); };
const SECRET = 'SECRET-REFRESH-TOKEN-7f3a';
const leaked = (text) => String(text).includes(SECRET);
const historyText = (home) => {
  try { return execFileSync('git', ['-C', path.join(home, '.agent-config-studio', 'history'), 'log', '--all', '-p'], { encoding: 'utf8', maxBuffer: 64 << 20 }); } catch { return ''; }
};

console.log('\ncredentials through aliases');

async function scenario(tag, plant, probes) {
  const home = mkTemp(tag);
  put(path.join(home, '.claude', 'CLAUDE.md'), '# global\n');
  const work = path.join(home, 'code', 'work');
  put(path.join(work, 'app', 'README.md'), 'app\n');
  put(path.join(home, '.agent-config-studio', 'roots.json'), JSON.stringify({ version: 1, roots: [{ id: 'work', path: work, label: 'Work', access: 'edit' }] }));
  plant(home, work);
  const srv = await startServer(home, { root: ROOT });
  ok(`${tag}: the server boots`, srv.up, srv.log().slice(-300));
  for (const [what, route, check] of probes(home, work)) {
    const r = await srv.call(route);
    // A search echoes its query: judge what came back, not what was asked.
    const body = r.json && 'hits' in r.json ? JSON.stringify(r.json.hits) : r.text;
    ok(`${tag}: ${what}`, !leaked(body) && check(r), `${r.status} ${r.text.slice(0, 160)}`);
  }
  ok(`${tag}: the marker is in no history commit`, !leaked(historyText(home)));
  await srv.stop();
}

const file = (p) => `/api/file?path=${encodeURIComponent(p)}`;

await scenario('hardlink', (home) => {
  put(path.join(home, '.codex', 'auth.json'), `{"refresh":"${SECRET}"}`);
  fs.linkSync(path.join(home, '.codex', 'auth.json'), path.join(home, '.codex', 'AGENTS.md'));
}, (home) => [
  ['a hard link of auth.json named AGENTS.md is refused by the editor', file(path.join(home, '.codex', 'AGENTS.md')), (r) => r.status === 403 && /hard links/.test(r.json?.error)],
  ['…search does not return its lines', `/api/search?q=${SECRET}`, (r) => r.status === 200 && r.json.hits.length === 0],
  ['…and auth.json itself stays refused', file(path.join(home, '.codex', 'auth.json')), (r) => r.status === 403],
]);

await scenario('symlink', (home) => {
  put(path.join(home, '.codex', 'tokens-store'), `{"refresh":"${SECRET}"}`);
  fs.symlinkSync('tokens-store', path.join(home, '.codex', 'auth.json'));
}, (home) => [
  ['a symlink NAMED auth.json is refused, though its target has an innocent name', file(path.join(home, '.codex', 'auth.json')), (r) => r.status === 403 && /protected/.test(r.json?.error)],
  ['…by its ~ spelling too', file('~/.codex/auth.json'), (r) => r.status === 403],
]);

await scenario('chain', (home) => {
  put(path.join(home, '.codex', 'tokens-store'), `{"refresh":"${SECRET}"}`);
  fs.symlinkSync('tokens-store', path.join(home, '.codex', 'auth.json'));
  fs.symlinkSync('auth.json', path.join(home, '.codex', 'AGENTS.md'));
}, (home) => [
  ['a chain AGENTS.md -> auth.json -> tokens-store is refused', file(path.join(home, '.codex', 'AGENTS.md')), (r) => r.status === 403 && /protected/.test(r.json?.error)],
  ['…and search never reads through it', `/api/search?q=${SECRET}`, (r) => r.status === 200 && r.json.hits.length === 0],
]);

await scenario('project', (home, work) => {
  put(path.join(home, '.claude', '.credentials.json'), `{"claudeAiOauth":{"accessToken":"${SECRET}"}}`);
  fs.linkSync(path.join(home, '.claude', '.credentials.json'), path.join(work, 'app', 'CLAUDE.md'));
  put(path.join(work, 'app', '.claude', 'skills', 'leaky', 'SKILL.md'), '---\nname: leaky\ndescription: x\n---\n');
  fs.linkSync(path.join(home, '.claude', '.credentials.json'), path.join(work, 'app', '.claude', 'skills', 'leaky', 'notes.md'));
}, (home, work) => [
  ['a project CLAUDE.md hard-linked to .credentials.json is refused by the editor', file(path.join(work, 'app', 'CLAUDE.md')), (r) => r.status === 403],
  ['…Context serves no bytes of it', '/api/context', (r) => r.status === 200],
  ['…search does not return it', `/api/search?q=${SECRET}`, (r) => r.status === 200 && r.json.hits.length === 0],
  ['…and the skill holding a hard-linked file never ships it', '/api/skills', (r) => r.status === 200 && !r.json.skills.some((s) => s.name === 'leaky' && !s.broken && (s.files || []).some((f) => /notes/.test(f.rel || f.name || '')))],
]);

// Context files and the skill export by id: every id Context and Skills hand out.
{
  const home = mkTemp('ids');
  const work = path.join(home, 'code', 'work');
  put(path.join(home, '.claude', '.credentials.json'), `{"t":"${SECRET}"}`);
  put(path.join(work, 'app', 'README.md'), 'x\n');
  fs.linkSync(path.join(home, '.claude', '.credentials.json'), path.join(work, 'app', 'AGENTS.md'));
  put(path.join(work, 'app', '.claude', 'skills', 'leaky', 'SKILL.md'), '---\nname: leaky\ndescription: x\n---\n');
  fs.linkSync(path.join(home, '.claude', '.credentials.json'), path.join(work, 'app', '.claude', 'skills', 'leaky', 'ref.md'));
  put(path.join(home, '.agent-config-studio', 'roots.json'), JSON.stringify({ version: 1, roots: [{ id: 'work', path: work, label: 'Work', access: 'edit' }] }));
  const srv = await startServer(home, { root: ROOT });
  const ctx = await srv.call('/api/context');
  const ids = JSON.stringify(ctx.json).match(/"id":"[0-9a-f]{24}"/g)?.map((m) => m.slice(6, -1)) || [];
  let served = '';
  for (const id of ids) served += (await srv.call(`/api/context/file?id=${id}`)).text;
  ok('ids: no Context file id serves the hard-linked AGENTS.md', !leaked(served) && !leaked(ctx.text), `${ids.length} ids`);
  const sk = await srv.call('/api/skills');
  const leaky = sk.json?.skills?.find((s) => s.name === 'leaky');
  const exp = leaky ? await fetch(`${srv.base}/api/skills/export?ids=${leaky.id}`).then((r) => r.text()) : '';
  ok('ids: the skill export never carries the hard-linked file', !leaked(exp) && !leaked(sk.text), leaky ? JSON.stringify(leaky).slice(0, 200) : 'no row');
  ok('ids: …nor the history mirror', !leaked(historyText(home)));
  await srv.stop();
}

assertRealHomesUnchanged(realBefore, ok);
for (const t of temps) fs.rmSync(t, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
