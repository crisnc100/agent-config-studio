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
const TIMEOUT_MS = 3000;

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
 * The login shell's PATH directories (absolute ones only). A shell that fails
 * or takes over 3 s falls back to the usual installer directories.
 */
export function loginPathDirs({ env = process.env, home = os.homedir() } = {}) {
  const shell = loginShell(env);
  return new Promise((resolve) => {
    execFile(shell, ['-lc', LOGIN_PATH_SCRIPT], { timeout: TIMEOUT_MS, maxBuffer: 1 << 20, env }, (err, stdout) => {
      const m = /__ACS_PATH__(.*?)__ACS_END__/s.exec(typeof stdout === 'string' ? stdout : '');
      if (!m) return resolve(installerDirs(home));
      resolve([...new Set(m[1].split(path.delimiter).filter((d) => path.isAbsolute(d)))]);
    });
  });
}
