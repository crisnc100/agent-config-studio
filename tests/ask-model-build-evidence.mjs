/**
 * A native agy build keeps refusal evidence that its stream spreads out: denied_actions on any result event, a step's
 * state and error message in separate updates, an inline subagent's state and error in separate updates. Its notes
 * stay bounded, and a refusal outranks a model mismatch. readAnswer over synthetic stream-json, with no CLI started;
 * HOME is a temp folder before ask-model is imported, so nothing under the real home is read.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { tempDir } from './fixtures/cleanup.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.HOME = fs.realpathSync(tempDir('acs-ask-build-evidence-'));
const { readAnswer } = await import(path.join(ROOT, 'tools', 'ask-model.mjs'));
const NEON = JSON.parse(fs.readFileSync(path.join(ROOT, 'models.default.json'), 'utf8')).models.neon;
const CANARY = 'build-evidence-canary';
const REFUSED = (n) => `agy refused ${n} of the builder's action(s), so the build is not complete`;

const step = (fields) => ({ event: 'step_update', step_update: { conversation_id: 'c0', ...fields } });
const edit = [
  step({ step_index: 0, state: 'ACTIVE', step_type: 'tool', tool_name: 'write_to_file', tool_info: { parameters: { TargetFile: './source.txt' } } }),
  step({ step_index: 0, state: 'DONE', step_type: 'tool', tool_name: 'write_to_file' }),
  step({ step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: 'edited source.txt' }),
];
const clean = { event: 'result', result: { status: 'SUCCESS', response: 'edited source.txt' } };
const stream = (middle = [], { model = NEON, results = [clean], before = edit } = {}) => ({
  code: 0,
  stderr: '',
  stdout: [{ event: 'init', init: { model } }, ...before, ...middle, ...results].map((e) => JSON.stringify(e)).join('\n'),
});
const build = (r) => readAnswer('agy', NEON, r, null, { family: 'neon', agyBuild: true });
const readOnly = (r) => readAnswer('agy', NEON, r, null, { family: 'neon' });
const refusedBuild = (got, entries, label) => {
  assert.equal(got.exit, 4, `${label}: ${JSON.stringify(got)}`);
  assert.equal(got.answer, undefined, label);
  assert.equal(got.error, REFUSED(entries.length), label);
  assert.deepEqual(got.denied, entries, label);
  assert.doesNotMatch(JSON.stringify(got), new RegExp(CANARY), label);
};
const cleanBuild = (got, label) => {
  assert.equal(got.exit, undefined, `${label}: ${JSON.stringify(got)}`);
  assert.equal(got.error, undefined, label);
  assert.equal(got.answer, 'edited source.txt', label);
  assert.deepEqual(got.denied, [], label);
};

test('denied_actions on any result event fails the build, even when a later result is clean', () => {
  const earlier = (denied) => ({ event: 'result', result: { status: 'SUCCESS', response: 'first turn', denied_actions: denied } });
  refusedBuild(build(stream([], { results: [earlier([{ action: 'read_file', display_name: CANARY }]), clean] })),
    ['read_file: needed an approval print mode cannot give'], 'an earlier list');
  refusedBuild(build(stream([], { results: [earlier({ action: 'read_url' }), clean] })),
    ['read_url: needed an approval print mode cannot give'], 'an earlier single entry');
  refusedBuild(build(stream([], { results: [
    earlier([{ action: 'read_file' }]),
    { event: 'result', result: { ...clean.result, denied_actions: [{ action: `../${CANARY}` }] } },
  ] })), ['read_file: needed an approval print mode cannot give', '(unnamed): needed an approval print mode cannot give'], 'both results');
  refusedBuild(build(stream([], { results: [{ event: 'result', result: 'not an object' }, earlier([{ action: 'read_file' }]), clean] })),
    ['read_file: needed an approval print mode cannot give'], 'beside a malformed result');

  const twoClean = build(stream([], { results: [earlier([]), clean] }));
  cleanBuild(twoClean, 'two clean results');
  assert.equal(twoClean.actionsComplete, false, 'a second result leaves the trace incomplete');

  const plain = readOnly(stream([], { results: [earlier([{ action: 'read_file' }]), clean] }));
  assert.equal(plain.exit, undefined, JSON.stringify(plain));
  assert.equal(plain.answer, 'edited source.txt');
  assert.deepEqual(plain.denied, [], 'read-only calls still list only the last result');
});

test("a step's state and error message in separate updates are one refusal, kept through a later DONE", () => {
  const active = (name = 'run_command', index = 2) => step({ step_index: index, state: 'ACTIVE', step_type: 'tool', tool_name: name, tool_info: { parameters: { CommandLine: CANARY } } });
  const failed = (index = 2, fields = {}) => step({ step_index: index, state: 'ERROR', step_type: 'tool', ...fields });
  const message = (text, index = 2, fields = {}) => step({ step_index: index, step_type: 'tool', tool_info: { error: { message: text } }, ...fields });
  const done = (index = 2) => step({ step_index: index, state: 'DONE', step_type: 'tool' });
  const denyRule = `Matches user-configured deny rule ${CANARY}`;
  for (const [label, middle, entry, refusal] of [
    ['state first', [active(), failed(), message(denyRule)], 'run_command: blocked by deny rule', 'deny-rule'],
    ['message first', [active(), message(denyRule), failed()], 'run_command: blocked by deny rule', 'deny-rule'],
    ['state first, then DONE', [active(), failed(), message(`EPERM ${CANARY}`), done()], 'run_command: permission denied', 'permission-denied'],
    ['message first, then DONE', [active(), message(`approval required ${CANARY}`), failed(), done()], 'run_command: needed an approval', 'approval-required'],
    ['state, DONE, then message', [active(), failed(), done(), message(denyRule)], 'run_command: blocked by deny rule', 'deny-rule'],
    ['an update with no message between', [active(), failed(), step({ step_index: 2, state: 'ERROR', step_type: 'tool', tool_info: { error: {} } }), message(denyRule)], 'run_command: blocked by deny rule', 'deny-rule'],
    ['DENIED, then a not-found message', [active(), step({ step_index: 2, state: 'DENIED', step_type: 'tool' }), message('not found')], 'run_command: denied', 'denied'],
    ['the tool named only after the refusal', [failed(), message(denyRule), step({ step_index: 2, step_type: 'tool', tool_name: 'run_command' })], 'run_command: blocked by deny rule', undefined],
  ]) {
    const got = build(stream(middle));
    refusedBuild(got, [entry], label);
    const traced = got.actions.find(({ tool }) => tool === 'run_command');
    if (refusal) assert.equal(traced?.refusal, refusal, `${label}: the trace agrees`);
    else assert.equal(traced, undefined, `${label}: no state the trace can report`);
  }

  const unnamed = build(stream([active(`bad name ${CANARY}`), message(denyRule), failed()]));
  refusedBuild(unnamed, ['(unnamed): blocked by deny rule'], 'an unreportable tool name');
  assert.deepEqual(unnamed.actions.map(({ tool }) => tool), ['write_to_file']);

  const many = Array.from({ length: 70 }, (_, i) => step({ step_index: 10 + i, state: 'DONE', step_type: 'tool', tool_name: 'view_file' }));
  const capped = build(stream([...many, active('run_command', 90), message(denyRule, 90), failed(90)]));
  refusedBuild(capped, ['run_command: blocked by deny rule'], 'past the action cap');
  assert.equal(capped.actions.length, 64);
  assert.equal(capped.actionsTruncated, true);
  assert.ok(!capped.actions.some(({ tool }) => tool === 'run_command'));
});

test('split updates that never pair a failed state with a refusal message do not fail the build', () => {
  const denyRule = 'Matches user-configured deny rule';
  for (const [label, middle] of [
    ['ERROR, then a plain tool error', [
      step({ step_index: 2, state: 'ERROR', step_type: 'tool', tool_name: 'run_command' }),
      step({ step_index: 2, step_type: 'tool', tool_info: { error: { message: 'command exited 1' } } }),
    ]],
    ['a refusal message on a step that only ends DONE', [
      step({ step_index: 2, step_type: 'tool', tool_name: 'write_to_file', tool_info: { error: { message: denyRule } } }),
      step({ step_index: 2, state: 'DONE', step_type: 'tool' }),
    ]],
    ['a refusal message on a CANCELLED step', [
      step({ step_index: 2, state: 'CANCELLED', step_type: 'tool', tool_name: 'run_command' }),
      step({ step_index: 2, step_type: 'tool', tool_info: { error: { message: denyRule } } }),
    ]],
    ['ERROR and the message on different steps', [
      step({ step_index: 2, state: 'ERROR', step_type: 'tool', tool_name: 'run_command' }),
      step({ step_index: 3, step_type: 'tool', tool_name: 'run_command', tool_info: { error: { message: denyRule } } }),
      step({ step_index: 3, state: 'DONE', step_type: 'tool' }),
    ]],
    ['ERROR and the message in different conversations', [
      step({ step_index: 2, state: 'ERROR', step_type: 'tool', tool_name: 'run_command' }),
      step({ conversation_id: 'c9', step_index: 2, step_type: 'tool', tool_name: 'run_command', tool_info: { error: { message: denyRule } } }),
    ]],
  ]) cleanBuild(build(stream(middle)), label);
});

test("an inline subagent's state and error in separate updates are one refusal, by conversation_id or log_uri", () => {
  const LOG = 'file:///no-such-fixture/sub/transcript.jsonl';
  const invoke = (index, subagent) => step({
    step_index: index, state: 'ACTIVE', step_type: 'subagent', tool_name: 'invoke_subagent', subagent_info: { subagents: [subagent] },
  });
  const unknown = (label) => `neon tried to start a subagent${label}; its denied calls are unknown`;
  for (const [label, middle, entry, notes] of [
    ['by conversation_id, state first', [
      invoke(3, { type_name: 'worker', conversation_id: 'c1', status: 'ERROR' }),
      invoke(3, { conversation_id: 'c1', error: `Matches user-configured deny rule ${CANARY}` }),
    ], 'subagent (worker): blocked by deny rule', []],
    ['by log_uri, message first', [
      invoke(3, { log_uri: LOG, error: { message: `EPERM ${CANARY}` } }),
      invoke(4, { log_uri: LOG, state: 'ERROR' }),
    ], 'subagent: permission denied', [unknown(' (a subagent)')]],
    ['conversation_id, then both ids, then log_uri, then DONE', [
      invoke(3, { type_name: 'worker', conversation_id: 'c1', state: 'ERROR' }),
      invoke(3, { conversation_id: 'c1', log_uri: LOG }),
      invoke(3, { log_uri: LOG, error: `approval required ${CANARY}` }),
      invoke(3, { conversation_id: 'c1', log_uri: LOG, status: 'DONE' }),
    ], 'subagent (worker): needed an approval', [unknown(' (c1)')]],
    ['denied_actions, then a later clean update', [
      invoke(3, { type_name: 'worker', conversation_id: 'c1', denied_actions: [{ action: CANARY }] }),
      invoke(3, { conversation_id: 'c1', status: 'DONE', denied_actions: [] }),
    ], 'subagent (worker): needed an approval', []],
  ]) {
    const got = build(stream(middle));
    refusedBuild(got, [entry], label);
    assert.deepEqual(got.notes, notes, label);
  }

  cleanBuild(build(stream([
    invoke(3, { type_name: 'worker', conversation_id: 'c1', status: 'ERROR' }),
    invoke(4, { type_name: 'worker', conversation_id: 'c2', error: 'Matches user-configured deny rule' }),
  ])), 'state and error on different subagents');
});

test('build notes stop at 64 entries with a count of the rest; read-only notes are unchanged', () => {
  const subagents = (n) => [step({
    step_index: 3, state: 'DONE', step_type: 'subagent', tool_name: 'invoke_subagent',
    subagent_info: { subagents: Array.from({ length: n }, (_, i) => ({ type_name: 'worker', conversation_id: `s${i}`, log_uri: `file:///no-such-fixture/s${i}/transcript.jsonl` })) },
  })];
  const note = 'neon tried to start a subagent (worker); its denied calls are unknown';

  const seventy = build(stream(subagents(70)));
  cleanBuild(seventy, 'seventy subagents');
  assert.equal(seventy.notes.length, 64);
  assert.deepEqual(seventy.notes.slice(0, 63), Array(63).fill(note));
  assert.equal(seventy.notes[63], '(7 more not listed)');

  const exact = build(stream(subagents(64)));
  assert.deepEqual(exact.notes, Array(64).fill(note));

  const refused = build(stream([...subagents(70), step({ step_index: 4, state: 'DENIED', step_type: 'tool', tool_name: 'run_command' })]));
  refusedBuild(refused, ['run_command: denied'], 'a refusal beside seventy subagents');
  assert.equal(refused.notes.length, 64);
  assert.equal(refused.notes[63], '(7 more not listed)');

  const empty = build(stream(subagents(70), { before: edit.slice(0, 2), results: [{ event: 'result', result: { status: 'SUCCESS', response: '' } }] }));
  assert.equal(empty.exit, 4, JSON.stringify(empty));
  assert.equal(empty.error, 'agy returned an empty answer');
  assert.equal(empty.notes.length, 64);
  assert.equal(empty.notes[63], '(7 more not listed)');

  const plain = readOnly(stream(subagents(70)));
  assert.equal(plain.exit, undefined, JSON.stringify(plain));
  assert.equal(plain.notes.length, 70, 'read-only calls keep every note');
});

test('a refusal beside a model mismatch exits 4 and keeps the mismatch; a mismatch alone still exits 2', () => {
  const denial = [step({ step_index: 2, state: 'DENIED', step_type: 'tool', tool_name: 'run_command' })];
  const mismatch = (reported) => `asked for ${NEON}, but agy reports it was asked for ${reported} — not its answer`;

  const both = build(stream(denial, { model: 'different-model' }));
  assert.equal(both.exit, 4, JSON.stringify(both));
  assert.equal(both.answer, undefined);
  assert.equal(both.error, `${REFUSED(1)}; ${mismatch('different-model')}`);
  assert.deepEqual(both.denied, ['run_command: denied']);
  assert.ok(!Object.hasOwn(both, 'served'), 'no model record beside a mismatch');

  const earlier = build(stream([], { model: 'different-model', results: [
    { event: 'result', result: { status: 'SUCCESS', response: 'first', denied_actions: [{ action: 'read_file' }] } }, clean,
  ] }));
  assert.equal(earlier.exit, 4);
  assert.equal(earlier.error, `${REFUSED(1)}; ${mismatch('different-model')}`);

  const invalid = build(stream(denial, { model: `bad model ${CANARY}` }));
  assert.equal(invalid.exit, 4);
  assert.equal(invalid.error, `${REFUSED(1)}; ${mismatch('(invalid model id)')}`);

  const alone = build(stream([], { model: 'different-model' }));
  assert.equal(alone.exit, 2, JSON.stringify(alone));
  assert.equal(alone.error, mismatch('different-model'));
  assert.equal(alone.answer, undefined);
  assert.deepEqual(alone.denied, []);
  assert.ok(!Object.hasOwn(alone, 'served'));

  const plain = readOnly(stream(denial, { model: 'different-model' }));
  assert.equal(plain.exit, 2, JSON.stringify(plain));
  assert.equal(plain.error, mismatch('different-model'));
});
