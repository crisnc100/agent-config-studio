/**
 * Built-in homes judged by where they really are (regrade P1). A ~/.claude
 * linked into a dotfiles repo is legitimate and keeps working; one linked to
 * ~/.ssh, or a ~/.agents linked to HOME, would hand the editor the keys — so
 * it is dropped from the safe roots and the skill roots, and reported in the
 * banner and the Folders view. Each scenario boots `node server.js` on its
 * own temp HOME.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshotRealHomes, assertRealHomesUnchanged } from './real-home.mjs';
import { seedProjectTree, startServer } from './fixtures/roots-home.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const realHome = os.homedir();
const realBefore = snapshotRealHomes();

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const temps = [];
const mkHome = (tag) => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `acs-bi-${tag}-`))); temps.push(d); return d; };
const put = (f, body) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); return f; };
const KEY = 'SSH-PRIVATE-KEY-MARKER\n';
const roots = (home, list) => put(path.join(home, '.agent-config-studio', 'roots.json'), JSON.stringify({ version: 1, roots: list }));

console.log('\nbuilt-in homes by their real location');
ok('the real HOME is never a test HOME', !temps.includes(realHome));

/* ── ~/.claude -> ~/.ssh ─────────────────────────────────────────────────── */
{
  const home = mkHome('claude-ssh');
  const key = put(path.join(home, '.ssh', 'id_ed25519'), KEY);
  put(path.join(home, '.ssh', 'skills', 'stolen', 'SKILL.md'), '---\nname: stolen\ndescription: x\n---\n');
  fs.symlinkSync(path.join(home, '.ssh'), path.join(home, '.claude'));
  const work = path.join(home, 'code', 'work');
  seedProjectTree(work, 'work');
  roots(home, [{ id: 'work', path: work, label: 'Work', access: 'edit' }]);
  const srv = await startServer(home, { root: ROOT });
  ok('the server boots with ~/.claude linked to ~/.ssh', srv.up, srv.log().slice(-400));
  for (const spelled of [key, path.join(home, '.claude', 'id_ed25519')]) {
    const g = await srv.call(`/api/file?path=${encodeURIComponent(spelled)}`);
    ok(`BI reading the key 403s (${spelled.includes('.claude') ? 'through ~/.claude' : 'at ~/.ssh'})`, g.status === 403 && !g.text.includes('SSH-PRIVATE'), g.text);
    const put403 = await srv.call('/api/file', { method: 'PUT', body: { path: spelled, content: 'pwned\n' } });
    ok('BI …and writing it 403s, the key unchanged', put403.status === 403 && fs.readFileSync(key, 'utf8') === KEY, put403.text);
  }
  const reg = (await srv.call('/api/registry')).json;
  ok('BI nothing under ~/.ssh is listed in the registry', !JSON.stringify(reg).includes(`${path.sep}.ssh${path.sep}`));
  const skills = (await srv.call('/api/skills')).json.skills;
  ok('BI nor in the skill roots: the skill planted there is not listed or exportable', !skills.some((s) => s.name === 'stolen'), JSON.stringify(skills.map((s) => s.name)));
  const r = (await srv.call('/api/roots')).json;
  ok('BI Folders reports ~/.claude ignored, with why', r.invalid.some((x) => x.id === '~/.claude' && /holds ~\/\.ssh/.test(x.reason)), JSON.stringify(r.invalid));
  ok('BI …so does the banner', /ignored\s+~\/\.claude: .*~\/\.ssh/.test(srv.log()), srv.log());
  ok('BI the edit root still works', registryJsonHas(reg, path.join(work, 'work-app', 'CLAUDE.md')));
  await srv.stop();
}

/* ── ~/.agents -> HOME ──────────────────────────────────────────────────── */
{
  const home = mkHome('agents-home');
  const key = put(path.join(home, '.ssh', 'id_rsa'), KEY);
  fs.symlinkSync(home, path.join(home, '.agents'));
  const work = path.join(home, 'code', 'work');
  seedProjectTree(work, 'work');
  roots(home, [{ id: 'work', path: work, label: 'Work', access: 'edit' }]);
  const srv = await startServer(home, { root: ROOT });
  ok('the server boots with ~/.agents linked to HOME', srv.up, srv.log().slice(-400));
  const g = await srv.call(`/api/file?path=${encodeURIComponent(key)}`);
  ok('BI ~/.agents -> HOME is dropped: the key under HOME 403s', g.status === 403, g.text);
  const r = (await srv.call('/api/roots')).json;
  ok('BI …reported as ignored (home folder or above)', r.invalid.some((x) => x.id === '~/.agents' && /home folder or a folder above it/.test(x.reason)), JSON.stringify(r.invalid));
  ok('BI …and project roots are not all swallowed by it: the edit root is still active',
     r.roots.some((x) => x.id === 'work' && x.status === 'ok') && registryJsonHas((await srv.call('/api/registry')).json, path.join(work, 'CLAUDE.md')), JSON.stringify(r));
  await srv.stop();
}

/* ── ~/.claude -> ~/dotfiles/claude (legitimate) ───────────────────────── */
{
  const home = mkHome('dotfiles');
  const real = path.join(home, 'dotfiles', 'claude');
  const md = put(path.join(real, 'CLAUDE.md'), '# global from dotfiles\n');
  fs.symlinkSync(real, path.join(home, '.claude'));
  roots(home, []);
  const srv = await startServer(home, { root: ROOT });
  const g = await srv.call(`/api/file?path=${encodeURIComponent(path.join(home, '.claude', 'CLAUDE.md'))}`);
  ok('BI ~/.claude -> ~/dotfiles/claude still opens in the editor', g.status === 200 && g.json.path === md, g.text);
  const p = await srv.call('/api/file', { method: 'PUT', body: { path: md, content: '# edited\n', mtime: g.json?.mtime } });
  ok('BI …and saves', p.status === 200 && p.json.saved && fs.readFileSync(md, 'utf8') === '# edited\n', p.text);
  ok('BI …and is not reported as ignored', !(await srv.call('/api/roots')).json.invalid.length && !/ignored/.test(srv.log()));
  await srv.stop();
}

function registryJsonHas(reg, p) { return reg.groups.some((g) => g.entries.some((e) => e.files.some((f) => f.path === p))); }

for (const t of temps) { try { fs.rmSync(t, { recursive: true, force: true }); } catch {} }
assertRealHomesUnchanged(realBefore, ok);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
