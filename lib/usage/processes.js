import { execFile } from 'node:child_process';
import fs from 'node:fs';
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

/** Real path where possible; a deleted or unreadable path falls back to resolve. */
const realPath = (p) => {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
};

/**
 * The one spawn in this module, written so a static guard can verify it: an
 * absolute path literal, literal flags, and exactly one computed argument —
 * the directory being inspected. Nothing here can resolve a name on PATH, and
 * no caller can contribute a FLAG, only a path.
 */
/**
 * `+d` is one level deep, NOT recursive — deliberate.
 *
 * `+D` walks every file under the home, and the sessions tree only ever grows:
 * measured 1.3s cold on a 9,198-file home here. A home large enough to cross
 * the timeout would fail closed permanently, and since no route exposes the
 * `force` flag the user would be sent back to the terminal — the exact outcome
 * this feature removes. Every codex process observed holds a TOP-LEVEL sqlite
 * or lock file, so one level is where the evidence actually is.
 */
const runShallow = (dir) => new Promise((resolve) => {
  execFile('/usr/sbin/lsof', ['-F', 'pcn', '-w', '+d', dir],
    { timeout: LSOF_TIMEOUT_MS, maxBuffer: 4 << 20 }, (err, stdout) => {
      // A non-zero exit just means "found nothing" — that is not an error. But
      // a TIMEOUT or a truncated buffer is: the output is partial, so "no
      // conflicts" would be a guess, and the caller would sign in on top of a
      // running session. Say we do not know instead.
      // A NUMERIC code means lsof itself ran and exited — non-zero there just
      // means "found nothing". A string code is a spawn-level failure (ENOENT
      // if lsof is missing, EACCES), and killed/maxBuffer mean the output is
      // partial. All of those are "we do not know", which must never be
      // mistaken for "nothing is running".
      // A NUMERIC code means lsof ran to completion; non-zero there just means
      // "found nothing". Anything else — killed, signalled from outside, a
      // spawn-level errno string — means the output is partial or absent, and
      // that must never read as "nothing is running".
      // ENOENT means lsof is not installed — a whole platform without the
      // capability, not a failed scan. Blocking every sign-in there would make
      // the app unusable on Linux to protect against a hazard we cannot even
      // observe; the caller is told instead.
      const unsupported = Boolean(err && err.code === 'ENOENT');
      const incomplete = !unsupported
        && Boolean(err && (err.killed || err.signal || typeof err.code !== 'number'));
      resolve({ out: typeof stdout === 'string' ? stdout : '', incomplete, unsupported });
    });
});

/** The small tmp/ tree, recursively — see the note above. Deliberately a
 *  SECOND call: one computed path per spawn keeps every flag a literal, which
 *  is the property guards.mjs checks. */
const runTmp = (tmpDir) => new Promise((resolve) => {
  execFile('/usr/sbin/lsof', ['-F', 'pcn', '-w', '+D', tmpDir],
    { timeout: LSOF_TIMEOUT_MS, maxBuffer: 4 << 20 }, (err, stdout) => {
      // A missing tmp/ is normal, not a failure — only a killed or unstarted
      // scan is unknown.
      const incomplete = Boolean(err && (err.killed || err.signal
        || (typeof err.code !== 'number' && err.code !== 'ENOENT')));
      resolve({ out: typeof stdout === 'string' ? stdout : '', incomplete, unsupported: false });
    });
});

/** Both scans, merged. */
const run = async (dir) => {
  const [a, b] = await Promise.all([runShallow(dir), runTmp(path.join(dir, 'tmp'))]);
  return {
    out: `${a.out}\n${b.out}`,
    incomplete: a.incomplete || b.incomplete,
    unsupported: a.unsupported,
  };
};

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
  // lsof reports the kernel's real path, so both sides must be real paths or a
  // symlinked home matches nothing — and a user whose ~/.codex is a symlink
  // (common in dotfiles setups) silently gets the overwrite this prevents.
  const resolved = realPath(home);
  const res = lsof ? { out: await lsof(resolved), incomplete: false } : await run(resolved);
  if (res.unsupported) {
    const e = new Error('lsof is not installed, so running Codex sessions cannot be detected');
    e.unsupported = true;
    throw e;
  }
  if (res.incomplete) {
    // Surfaced, never swallowed: an unknown answer must not look like a safe one.
    const e = new Error('could not determine what is using this seat (the scan did not finish)');
    e.incomplete = true;
    throw e;
  }
  const byPid = new Map();
  for (const row of parseLsof(res.out)) {
    if (row.pid === self) continue;
    if (!row.name) continue;
    const name = realPath(row.name);
    if (name === resolved) continue;                       // the directory itself is not "using" it
    if (!name.startsWith(resolved + path.sep)) continue;   // sep guards a shared-prefix sibling
    if (!byPid.has(row.pid)) {
      byPid.set(row.pid, { pid: row.pid, command: row.command || 'unknown', files: [], hasArtefact: false });
    }
    const entry = byPid.get(row.pid);
    // Decide over EVERY row, but only keep a few paths for display. Capping
    // first made detection depend on lsof's fd ordering: a process whose first
    // four handles happened to be config files was invisible.
    if (SESSION_ARTEFACT.test(name)) entry.hasArtefact = true;
    if (entry.files.length < 4) entry.files.push(row.name);
  }
  return [...byPid.values()];
}

/**
 * Only processes that are plausibly Codex. A seat's home can legitimately be
 * open in an editor, a backup tool, or a file browser, and offering to kill
 * those would be worse than the problem.
 */
const CODEX_COMMAND = /^(codex|node|Code|ChatGPT)/i;
/** Files that mean "this process is using the home", not merely reading config. */
const SESSION_ARTEFACT = /\.(sqlite|jsonl)(-shm|-wal)?$|\.lock$/;

export async function codexProcessesUsingHome(home, opts = {}) {
  const all = await processesUsingHome(home, opts);
  return all.filter((p) => CODEX_COMMAND.test(p.command) && p.hasArtefact);
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
