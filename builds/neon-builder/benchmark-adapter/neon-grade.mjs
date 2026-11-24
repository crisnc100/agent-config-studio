import fs from 'node:fs';
import path from 'node:path';

const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
const SHELL = '/bin/sh';
const SYSTEM_TOOLS = [SHELL, '/bin/bash', '/bin/cat', '/bin/mkdir', '/bin/rm', '/usr/bin/env'];
const SYSTEM_LIBS = ['/usr/lib', '/System/Library/dyld', '/System/Library/Frameworks', '/System/Library/PrivateFrameworks'];
const SYSTEM_DATA = ['/', '/dev/null', '/dev/urandom', '/dev/random', '/private/var/select/sh',
  '/System/Library/CoreServices/SystemVersion.plist', '/System/Library/OpenSSL/openssl.cnf'];
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

function ancestors(files) {
  const dirs = new Set();
  for (const file of files) {
    for (let dir = path.dirname(file); !dirs.has(dir); dir = path.dirname(dir)) dirs.add(dir);
  }
  return [...dirs];
}

const filter = (kind, files) => files.map((file) => `(${kind} ${JSON.stringify(file)})`).join(' ');
const rule = (operations, kind, files) => `(allow ${operations} ${filter(kind, files)})`;

export function prepareNeonGrade(testCommand, dirs) {
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
  const executable = findRuntime(runtime);
  fs.symlinkSync(executable, path.join(bin, runtime));

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
  const launchers = [...SYSTEM_TOOLS, executable];
  const profile = [
    ...SANDBOX_RULES,
    rule('file-read-metadata', 'literal', ancestors([...paths, ...launchers, ...SYSTEM_DATA])),
    rule('file-read*', 'literal', SYSTEM_DATA),
    rule('file-read* file-map-executable', 'literal', launchers),
    rule('process-exec', 'literal', [...SYSTEM_TOOLS, executable]),
    rule('file-read* file-map-executable', 'subpath', [...paths, ...SYSTEM_LIBS]),
    rule('process-exec', 'subpath', [checkout, tmp, uvPython]),
    rule('file-write*', 'subpath', [checkout, home, tmp, uvCache, bunCache]),
  ];
  return { runtime, setupEnv, invocation(command, pg) {
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

