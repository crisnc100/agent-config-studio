import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
const SHELL = '/bin/sh';
const SYSTEM_TOOLS = [SHELL, '/bin/bash', '/bin/cat', '/bin/mkdir', '/bin/rm', '/usr/bin/env'];
const SYSTEM_LIBS = ['/usr/lib', '/System/Library/dyld', '/System/Library/Frameworks', '/System/Library/PrivateFrameworks'];
const SYSTEM_DATA = ['/', '/dev/null', '/dev/urandom', '/dev/random', '/private/var/select/sh',
  '/System/Library/CoreServices/SystemVersion.plist', '/System/Library/OpenSSL/openssl.cnf'];
const RUNTIME_PREFLIGHT = {
  uv: 'uv run --no-sync python --version',
  bun: 'bun -e "console.log(Bun.version)"',
  node: 'node -e "require(\'node:crypto\'); console.log(process.version)"',
};
const GIT_PREFLIGHT = `node --input-type=module - <<'NODE'
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { dirname, join } from 'node:path';
const scratch = mkdtempSync(join(process.env.TMPDIR, 'git-preflight-'));
const env = { HOME: process.env.HOME, PATH: dirname(process.execPath) + ':/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1' };
execFileSync('git', ['--version'], { env, stdio: 'inherit' });
execFileSync('git', ['init', '-q', '--bare', scratch], { env, stdio: 'inherit' });
NODE`;

const SANDBOX_RULES = [
  '(version 1)',
  '(deny default)',
  '(allow process-fork)',
  '(allow process-info* (target self))',
  '(allow sysctl-read (sysctl-name-prefix "hw.") (sysctl-name-prefix "machdep.cpu.") (sysctl-name "kern.ostype") (sysctl-name "kern.osrelease") (sysctl-name "kern.osversion") (sysctl-name "kern.version") (sysctl-name "kern.hostname"))',
  '(allow file-write-data (literal "/dev/null"))',
];

function findRuntime(name) {
  if (name === 'node') return fs.realpathSync(process.execPath);
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return fs.realpathSync(candidate);
    } catch { /* try the next PATH entry */ }
  }
  throw new Error(`the ${name} grade runtime is missing from PATH`);
}

function copyRunnerExecutable(source, destination) {
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_FICLONE);
  fs.chmodSync(destination, 0o500);
}

function prepareGit(bin, home) {
  const result = spawnSync('/usr/bin/xcrun', ['--find', 'git'], {
    cwd: '/', env: { PATH: '/usr/bin:/bin', HOME: home, LC_ALL: 'C' }, encoding: 'utf8', timeout: 15_000,
  });
  const located = result.stdout?.trim();
  if (result.status !== 0 || !located || !path.isAbsolute(located)) {
    throw new Error(`could not locate the Apple Git runtime: ${result.error?.message || result.stderr?.trim() || 'xcrun returned no executable'}`);
  }
  const git = fs.realpathSync(located);
  if (git === '/usr/bin/git' || !fs.statSync(git).isFile()) throw new Error('xcrun did not resolve the Apple Git executable behind its shim');
  fs.accessSync(git, fs.constants.X_OK);
  copyRunnerExecutable(git, path.join(bin, 'git'));
  const helpers = ['git-receive-pack', 'git-upload-pack'];
  for (const name of helpers) fs.symlinkSync('git', path.join(bin, name));
  // Apple Git relocates its resource prefix with the binary. Stage only its stock templates.
  const sourceTemplates = path.resolve(path.dirname(git), '../share/git-core/templates');
  const templates = path.resolve(bin, '../share/git-core/templates');
  if (!fs.existsSync(sourceTemplates)) throw new Error('the Apple Git runtime is missing its repository templates');
  fs.cpSync(sourceTemplates, templates, { recursive: true, verbatimSymlinks: true, mode: fs.constants.COPYFILE_FICLONE });
  return { tools: ['git', ...helpers].map((name) => path.join(bin, name)), templates };
}

function ancestors(files) {
  const dirs = new Set();
  for (const file of files) {
    for (let dir = path.dirname(file); !dirs.has(dir); dir = path.dirname(dir)) dirs.add(dir);
  }
  return [...dirs];
}

const filter = (kind, files) => files.map((file) => `(${kind} ${JSON.stringify(file)})`).join(' ');
const rule = (operations, kind, files) => `(allow ${operations} ${filter(kind, files)})`;

export function prepareNeonGrade(testCommand, dirs, { needsGit = false } = {}) {
  if (process.platform !== 'darwin' || !fs.existsSync(SANDBOX_EXEC)) throw new Error('Neon grading requires macOS sandbox-exec');
  const runtime = testCommand.match(/^(?:cd [\w./-]+ && )?(node|bun|uv) /)?.[1];
  if (!runtime) throw new Error('the grade command has no supported Neon runtime (node, bun or uv)');
  const checkout = fs.realpathSync(dirs.repo);
  const caseDir = fs.realpathSync(dirs.case);
  if (path.dirname(checkout) !== caseDir) throw new Error('the Neon checkout is outside its disposable case directory');
  const state = path.join(caseDir, 'grade');
  const home = path.join(state, 'home');
  const bin = path.join(state, 'bin');
  const tmp = path.join(state, 'tmp');
  const uvCache = path.join(state, 'uv-cache');
  const uvPython = path.join(state, 'uv-python');
  const bunCache = path.join(state, 'bun-cache');
  for (const dir of [home, bin, tmp, uvCache, uvPython, bunCache]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let executable = findRuntime(runtime);
  if (needsGit && runtime !== 'node') throw new Error('the Git-backed grade requires Node');
  const git = needsGit ? prepareGit(bin, home) : null;
  if (git) {
    // The reference test constructs its own PATH from dirname(process.execPath). Node resolves symlinks,
    // so a private copy keeps the private Git directory available even when the test replaces PATH.
    const privateNode = path.join(bin, runtime);
    copyRunnerExecutable(executable, privateNode);
    executable = privateNode;
  } else fs.symlinkSync(executable, path.join(bin, runtime));

  // Copy installs prevent case files from sharing writable inodes with a dependency cache.
  const setupEnv = { UV_CACHE_DIR: uvCache, UV_PYTHON_INSTALL_DIR: uvPython, UV_MANAGED_PYTHON: '1', UV_LINK_MODE: 'copy', BUN_INSTALL_CACHE_DIR: bunCache };
  const gradeEnv = {
    PATH: [bin, '/usr/bin', '/bin'].join(':'), HOME: home, TMPDIR: tmp, LANG: 'C', LC_ALL: 'C',
    ...setupEnv,
    // Setup selects and installs dependencies before the model edits the checkout. uv's resolver opens
    // macOS System Configuration IPC even offline, so grading uses that existing environment.
    UV_OFFLINE: '1', UV_NO_SYNC: '1', UV_PYTHON_DOWNLOADS: 'never',
  };

  const paths = [checkout, bin, home, tmp, uvCache, uvPython, bunCache];
  const launchers = [...SYSTEM_TOOLS, executable, ...(git?.tools ?? [])];
  const templates = git ? [git.templates] : [];
  const profile = [
    ...SANDBOX_RULES,
    rule('file-read-metadata', 'literal', ancestors([...paths, ...launchers, ...SYSTEM_DATA, ...templates])),
    rule('file-read*', 'literal', SYSTEM_DATA),
    rule('file-read* file-map-executable', 'literal', launchers),
    rule('process-exec', 'literal', launchers),
    ...(git ? [rule('file-read*', 'subpath', templates)] : []),
    rule('file-read* file-map-executable', 'subpath', [...paths, ...SYSTEM_LIBS]),
    rule('process-exec', 'subpath', [checkout, tmp, uvPython]),
    rule('file-write*', 'subpath', [checkout, home, tmp, uvCache, bunCache]),
  ];
  const preflight = RUNTIME_PREFLIGHT[runtime] + (git ? ` && ${GIT_PREFLIGHT}` : '');
  return { runtime, needsGit, setupEnv, preflight, invocation(command, pg) {
    const rules = [...profile];
    if (pg) {
      const canonical = path.join(fs.realpathSync(path.dirname(pg.socket)), path.basename(pg.socket));
      rules.push(rule('file-read-metadata', 'literal', ancestors([canonical])));
      for (const socket of new Set([pg.socket, canonical])) {
        rules.push(`(allow network-outbound (remote unix-socket (path ${JSON.stringify(socket)})))`);
      }
    }
    return { cmd: SANDBOX_EXEC, args: ['-p', rules.join('\n'), SHELL, '-c', command], env: { ...gradeEnv, ...pg?.env } };
  } };
}

