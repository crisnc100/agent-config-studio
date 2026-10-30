/**
 * A registry walk cut short (lib/walk-budget.js) never makes files vanish:
 * on a busy machine a large root's walk ran out at a different place each
 * time, and every file it did not reach was announced as "removed outside
 * the studio", then "added" again on the next walk. On a temp HOME:
 *
 *   - a walk cut by the entry cap, or by time, after a complete one: no
 *     removed entries, so no notice
 *   - a real deletion, reached by the cut walk or not: exactly that file is removed
 *   - a large root's first complete index is sent as `index`, never announced
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { snapshotRealHomes, assertRealHomesUnchanged } from './real-home.mjs';
import { tempDir } from './fixtures/cleanup.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const realBefore = snapshotRealHomes();
const home = fs.realpathSync(tempDir('acs-walk-partial-'));
process.env.HOME = home;
process.env.ACS_SUITE = 'offline';
delete process.env.CODEX_HOME;

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
console.log('\nwalk-partial');

// 30 repos, one CLAUDE.md each: 30 entries at the top, one in each repo.
const mkRoot = (name) => {
  const dir = path.join(home, 'code', name);
  for (let i = 0; i < 30; i++) {
    const d = path.join(dir, `r${String(i).padStart(2, '0')}`);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'CLAUDE.md'), `# ${name} ${i}\n`);
  }
  return dir;
};
const big = mkRoot('big');
const writeRoots = (dirs) => {
  fs.mkdirSync(path.join(home, '.agent-config-studio'), { recursive: true });
  fs.writeFileSync(path.join(home, '.agent-config-studio', 'roots.json'), JSON.stringify({
    version: 1, roots: dirs.map((p) => ({ id: path.basename(p), path: p, label: path.basename(p), access: 'edit' })),
  }));
};
writeRoots([big]);

const reg = await import('../lib/registry.js');
const { WALK_LIMITS, isPartial } = await import('../lib/walk-budget.js');
const { snapshotOf, diffSnapshots, splitIndexed } = await import('../lib/watch.js');
const DEFAULT = { ...WALK_LIMITS };
const snap = () => snapshotOf(reg.buildRegistry());
const under = (s, dir) => [...s.keys()].filter((p) => p.startsWith(dir + path.sep));
// Resolves when `dir`'s off-path walk ends (another root's may end first).
const walkDone = (dir = big) => new Promise((r) => {
  const off = reg.onWalkDone((root, info) => { if (root === dir) { off(); r({ root, ...info }); } });
});
// What the server does on a change: large roots walked again, then a rebuild.
const change = () => { reg.staleLargeWalks(); return snap(); };

// 1. A complete walk: all 30.
const s0 = snap();
ok('a complete walk lists all 30', under(s0, big).length === 30, String(under(s0, big).length));

// 2. Cut by the entry cap (30 top entries + 10 repos): the slice and the
//    off-path walk both run out, and nothing the complete walk found is lost.
WALK_LIMITS.maxEntries = 40;
let done = walkDone();
const s1 = change();
const d1 = diffSnapshots(s0, s1);
ok('a cut slice after a complete walk removes nothing', d1.removed.length === 0, d1.removed.join(', '));
const w1 = await done;
const s2 = snap();
const d2 = diffSnapshots(s1, s2);
ok('…nor does the cut off-path walk', d2.removed.length === 0 && d2.added.length === 0, JSON.stringify(d2));
ok('…which is still reported partial', isPartial(big));
ok('…and is not an index filling in: the root had a complete walk', w1.indexing === false);

// 3. Real deletions while the walks are cut: one the cut walk reaches (the
//    first ten repos are), one it cannot. Exactly those two are removed.
const gone = [path.join(big, 'r00', 'CLAUDE.md'), path.join(big, 'r29', 'CLAUDE.md')];
for (const f of gone) fs.rmSync(f);
done = walkDone();
change();
await done;
const s3 = snap();
const d3 = diffSnapshots(s2, s3);
ok('a real deletion during cut walks is removed — exactly the deleted files',
   JSON.stringify(d3.removed.sort()) === JSON.stringify(gone) && !d3.added.length, JSON.stringify(d3));

// 4. Cut by time: the walk ends at its first entry and finds nothing.
WALK_LIMITS.maxEntries = DEFAULT.maxEntries;
WALK_LIMITS.timeMs = -1;
done = walkDone();
change();
await done;
const s4 = snap();
const d4 = diffSnapshots(s3, s4);
ok('a walk cut by time removes nothing', d4.removed.length === 0 && under(s4, big).length === 28, `${JSON.stringify(d4)} ${under(s4, big).length}`);

// 5. Complete again: the list is exactly what is on disk, and no news.
WALK_LIMITS.timeMs = DEFAULT.timeMs;
done = walkDone();
change();
await done;
const s5 = snap();
const d5 = diffSnapshots(s4, s5);
ok('the next complete walk changes nothing', !d5.added.length && !d5.removed.length && under(s5, big).length === 28, JSON.stringify(d5));
ok('…and clears partial', !isPartial(big));

// 6. A root that is large from its first walk: its index fills in, and that
//    is not "added outside the studio".
const fresh = mkRoot('fresh');
writeRoots([big, fresh]);
WALK_LIMITS.maxEntries = 40;
done = walkDone(fresh);
const s6 = snap();
const w6 = await done;
ok('a fresh large root starts partial, its walks marked indexing', isPartial(fresh) && w6.root === fresh && w6.indexing === true);
WALK_LIMITS.maxEntries = DEFAULT.maxEntries;
done = walkDone(fresh);
change();
const w7 = await done;
const s7 = snap();
const d7 = diffSnapshots(s6, s7);
ok('…its first complete walk adds the rest', w7.indexing === true && under(s7, fresh).length === 30 && d7.added.length > 0, `${under(s7, fresh).length} ${JSON.stringify(d7)}`);
const index = splitIndexed(d7, w7.indexing ? w7.root : null);
ok('…all of them sent as the index, none as outside adds', index.added.length > 0 && d7.added.length === 0, JSON.stringify({ index, d7 }));
fs.writeFileSync(path.join(fresh, 'r00', 'AGENTS.md'), 'new\n');
done = walkDone(fresh);
change();
const w8 = await done;
const d8 = diffSnapshots(s7, snap());
ok('…after which a new file is a real add again', w8.indexing === false && d8.added.length === 1
   && splitIndexed(d8, w8.indexing ? w8.root : null).added.length === 0 && d8.added.length === 1, JSON.stringify(d8));

// The page: an `index` event refreshes the list but is never announced.
{
  const ctx = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'public', 'file-events.js'), 'utf8'), ctx);
  ok('the page does not announce an index event', ctx.fileEventPlan({ origin: 'index', added: ['~/a'] }, {}).announce === false);
  ok('…but still announces an outside one', ctx.fileEventPlan({ origin: 'outside', removed: ['~/a'] }, {}).announce === true);
}
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
ok('the server sends a walk\'s indexing adds as `index`',
   /splitIndexed\(delta, indexing\)/.test(server) && /\[index, 'index'\]/.test(server) && /indexing: indexing \? rootReal : null/.test(server));

assertRealHomesUnchanged(realBefore, ok);
fs.rmSync(home, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
