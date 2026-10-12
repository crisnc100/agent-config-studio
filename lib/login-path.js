import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The PATH a new terminal would have, for the setup screen's Recheck.
 *
 * The server's PATH is the one it was launched with, so a CLI installed since
 * — whose installer added a directory to the shell's startup files — is
 * invisible to it. A login shell reads those files; this asks one to print
 * its PATH and nothing else. The binary search afterwards is harness.js's,
 * with its candidate and shim rules; nothing here runs what it finds.
 *
 * Pinned by tests/guards.mjs: argv is exactly ['-lc', LOGIN_PATH_SCRIPT], and
 * the script is this one literal — no caller contributes a word to it. The
 * shell is $SHELL only when /etc/shells lists it, else /bin/sh. Markers frame
 * the answer, so a profile that prints a banner cannot be mistaken for PATH.
 */
const LOGIN_PATH_SCRIPT = 'printf "__ACS_PATH__%s__ACS_END__" "$PATH"';
/**
 * The one budget for a login-shell read: the read at start, Recheck's read,
 * and how long the first request waits for the one at start all use it.
 */
export const LOGIN_READ_MS = 1500;

/** Where the official installers and package managers put binaries: the answer when the shell gives none. */
const installerDirs = (home) => [
  path.join(home, '.local', 'bin'), path.join(home, '.grok', 'bin'), path.join(home, '.npm-global', 'bin'),
  '/opt/homebrew/bin', '/usr/local/bin',
];

/** $SHELL when it is a listed login shell, else /bin/sh. */
export function loginShell(env = process.env) {
  const want = env.SHELL;
  if (!want || !path.isAbsolute(want)) return '/bin/sh';
  let listed = [];
  try { listed = fs.readFileSync('/etc/shells', 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')); } catch {}
  return listed.includes(want) && fs.existsSync(want) ? want : '/bin/sh';
}

/**
 * The login shell's PATH directories (absolute ones only), and whether the
 * shell itself said so (`fromShell`); a shell that fails or outlasts the
 * budget gives the usual installer directories instead, marked as a guess.
 * The shell comes from loginShell() and nowhere else.
 */
export function loginPathRead({ env = process.env, home = os.homedir(), timeoutMs = LOGIN_READ_MS } = {}) {
  const shell = loginShell(env);
  return new Promise((resolve) => {
    execFile(shell, ['-lc', LOGIN_PATH_SCRIPT], { timeout: timeoutMs, maxBuffer: 1 << 20, env }, (err, stdout) => {
      const m = /__ACS_PATH__(.*?)__ACS_END__/s.exec(typeof stdout === 'string' ? stdout : '');
      if (!m) return resolve({ dirs: installerDirs(home), fromShell: false });
      // `raw` keeps every entry as the shell has it, relative and empty ones included.
      resolve({ dirs: [...new Set(m[1].split(path.delimiter).filter((d) => path.isAbsolute(d)))], raw: m[1].split(path.delimiter), fromShell: true });
    });
  });
}

/** loginPathRead's directories alone. */
export const loginPathDirs = (opts) => loginPathRead(opts).then((r) => r.dirs);

/*
 * One server-wide answer, so everything that looks for a binary — the CLI
 * cards, the account suggestions, the Codex sign-in, whether `acs` is on
 * PATH — sees the same directories. Read once at start, again on Recheck.
 */
let cached = [];
let known = false;
let pending = null;

/** The cached login-shell PATH directories ([] until the first read lands). */
export const loginDirs = () => cached;

/** Did the last read come from the shell itself — not a fallback, not still out? */
export const loginDirsKnown = () => known && !pending;

/**
 * Wait for a read that is already under way — the one at start — for at most
 * `ms`, so the first question asked is answered with the login PATH rather
 * than the inherited one. Returns at once when no read is pending.
 */
export async function loginDirsSettled(ms = LOGIN_READ_MS) {
  if (!pending) return;
  let t;
  await Promise.race([pending.catch(() => {}), new Promise((r) => { t = setTimeout(r, ms); })]);
  clearTimeout(t);
}

/** Read the login shell's PATH again; concurrent callers share one read. */
export function refreshLoginDirs(opts = {}) {
  if (!pending) {
    pending = loginPathRead(opts).then((r) => { cached = r.dirs; known = r.fromShell; return r.dirs; }).finally(() => { pending = null; });
  }
  return pending;
}
