/**
 * A native agy build fails on any refused action its stream shows, and on nothing else: readAnswer over synthetic
 * stream-json, with no CLI started. HOME is a temp folder before ask-model is imported, so nothing under the real
 * home is read. The end-to-end exit, receipt and stderr are in tests/ask-model-build.mjs.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { tempDir } from './fixtures/cleanup.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.HOME = fs.realpathSync(tempDir('acs-ask-build-denials-'));
const { readAnswer } = await import(path.join(ROOT, 'tools', 'ask-model.mjs'));
const NEON = JSON.parse(fs.readFileSync(path.join(ROOT, 'models.default.json'), 'utf8')).models.neon;
const CANARY = 'build-denial-canary';

const step = (fields) => ({ event: 'step_update', step_update: { conversation_id: 'c0', ...fields } });
const edit = [
  step({ step_index: 0, state: 'ACTIVE', step_type: 'tool', tool_name: 'write_to_file', tool_info: { parameters: { TargetFile: './source.txt' } } }),
  step({ step_index: 0, state: 'DONE', step_type: 'tool', tool_name: 'write_to_file' }),
  step({ step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: 'edited source.txt' }),
];
const stream = (middle = [], { model = NEON, result = {}, code = 0 } = {}) => ({
  code,
  stderr: '',
  stdout: [
    { event: 'init', init: { model } },
    ...edit,
    ...middle,
    { event: 'result', result: { status: 'SUCCESS', response: 'edited source.txt', ...result } },
  ].map((e) => JSON.stringify(e)).join('\n'),
});
const build = (r) => readAnswer('agy', NEON, r, null, { family: 'neon', agyBuild: true });
const refusedBuild = (got, entries) => {
  assert.equal(got.exit, 4, JSON.stringify(got));
  assert.equal(got.answer, undefined);
  assert.match(got.error, new RegExp(`^agy refused ${entries.length} of the builder's action\\(s\\), so the build is not complete$`));
  assert.deepEqual(got.denied, entries);
  assert.doesNotMatch(JSON.stringify(got), new RegExp(CANARY));
};
const cleanBuild = (got) => {
  assert.equal(got.exit, undefined, JSON.stringify(got));
  assert.equal(got.error, undefined);
  assert.equal(got.answer, 'edited source.txt');
  assert.deepEqual(got.denied, []);
  assert.deepEqual(got.served, { requested: NEON, verified: false });
};

test('a clean build stream answers with no denial and an unverified model', () => {
  const got = build(stream());
  cleanBuild(got);
  assert.deepEqual(got.actions, [{ tool: 'write_to_file', state: 'DONE', target: './source.txt' }]);
  assert.equal(got.actionsComplete, true);
});

test('each kind of refused action fails the build with a sanitized entry', () => {
  const tool = (state, message, name = 'run_command') => [step({
    step_index: 5, state, step_type: 'tool', tool_name: name,
    tool_info: { parameters: { CommandLine: CANARY }, ...(message === undefined ? {} : { error: { message } }) },
  })];
  const subagent = (fields) => [step({
    step_index: 6, state: 'DONE', step_type: 'subagent', tool_name: 'invoke_subagent',
    subagent_info: { subagents: [{ type_name: 'worker', conversation_id: 'c1', initial_prompt: 'report what was denied', ...fields }] },
  })];
  for (const [label, middle, entry, result] of [
    ['state DENIED', tool('DENIED'), 'run_command: denied'],
    ['state DENIED whose message also says not found', tool('DENIED', `not found ${CANARY}`), 'run_command: denied'],
    ['a deny rule', tool('ERROR', `permission check failed: Matches user-configured deny rule ${CANARY}`), 'run_command: blocked by deny rule'],
    ['a user who denied permission', tool('ERROR', `user denied permission ${CANARY}`), 'run_command: denied'],
    ['an approval print mode cannot give', tool('ERROR', `approval required ${CANARY}`, 'write_file'), 'write_file: needed an approval'],
    ['missing consent', tool('ERROR', `no consent ${CANARY}`, 'write_file'), 'write_file: needed an approval'],
    ['EACCES', tool('ERROR', `EACCES ${CANARY}`, 'read_file'), 'read_file: permission denied'],
    ['EPERM', tool('ERROR', `EPERM ${CANARY}`, 'read_file'), 'read_file: permission denied'],
    ['permission denied', tool('ERROR', `Permission denied ${CANARY}`, 'read_file'), 'read_file: permission denied'],
    ['operation not permitted', tool('ERROR', `Operation not permitted ${CANARY}`, 'read_file'), 'read_file: permission denied'],
    ['result.denied_actions', [], 'read_file: needed an approval print mode cannot give', { denied_actions: [{ action: 'read_file', display_name: CANARY }] }],
    ['a nested subagent deny rule', subagent({ status: 'ERROR', error: `Matches user-configured deny rule ${CANARY}` }), 'subagent (worker): blocked by deny rule'],
    ['a nested subagent tool error object', subagent({ state: 'ERROR', error: { message: `EPERM ${CANARY}` } }), 'subagent (worker): permission denied'],
    ['a nested subagent DENIED', subagent({ state: 'DENIED' }), 'subagent (worker): denied'],
    ['nested subagent denied_actions', subagent({ denied_actions: [{ action: CANARY }] }), 'subagent (worker): needed an approval'],
  ]) {
    const got = build(stream(middle, { result }));
    assert.equal(got.exit, 4, label);
    refusedBuild(got, [entry]);
  }
});

test('a later success, the action cap and an unreportable tool name never hide an earlier refusal', () => {
  const recovered = build(stream([
    step({ step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'read_file', tool_info: { parameters: { AbsolutePath: '/fixture/outside.txt' } } }),
    step({ step_index: 2, state: 'ERROR', step_type: 'tool', tool_info: { error: { message: `Operation not permitted ${CANARY}` } } }),
    step({ step_index: 2, state: 'ERROR', step_type: 'tool', tool_info: { error: { message: 'not found' } } }),
    step({ step_index: 2, state: 'DONE', step_type: 'tool', tool_name: 'read_file' }),
  ]));
  refusedBuild(recovered, ['read_file: permission denied']);
  assert.deepEqual(recovered.actions.at(-1), { tool: 'read_file', state: 'DONE', target: '/fixture/outside.txt', refusal: 'permission-denied' });
  assert.equal(recovered.actionsComplete, false);

  const nested = (status) => step({
    step_index: 3, state: 'DONE', step_type: 'subagent', tool_name: 'invoke_subagent',
    subagent_info: { subagents: [{ type_name: 'worker', conversation_id: 'c1', status, ...(status === 'ERROR' ? { error: 'deny rule' } : {}) }] },
  });
  refusedBuild(build(stream([nested('ERROR'), nested('DONE')])), ['subagent (worker): blocked by deny rule']);

  const many = Array.from({ length: 70 }, (_, i) => step({ step_index: 10 + i, state: 'DONE', step_type: 'tool', tool_name: 'view_file' }));
  const capped = build(stream([...many, step({ step_index: 90, state: 'ERROR', step_type: 'tool', tool_name: 'run_command', tool_info: { error: { message: 'deny rule' } } })]));
  refusedBuild(capped, ['run_command: blocked by deny rule']);
  assert.equal(capped.actions.length, 64);
  assert.equal(capped.actionsTruncated, true);
  assert.ok(!capped.actions.some(({ tool }) => tool === 'run_command'));

  const unnamed = build(stream([
    step({ step_index: 4, state: 'DENIED', step_type: 'tool', tool_name: `bad name ${CANARY}` }),
    step({ state: 'ERROR', step_type: 'tool', tool_name: 'run_command', tool_info: { error: { message: 'deny rule' } } }),
  ], { result: { denied_actions: [{ action: `../${CANARY}` }, { display_name: 'x' }] } }));
  refusedBuild(unnamed, [
    '(unnamed): denied', 'run_command: blocked by deny rule',
    '(unnamed): needed an approval print mode cannot give', '(unnamed): needed an approval print mode cannot give',
  ]);
  assert.deepEqual(unnamed.actions.map(({ tool }) => tool), ['write_to_file', 'run_command']);
});

test('repeated updates of one refused step count once; a long list is bounded', () => {
  const twice = step({ step_index: 2, state: 'ERROR', step_type: 'tool', tool_name: 'run_command', tool_info: { error: { message: 'deny rule' } } });
  refusedBuild(build(stream([twice, twice])), ['run_command: blocked by deny rule']);

  const hundred = Array.from({ length: 100 }, (_, i) => step({ step_index: 10 + i, state: 'DENIED', step_type: 'tool', tool_name: 'run_command' }));
  const got = build(stream(hundred));
  assert.equal(got.exit, 4);
  assert.match(got.error, /^agy refused 100 of the builder's action\(s\)/);
  assert.equal(got.denied.length, 64);
  assert.deepEqual(got.denied.slice(0, 63), Array(63).fill('run_command: denied'));
  assert.equal(got.denied[63], '(37 more not listed)');
});

test('tool errors that are not refusals, quoted refusal text and an incomplete trace do not fail the build', () => {
  const got = build(stream([
    step({ step_index: 2, state: 'ERROR', step_type: 'tool', tool_name: 'read_file', tool_info: { error: { message: 'ENOENT: no such file or directory' } } }),
    step({ step_index: 3, state: 'ERROR', step_type: 'tool', tool_name: 'run_command', tool_info: { error: { message: 'command exited 1' } } }),
    step({ step_index: 4, state: 'ERROR', step_type: 'tool', tool_name: 'view_file', tool_info: { error: { message: 'file not found' } } }),
    step({ step_index: 5, state: 'CANCELLED', step_type: 'tool', tool_name: 'run_command', tool_info: { error: { message: 'deny rule' } } }),
    step({ step_index: 6, state: 'DONE', step_type: 'tool', tool_name: 'write_to_file', tool_info: {
      parameters: { TargetFile: './notes.md', CodeContent: 'blocked by deny rule; Permission denied; EACCES; approval required' },
      output: 'Operation not permitted', error: { message: 'deny rule' },
    } }),
    step({ step_index: 7, state: 'DONE', step_type: 'tool', tool_name: 'run_command', tool_info: { output: 'touch: /outside: Operation not permitted' } }),
    step({ step_index: 8, state: 'DONE', step_type: 'agent_response', text_delta: 'If agy says "user denied permission" or EPERM, retry.' }),
    step({ step_index: 9, state: 'ACTIVE', step_type: 'subagent', tool_name: 'invoke_subagent', subagent_info: { subagents: [{
      type_name: 'worker', initial_prompt: 'report whether each call was denied by a deny rule or EACCES', log_uri: 'file:///no-such/transcript.jsonl',
    }] } }),
    step({ step_index: 10, state: 'ERROR', step_type: 'tool', tool_name: 'run_command', tool_info: { error: { message: { text: 'deny rule' } } } }),
  ], { result: { denied_actions: [] } }));
  assert.equal(got.exit, undefined, JSON.stringify(got));
  assert.equal(got.answer, 'If agy says "user denied permission" or EPERM, retry.');
  assert.deepEqual(got.denied, []);
  assert.equal(got.actionsComplete, false);
  assert.deepEqual(got.actions.filter(({ refusal }) => refusal).map(({ refusal }) => refusal), ['not-found', 'tool-error', 'not-found', 'tool-error']);
  assert.deepEqual(got.notes, ['neon tried to start a subagent (worker); its denied calls are unknown']);
});

test('model mismatch, a failed turn and an empty answer keep their errors, and still carry the denial', () => {
  const denial = [step({ step_index: 2, state: 'DENIED', step_type: 'tool', tool_name: 'run_command' })];
  const mismatch = build(stream(denial, { model: 'different-model' }));
  assert.equal(mismatch.exit, 2);
  assert.match(mismatch.error, /different-model — not its answer/);
  assert.deepEqual(mismatch.denied, ['run_command: denied']);
  for (const [r, why] of [
    [stream(denial, { code: 7 }), /^agy builder failed \(exit 7\)$/],
    [stream(denial, { result: { status: 'ERROR' } }), /^agy builder did not report a successful result$/],
  ]) {
    const got = build(r);
    assert.equal(got.exit, 4);
    assert.match(got.error, why);
    assert.deepEqual(got.denied, ['run_command: denied']);
  }
  const empty = readAnswer('agy', NEON, {
    code: 0, stderr: '',
    stdout: [{ event: 'init', init: { model: NEON } }, ...denial, { event: 'result', result: { status: 'SUCCESS', response: '' } }].map((e) => JSON.stringify(e)).join('\n'),
  }, null, { family: 'neon', agyBuild: true });
  assert.equal(empty.exit, 4);
  assert.equal(empty.error, 'agy returned an empty answer after 1 denied tool call(s): run_command: denied');
});

test('read-only agy calls keep answering beside a refusal, listing only what they listed before', () => {
  const r = stream([
    step({ step_index: 2, state: 'DENIED', step_type: 'tool', tool_name: 'run_command' }),
    step({ step_index: 3, state: 'ERROR', step_type: 'tool', tool_name: 'read_file', tool_info: { error: { message: 'Operation not permitted' } } }),
    step({ step_index: 4, state: 'ERROR', step_type: 'tool', tool_name: 'write_file', tool_info: { error: { message: 'Matches user-configured deny rule' } } }),
  ], { result: { denied_actions: [{ action: 'read_file' }] } });
  const got = readAnswer('agy', NEON, r, null, { family: 'neon' });
  assert.equal(got.exit, undefined, JSON.stringify(got));
  assert.equal(got.answer, 'edited source.txt');
  assert.deepEqual(got.denied, ['write_file: Matches user-configured deny rule', 'read_file: needed an approval print mode cannot give']);
  assert.ok(!Object.hasOwn(got, 'actions'));
});
