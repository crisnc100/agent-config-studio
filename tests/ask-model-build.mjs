import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const installer = path.join(repo, 'bin', 'model-id.mjs');
const neon = JSON.parse(fs.readFileSync(path.join(repo, 'models.default.json'), 'utf8')).models.neon;
const helperNames = ['agy-builder.mjs', 'agy-builder-source.mjs'];
const diagnostic = 'auth-diagnostic-canary';


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
  const sessionTmp = path.join(base, 'session-tmp');
  fs.mkdirSync(sessionTmp);
  const env = { HOME: home, PATH: `${stubs}:/usr/bin:/bin`, TMPDIR: sessionTmp, GIT_CONFIG_NOSYSTEM: '1' };
  const git = spawnSync('/usr/bin/git', ['init', '-q'], { env, cwd: root, encoding: 'utf8' });
  assert.equal(git.status, 0, git.stderr);
  fs.writeFileSync(path.join(root, 'source.txt'), 'original');
  const install = (entry = installer) => spawnSync(process.execPath, [entry, '--install'], { env, encoding: 'utf8' });
  const installed = install();
  assert.equal(installed.status, 0, installed.stderr);
  const launch = path.join(home, '.local', 'bin', 'ask-model');
  const called = path.join(base, 'agy-called');
  const versionCalled = path.join(base, 'agy-version-called');
  const ready = path.join(base, 'agy-ready');
  const token = path.join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
  const fakeAgy = (kind = 'success') => {
    fs.writeFileSync(bin, `#!${process.execPath}
${`
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const kind = ${JSON.stringify(kind)};
const diagnostic = ${JSON.stringify(diagnostic)};
const token = ${JSON.stringify(token)};
const writeToken = () => {
  fs.mkdirSync(path.dirname(token), { recursive: true });
  fs.writeFileSync(token, diagnostic);
};
const argv = process.argv.slice(2);
const value = (flag) => argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined;
if (argv[0] === '--version') {
  fs.writeFileSync(${JSON.stringify(versionCalled)}, process.cwd());
  if (kind === 'version-token') writeToken();
  console.log(kind === 'wrong-version' ? diagnostic : '1.5.14');
  process.exit(0);
}
const log = value('--log-file');
const call = {
  argv, cwd: process.cwd(), home: process.env.HOME, tmp: process.env.TMPDIR,
  update: process.env.AGY_CLI_DISABLE_AUTO_UPDATE, hooks: process.env.CMUX_ANTIGRAVITY_HOOKS_DISABLED,
  logMode: fs.statSync(path.dirname(log)).mode & 0o777,
  nativeConfigPresent: fs.existsSync(path.join(process.env.HOME, '.gemini/config/plugins.json')),
};
fs.writeFileSync(${JSON.stringify(called)}, JSON.stringify(call));
if (kind === 'symlink-log') fs.symlinkSync(${JSON.stringify(prompt)}, log);
else if (kind === 'directory-log') fs.mkdirSync(log);
else if (kind === 'fifo-log') {
  if (spawnSync('/usr/bin/mkfifo', [log]).status) process.exit(88);
} else if (kind !== 'missing-log') {
  fs.writeFileSync(log, ['sign-in', 'nonzero-sign-in', 'cancel-sign-in'].includes(kind) ?
    'file-based token storage ' + diagnostic : 'fixture keychain log ' + diagnostic);
  if (kind === 'unreadable-log') fs.chmodSync(log, 0);
}
if (kind === 'left-token') writeToken();
fs.writeFileSync('source.txt', 'native fixture edit');
const id = value('--model');
// Kinds not listed stream a clean build: one edit and no refusal.
const refused = ['denied', 'mismatch', 'empty', 'nonzero', 'bad-status', 'large-trace', 'complete-trace', 'ambiguous-trace', 'invalid-stream', 'unknown-event'].includes(kind);
  const events = [
    { event: 'init', init: { model: kind === 'mismatch' ? 'different-model' : id } },
    ...(!refused ? [
      { step_update: { step_index: 0, state: 'ACTIVE', tool_name: 'write_to_file', tool_info: {
        parameters: { TargetFile: './source.txt', CodeContent: diagnostic },
      } } },
      { step_update: { step_index: 0, state: 'DONE', tool_name: 'write_to_file' } },
    ] : [
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
    ]),
    ...(['denied', 'mismatch', 'empty', 'nonzero', 'bad-status', 'subagent'].includes(kind) ? [{ step_update: {
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
      ...(refused ? { denied_actions: [{ action: 'outside read' }] } : {}),
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
const emit = () => {
  console.log((kind === 'invalid-stream' ? 'incomplete fixture line\\n' : '') +
    events.map((e) => JSON.stringify(e.step_update ? { event: 'step_update', ...e } : e)).join('\\n'));
  console.error(diagnostic);
  process.exitCode = ['nonzero', 'nonzero-sign-in'].includes(kind) ? 7 : 0;
};
if (kind === 'cancel-sign-in' || kind === 'cancel') {
  const wait = setInterval(() => {}, 1000);
  process.on('SIGTERM', () => {
    clearInterval(wait);
    fs.appendFileSync('source.txt', ' after SIGTERM');
    emit();
  });
  fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
} else emit();
`}`, { mode: 0o700 });
  };
  const askFlags = (args, { target = root, family = ['--family', 'neon'], json = true, build = true } = {}) => [
    ...family, '--prompt-file', prompt, ...(build ? ['--build'] : []),
    ...(target === null ? [] : ['--cwd', target]), ...(json ? ['--json'] : []), ...args,
  ];
  const ask = (args, { invoked = launch, ...options } = {}) => {
    for (const file of [called, versionCalled, vendorCalled]) fs.rmSync(file, { force: true });
    const r = spawnSync(invoked, askFlags(args, options), { env, cwd: root, encoding: 'utf8', timeout: 15_000 });
    assert.ifError(r.error);
    return r;
  };
  const setRoles = (doc) => fs.writeFileSync(path.join(studio, 'roles.json'), JSON.stringify({ version: 1, ...doc }));
  const call = () => JSON.parse(fs.readFileSync(called, 'utf8'));
  const askAsync = () => spawn(launch, askFlags([]), { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  return { ask, askAsync, home, root, base, launch, resolverBin, install, fakeAgy, called, call, versionCalled,
    ready, token, sessionTmp, vendorCalled, setRoles };
}

test('build requires an explicit canonical cwd and rejects other modes, roles and vendors before dispatch', (t) => {
  const f = fixture(t);
  f.fakeAgy();
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
    assert.ok(!fs.existsSync(f.versionCalled));
    assert.ok(!fs.existsSync(f.vendorCalled));
  }
  const help = spawnSync(f.launch, ['--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--build: uses the tested agy version with normal Antigravity permissions/);
});

test('installed build makes a native edit using the exact argv, preferred builder effort and an unverified model record', (t) => {
  const f = fixture(t);
  f.fakeAgy();
  fs.mkdirSync(path.join(f.home, '.gemini/config'), { recursive: true });
  fs.writeFileSync(path.join(f.home, '.gemini/config/plugins.json'), '{}');
  fs.mkdirSync(path.join(f.root, '.agents'));
  fs.writeFileSync(path.join(f.root, '.agents/hooks.json'), '{}');
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
  assert.equal(doc.build.execution, 'native');
  assert.equal(doc.build.completed, true);
  assert.ok(!Object.hasOwn(doc.build, 'published'));
  assert.ok(!Object.hasOwn(doc, 'brokerEvents'));
  assert.ok(!Object.hasOwn(doc, 'logFile'));
  assert.equal(doc.changed, null);
  assert.equal(fs.readFileSync(path.join(f.root, 'source.txt'), 'utf8'), 'native fixture edit');
  assert.ok(!Object.hasOwn(doc, 'denied'));
  assert.ok(!Object.hasOwn(doc, 'notes'));
  assert.deepEqual(doc.actions, [{ tool: 'write_to_file', state: 'DONE', target: './source.txt' }]);
  assert.equal(doc.actionsComplete, true);
  assert.equal(doc.actionsTruncated, false);
  assert.doesNotMatch(r.stderr + r.stdout, new RegExp(diagnostic));
  assert.doesNotMatch(r.stderr, /ask-model: agy: denied/);
  assert.match(r.stderr, /was requested \(unverified\)\./);
  assert.doesNotMatch(r.stderr, /agy\.log/);
  const { argv, ...call } = f.call();
  const log = argv.at(-1);
  assert.equal(path.basename(log), 'agy.log');
  assert.equal(path.dirname(path.dirname(log)), f.sessionTmp);
  assert.ok(!fs.existsSync(path.dirname(log)));
  assert.deepEqual(call, {
    cwd: f.root, home: f.home, tmp: f.sessionTmp, update: 'true', hooks: '1', logMode: 0o700, nativeConfigPresent: true,
  });
  const versionCwd = fs.readFileSync(f.versionCalled, 'utf8');
  assert.notEqual(versionCwd, f.root);
  assert.ok(!fs.existsSync(versionCwd));
  assert.deepEqual(argv, [
    '-p', argv[1], '--model', neon, '--effort', 'high', '--output-format', 'stream-json',
    '--print-timeout', '1800s', '--disable-slash-commands', '--mode', 'accept-edits', '--log-file', log,
  ]);
  assert.match(argv[1], /^You are the implementer/);
  assert.match(argv[1], /Do not invoke other models, delegate, or run reviews or grades/);
  assert.match(argv[1], /Do not push, open a pull request, or merge/);
  assert.ok(argv[1].endsWith('\n-literal prompt\n'));
  const calledFlag = (flag) => {
    const { argv } = f.call();
    return argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined;
  };
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
    assert.equal(calledFlag('--effort'), effort ?? undefined);
    assert.equal(f.call().cwd, f.root);
  }
  f.setRoles({ roles: { builder: { use: 'sol', alt: { family: 'neon', effort: 'xhigh' } } }, flavor: { neon: { effort: 'low' } } });
  assert.equal(JSON.parse(f.ask([]).stdout).effort, 'low');
  assert.equal(JSON.parse(f.ask(['--effort-from', 'builder']).stdout).effort, 'xhigh');
  f.setRoles({});
  assert.equal(JSON.parse(f.ask([]).stdout).effort, null);
  assert.equal(calledFlag('--effort'), undefined);
  f.fakeAgy('subagent');
  const sub = f.ask([]);
  assert.equal(sub.status, 0, sub.stderr);
  const subDoc = JSON.parse(sub.stdout);
  assert.deepEqual(subDoc.build, { execution: 'native', completed: true });
  assert.equal(subDoc.answer, 'fixture answer');
  assert.deepEqual(subDoc.notes, ['neon tried to start a subagent (fixture worker); its denied calls are unknown']);
  assert.ok(!Object.hasOwn(subDoc, 'denied'));
  assert.equal(subDoc.actionsComplete, false, 'subagent activity is outside this trace');
  assert.match(sub.stderr, /ask-model: agy: neon tried to start a subagent \(fixture worker\)/);
});

test('build keeps denial evidence and omits completion after unsuccessful model output', (t) => {
  const f = fixture(t);
  for (const [kind, status, error] of [
    ['denied', 4, /^agy refused 5 of the builder's action\(s\), so the build is not complete\. Inspect the worktree/],
    ['mismatch', 2, /different-model/],
    ['empty', 4, /empty answer/],
    ['nonzero', 4, /agy builder failed \(exit 7\)/],
    ['bad-status', 4, /did not report a successful result/],
  ]) {
    f.fakeAgy(kind);
    const r = f.ask([]);
    assert.equal(r.status, status, r.stderr);
    const doc = JSON.parse(r.stdout);
    assert.match(doc.error, error);
    assert.equal(doc.answer, null);
    assert.equal(doc.changed, null);
    assert.ok(!Object.hasOwn(doc, 'brokerEvents'));
    assert.ok(!Object.hasOwn(doc, 'build'));
    assert.deepEqual(doc.denied, [
      'run_command: blocked by deny rule', 'read_file: permission denied', 'write_file: needed an approval',
      'read_url: blocked by deny rule', 'outside read: needed an approval print mode cannot give',
    ], kind);
    assert.deepEqual(doc.notes, ['neon tried to start a subagent (fixture worker); its denied calls are unknown']);
    assert.deepEqual(doc.actions, [
      { tool: 'run_command', state: 'ERROR', refusal: 'deny-rule' },
      { tool: 'read_file', state: 'ERROR', target: '/fixture/other-project.txt', refusal: 'permission-denied' },
      { tool: 'write_file', state: 'ERROR', target: '/fixture/outside.txt', refusal: 'approval-required' },
      { tool: 'read_url', state: 'ERROR', target: 'https://example.test/target', refusal: 'deny-rule' },
    ]);
    assert.doesNotMatch(r.stderr + r.stdout, new RegExp(diagnostic));
    assert.match(r.stderr, /denied run_command: blocked by deny rule/);
    assert.match(r.stderr, /denied outside read/);
    assert.doesNotMatch(r.stderr, /was requested \(unverified\)/);
    assert.ok(!fs.existsSync(f.vendorCalled));
    assert.match(doc.error, /Inspect the worktree before retrying/);
    assert.equal(fs.readFileSync(path.join(f.root, 'source.txt'), 'utf8'), 'native fixture edit');
    assert.deepEqual(fs.readdirSync(f.sessionTmp), []);
  }
  f.fakeAgy('denied');
  const refusedPlain = f.ask([], { json: false });
  assert.equal(refusedPlain.status, 4, refusedPlain.stderr);
  assert.equal(refusedPlain.stdout, '');
  assert.match(refusedPlain.stderr, /agy refused 5 of the builder's action\(s\)/);
  f.fakeAgy();
  const plain = f.ask([], { json: false });
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(plain.stdout, 'fixture answer\n');
});

test('the build trace bounds the number of actions and target length', (t) => {
  const f = fixture(t);
  f.fakeAgy('large-trace');
  const r = f.ask([]);
  assert.equal(r.status, 4, r.stderr);
  const { actions, actionsComplete, actionsTruncated, build, error } = JSON.parse(r.stdout);
  assert.equal(build, undefined);
  assert.match(error, /^agy refused 5 of the builder's action\(s\)/);
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
    f.fakeAgy(kind);
    const r = f.ask([]);
    assert.equal(r.status, 4, r.stderr);
    const { actions, actionsComplete, actionsTruncated, build, denied, error } = JSON.parse(r.stdout);
    assert.equal(build, undefined, kind);
    assert.match(error, /^agy refused 5 of the builder's action\(s\)/, kind);
    assert.ok(denied.includes('read_file: permission denied'), kind);
    assert.equal(actionsComplete, expected, kind);
    assert.equal(actionsTruncated, false, kind);
    if (expected) assert.deepEqual(actions.slice(-2), [
      { tool: 'write_to_file', state: 'DONE', target: './source.txt' },
      { tool: 'finish', state: 'DONE' },
    ]);
    // A later DONE for the refused read neither clears its refusal nor the failure.
    if (kind === 'ambiguous-trace') assert.deepEqual(actions[1], { tool: 'read_file', state: 'DONE', target: '/fixture/other-project.txt', refusal: 'permission-denied' });
  }
});

test('build rejects non-root directories, the home tree and noncanonical Git roots before probing agy', (t) => {
  const f = fixture(t);
  f.fakeAgy();
  const nested = path.join(f.root, 'nested');
  const notGit = path.join(f.base, 'not-git');
  for (const dir of [nested, notGit]) fs.mkdirSync(dir);
  const git = spawnSync('/usr/bin/git', ['init', '-q'], { cwd: f.home, encoding: 'utf8' });
  assert.equal(git.status, 0, git.stderr);
  for (const [target, error] of [
    [nested, /requires a canonical Git worktree root/], [notGit, /requires a canonical Git worktree root/],
    [f.home, /home folder/], [f.base, /folder holding it/], ['/', /filesystem root/],
  ]) {
    const r = f.ask([], { target });
    assert.equal(r.status, 4, r.stderr);
    assert.match(JSON.parse(r.stdout).error, error);
    assert.ok(!fs.existsSync(f.versionCalled));
    assert.ok(!fs.existsSync(f.called));
  }
});

test('build checks the token before probing agy and requires the tested version before opening a session', (t) => {
  const f = fixture(t);
  f.fakeAgy();
  fs.mkdirSync(path.dirname(f.token), { recursive: true });
  fs.writeFileSync(f.token, diagnostic);
  const blocked = f.ask([]);
  assert.equal(blocked.status, 4, blocked.stderr);
  assert.match(JSON.parse(blocked.stdout).error, /plain text/);
  assert.doesNotMatch(blocked.stderr + blocked.stdout, new RegExp(diagnostic));
  assert.ok(!fs.existsSync(f.versionCalled));
  assert.ok(!fs.existsSync(f.called));
  fs.unlinkSync(f.token);
  for (const [kind, why] of [['wrong-version', /requires the tested CLI version 1.5.14/], ['version-token', /plain text/]]) {
    f.fakeAgy(kind);
    const r = f.ask([]);
    assert.equal(r.status, 4, r.stderr);
    assert.match(JSON.parse(r.stdout).error, why);
    assert.ok(!Object.hasOwn(JSON.parse(r.stdout), 'build'));
    assert.ok(fs.existsSync(f.versionCalled));
    assert.ok(!fs.existsSync(f.called));
    assert.doesNotMatch(r.stderr + r.stdout, new RegExp(diagnostic));
    assert.deepEqual(fs.readdirSync(f.sessionTmp), []);
  }
});

test('build needs a readable, owned regular log and refuses fallback evidence after success or failure', (t) => {
  const f = fixture(t);
  for (const [kind, why] of [
    ['sign-in', /file-based token storage/], ['nonzero-sign-in', /exit 7.*file-based token storage/],
    ['missing-log', /readable, owned regular log/], ['unreadable-log', /readable, owned regular log/],
    ['symlink-log', /readable, owned regular log/], ['directory-log', /readable, owned regular log/],
    ['fifo-log', /readable, owned regular log/], ['left-token', /plain text/],
  ]) {
    f.fakeAgy(kind);
    const r = f.ask([]);
    assert.equal(r.status, 4, r.stderr);
    const doc = JSON.parse(r.stdout);
    assert.match(doc.error, why);
    assert.match(doc.error, /Inspect the worktree before retrying/);
    assert.equal(doc.answer, null);
    assert.ok(!Object.hasOwn(doc, 'build'));
    assert.doesNotMatch(r.stderr + r.stdout, new RegExp(diagnostic));
    assert.deepEqual(fs.readdirSync(f.sessionTmp), []);
  }
});

test('cancellation checks the log and fails even if agy catches SIGTERM and exits zero after editing', async (t) => {
  for (const kind of ['cancel', 'cancel-sign-in']) {
    const f = fixture(t);
    f.fakeAgy(kind);
    const child = f.askAsync();
    t.after(() => child.kill('SIGKILL'));
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const finished = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    for (let attempt = 0; attempt < 200 && !fs.existsSync(f.ready); attempt++) await delay(10);
    assert.ok(fs.existsSync(f.ready), stderr);
    assert.ok(child.kill('SIGTERM'));
    assert.deepEqual(await finished, { code: 4, signal: null }, stderr);
    const doc = JSON.parse(stdout);
    assert.match(doc.error, /cancelled by SIGTERM/);
    assert.match(doc.error, /Inspect the worktree before retrying/);
    assert.equal(doc.answer, null);
    assert.ok(!Object.hasOwn(doc, 'build'));
    if (kind === 'cancel-sign-in') assert.match(doc.error, /file-based token storage/);
    assert.doesNotMatch(stderr + stdout, new RegExp(diagnostic));
    assert.equal(fs.readFileSync(path.join(f.root, 'source.txt'), 'utf8'), 'native fixture edit after SIGTERM');
    assert.deepEqual(fs.readdirSync(f.sessionTmp), []);
  }
});

test('model-id reinstalls the native launcher from the installed copy without either retired helper', (t) => {
  const f = fixture(t);
  for (const name of helperNames) assert.ok(!fs.existsSync(path.join(f.resolverBin, name)));
  fs.unlinkSync(f.launch);
  const reinstall = f.install(path.join(f.resolverBin, 'model-id.mjs'));
  assert.equal(reinstall.status, 0, reinstall.stderr);
  assert.ok(fs.lstatSync(f.launch).isSymbolicLink());
  for (const name of helperNames) assert.ok(!fs.existsSync(path.join(f.resolverBin, name)));
  f.fakeAgy();
  const r = f.ask([]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).build.completed, true);
  assert.ok(!fs.existsSync(f.vendorCalled));
  const ro = f.ask([], { family: ['--family', 'fable'], build: false });
  assert.equal(JSON.parse(ro.stdout).mode, 'read-only');
  assert.ok(fs.existsSync(f.vendorCalled));
});

test('an npm launch ignores retired helper copies and reports a stale ask-model copy', (t) => {
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
  for (const name of helperNames) fs.writeFileSync(path.join(f.resolverBin, name), '// stale helper copy\n');
  assert.doesNotMatch(start().stdout, reminder);
  fs.appendFileSync(path.join(f.resolverBin, 'ask-model.mjs'), '// stale launcher copy\n');
  const stale = start();
  assert.equal(stale.status, 0, stale.stderr);
  assert.match(stale.stdout, reminder);
  const reinstall = f.install();
  assert.equal(reinstall.status, 0, reinstall.stderr);
  assert.doesNotMatch(start().stdout, reminder);
});
