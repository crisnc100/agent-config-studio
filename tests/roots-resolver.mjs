/**
 * realpathNearest resolves a path the way the kernel does (regrade 2, P1):
 * links followed in order, `..` stepping up from where the walk really is,
 * dangling links followed to their targets. Each shape below is predicted
 * first, then written THROUGH, and the prediction must equal the kernel's
 * own answer (libc realpath of what was created). The temp folder is used by
 * its unresolved spelling — on macOS that is /var/…, itself a link to
 * /private/var. Then the editor routes, against a real server: a dangling
 * link whose lexical collapse names an existing file must never read or
 * overwrite that file.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshotRealHomes, assertRealHomesUnchanged } from './real-home.mjs';
import { seedGlobals, startServer } from './fixtures/roots-home.mjs';
import { realpathNearest } from '../lib/paths.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const realBefore = snapshotRealHomes();

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

console.log('\nresolver');
// Unresolved on purpose: /var/folders/… on macOS.
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'acs-resolve-'));
const mk = (...p) => { fs.mkdirSync(path.join(...p), { recursive: true }); return path.join(...p); };
const E = mk(T, 'edit'), R = mk(T, 'read', 'sub');
fs.symlinkSync(R, path.join(E, 'jump'));                       // edit/jump -> read/sub
fs.writeFileSync(path.join(E, 'decoy.md'), 'DECOY\n');           // what a lexical `jump/..` names
mk(E, 'trunk'); mk(E, 'rel');

const shapes = [
  ['a dangling leaf through jump/..', 'trunk/.worktrees.conf', `${E}/jump/../new.conf`],
  ['a dangling leaf whose lexical collapse names an EXISTING file', 'trunk/decoy-link.md', `${E}/jump/../decoy.md`],
  ['a relative target with ..', 'rel/link.md', '../jump/../rel-target.md'],
  ['a chain: link -> dangling link -> jump/..', 'trunk/chain-a', `${E}/trunk/chain-b`],
  ['a target spelled through the unresolved tmp path (/var on macOS)', 'trunk/var-link', `${T}/edit/jump/../../var-target.md`],
];
fs.symlinkSync(`${E}/jump/../chain-end.md`, path.join(E, 'trunk', 'chain-b'));
for (const [what, rel, target] of shapes) {
  const link = path.join(E, rel);
  fs.symlinkSync(target, link);
  const predicted = realpathNearest(link);
  fs.writeFileSync(link, 'written through\n');
  const kernel = fs.realpathSync.native(link);
  ok(`R ${what}: predicted before the write = where the kernel wrote it`, predicted === kernel, `${predicted} vs ${kernel}`);
}
ok('R …and the decoy was never the destination', fs.readFileSync(path.join(E, 'decoy.md'), 'utf8') === 'DECOY\n');
ok('R an existing path is the kernel\'s realpath (the /var spelling resolved)', realpathNearest(path.join(T, 'edit', 'jump')) === fs.realpathSync.native(R));
const loop = path.join(E, 'loop');
fs.symlinkSync(loop, loop);
let loopErr = null;
try { realpathNearest(path.join(loop, 'x')); } catch (e) { loopErr = e; }
ok('R a link loop is refused, not walked forever', loopErr?.status === 400, loopErr?.message);
fs.rmSync(T, { recursive: true, force: true });

// The editor routes on a dangling link whose lexical collapse is an existing file.
{
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acs-resolve-home-')));
  const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acs-resolve-read-')));
  seedGlobals(home);
  const W = path.join(home, 'code', 'work');
  const RS = mk(other, 'shared', 'sub');
  mk(W, 'app'); mk(W, 'inner');
  fs.symlinkSync(RS, path.join(W, 'jump'));
  fs.symlinkSync(path.join(W, 'inner'), path.join(W, 'jump2'));
  const decoy = path.join(W, 'decoy.md');
  fs.writeFileSync(decoy, 'DECOY-BYTES\n');
  const toRead = path.join(W, 'app', 'CLAUDE.md');
  fs.symlinkSync(`${W}/jump/../decoy.md`, toRead);            // kernel: <read>/shared/decoy.md
  const toEdit = path.join(W, 'app', 'AGENTS.md');
  fs.symlinkSync(`${W}/jump2/../fresh.md`, toEdit);            // kernel: <work>/fresh.md (missing)
  fs.mkdirSync(path.join(home, '.agent-config-studio'), { recursive: true });
  fs.writeFileSync(path.join(home, '.agent-config-studio', 'roots.json'), JSON.stringify({ version: 1, roots: [
    { id: 'work', path: W, label: 'Work', access: 'edit' },
    { id: 'shared', path: path.join(other, 'shared'), label: 'Shared', access: 'read' },
  ] }));
  const srv = await startServer(home, { root: ROOT });
  ok('the server boots', srv.up, srv.log().slice(-300));
  const g = await srv.call(`/api/file?path=${encodeURIComponent(toRead)}`);
  ok('R GET of a dangling link into the read root refuses, and never serves the existing decoy', g.status === 403 && !g.text.includes('DECOY-BYTES'), g.text);
  const p = await srv.call('/api/file', { method: 'PUT', body: { path: toRead, content: 'overwrite\n' } });
  ok('R PUT through it refuses: the decoy is untouched and nothing appears in the read root',
     p.status === 403 && fs.readFileSync(decoy, 'utf8') === 'DECOY-BYTES\n' && !fs.existsSync(path.join(other, 'shared', 'decoy.md')), p.text);
  const g2 = await srv.call(`/api/file?path=${encodeURIComponent(toEdit)}`);
  ok('R a dangling link within the edit root resolves to its true (missing) target, not another file',
     g2.status >= 400 && !g2.text.includes('DECOY-BYTES') && !(g2.json?.path && g2.json.path !== path.join(W, 'fresh.md')), g2.text);
  await srv.stop();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(other, { recursive: true, force: true });
}

assertRealHomesUnchanged(realBefore, ok);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
