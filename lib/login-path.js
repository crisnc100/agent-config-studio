import os from 'node:os';
import path from 'node:path';

/**
 * PATH directories a CLI installed since the studio started may live in.
 *
 * The server's PATH is the one it was launched with, so a CLI installed in a
 * new terminal — whose installer added a directory to the shell's startup
 * files — is invisible to it. Recheck adds these: where the official
 * installers and package managers put their binaries.
 */
export async function loginPathDirs({ home = os.homedir() } = {}) {
  return [
    path.join(home, '.local', 'bin'),
    path.join(home, '.grok', 'bin'),
    path.join(home, '.npm-global', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];
}
