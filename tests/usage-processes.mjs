/**
 * Seat-conflict detection. No real processes are signalled: every test injects
 * a fake lsof and a fake kill.
 *
 * What this guards: the stop endpoint takes a pid list from an HTTP request. A
 * naive implementation would be a remote-kill primitive — so nothing may be
 * signalled that is not re-verified, at that moment, to be a codex process
 * holding THIS seat's home.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { processesUsingHome, codexProcessesUsingHome, stopProcesses } from '../lib/usage/processes.js';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

const HOME = '/tmp/seat-home';
/** Build lsof -F output: p<pid>, c<command>, n<name>. */
const lsofOut = (rows) => rows.map(([pid, cmd, name]) => `p${pid}\nc${cmd}\nn${name}`).join('\n') + '\n';
const fakeLsof = (rows) => async () => lsofOut(rows);

console.log('\nusage/processes');

// --- parsing -----------------------------------------------------------------
{
  const rows = await processesUsingHome(HOME, {
    lsof: fakeLsof([
      [101, 'codex', `${HOME}/logs_2.sqlite`],
      [101, 'codex', `${HOME}/queue_1.sqlite-wal`],
      [202, 'node', `${HOME}/sessions/2026/09/a.jsonl`],
    ]),
  });
  ok('groups open files by pid', rows.length === 2, JSON.stringify(rows.map((r) => r.pid)));
  ok('carries the command', rows.find((r) => r.pid === 101).command === 'codex');
}

// --- scoping: only files genuinely INSIDE the home --------------------------
{
  const rows = await processesUsingHome(HOME, {
    lsof: fakeLsof([
      [1, 'codex', HOME],                       // the directory itself is not "using" it
      [2, 'codex', `${HOME}-other/x.sqlite`],   // prefix collision, different home
      [3, 'codex', '/elsewhere/x.sqlite'],
      [4, 'codex', `${HOME}/real.sqlite`],
    ]),
  });
  const pids = rows.map((r) => r.pid);
  ok('the home directory entry alone does not count', !pids.includes(1), JSON.stringify(pids));
  ok('a sibling home with a shared prefix is not this home', !pids.includes(2), JSON.stringify(pids));
  ok('an unrelated path is excluded', !pids.includes(3));
  ok('a real file inside the home counts', pids.includes(4));
}

// --- a symlinked home still matches ------------------------------------------
{
  // Review finding: lsof reports the kernel's REAL path, while the comparison
  // used path.resolve, which keeps symlinks. A user whose ~/.codex is a symlink
  // (dotfiles setups) got zero conflicts and the silent overwrite this feature
  // exists to prevent.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acs-link-'));
  const real = path.join(dir, 'real');
  const link = path.join(dir, 'link');
  fs.mkdirSync(real, { recursive: true });
  fs.symlinkSync(real, link);
  const realReal = fs.realpathSync(real);

  const rows = await processesUsingHome(link, {
    lsof: fakeLsof([[77, 'codex', `${realReal}/logs_2.sqlite`]]),
  });
  ok('a symlinked home matches the real paths lsof reports', rows.some((r) => r.pid === 77),
     JSON.stringify(rows));
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- the studio never reports itself ----------------------------------------
{
  const rows = await processesUsingHome(HOME, {
    self: 999, lsof: fakeLsof([[999, 'node', `${HOME}/a.sqlite`], [1000, 'codex', `${HOME}/b.sqlite`]]),
  });
  ok('the studio process is not a conflict with itself', !rows.some((r) => r.pid === 999));
  ok('...but other processes still are', rows.some((r) => r.pid === 1000));
}

// --- only plausibly-codex processes are offered for stopping ----------------
{
  const rows = await codexProcessesUsingHome(HOME, {
    lsof: fakeLsof([
      [1, 'codex', `${HOME}/logs_2.sqlite`],
      [2, 'Finder', `${HOME}/notes.sqlite`],
      [3, 'mdworker', `${HOME}/x.sqlite`],
      [4, 'node', `${HOME}/sessions/a.jsonl`],
      [5, 'codex', `${HOME}/README.txt`],        // codex, but not a session artefact
    ]),
  });
  const pids = rows.map((r) => r.pid).sort();
  ok('a codex process holding session state is offered', pids.includes(1));
  ok('a node process holding a rollout is offered', pids.includes(4));
  ok('Finder is never offered for stopping', !pids.includes(2), JSON.stringify(pids));
  ok('the spotlight indexer is never offered', !pids.includes(3));
  ok('a codex process with no session artefact is not offered', !pids.includes(5));
}

// --- stopping re-verifies; a pid list is a hint, not an instruction ----------
{
  const live = fakeLsof([[10, 'codex', `${HOME}/logs_2.sqlite`], [11, 'codex', `${HOME}/queue_1.sqlite`]]);
  const killed = [];
  const kill = (pid, sig) => { killed.push([pid, sig]); };

  const r = await stopProcesses(HOME, [10, 11], { lsof: live, kill });
  ok('verified pids are signalled', r.stopped.sort().join(',') === '10,11', JSON.stringify(r));
  ok('SIGTERM, never SIGKILL — work in progress gets to save',
     killed.every(([, sig]) => sig === 'SIGTERM'), JSON.stringify(killed));

  // The attack: a pid that is NOT attached to this seat.
  killed.length = 0;
  const r2 = await stopProcesses(HOME, [1, 99999, 10], { lsof: live, kill });
  ok('a pid not holding this home is refused', r2.refused.includes(99999), JSON.stringify(r2));
  ok('...and is never signalled', !killed.some(([p]) => p === 99999), JSON.stringify(killed));
  ok('pid 1 is never signalled', !killed.some(([p]) => p === 1));
  ok('the legitimate pid in the same call still works', killed.some(([p]) => p === 10));

  // A process that belongs to a DIFFERENT seat must not be reachable from this one.
  const other = fakeLsof([[10, 'codex', '/tmp/another-seat/logs_2.sqlite']]);
  killed.length = 0;
  const r3 = await stopProcesses(HOME, [10], { lsof: other, kill });
  ok('a process on another seat is refused', r3.refused.includes(10) && killed.length === 0, JSON.stringify(r3));
}

// --- an unknown answer must not look like a safe one -------------------------
{
  // Review finding: a timed-out or truncated lsof resolved with partial output,
  // so "no conflicts" was a guess and the sign-in proceeded on top of a running
  // session. Unknown has to be distinguishable from none.
  let threw = null;
  try {
    await processesUsingHome(HOME, {
      lsof: async () => { const e = new Error('boom'); e.incomplete = true; throw e; },
    });
  } catch (e) { threw = e; }
  ok('an lsof failure propagates rather than reading as "nothing running"', threw !== null,
     'returned normally — a partial scan would look safe');
}

// --- junk input --------------------------------------------------------------
{
  const kill = () => { throw new Error('should not be called'); };
  const live = fakeLsof([[10, 'codex', `${HOME}/a.sqlite`]]);
  for (const junk of [null, undefined, 'all', ['x'], [0], [-1], [1.5], [{}]]) {
    const r = await stopProcesses(HOME, junk, { lsof: live, kill });
    ok(`junk pids signal nothing: ${JSON.stringify(junk)}`, r.stopped.length === 0);
  }
  ok('a missing home yields no conflicts', (await processesUsingHome(null)).length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
