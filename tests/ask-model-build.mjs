import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const installer = path.join(repo, 'bin', 'model-id.mjs');
const neon = JSON.parse(fs.readFileSync(path.join(repo, 'models.default.json'), 'utf8')).models.neon;
const helperNames = ['agy-builder.mjs', 'agy-builder-source.mjs'];
const diagnostic = 'auth-diagnostic-canary';
const brokerEvent = { origin: 'daily-cloudcode-pa.googleapis.com', method: 'POST', path: '/v1internal:fixture', status: 403, reason: 'request denied' };

function fixture(t) {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'acs-ask-build-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, 'home');
  const root = path.join(base, 'work');
  const stubs = path.join(base, 'stubs');
  for (const dir of [home, root, stubs]) fs.mkdirSync(dir);
  const bin = path.join(stubs, 'agy');
  const vendorCalled = path.join(base, 'vendor-called');
  for (const executable of [bin, path.join(stubs, 'claude'), path.join(stubs, 'codex')]) {
    fs.writeFileSync(executable, `#!/bin/sh\ntouch "${vendorCalled}"\nexit 93\n`, { mode: 0o700 });
  }
  const prompt = path.join(base, 'prompt.txt');
  fs.writeFileSync(prompt, '-literal prompt\n');
  const studio = path.join(home, '.agent-config-studio');
  const resolverBin = path.join(studio, 'resolver', 'bin');
  const env = { HOME: home, PATH: `${stubs}:/usr/bin:/bin`, GIT_CONFIG_NOSYSTEM: '1' };
  const git = spawnSync('/usr/bin/git', ['init', '-q'], { env, cwd: root, encoding: 'utf8' });
  assert.equal(git.status, 0, git.stderr);
  fs.writeFileSync(path.join(root, 'source.txt'), 'original');
  const install = (entry = installer) => spawnSync(process.execPath, [entry, '--install'], { env, encoding: 'utf8' });
  const installed = install();
  assert.equal(installed.status, 0, installed.stderr);
  const launch = path.join(home, '.local', 'bin', 'ask-model');
  const called = path.join(base, 'helper-called');
  const fakeHelper = (kind = 'success') => {
    fs.writeFileSync(path.join(resolverBin, 'agy-builder.mjs'), `
import fs from 'node:fs';
export async function runAgyBuilder(options, ...overrides) {
  const { root, bin, id, effort, prompt, readResult, checkWorkspace, checkConfig, checkToken, checkSignIn, onBrokerAudit } = options;
  const home = ${JSON.stringify(home)};
  const kind = ${JSON.stringify(kind)};
  const log = ${JSON.stringify(path.join(base, 'fake-agy.log'))};
  fs.writeFileSync(log, kind === 'sign-in' ? 'file-based token storage' : 'fixture keychain log');
  fs.writeFileSync(${JSON.stringify(called)}, JSON.stringify({
    root, bin, id, effort, prompt, overrides: overrides.length,
    workspace: checkWorkspace(root), config: checkConfig(home), token: checkToken(home),
    signInFailed: Boolean(checkSignIn(log, home)),
  }));
  fs.unlinkSync(log);
  onBrokerAudit([${JSON.stringify(brokerEvent)}]);
  if (kind === 'sign-in') throw new Error('fixture keychain postflight failed');
  const diagnostic = ${JSON.stringify(diagnostic)};
  const events = [
    { event: 'init', init: { model: kind === 'mismatch' ? 'different-model' : id } },
    { step_update: { step_index: 0, state: 'ERROR', tool_name: 'run_command', tool_info: { error: { message: 'blocked by deny rule' } } } },
    { step_update: { step_index: 1, state: 'ACTIVE', tool_name: 'read_file', tool_info: {
      parameters: { AbsolutePath: '/fixture/other-project.txt', Content: diagnostic },
    } } },
    { step_update: { step_index: 1, state: 'ERROR', tool_info: {
      error: { message: 'Operation not permitted: ' + diagnostic },
    } } },
    { step_update: { step_index: 2, state: 'ERROR', tool_name: 'write_file', tool_info: {
      parameters: { TargetFile: '/fixture/outside.txt', ReplacementContent: diagnostic },
      error: { message: 'approval needed' },
    } } },
    { step_update: { step_index: 3, state: 'ERROR', tool_name: 'read_url', tool_info: {
      parameters: { Url: 'https://user:' + diagnostic + '@example.test/target?token=' + diagnostic + '#' + diagnostic },
      error: { message: 'blocked by deny rule: ' + diagnostic },
    } } },
    ...(!['complete-trace', 'ambiguous-trace', 'invalid-stream', 'unknown-event', 'large-trace'].includes(kind) ? [{ step_update: {
      subagent_info: { subagents: [{ type_name: 'fixture worker', log_uri: 'file:///no-such-fixture/transcript.jsonl' }] },
    } }] : []),
    ...(kind === 'ambiguous-trace' ? [{ step_update: { step_index: 1, state: 'DONE', tool_name: 'read_file' } }] : []),
    ...(kind === 'unknown-event' ? [{ event: 'unclassified_update' }] : []),
    ...(kind === 'complete-trace' ? [
      { step_update: { step_index: 4, state: 'DONE', tool_name: 'write_to_file', tool_info: { parameters: { TargetFile: './source.txt' } } } },
      { step_update: { step_index: 5, state: 'DONE', tool_name: 'finish' } },
    ] : []),
    { event: 'result', result: {
      status: kind === 'bad-status' ? 'ERROR' : 'SUCCESS',
      response: kind === 'bad-status' ? diagnostic : kind === 'empty' ? '' : 'fixture answer',
      denied_actions: [{ action: 'outside read' }],
    } },
  ];
  if (kind === 'large-trace') {
    const result = events.pop();
    for (let step_index = 10; step_index < 100; step_index++) events.push({ step_update: {
      step_index, tool_name: 'read_file', state: 'DONE', tool_info: { parameters: { AbsolutePath: '/fixture/' + 'x'.repeat(1024) } },
    } });
    events.push({ step_update: { step_index: 100, state: 'DONE', tool_name: 'view_file_outline', tool_info: {
      parameters: { AbsolutePath: '/fixture/other-project.txt' },
    } } }, result);
  }
  const got = readResult(id, {
    code: kind === 'nonzero' ? 7 : 0,
    stdout: (kind === 'invalid-stream' ? 'incomplete fixture line\\n' : '') +
      events.map((e) => JSON.stringify(e.step_update ? { event: 'step_update', ...e } : e)).join('\\n'),
    stderr: diagnostic,
  });
  if (got.exit !== undefined) throw new Error(got.error);
  if (kind === 'publication') throw new Error('fixture publication refused');
  return { ...got, mode: 'build', served: { requested: id, id, verified: false }, build: { published: true }, changed: ['source.txt'] };
}
`);
  };
  const ask = (args, { target = root, family = ['--family', 'neon'], json = true, build = true, invoked = launch } = {}) => {
    fs.rmSync(called, { force: true });
    fs.rmSync(vendorCalled, { force: true });
    const flags = [
      ...family, '--prompt-file', prompt, ...(build ? ['--build'] : []),
      ...(target === null ? [] : ['--cwd', target]), ...(json ? ['--json'] : []), ...args,
    ];
    const r = spawnSync(invoked, flags, { env, cwd: root, encoding: 'utf8', timeout: 15_000 });
    assert.ifError(r.error);
    return r;
  };
  const setRoles = (doc) => fs.writeFileSync(path.join(studio, 'roles.json'), JSON.stringify({ version: 1, ...doc }));
  return { ask, home, root, bin, base, launch, resolverBin, install, fakeHelper, called, vendorCalled, setRoles };
}

test('build requires an explicit canonical cwd and rejects other modes, roles and vendors before dispatch', (t) => {
  const f = fixture(t);
  f.fakeHelper();
  const alias = path.join(f.base, 'alias');
  fs.symlinkSync(f.root, alias);
  const cases = [
    [[], { target: null }, /explicit --cwd/],
    [[], { target: alias }, /canonical Git worktree root/],
    [[], { target: path.join(f.base, 'missing') }, /does not exist/],
    [[], { target: path.join(f.root, 'source.txt') }, /is not a directory/],
    [[], { family: ['--role', 'security'] }, /only accepts the builder role/],
    [[], { family: ['--family', 'sol'] }, /uses the agy builder.*codex/],
    [[], { family: ['--family', 'fable'] }, /uses the agy builder.*claude/],
    ...['--investigate', '--no-tools', '--min-tools', '--x-search', '--schema'].map((flag) => [
      flag === '--schema' ? [flag, '/not/read.json'] : [flag], {}, new RegExp(`--build and ${flag}`),
    ]),
  ];
  for (const [args, opts, message] of cases) {
    const r = f.ask(args, opts);
    assert.equal(r.status, 64, r.stderr);
    assert.match(r.stderr, message);
    assert.equal(r.stdout, '');
    assert.ok(!fs.existsSync(f.called));
    assert.ok(!fs.existsSync(f.vendorCalled));
  }
  const help = spawnSync(f.launch, ['--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--build: pinned macOS arm64 agy only/);
});

test('installed build uses the exact callbacks, preferred builder effort and an unverified publication record', (t) => {
  const f = fixture(t);
  f.fakeHelper();
  f.setRoles({
    roles: {
      builder: { use: [{ family: 'neon', effort: 'high' }], effort: 'medium' },
      advisor: { use: 'neon', effort: 'low' },
    },
    flavor: { neon: { effort: 'medium' } },
  });
  const r = f.ask([]);
  assert.equal(r.status, 0, r.stderr);
  const doc = JSON.parse(r.stdout);
  assert.equal(doc.family, 'neon');
  assert.equal(doc.id, neon);
  assert.equal(doc.answer, 'fixture answer');
  assert.equal(doc.effort, 'high');
  assert.equal(doc.error, null);
  assert.equal(doc.mode, 'build');
  assert.deepEqual(doc.served, { requested: neon, id: neon, verified: false });
  assert.deepEqual(doc.build, { published: true });
  assert.deepEqual(doc.changed, ['source.txt']);
  assert.deepEqual(doc.brokerEvents, [brokerEvent]);
  assert.deepEqual(doc.denied, ['run_command: blocked by deny rule', 'read_url: blocked by deny rule', 'outside read: needed an approval print mode cannot give']);
  assert.deepEqual(doc.actions, [
    { tool: 'run_command', state: 'ERROR', refusal: 'deny-rule' },
    { tool: 'read_file', state: 'ERROR', target: '/fixture/other-project.txt', refusal: 'permission-denied' },
    { tool: 'write_file', state: 'ERROR', target: '/fixture/outside.txt', refusal: 'approval-required' },
    { tool: 'read_url', state: 'ERROR', target: 'https://example.test/target', refusal: 'deny-rule' },
  ]);
  assert.equal(doc.actionsComplete, false, 'subagent activity is outside this trace');
  assert.equal(doc.actionsTruncated, false);
  assert.doesNotMatch(r.stderr + r.stdout, new RegExp(diagnostic));
  assert.match(doc.notes[0], /fixture worker/);
  assert.match(r.stderr, /denied run_command: blocked by deny rule/);
  assert.match(r.stderr, /was requested \(unverified\)\./);
  assert.doesNotMatch(r.stderr, /agy\.log/);
  const called = () => JSON.parse(fs.readFileSync(f.called, 'utf8'));
  assert.deepEqual(called(), {
    root: f.root, bin: f.bin, id: neon, effort: 'high', prompt: '\n-literal prompt\n',
    overrides: 0, workspace: [], config: null, token: null, signInFailed: false,
  });
  assert.ok(!fs.existsSync(f.vendorCalled));
  const cases = [
    [[], { family: ['--role', 'builder'] }, 'high'],
    [['--effort-from', 'advisor'], {}, 'low'],
    [['--effort-from', 'advisor', '--effort', 'medium'], {}, 'medium'],
    [['--effort', ''], {}, null],
    [[], { target: '.' }, 'high'],
  ];
  for (const [args, opts, effort] of cases) {
    const r = f.ask(args, opts);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).effort, effort);
    assert.equal(called().effort, effort ?? undefined);
    assert.equal(called().root, f.root);
  }
  f.setRoles({ roles: { builder: { use: 'sol', alt: { family: 'neon', effort: 'xhigh' } } }, flavor: { neon: { effort: 'low' } } });
  assert.equal(JSON.parse(f.ask([]).stdout).effort, 'low');
  assert.equal(JSON.parse(f.ask(['--effort-from', 'builder']).stdout).effort, 'xhigh');
  f.setRoles({});
  assert.equal(JSON.parse(f.ask([]).stdout).effort, null);
  assert.equal(called().effort, undefined);
});

test('build keeps denial evidence and never reports a publication after a bad answer or failed publication', (t) => {
  const f = fixture(t);
  for (const [kind, status, error] of [
    ['mismatch', 2, /different-model/],
    ['empty', 4, /empty answer/],
    ['nonzero', 4, /agy builder failed \(exit 7\)/],
    ['bad-status', 4, /did not report a successful result/],
    ['publication', 4, /publication refused/],
  ]) {
    f.fakeHelper(kind);
    const r = f.ask([]);
    assert.equal(r.status, status, r.stderr);
    const doc = JSON.parse(r.stdout);
    assert.match(doc.error, error);
    assert.equal(doc.answer, null);
    assert.equal(doc.changed, null);
    assert.deepEqual(doc.brokerEvents, [brokerEvent]);
    assert.ok(!Object.hasOwn(doc, 'build'));
    assert.equal(doc.denied.length, 3);
    assert.equal(doc.notes.length, 1);
    assert.equal(doc.actions.length, 4);
    assert.doesNotMatch(r.stderr + r.stdout, new RegExp(diagnostic));
    assert.match(r.stderr, /denied outside read/);
    assert.ok(!fs.existsSync(f.vendorCalled));
    assert.equal(fs.readFileSync(path.join(f.root, 'source.txt'), 'utf8'), 'original');
  }
  f.fakeHelper();
  const plain = f.ask([], { json: false });
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(plain.stdout, 'fixture answer\n');
  f.fakeHelper('sign-in');
  const signIn = f.ask([]);
  assert.equal(signIn.status, 4, signIn.stderr);
  assert.match(JSON.parse(signIn.stdout).error, /keychain postflight failed/);
  assert.ok(!Object.hasOwn(JSON.parse(signIn.stdout), 'build'));
  assert.equal(JSON.parse(fs.readFileSync(f.called, 'utf8')).signInFailed, true);
});

test('the build trace bounds the number of actions and target length', (t) => {
  const f = fixture(t);
  f.fakeHelper('large-trace');
  const r = f.ask([]);
  assert.equal(r.status, 0, r.stderr);
  const { actions, actionsComplete, actionsTruncated } = JSON.parse(r.stdout);
  assert.equal(actions.length, 64);
  assert.equal(actions[1].target, '/fixture/other-project.txt');
  assert.deepEqual(actions.at(-1), { tool: 'read_file', state: 'DONE' });
  assert.equal(actionsComplete, false);
  assert.equal(actionsTruncated, true);
  assert.ok(!actions.some(({ tool }) => tool === 'view_file_outline'));
});

test('build completeness requires a fully parsed stream with unambiguous terminal tool updates', (t) => {
  const f = fixture(t);
  for (const [kind, expected] of [['complete-trace', true], ['ambiguous-trace', false], ['invalid-stream', false], ['unknown-event', false]]) {
    f.fakeHelper(kind);
    const r = f.ask([]);
    assert.equal(r.status, 0, r.stderr);
    const { actions, actionsComplete, actionsTruncated } = JSON.parse(r.stdout);
    assert.equal(actionsComplete, expected, kind);
    assert.equal(actionsTruncated, false, kind);
    if (expected) assert.deepEqual(actions.slice(-2), [
      { tool: 'write_to_file', state: 'DONE', target: './source.txt' },
      { tool: 'finish', state: 'DONE' },
    ]);
  }
});

test('real installed helper refuses unsupported launches before any vendor executable starts', (t) => {
  const f = fixture(t);
  const r = f.ask([]);
  assert.equal(r.status, 4, r.stderr);
  const doc = JSON.parse(r.stdout);
  assert.match(doc.error, process.platform === 'darwin' ? /tested macOS arm64 agy/ : /requires macOS sandbox-exec/);
  assert.equal(doc.answer, null);
  assert.deepEqual(doc.brokerEvents, []);
  assert.ok(!Object.hasOwn(doc, 'build'));
  assert.ok(!fs.existsSync(f.vendorCalled));
  if (process.platform === 'darwin') {
    const subdir = path.join(f.root, 'nested');
    fs.mkdirSync(subdir);
    const sub = f.ask([], { target: subdir });
    assert.equal(sub.status, 4, sub.stderr);
    assert.match(JSON.parse(sub.stdout).error, /requires a Git worktree root/);
    assert.ok(!fs.existsSync(f.vendorCalled));
    const token = path.join(f.home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
    fs.mkdirSync(path.dirname(token), { recursive: true });
    fs.writeFileSync(token, diagnostic);
    const blocked = f.ask([]);
    assert.equal(blocked.status, 4, blocked.stderr);
    assert.match(JSON.parse(blocked.stdout).error, /refused a plaintext token/);
    assert.doesNotMatch(blocked.stderr + blocked.stdout, new RegExp(diagnostic));
    assert.ok(!fs.existsSync(f.vendorCalled));
  }
});

test('model-id installs both helpers and can reinstall from the copy without the checkout', (t) => {
  const f = fixture(t);
  for (const name of helperNames) {
    const installed = path.join(f.resolverBin, name);
    assert.ok(fs.lstatSync(installed).isFile());
    assert.deepEqual(fs.readFileSync(installed), fs.readFileSync(path.join(repo, 'tools', name)));
  }
  fs.unlinkSync(f.launch);
  const reinstall = f.install(path.join(f.resolverBin, 'model-id.mjs'));
  assert.equal(reinstall.status, 0, reinstall.stderr);
  assert.ok(fs.lstatSync(f.launch).isSymbolicLink());
  for (const name of helperNames) {
    assert.deepEqual(fs.readFileSync(path.join(f.resolverBin, name)), fs.readFileSync(path.join(repo, 'tools', name)));
  }
  fs.unlinkSync(path.join(f.resolverBin, 'agy-builder.mjs'));
  const denied = f.ask([]);
  assert.equal(denied.status, 4, denied.stderr);
  assert.match(JSON.parse(denied.stdout).error, /Cannot find module .*agy-builder\.mjs/);
  assert.ok(!fs.existsSync(f.vendorCalled));
  const ro = f.ask([], { family: ['--family', 'fable'], build: false });
  assert.equal(JSON.parse(ro.stdout).mode, 'read-only');
  assert.ok(fs.existsSync(f.vendorCalled));
});

test('an npm launch reminds the user to reinstall when either helper alone is stale', (t) => {
  const f = fixture(t);
  const pkg = path.join(f.base, 'node_modules', 'agent-config-studio');
  const bin = path.join(pkg, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const acs = path.join(bin, 'acs');
  fs.copyFileSync(path.join(repo, 'bin', 'acs'), acs);
  for (const name of ['lib', 'tools', 'models.default.json', 'bin/model-id.mjs', 'bin/agent.mjs', 'bin/agent-install.mjs']) {
    fs.symlinkSync(path.join(repo, name), path.join(pkg, name));
  }
  fs.writeFileSync(path.join(pkg, 'server.js'), '');
  fs.writeFileSync(path.join(bin, 'acs-net.mjs'), "process.exitCode = process.argv[2] === 'wait' ? 0 : 1;\n");
  const start = () => spawnSync(acs, ['--no-open'], {
    env: { HOME: f.home, PATH: '/usr/bin:/bin', ACS_NODE: process.execPath }, encoding: 'utf8', timeout: 15_000,
  });
  const reminder = /installed model-id resolver is older than this package.*acs install-model-id/;
  const clean = start();
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stdout, /npm package/);
  assert.doesNotMatch(clean.stdout, reminder);
  for (const name of helperNames) {
    const installed = path.join(f.resolverBin, name);
    fs.appendFileSync(installed, '// stale copy\n');
    const stale = start();
    assert.equal(stale.status, 0, stale.stderr);
    assert.match(stale.stdout, reminder);
    const reinstall = f.install();
    assert.equal(reinstall.status, 0, reinstall.stderr);
  }
  assert.doesNotMatch(start().stdout, reminder);
});
