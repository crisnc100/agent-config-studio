import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { captureAgySource } from '../tools/agy-builder-source.mjs';

const git = (cwd, ...args) => {
  const result = spawnSync('/usr/bin/git', args, {
    cwd, encoding: 'utf8', env: {
      PATH: '/usr/bin:/bin', HOME: '/var/empty', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull,
      GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.test', GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.test',
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
};

function tempDir(t) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'acs-source-test-')));
  t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
  return dir;
}

function workspace(t) {
  const base = tempDir(t);
  const root = path.join(base, 'work');
  fs.mkdirSync(root);
  git(root, 'init', '-q');
  const home = path.join(base, 'home');
  const source = path.join(base, 'source');
  const gitState = path.join(base, 'git-state');
  for (const dir of [home, source, gitState]) fs.mkdirSync(dir);
  const capture = (top = root) => captureAgySource(top, { source, gitState, home });
  const put = (name, text, folder = root) => {
    const file = path.join(folder, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  const get = (name, folder = root) => fs.readFileSync(path.join(folder, name), 'utf8');
  return { base, root, home, source, capture, put, get };
}

test('stage captures current source on private inodes and publishes only changes', (t) => {
  const { root, home, source, capture, put, get } = workspace(t);
  put('.gitignore', 'ignored.txt\n');
  put('tracked.txt', 'git version');
  put('remove.txt', 'tracked remove');
  put('keep.txt', 'tracked untouched');
  put('.env.testing', 'private canary');
  put('Node_Modules/pkg/index.js', 'runtime canary');
  put('AGENTS.md', 'policy canary');
  git(root, 'add', '.');
  put('tracked.txt', 'operator version');
  put('new.txt', 'operator untracked');
  put('ignored.txt', 'private canary');
  put('global-ignore.txt', 'another private canary');
  put('.config/git/ignore', 'global-ignore.txt\n', home);
  fs.symlinkSync('tracked.txt', path.join(root, 'internal-link'));

  const { publish } = capture();
  assert.deepEqual(fs.readdirSync(source).sort(), ['.gitignore', 'keep.txt', 'new.txt', 'remove.txt', 'tracked.txt']);
  assert.equal(get('tracked.txt', source), 'operator version');
  const tracked = path.join(root, 'tracked.txt');
  const untouched = path.join(root, 'keep.txt');
  const before = fs.statSync(tracked).ino;
  const keep = fs.statSync(untouched);
  assert.notEqual(fs.statSync(path.join(source, 'tracked.txt')).ino, before);

  put('tracked.txt', 'model version', source);
  put('folder/leaf.txt', 'model addition', source);
  fs.unlinkSync(path.join(source, 'remove.txt'));
  put('keep.txt', 'concurrent operator edit');
  assert.deepEqual(publish(), ['folder/leaf.txt', 'remove.txt', 'tracked.txt']);
  assert.equal(get('tracked.txt'), 'model version');
  assert.notEqual(fs.statSync(tracked).ino, before);
  assert.equal(get('folder/leaf.txt'), 'model addition');
  assert.equal(get('new.txt'), 'operator untracked');
  assert.equal(get('keep.txt'), 'concurrent operator edit');
  assert.equal(fs.statSync(untouched).ino, keep.ino);
  assert.equal(get('.env.testing'), 'private canary');
  assert.equal(get('ignored.txt'), 'private canary');
  assert.equal(get('AGENTS.md'), 'policy canary');
  assert.equal(fs.existsSync(path.join(root, 'remove.txt')), false);
});

test('linked worktrees resolve independently of ambient routing and fsmonitor config', (t) => {
  const { base, root, source, capture, put, get } = workspace(t);
  put('tracked.txt', 'before branch');
  git(root, 'add', 'tracked.txt');
  git(root, 'commit', '-qm', 'fixture');
  const linked = path.join(base, 'linked');
  git(root, 'worktree', 'add', '-q', '-b', 'fixture-linked', linked);
  const marker = path.join(base, 'fsmonitor-ran');
  const monitor = path.join(base, 'monitor');
  fs.writeFileSync(monitor, `#!/bin/sh\n/usr/bin/touch "${marker}"\n`, { mode: 0o755 });
  git(root, 'config', 'core.fsmonitor', monitor);
  const old = process.env.GIT_WORK_TREE;
  process.env.GIT_WORK_TREE = root;
  try {
    put('tracked.txt', 'linked edit', linked);
    const { publish } = capture(linked);
    assert.equal(get('tracked.txt', source), 'linked edit');
    put('tracked.txt', 'staged edit', source);
    assert.deepEqual(publish(), ['tracked.txt']);
  } finally {
    if (old === undefined) delete process.env.GIT_WORK_TREE;
    else process.env.GIT_WORK_TREE = old;
  }
  assert.equal(get('tracked.txt', linked), 'staged edit');
  assert.equal(get('tracked.txt'), 'before branch');
  assert.equal(fs.existsSync(marker), false);
});

test('capture refuses non-root workspaces, symlink aliases and Git redirects', (t) => {
  const { base, root, capture } = workspace(t);
  const sub = path.join(root, 'sub');
  const alias = path.join(base, 'alias');
  fs.mkdirSync(sub);
  fs.symlinkSync(root, alias);
  assert.throws(() => capture(sub), /requires a Git worktree root/);
  assert.throws(() => capture(alias), /canonical Git worktree root/);
  assert.throws(() => capture(''), /canonical Git worktree root/);
  git(root, 'config', 'core.worktree', sub);
  assert.throws(() => capture(), /did not resolve/);
});

test('capture refuses an approved escaping link, shared hardlink and special file', (t) => {
  const { base, root, capture, put } = workspace(t);
  put('outside.txt', 'outside fixture', base);
  const outside = path.join(base, 'outside.txt');
  const candidate = path.join(root, 'candidate');
  fs.symlinkSync(outside, candidate);
  assert.throws(() => capture(), /unsafe source link/);
  fs.unlinkSync(candidate);
  // At this point capture has already created its own Git state. Use another fixture per attempt.
  const hard = workspace(t);
  fs.linkSync(outside, path.join(hard.root, 'candidate'));
  assert.throws(() => hard.capture(), /unsafe source file/);
  const special = workspace(t);
  const fifo = path.join(special.root, 'fifo');
  assert.equal(spawnSync('/usr/bin/mkfifo', [fifo]).status, 0);
  // Git omits untracked FIFOs. A tracked path swapped to a FIFO must still fail.
  special.put('tracked.txt', 'file');
  git(special.root, 'add', 'tracked.txt');
  fs.renameSync(fifo, path.join(special.root, 'tracked.txt'));
  assert.throws(() => special.capture(), /unsafe source file/);
});

test('publication prevalidates protected, ignored and linked candidates before any edit', (t) => {
  for (const kind of ['protected', 'ignored', 'symlink', 'hardlink', 'nested repository']) {
    const { base, root, source, capture, put, get } = workspace(t);
    put('early.txt', 'operator');
    put('.gitignore', 'ignored.txt\n');
    if (kind === 'nested repository') {
      const nested = path.join(root, 'nested');
      fs.mkdirSync(nested);
      git(nested, 'init', '-q');
      put('tracked.txt', 'nested operator', nested);
      git(nested, 'add', 'tracked.txt');
      git(nested, 'commit', '-qm', 'fixture');
      git(root, 'add', 'nested');
    }
    const { publish } = capture();
    put('early.txt', 'model', source);
    const newFile = path.join(source, 'linked');
    const other = path.join(base, 'outside');
    fs.writeFileSync(other, 'outside fixture');
    if (kind === 'protected') put('secrets.json', 'fixture', source);
    if (kind === 'ignored') put('ignored.txt', 'fixture', source);
    if (kind === 'symlink') fs.symlinkSync(other, newFile);
    if (kind === 'hardlink') fs.linkSync(other, newFile);
    if (kind === 'nested repository') put('nested/extra.txt', 'fixture', source);
    assert.throws(publish, /protected|attempted to publish ignored|unsafe source file/, kind);
    assert.equal(get('early.txt'), 'operator', kind);
  }
});

test('publication refuses changed targets, swapped ancestors and changed Git metadata', (t) => {
  for (const kind of ['concurrent file', 'ancestor', 'hardlink', 'new file', 'git index']) {
    const { base, root, source, capture, put, get } = workspace(t);
    put('early.txt', 'operator');
    put('folder/leaf.txt', 'operator');
    git(root, 'add', '.');
    const { publish } = capture();
    put('early.txt', 'model', source);
    put('folder/leaf.txt', 'model', source);
    if (kind === 'concurrent file') put('folder/leaf.txt', 'concurrent operator edit');
    if (kind === 'ancestor') {
      fs.renameSync(path.join(root, 'folder'), path.join(base, 'moved'));
      fs.symlinkSync(path.join(base, 'moved'), path.join(root, 'folder'));
    }
    if (kind === 'hardlink') fs.linkSync(path.join(root, 'folder', 'leaf.txt'), path.join(base, 'outside'));
    if (kind === 'new file') {
      put('folder/new.txt', 'model', source);
      put('folder/new.txt', 'concurrent operator edit');
    }
    if (kind === 'git index') {
      put('operator.txt', 'concurrent index change');
      git(root, 'add', 'operator.txt');
    }
    assert.throws(publish, /changed|unsafe source ancestor/, kind);
    assert.equal(get('early.txt'), 'operator', kind);
  }
});

test('publication rolls back earlier changes when a later replacement fails', (t) => {
  const { root, source, capture, put, get } = workspace(t);
  put('a.txt', 'before a');
  put('b.txt', 'before b');
  const { publish } = capture();
  put('a.txt', 'after a', source);
  put('b.txt', 'after b', source);
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (a, b) => {
    if (path.basename(a) === 'new-1' && b === path.join(root, 'b.txt')) throw new Error('injected publish failure');
    return rename(a, b);
  });
  assert.throws(publish, /injected publish failure/);
  assert.equal(get('a.txt'), 'before a');
  assert.equal(get('b.txt'), 'before b');
  assert.equal(fs.readdirSync(root).some((entry) => entry.startsWith('.acs-agy-')), false);
});

test('publication accepts additions in eligible directories without captured files', (t) => {
  const { root, source, capture, put, get } = workspace(t);
  put('.gitignore', '*.local\nignored/\n');
  put('only-excluded/secret.local', 'operator canary');
  put('only-excluded/.env', 'protected canary');
  put('ignored/secret.local', 'ignored canary');
  fs.mkdirSync(path.join(root, 'empty', 'nested'), { recursive: true });

  const { publish } = capture();
  put('empty/nested/new.txt', 'new under empty directory', source);
  put('only-excluded/new.txt', 'new alongside excluded paths', source);
  assert.deepEqual(publish(), ['empty/nested/new.txt', 'only-excluded/new.txt']);
  assert.equal(get('empty/nested/new.txt'), 'new under empty directory');
  assert.equal(get('only-excluded/new.txt'), 'new alongside excluded paths');
  assert.equal(get('only-excluded/secret.local'), 'operator canary');
  assert.equal(get('only-excluded/.env'), 'protected canary');
  assert.deepEqual(fs.readdirSync(path.join(source, 'only-excluded')), ['new.txt']);
  assert.equal(fs.existsSync(path.join(source, 'ignored')), false);
});

test('publication refuses a new file after its previously empty parent is replaced', (t) => {
  const { base, root, source, capture, put } = workspace(t);
  fs.mkdirSync(path.join(root, 'empty'));
  const { publish } = capture();
  put('empty/new.txt', 'must be discarded', source);
  fs.renameSync(path.join(root, 'empty'), path.join(base, 'moved'));
  fs.mkdirSync(path.join(root, 'empty'));
  assert.throws(publish, /source directory changed: empty/);
  assert.equal(fs.existsSync(path.join(root, 'empty/new.txt')), false);
});
