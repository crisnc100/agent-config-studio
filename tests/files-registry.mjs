/**
 * What the registry tells the Files page about auto-memory: the project name
 * the Memory view uses (the decoded slug's repository), not the raw slug, and
 * where that project lives, for the tooltip.
 *
 * HOME is redirected to a temp dir seeded from tests/fixtures/memory-home.mjs
 * before anything from lib/ loads.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { snapshotRealHomes, assertRealHomesUnchanged } from './real-home.mjs';
import { seedMemoryHome, unlockMemoryHome, enc } from './fixtures/memory-home.mjs';

const realBefore = snapshotRealHomes();
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acs-files-reg-')));
process.env.HOME = home;
process.env.ACS_SUITE = 'offline';
delete process.env.CODEX_HOME;

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
console.log('\nfiles/registry');

seedMemoryHome(home);
const alpha = path.join(home, 'Documents', 'Projects', 'alpha');
const wt = path.join(home, 'Documents', 'Projects', 'alpha-wt', 'alpha-feature');
// A worktree's own memory: it belongs to the same repository as alpha's.
const wtMem = path.join(home, '.claude', 'projects', enc(wt), 'memory');
fs.mkdirSync(wtMem, { recursive: true });
fs.writeFileSync(path.join(wtMem, 'wt-fact.md'), '---\nname: wt-fact\n---\nfrom the worktree\n');
// A slug that resolves nowhere keeps its HOME-relative form.
const goneMem = path.join(home, '.claude', 'projects', enc(path.join(home, 'Documents', 'Projects', 'gone-project')), 'memory');
fs.mkdirSync(goneMem, { recursive: true });
fs.writeFileSync(path.join(goneMem, 'g.md'), 'gone\n');

const { buildRegistry } = await import('../lib/registry.js');
const reg = buildRegistry();
const auto = reg.groups.find((g) => g.id === 'auto-memory');
const bySlug = (abs) => auto?.entries.find((e) => e.dir.includes(enc(abs)));
ok('the registry has auto-memory entries', !!auto && auto.entries.length >= 2);
const a = bySlug(alpha);
ok('a repository\'s auto-memory is labelled with the repository name, not its slug', a?.label === 'alpha', a?.label);
ok('…and carries where the project is, as a ~ path', a?.where === '~/Documents/Projects/alpha', a?.where);
const w = bySlug(wt);
ok('a worktree\'s auto-memory is labelled with its main checkout, as in the Memory view', w?.label === 'alpha', w?.label);
ok('…its own folder still in `where`, to tell the two apart', w?.where === '~/Documents/Projects/alpha-wt/alpha-feature', w?.where);
const g = auto.entries.find((e) => e.dir.includes('gone-project'));
ok('a slug that resolves nowhere keeps a readable HOME-relative label and no `where`', !!g && !g.label.includes(enc(home)) && /gone-project$/.test(g.label) && g.where == null, `${g?.label} / ${g?.where}`);
ok('no auto-memory label is a raw slug of the temp HOME', auto.entries.every((e) => !e.label.includes(enc(home).slice(1))), auto.entries.map((e) => e.label).join(', '));
const again = buildRegistry().groups.find((x) => x.id === 'auto-memory');
ok('a rebuild gives the same labels (decoded once, then memoised)', JSON.stringify(again.entries.map((e) => e.label)) === JSON.stringify(auto.entries.map((e) => e.label)));

// The Files page's own disambiguation, on these real entries: alpha and its worktree share a label.
const vm = await import('node:vm');
const ctx = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'public', 'files-view.js'), 'utf8'), ctx);
ctx.reg = reg;
const shown = vm.runInContext(`(() => { const t = filesModel(reg).flatMap((x) => x.types).find((x) => x.key.endsWith(':auto-memory')); return t.labels; })()`, ctx);
ok('on the Files page the two "alpha" entries are told apart by their folders', shown[a.id] !== shown[w.id] && /alpha/.test(shown[a.id]) && /alpha-feature/.test(shown[w.id]), `${shown[a.id]} | ${shown[w.id]}`);

assertRealHomesUnchanged(realBefore, ok);
unlockMemoryHome(home);
fs.rmSync(home, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
