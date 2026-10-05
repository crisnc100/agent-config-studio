/**
 * B1, the history boundary (builds/configurable-roots/plan.md): every file the
 * history mirror copies or compares is re-proved at the moment it is read.
 * Here files that were ordinary when discovered — and already in history —
 * are swapped for links to a credential or to a file outside every root, and
 * the credential's bytes must never reach the history repo, in any commit.
 *
 * HOME is redirected to a temp directory before anything from lib/ loads.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { snapshotRealHomes, assertRealHomesUnchanged } from './real-home.mjs';

const realHome = os.homedir();
const realBefore = snapshotRealHomes();
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acs-hist-')));
const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acs-hist-outside-')));
process.env.HOME = home;
process.env.ACS_SUITE = 'offline';
delete process.env.CODEX_HOME;

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

console.log('\nhistory boundary');
ok('HOME is redirected away from the real one', os.homedir() === home && home !== realHome);

const app = path.join(home, 'code', 'work', 'app');
fs.mkdirSync(app, { recursive: true });
const files = {
  claude: path.join(app, 'CLAUDE.md'),
  agents: path.join(app, 'AGENTS.md'),
  notes: path.join(app, 'docs', 'CLAUDE.md'),
  outer: path.join(app, 'ext', 'CLAUDE.md'),
};
for (const [n, f] of Object.entries(files)) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, `# ${n} SAFE-BYTES\n`); }
fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
const cred = path.join(home, '.codex', 'auth.json');
fs.writeFileSync(cred, '{"token":"CRED-SECRET-MARKER"}\n');
const outFile = path.join(outside, 'CLAUDE.md');
fs.writeFileSync(outFile, '# OUTSIDE-SECRET-MARKER\n');

const roots = await import('../lib/roots.js');
roots.addRoot({ path: path.join(home, 'code', 'work'), access: 'edit', label: 'Work', id: 'work' }, { home });
const history = await import('../lib/history.js');
const repo = path.join(home, '.agent-config-studio', 'history');
const everything = () => {
  const log = execFileSync('git', ['-C', repo, 'log', '--all', '-p', '--format=%H %s'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  let tree = '';
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.name === '.git') continue; const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else tree += fs.readFileSync(p, 'utf8'); } };
  walk(repo);
  return log + tree;
};
const leaked = () => /CRED-SECRET-MARKER|OUTSIDE-SECRET-MARKER/.test(everything());
const swap = (f, target) => { fs.rmSync(f); fs.symlinkSync(target, f); };

await history.ensureRepo();
ok('the files are in history after the first snapshot (the probe works)', /# claude SAFE-BYTES/.test(everything()) && /# agents SAFE-BYTES/.test(everything()));

// Swapped after discovery and after the first snapshot; then the editor's
// two history calls are made with the path as it was authorized.
swap(files.claude, cred);
let recErr = null, baseErr = null;
try { await history.record(files.claude, 'edit'); } catch (e) { recErr = e; }
try { await history.recordBaseline(files.claude, 'baseline'); } catch (e) { baseErr = e; }
ok('B1 history.record refuses a file that became a credential link', recErr?.status === 403, recErr?.message);
ok('B1 history.recordBaseline refuses it too', baseErr?.status === 403, baseErr?.message);
swap(files.outer, outFile);
let outErr = null;
try { await history.record(files.outer, 'edit'); } catch (e) { outErr = e; }
ok('B1 …and a file that became a link out of every root', outErr?.status === 403, outErr?.message);
ok('B1 no credential or outside bytes are in the history repo', !leaked());

// Swapped between snapshotAll's registry build and its copies.
history._setSnapshotHook(() => {
  history._setSnapshotHook(null);
  swap(files.agents, cred);
  swap(files.notes, outFile);
});
let snap = null, snapErr = null;
try { snap = await history.snapshotAll('snapshot after the swap'); } catch (e) { snapErr = e; }
ok('B1 snapshotAll still completes when files turn into forbidden links mid-snapshot', !snapErr && snap, snapErr?.message);
ok('B1 …and copies none of their targets: no credential or outside bytes in any commit or file', !leaked());

assertRealHomesUnchanged(realBefore, ok);
fs.rmSync(home, { recursive: true, force: true });
fs.rmSync(outside, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
