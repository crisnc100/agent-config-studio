import { execFile } from 'node:child_process';
import path from 'node:path';

/**
 * Which running processes are attached to a seat's CODEX_HOME.
 *
 * This exists because of a failure the UI could not previously see. A Codex
 * process holds the credentials it started with and refreshes them back into
 * its home on its own schedule. Sign a seat into a different account while one
 * is running and the next refresh overwrites the new login — silently, minutes
 * later. Observed twice on this machine in one day.
 *
 * Telling the user "quit your session first" in a runbook is not a fix: they
 * cannot see which processes those are, and a second user will not read it.
 * The studio has to detect it and offer to handle it.
 *
 * Detection is by OPEN FILE, not by environment: a process's CODEX_HOME is not
 * readable from outside on macOS, but anything using a home holds sqlite and
 * lock files open inside it. That is also the honest test — a process that has
 * the home open is one that can write to it, whatever its env says.
 *
 * Never spawns a harness binary; `lsof` is pinned argv with no shell.
 */

const LSOF_TIMEOUT_MS = 5000;

/**
 * The one spawn in this module, written so a static guard can verify it: an
 * absolute path literal, literal flags, and exactly one computed argument —
 * the directory being inspected. Nothing here can resolve a name on PATH, and
 * no caller can contribute a FLAG, only a path.
 */
const run = (dir) => new Promise((resolve) => {
  execFile('/usr/sbin/lsof', ['-F', 'pcn', '-w', '+D', dir],
    { timeout: LSOF_TIMEOUT_MS, maxBuffer: 4 << 20 }, (err, stdout) => {
      // lsof exits non-zero when it simply finds nothing; that is not an error.
      resolve(typeof stdout === 'string' ? stdout : '');
    });
});

/** Parse `lsof -F` output: records are one field per line, `p<pid>`, `c<cmd>`, `n<name>`. */
function parseLsof(out) {
  const rows = [];
  let pid = null, command = null;
  for (const line of out.split('\n')) {
    const tag = line[0], value = line.slice(1);
    if (tag === 'p') { pid = Number(value); command = null; }
    else if (tag === 'c') { command = value; }
    else if (tag === 'n' && pid) rows.push({ pid, command, name: value });
  }
  return rows;
}

/**
 * Processes holding a file open under `home`.
 *
 * `self` is excluded: the studio reads seat files itself and must never report
 * itself as a conflict.
 */
export async function processesUsingHome(home, { self = process.pid, lsof = null } = {}) {
  if (!home) return [];
  const resolved = path.resolve(home);
  const out = lsof ? await lsof(resolved) : await run(resolved);
  const byPid = new Map();
  for (const row of parseLsof(out)) {
    if (row.pid === self) continue;
    if (!row.name || path.resolve(row.name) === resolved) continue;
    if (!path.resolve(row.name).startsWith(resolved + path.sep)) continue;
    if (!byPid.has(row.pid)) byPid.set(row.pid, { pid: row.pid, command: row.command || 'unknown', files: [] });
    if (byPid.get(row.pid).files.length < 4) byPid.get(row.pid).files.push(row.name);
  }
  return [...byPid.values()];
}

/**
 * Only processes that are plausibly Codex. A seat's home can legitimately be
 * open in an editor, a backup tool, or a file browser, and offering to kill
 * those would be worse than the problem.
 */
const CODEX_COMMAND = /^(codex|node|Code|ChatGPT)/i;

export async function codexProcessesUsingHome(home, opts = {}) {
  const all = await processesUsingHome(home, opts);
  return all.filter((p) => CODEX_COMMAND.test(p.command)
    && p.files.some((f) => /\.(sqlite|jsonl)(-shm|-wal)?$|\.lock$/.test(f)));
}

/**
 * Stop the given processes — but only after re-confirming each one still holds
 * this home open.
 *
 * The re-check is not belt-and-braces: pids are reused. Between listing and
 * clicking, a pid can belong to something else entirely, and a web UI that
 * kills by a number it was handed is a remote-kill primitive. Nothing is
 * signalled unless it is verified, at this moment, to be a codex process
 * attached to this seat.
 */
export async function stopProcesses(home, pids, { kill = process.kill.bind(process), ...opts } = {}) {
  const wanted = new Set((Array.isArray(pids) ? pids : [])
    .map(Number).filter((n) => Number.isInteger(n) && n > 1));
  if (!wanted.size) return { stopped: [], skipped: [], refused: [] };

  const live = await codexProcessesUsingHome(home, opts);
  const liveByPid = new Map(live.map((p) => [p.pid, p]));

  const stopped = [], skipped = [], refused = [];
  for (const pid of wanted) {
    if (!liveByPid.has(pid)) { refused.push(pid); continue; }   // gone, or no longer ours
    try { kill(pid, 'SIGTERM'); stopped.push(pid); }
    catch (e) { skipped.push({ pid, error: e.message }); }
  }
  return { stopped, skipped, refused };
}
