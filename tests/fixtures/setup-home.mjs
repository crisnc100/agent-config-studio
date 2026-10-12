/**
 * Fixtures for the setup-screen suites (builds/setup-screen): fake agent CLIs
 * and a PATH that holds nothing but them, node and the system tools.
 *
 * A fake CLI is a POSIX sh script. `--version` prints a version (or sleeps
 * first, for the slow-probe case); `login` behaves like `codex login`: it
 * prints an OAuth URL on stderr, then — after `loginMs` — writes a non-empty
 * auth.json into $CODEX_HOME and exits. Every call is appended to `calls.log`
 * beside the script, so a test can prove what ran.
 */
import fs from 'node:fs';
import path from 'node:path';

const CLIS = ['claude', 'codex', 'grok'];

export function fakeCli(dir, name, { version = `${name} 9.9.9 (fake)`, slowMs = 0, loginMs = 300, loginUrl = true } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const log = path.join(dir, 'calls.log');
  const url = 'https://auth.openai.com/oauth/authorize?client_id=fake&state=s1&code_challenge=c1';
  const script = `#!/bin/sh
echo "${name} $*" >> '${log}'
case "$1" in
  --version)
    ${slowMs ? `sleep ${slowMs / 1000}` : ':'}
    echo '${version}'
    ;;
  login)
    ${loginUrl ? `echo "Visit ${url} to sign in" >&2` : ':'}
    sleep ${loginMs / 1000}
    [ -n "$CODEX_HOME" ] && printf '{"fake":true}' > "$CODEX_HOME/auth.json"
    ;;
  logout)
    [ -n "$CODEX_HOME" ] && rm -f "$CODEX_HOME/auth.json"
    ;;
  *) exit 2 ;;
esac
`;
  const file = path.join(dir, name);
  fs.writeFileSync(file, script, { mode: 0o755 });
  return file;
}

/** A recorder named `name` that only logs that it ran (a fake `security`, say). */
export function recorder(dir, name) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\necho "${name} $*" >> '${path.join(dir, 'calls.log')}'\nexit 1\n`, { mode: 0o755 });
  return file;
}

export const calls = (dir) => { try { return fs.readFileSync(path.join(dir, 'calls.log'), 'utf8'); } catch { return ''; } };

/**
 * PATH = the fake-CLI dir, node's own dir (as a link), and the system dirs
 * that hold no real agent CLI — so nothing but the fakes can be found.
 */
export function isolatedPath(binDir) {
  fs.mkdirSync(binDir, { recursive: true });
  const node = path.join(binDir, 'node');
  if (!fs.existsSync(node)) fs.symlinkSync(process.execPath, node);
  const sys = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'].filter((d) => !CLIS.some((c) => fs.existsSync(path.join(d, c))));
  return [binDir, ...sys].join(':');
}

/** Headers a browser would send for each origin case the strict check must refuse. */
export const FOREIGN = (base) => {
  const port = Number(new URL(base).port);
  return {
    'a foreign Origin': { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
    'another localhost port': { origin: `http://localhost:${port === 5173 ? 5174 : 5173}`, 'sec-fetch-site': 'same-site' },
    'Origin: null': { origin: 'null' },
    'Sec-Fetch-Site: same-site without Origin': { 'sec-fetch-site': 'same-site' },
  };
};
