/**
 * tests/fixtures/cleanup.mjs: a suite cancelled (SIGTERM) while a launcher shell
 * waits on a foreground node leaves no node child behind, when the launcher is
 * spawned the way acs-launcher.mjs and acs-node.mjs spawn bin/acs: detached and
 * tracked as a process group. The launcher here does what bin/acs does — a
 * server in the background, a TERM trap, then a foreground node it waits on
 * (which defers the trap). The ungrouped control shows the sweep's old gap.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLEANUP = path.join(ROOT, 'tests', 'fixtures', 'cleanup.mjs');
const sb = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-launcher-'));
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

const launcher = path.join(sb, 'launcher.sh');
fs.writeFileSync(launcher, [
  '#!/bin/sh',
  'NODE="$1"; PIDS="$2"',
  '"$NODE" -e "require(\'fs\').appendFileSync(process.argv[1], \'server \' + process.pid + \'\\n\'); setInterval(() => {}, 1000)" "$PIDS" &',
  'SERVER_PID=$!',
  "trap 'kill $SERVER_PID 2>/dev/null' INT TERM",
  '"$NODE" -e "require(\'fs\').appendFileSync(process.argv[1], \'foreground \' + process.pid + \'\\n\'); setInterval(() => {}, 1000)" "$PIDS"',
  'wait $SERVER_PID',
  '',
].join('\n'));

async function cancelSuite(label, group) {
  const pids = path.join(sb, `${label}.pids`);
  const suite = path.join(sb, `${label}-suite.mjs`);
  fs.writeFileSync(suite, `
    import { spawn } from 'node:child_process';
    import { track } from ${JSON.stringify(CLEANUP)};
    const child = spawn('/bin/sh', [${JSON.stringify(launcher)}, process.execPath, ${JSON.stringify(pids)}], { stdio: 'ignore'${group ? ', detached: true' : ''} });
    track(child${group ? ', { group: true }' : ''});
    setInterval(() => {}, 1000);
  `);
  const s = spawn(process.execPath, [suite], { stdio: 'ignore' });
  const read = () => { try { return Object.fromEntries(fs.readFileSync(pids, 'utf8').trim().split('\n').map((l) => l.split(' ')).map(([k, v]) => [k, Number(v)])); } catch { return {}; } };
  for (let i = 0; i < 100 && !(read().server && read().foreground); i++) await sleep(50);
  const started = read();
  s.kill('SIGTERM');
  await new Promise((r) => (s.exitCode !== null || s.signalCode !== null ? r() : s.once('exit', r)));
  const live = () => Object.entries(started).filter(([, pid]) => alive(pid));
  for (let i = 0; i < 40 && live().length; i++) await sleep(50);
  const left = live();
  for (const [, pid] of left) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  return { started, left };
}

console.log('\ncleanup: a cancelled suite leaves no launcher child behind');
try {
  const g = await cancelSuite('group', true);
  ok('the launcher started its background server and its foreground node', !!g.started.server && !!g.started.foreground, JSON.stringify(g.started));
  ok('detached + track({ group: true }): SIGTERM to the suite leaves no node child running', g.left.length === 0, JSON.stringify(g.left));
  const c = await cancelSuite('control', false);
  ok('control: tracked without a group, the same cancel leaves node children running (the test can see the gap)', !!c.started.foreground && c.left.length > 0, JSON.stringify(c));

  // The real launcher call sites spawn bin/acs that way.
  for (const f of ['acs-launcher.mjs', 'acs-node.mjs']) {
    const src = fs.readFileSync(path.join(ROOT, 'tests', f), 'utf8');
    const starts = src.split('\n').filter((l) => /const child = spawn\('\/bin\/sh', \[ACS\]/.test(l));
    ok(`${f}: every bin/acs start is detached and tracked as a group`, starts.length > 0 && starts.every((l) => /detached: true/.test(l) && /track\(child, \{ group: true \}\)/.test(l)), starts.join('\n'));
  }
} finally {
  fs.rmSync(sb, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
