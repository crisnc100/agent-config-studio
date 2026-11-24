import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess, { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import { agyBuildEnv, runAgyBuilder } from '../tools/agy-builder.mjs';

function setup(t) {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'acs-builder-test-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'root');
  const home = path.join(base, 'home');
  for (const dir of [root, home]) fs.mkdirSync(dir);
  const git = spawnSync('/usr/bin/git', ['init', '-q'], {
    cwd: root, env: { PATH: '/usr/bin:/bin', HOME: home, GIT_CONFIG_NOSYSTEM: '1' },
  });
  assert.equal(git.status, 0);
  fs.writeFileSync(path.join(root, 'file.txt'), 'operator');
  const opts = {
    root, home, bin: '/invalid/fake/agy', id: 'fixture-model', effort: 'high', prompt: '/as literal text',
    checkWorkspace: () => [], checkConfig: () => null, checkToken: () => null, checkSignIn: () => null,
    readResult: (id, reply) => ({ answer: reply.stdout, served: { requested: id } }),
  };
  let callRoot;
  let stopped = 0;
  const prepare = async (layout, bin, actualHome) => {
    callRoot = path.dirname(layout.source);
    assert.ok(callRoot.startsWith('/private/tmp/'));
    assert.equal(actualHome, home);
    assert.equal(bin, opts.bin);
    const broker = {
      port: 42402,
      certificate: path.join(layout.ca, 'root.pem'),
      url: 'http://fixture:fixture-secret@127.0.0.1:42402',
      close() { stopped++; },
    };
    const params = { ...layout, home, bin, certificate: broker.certificate, port: broker.port };
    return { params, broker, env: agyBuildEnv({ home: layout.privateHome, runtime: layout.runtime, broker }) };
  };
  return {
    opts, prepare, root, home, original: () => fs.readFileSync(path.join(root, 'file.txt'), 'utf8'),
    removed: () => callRoot && !fs.existsSync(callRoot) && stopped === 1,
  };
}

test('builder supplies only walled edit permissions and publishes a labeled answer', async (t) => {
  const { opts, home, original, prepare, removed } = setup(t);
  const events = [];
  opts.checkConfig = (dir) => { events.push('config'); assert.equal(dir, home); };
  opts.checkWorkspace = (dir) => { events.push('workspace'); assert.equal(dir, opts.root); return []; };
  opts.checkToken = (dir) => { events.push(dir === home ? 'real token' : 'private token'); };
  opts.checkSignIn = (logFile, dir) => {
    events.push('sign-in');
    assert.equal(path.join(path.dirname(dir), 'agy.log'), logFile);
    assert.equal(original(), 'operator');
  };
  const result = await runAgyBuilder(opts, { prepare, invoke(args, source, env) {
    events.push('invoke');
    assert.equal(args[args.indexOf('-p') + 1].includes('(deny default)'), true);
    const command = args.slice(args.indexOf('-p') + 2);
    const arg = (flag) => command[command.indexOf(flag) + 1];
    assert.equal(command[0], opts.bin);
    assert.equal(arg('-p'), '/as literal text');
    assert.equal(arg('--model'), opts.id);
    assert.equal(arg('--effort'), 'high');
    assert.ok(command.includes('--disable-slash-commands'));
    assert.ok(!command.includes('--dangerously-skip-permissions'));
    const { permissions } = JSON.parse(arg('--settings'));
    assert.deepEqual(permissions.allow, [`read_file(${source})`, `write_file(${source})`]);
    for (const rule of ['command(*)', 'mcp(*)', 'read_url(*)', 'download_url(*)', 'execute_url(*)',
      `write_file(${path.dirname(env.HOME)})`, `write_file(${home}/Library/Keychains)`]) assert.ok(permissions.deny.includes(rule));
    assert.equal(env.AGY_CLI_DISABLE_AUTO_UPDATE, 'true');
    assert.notEqual(env.HOME, home);
    for (const name of ['GIT_DIR', 'GIT_CONFIG_COUNT', 'HTTP_PROXY_AUTH', 'SSH_AUTH_SOCK', 'NODE_OPTIONS', 'DYLD_INSERT_LIBRARIES',
      'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_API_KEY', 'NO_PROXY']) assert.ok(!(name in env));
    assert.equal(fs.readFileSync(path.join(source, 'file.txt'), 'utf8'), 'operator');
    fs.writeFileSync(arg('--log-file'), 'fixture log');
    fs.writeFileSync(path.join(source, 'file.txt'), 'model edit');
    return { code: 0, signal: null, stdout: 'answer fixture-secret' };
  } });
  assert.deepEqual(events, ['config', 'real token', 'workspace', 'private token', 'real token', 'invoke',
    'real token', 'private token', 'sign-in']);
  assert.deepEqual(result, { answer: 'answer [broker credential]', mode: 'build',
    served: { requested: opts.id, id: opts.id, verified: false }, build: { published: true }, changed: ['file.txt'] });
  assert.equal(original(), 'model edit');
  assert.ok(removed());
});

test('builder discards staged edits after runtime, sign-in or answer failure', async (t) => {
  for (const kind of ['runtime', 'sign-in', 'real plaintext', 'private plaintext', 'log link', 'answer', 'different model', 'spawn']) {
    const { opts, prepare, original, home, removed } = setup(t);
    let invoked = false;
    if (kind === 'sign-in') opts.checkSignIn = () => 'log fixture error';
    if (kind === 'real plaintext') opts.checkToken = (dir) => invoked && dir === home;
    if (kind === 'private plaintext') opts.checkToken = (dir) => invoked && dir !== home;
    if (kind === 'answer') opts.readResult = () => ({ exit: 4, error: 'failed model' });
    if (kind === 'different model') opts.readResult = () => ({ answer: 'wrong model', served: { requested: 'other' } });
    await assert.rejects(runAgyBuilder(opts, { prepare, invoke(_args, source) {
      invoked = true;
      const logPath = path.join(path.dirname(source), 'runtime', 'agy.log');
      if (kind === 'log link') fs.symlinkSync(path.join(opts.root, 'file.txt'), logPath);
      else fs.writeFileSync(logPath, 'fixture log');
      fs.writeFileSync(path.join(source, 'file.txt'), 'must discard');
      if (kind === 'spawn') throw new Error('spawn fixture failed');
      return { code: kind === 'runtime' ? 1 : 0, stdout: 'fixture' };
    } }), /failed|valid answer/, kind);
    assert.ok(invoked, kind);
    assert.equal(original(), 'operator', kind);
    assert.ok(removed(), kind);
  }
});

test('builder refuses configuration, unsafe roots, token leftovers and wrong binaries before invocation', async (t) => {
  for (const kind of ['config', 'workspace', 'root', 'token', 'binary']) {
    const { opts, original } = setup(t);
    let prepared = false;
    const prepare = async () => { prepared = true; throw new Error('unexpected launch'); };
    const invoke = () => assert.fail('unexpected model invocation');
    if (kind === 'config') opts.checkConfig = () => 'fixture configured hook';
    if (kind === 'workspace') opts.checkWorkspace = () => ['fixture hooks'];
    if (kind === 'root') opts.root = path.dirname(opts.root);
    if (kind === 'token') opts.checkToken = () => ({});
    if (kind === 'binary') {
      opts.bin = path.join(opts.home, 'agy');
      fs.writeFileSync(opts.bin, '#!/bin/sh\nprintf 1.5.14', { mode: 0o700 });
    }
    await assert.rejects(runAgyBuilder(opts, { prepare: kind === 'binary' ? undefined : prepare, invoke }),
      /configured hook|customization|operator home|plaintext token|tested macOS arm64/, kind);
    assert.ok(!prepared, kind);
    assert.equal(original(), 'operator', kind);
  }
});


test('cancellation between clean child exit and stream close discards the build', async (t) => {
  for (const cancellation of ['SIGINT', 'SIGTERM', 'SIGHUP', 'timeout', null]) {
    await t.test(cancellation ?? 'ordinary close', async (t) => {
      const { opts, prepare, original, removed } = setup(t);
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const spawn = t.mock.method(childProcess, 'spawn', (_bin, _args, { cwd: source }) => {
        fs.writeFileSync(path.join(path.dirname(source), 'runtime', 'agy.log'), 'fixture log');
        fs.writeFileSync(path.join(source, 'file.txt'), 'model edit');
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        queueMicrotask(() => {
          child.emit('exit', 0, null);
          if (cancellation === 'timeout') t.mock.timers.tick(1_815_000);
          else if (cancellation) process.emit(cancellation, cancellation);
          child.stdout.emit('data', Buffer.from('valid answer'));
          child.emit('close', 0, null);
        });
        return child;
      });
      syncBuiltinESMExports();
      try {
        const call = runAgyBuilder(opts, { prepare });
        if (cancellation) {
          await assert.rejects(call, /agy builder invocation cancelled/);
          assert.equal(original(), 'operator');
        } else {
          const result = await call;
          assert.deepEqual(result.changed, ['file.txt']);
          assert.equal(original(), 'model edit');
        }
        assert.ok(removed());
        assert.equal(spawn.mock.callCount(), 1);
      } finally {
        spawn.mock.restore();
        syncBuiltinESMExports();
      }
    });
  }
});
