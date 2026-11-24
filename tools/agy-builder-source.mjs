import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const DENIED_COMPONENTS = [
  '[.]git', '[.]gitmodules', '[.]gemini', '[.]agents?', '_agents?', '[.]claude', '[.]codex', '[.]cursor',
  '[.]mcp[.]json', '[.]vscode', '[.]github', '[.]husky', 'hooks', 'hooks[.]json', 'mcp_config[.]json',
  'plugins[.]json', 'agents[.]json', 'agents[.]md', 'claude[.]md', 'gemini[.]md', 'codeowners',
  '[.]worktrees[.]conf', '[.]acs-agy-[^/]*', 'node_modules', 'vendor', '[.]venv', 'venv', '[.]direnv',
  '[.]cache', '[.]ssh', '[.]aws', '[.]gnupg', '[.]config', '[.]kube', '[.]docker', '[.]env[^/]*',
  'dotenv', 'secrets?', 'credentials?', 'secrets?[.][^/]*', 'credentials?[.][^/]*',
  'service[-_]account[^/]*[.]json', '[.]npmrc', '[.]netrc', '[.]pypirc', '[.]gitconfig',
  'id_(rsa|dsa|ecdsa|ed25519)[^/]*', '[^/]+[.](pem|key|p12|pfx|kdbx|keychain-db)', 'antigravity-oauth-token',
];

// Seatbelt path regexes on case-insensitive APFS and the independent publication check must agree.
export const protectedSourcePattern = `(^|/)(${DENIED_COMPONENTS.join('|')})(/|$)`;
const protectedSource = new RegExp(protectedSourcePattern, 'i');
const fileMode = (stat) => Number(stat.mode & 0o777n);
const statAt = (file) => fs.lstatSync(file, { bigint: true, throwIfNoEntry: false });
const identity = (stat) => stat && `${stat.dev}:${stat.ino}`;
const stamp = (stat) => stat && `${identity(stat)}:${stat.mode}:${stat.nlink}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
const inside = (top, file) => file.startsWith(top + '/');
const real = fs.realpathSync.native;
const SAFE_GIT_ENV = {
  PATH: '/usr/bin:/bin', HOME: '/var/empty', LANG: 'en_US.UTF-8', GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: os.devNull, GIT_ATTR_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
};

function git(root, env, args, input) {
  const result = spawnSync('/usr/bin/git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', ...args], {
    cwd: root, env, input: input === undefined ? undefined : Buffer.from(input), stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    encoding: 'buffer', timeout: 15_000, maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error || result.status !== 0 &&
      !(['check-ignore', 'config'].includes(args[0]) && result.status === 1)) {
    throw new Error(`Git ${args[0]} failed for the builder worktree`);
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(result.stdout);
}

function validName(name) {
  if (!name || name.includes('\0') || name.includes('\uFFFD') ||
      name.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('invalid builder source path');
  }
  return name;
}

function regularFile(file, initial = statAt(file)) {
  if (!initial?.isFile() || initial.nlink !== 1n) throw new Error(`unsafe source file: ${file}`);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const check = () => stamp(initial) === stamp(fs.fstatSync(fd, { bigint: true }));
    if (!check()) throw new Error(`source changed while being read: ${file}`);
    const bytes = fs.readFileSync(fd);
    if (!check() || stamp(initial) !== stamp(statAt(file))) throw new Error(`source changed while being read: ${file}`);
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    return { bytes, digest, mode: fileMode(initial), stamp: stamp(initial) };
  } finally {
    fs.closeSync(fd);
  }
}

function writeNew(file, { bytes, mode }) {
  const fd = fs.openSync(file, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, bytes);
    fs.fchmodSync(fd, mode);
  } finally {
    fs.closeSync(fd);
  }
}

function locate(root, home) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || root === '/' || path.normalize(root) !== root ||
      root.includes('\n') || root.startsWith('/System/Volumes/Data/') || real(root) !== root) {
    throw new Error('builder requires an explicit canonical Git worktree root');
  }
  if (root === home || inside(root, home)) throw new Error('builder worktree cannot contain the operator home');
  const rootStat = statAt(root);
  const marker = statAt(path.join(root, '.git'));
  if (!rootStat?.isDirectory() || !(marker?.isDirectory() || marker?.isFile() && marker.nlink === 1n)) {
    throw new Error('builder requires a Git worktree root');
  }
  const response = git(root, SAFE_GIT_ENV, ['rev-parse', '--is-inside-work-tree', '--show-toplevel',
    '--absolute-git-dir', '--path-format=absolute', '--git-common-dir', '--show-object-format']).trimEnd().split('\n');
  const [isTree, top, gitDir, common, objectFormat] = response;
  if (response.length !== 5 || isTree !== 'true' || real(top) !== root || !['sha1', 'sha256'].includes(objectFormat)) {
    throw new Error('Git did not resolve the supplied builder worktree root');
  }
  return { rootStat, gitDir, common, objectFormat };
}

function ignoreFiles(root, home, common) {
  const env = { ...SAFE_GIT_ENV, HOME: home };
  delete env.GIT_CONFIG_GLOBAL;
  const requested = git(root, env, ['config', '--null', '--type=path', '--get', 'core.excludesFile'])
    .replace(/\0$/, '');
  return [
    requested ? path.resolve(root, requested) : path.join(home, '.config', 'git', 'ignore'),
    path.join(common, 'info', 'exclude'),
  ];
}

function readIgnore(file) {
  let resolved;
  try { resolved = real(file); } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
  const stat = statAt(resolved);
  if (!stat?.isFile() || stat.size > 4_194_304n) throw new Error('unsafe Git ignore file for the builder worktree');
  return regularFile(resolved, stat).bytes.toString();
}

function safeGit(root, repo, directory, ignore) {
  const config = repo.objectFormat === 'sha256'
    ? '[core]\nrepositoryformatversion = 1\n[extensions]\nobjectFormat = sha256\n'
    : '[core]\nrepositoryformatversion = 0\n';
  fs.writeFileSync(path.join(directory, 'config'), config);
  fs.writeFileSync(path.join(directory, 'HEAD'), 'ref: refs/heads/builder\n');
  for (const name of ['info', 'refs', 'objects']) fs.mkdirSync(path.join(directory, name));
  // Git looks for a split index's shared parts alongside the selected index.
  for (const name of fs.readdirSync(repo.gitDir)) {
    if (/^sharedindex\.[0-9a-f]+$/.test(name)) fs.symlinkSync(path.join(repo.gitDir, name), path.join(directory, name));
  }
  const excludes = ignore.map(readIgnore);
  fs.writeFileSync(path.join(directory, 'info', 'exclude'), excludes.join('\n'));
  const env = {
    ...SAFE_GIT_ENV, GIT_DIR: directory, GIT_COMMON_DIR: directory, GIT_WORK_TREE: root,
    GIT_INDEX_FILE: path.join(repo.gitDir, 'index'), GIT_OPTIONAL_LOCKS: '0',
  };
  return (args, input) => git(root, env, args, input);
}

function directoryAncestors(name) {
  const parts = name.split('/');
  parts.pop();
  return parts.map((_, index) => parts.slice(0, index + 1).join('/'));
}

function stageFiles(source) {
  const found = new Map();
  function walk(parent) {
    for (const entry of fs.readdirSync(path.join(source, parent))) {
      const name = validName(parent ? `${parent}/${entry}` : entry);
      if (protectedSource.test(name)) throw new Error(`protected builder source path: ${name}`);
      const file = path.join(source, name);
      const stat = statAt(file);
      if (stat?.isDirectory() && real(file) === file) walk(name);
      else {
        const { mode, digest, stamp } = regularFile(file, stat);
        found.set(name, { mode, digest, stamp });
      }
    }
  }
  walk('');
  return found;
}

export function captureAgySource(root, { source, gitState, home }) {
  const repo = locate(root, home);
  const excluded = new Set();
  const names = new Set();
  const original = new Map();
  const dirs = new Map();
  const caseNames = new Map();
  const pinned = new Map();
  const ignore = ignoreFiles(root, home, repo.common);
  for (const file of [path.join(root, '.git'), path.join(repo.gitDir, 'HEAD'), path.join(repo.gitDir, 'index'),
    path.join(repo.gitDir, 'config.worktree'), path.join(repo.common, 'config'), path.join(repo.gitDir, 'commondir'), ...ignore]) {
    const stat = statAt(file);
    pinned.set(file, stat?.isDirectory() ? identity(stat) : stamp(stat));
  }
  const readGit = safeGit(root, repo, gitState, ignore);
  const tracked = readGit(['ls-files', '--stage', '-z']).split('\0').filter(Boolean);
  const untracked = readGit(['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
  for (const entry of tracked) {
    const name = validName(entry.slice(entry.indexOf('\t') + 1));
    if (entry.startsWith('160000 ')) excluded.add(name);
    else names.add(name);
  }
  for (const entry of untracked) {
    if (entry.endsWith('/')) excluded.add(validName(entry.slice(0, -1)));
    else names.add(validName(entry));
  }
  const blocked = (name) => protectedSource.test(name) ||
    [name, ...directoryAncestors(name)].some((parent) => excluded.has(parent));

  function checkRoot(checkGit = true) {
    if (real(root) !== root || identity(statAt(root)) !== identity(repo.rootStat)) {
      throw new Error('builder worktree root changed');
    }
    if (!checkGit) return;
    for (const [file, expected] of pinned) {
      const stat = statAt(file);
      if ((stat?.isDirectory() ? identity(stat) : stamp(stat)) !== expected) {
        throw new Error('Git worktree metadata changed during the build');
      }
    }
  }

  function guardDirectory(parent, capturing = false) {
    const dir = path.join(root, parent);
    const stat = statAt(dir);
    if (stat && (!stat.isDirectory() || real(dir) !== dir || stat.dev !== repo.rootStat.dev)) {
      throw new Error(`unsafe source ancestor: ${parent}`);
    }
    const id = identity(stat);
    if (capturing && !dirs.has(parent)) dirs.set(parent, id);
    if (dirs.get(parent) !== id) throw new Error(`source directory changed: ${parent}`);
    return stat;
  }

  for (const name of names) {
    if (blocked(name)) continue;
    const caseName = name.normalize('NFC').toLowerCase();
    if (caseNames.has(caseName)) throw new Error(`ambiguous builder source path: ${name}`);
    caseNames.set(caseName, name);
    if (directoryAncestors(name).some((parent) => !guardDirectory(parent, true))) continue;
    const file = path.join(root, name);
    const stat = statAt(file);
    if (!stat) continue;
    if (stat.isSymbolicLink()) {
      const target = real(file);
      if (!inside(root, target) || blocked(path.relative(root, target))) {
        throw new Error(`unsafe source link: ${name}`);
      }
      excluded.add(name);
      continue;
    }
    if (real(file) !== file) throw new Error(`noncanonical source path: ${name}`);
    const { bytes, ...state } = regularFile(file, stat);
    const privateFile = path.join(source, name);
    fs.mkdirSync(path.dirname(privateFile), { recursive: true, mode: 0o700 });
    writeNew(privateFile, { bytes, mode: state.mode });
    original.set(name, state);
  }
  checkRoot();
  const sourceId = identity(statAt(source));

  function guardTarget(name, expected = original.get(name), checkGit = true) {
    checkRoot(checkGit);
    for (const parent of directoryAncestors(name)) guardDirectory(parent);
    const candidate = path.join(root, name);
    const stat = statAt(candidate);
    if (stamp(stat) !== expected?.stamp || stat && real(candidate) !== candidate) {
      throw new Error(`source changed during the build: ${name}`);
    }
    return candidate;
  }

  function publish() {
    if (real(source) !== source || identity(statAt(source)) !== sourceId) throw new Error('private source root changed');
    const after = stageFiles(source);
    const changed = [...new Set([...original.keys(), ...after.keys()])].filter((name) => {
      const before = original.get(name);
      const current = after.get(name);
      return before?.digest !== current?.digest || before?.mode !== current?.mode;
    }).sort();
    if (!changed.length) {
      checkRoot();
      return changed;
    }
    const added = [];
    const reportedNames = new Map(caseNames);
    for (const name of changed) {
      const caseName = name.normalize('NFC').toLowerCase();
      if (blocked(name) || reportedNames.has(caseName) && reportedNames.get(caseName) !== name) {
        throw new Error(`protected or ambiguous builder source path: ${name}`);
      }
      reportedNames.set(caseName, name);
      guardTarget(name);
      if (!original.has(name)) added.push(name);
    }
    if (added.length && readGit(['check-ignore', '--no-index', '--stdin', '-z'], added.join('\0') + '\0')) {
      throw new Error('builder attempted to publish ignored source');
    }

    const transaction = fs.mkdtempSync(path.join(root, '.acs-agy-publish-'));
    const createdDirs = [];
    const installed = [];
    const rollback = [];
    try {
      const entries = changed.map((name, index) => {
        const target = guardTarget(name);
        const install = after.get(name) ? path.join(transaction, `new-${index}`) : null;
        const backup = original.has(name) ? path.join(transaction, `old-${index}`) : null;
        if (install) {
          const copied = regularFile(path.join(source, name));
          if (copied.stamp !== after.get(name).stamp) throw new Error(`private source changed: ${name}`);
          writeNew(install, copied);
        }
        if (backup) {
          const saved = regularFile(target);
          if (saved.stamp !== original.get(name).stamp) throw new Error(`source changed during the build: ${name}`);
          writeNew(backup, saved);
        }
        return { name, install, backup };
      });
      for (const { name, install, backup } of entries) {
        checkRoot();
        for (const parent of directoryAncestors(name)) {
          if (guardDirectory(parent)) continue;
          const dir = path.join(root, parent);
          fs.mkdirSync(dir);
          createdDirs.push(parent);
          dirs.set(parent, identity(statAt(dir)));
        }
        const target = guardTarget(name);
        if (!install) fs.unlinkSync(target);
        else if (backup) fs.renameSync(install, target);
        else fs.linkSync(install, target);
        installed.push({ name, backup, expected: { stamp: stamp(statAt(target)) } });
      }
      return changed;
    } catch (error) {
      for (const { name, backup, expected } of installed.reverse()) {
        try {
          const target = guardTarget(name, expected, false);
          if (!backup) fs.unlinkSync(target);
          else if (expected.stamp === undefined) fs.linkSync(backup, target);
          else fs.renameSync(backup, target);
        } catch { rollback.push(name); }
      }
      for (const parent of createdDirs.reverse()) {
        try {
          checkRoot(false);
          guardDirectory(parent);
          fs.rmdirSync(path.join(root, parent));
        } catch { rollback.push(parent); }
      }
      if (rollback.length) throw new Error(`publication interrupted and could not be rolled back: ${rollback.join(', ')}`,
        { cause: error });
      throw error;
    } finally {
      if (!rollback.length) fs.rmSync(transaction, { recursive: true, force: true });
    }
  }

  return { publish };
}
