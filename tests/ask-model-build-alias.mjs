/**
 * A native agy build counts an inline subagent as one, whichever of its ids (conversation_id, log_uri) each update
 * names: evidence recorded under two ids before an update links them belongs to one subagent, so a refusal split
 * across them fails the build, and two refusals of one subagent are one entry. readAnswer over synthetic stream-json,
 * with no CLI started; HOME is a temp folder before ask-model is imported, so nothing under the real home is read.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { tempDir } from './fixtures/cleanup.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.HOME = fs.realpathSync(tempDir('acs-ask-build-alias-'));
const { readAnswer } = await import(path.join(ROOT, 'tools', 'ask-model.mjs'));
const NEON = JSON.parse(fs.readFileSync(path.join(ROOT, 'models.default.json'), 'utf8')).models.neon;
const CANARY = 'build-alias-canary';
const REFUSED = (n) => `agy refused ${n} of the builder's action(s), so the build is not complete`;
const MISMATCH = `asked for ${NEON}, but agy reports it was asked for different-model — not its answer`;
const LOG = 'file:///no-such-fixture/sub/transcript.jsonl';
const DENY_RULE = `Matches user-configured deny rule ${CANARY}`;
const EPERM = `EPERM ${CANARY}`;

const step = (fields) => ({ event: 'step_update', step_update: { conversation_id: 'c0', ...fields } });
const edit = [
  step({ step_index: 0, state: 'ACTIVE', step_type: 'tool', tool_name: 'write_to_file', tool_info: { parameters: { TargetFile: './source.txt' } } }),
  step({ step_index: 0, state: 'DONE', step_type: 'tool', tool_name: 'write_to_file' }),
  step({ step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: 'edited source.txt' }),
];
const clean = { event: 'result', result: { status: 'SUCCESS', response: 'edited source.txt' } };
const stream = (middle = [], { model = NEON } = {}) => ({
  code: 0,
  stderr: '',
  stdout: [{ event: 'init', init: { model } }, ...edit, ...middle, clean].map((e) => JSON.stringify(e)).join('\n'),
});
const build = (r) => readAnswer('agy', NEON, r, null, { family: 'neon', agyBuild: true });
const readOnly = (r) => readAnswer('agy', NEON, r, null, { family: 'neon' });
const refusedBuild = (got, entries, label, count = entries.length) => {
  assert.equal(got.exit, 4, `${label}: ${JSON.stringify(got)}`);
  assert.equal(got.answer, undefined, label);
  assert.equal(got.error, REFUSED(count), label);
  assert.deepEqual(got.denied, entries, label);
  assert.doesNotMatch(JSON.stringify(got), new RegExp(CANARY), label);
};
const cleanBuild = (got, label) => {
  assert.equal(got.exit, undefined, `${label}: ${JSON.stringify(got)}`);
  assert.equal(got.error, undefined, label);
  assert.equal(got.answer, 'edited source.txt', label);
  assert.deepEqual(got.denied, [], label);
};

const invoke = (...subagents) => step({
  step_index: 3, state: 'ACTIVE', step_type: 'subagent', tool_name: 'invoke_subagent', subagent_info: { subagents },
});
const byConv = (fields = {}, id = 'c1') => invoke({ conversation_id: id, ...fields });
const byLog = (fields = {}, uri = LOG) => invoke({ log_uri: uri, ...fields });
const link = (fields = {}, id = 'c1', uri = LOG) => invoke({ conversation_id: id, log_uri: uri, ...fields });
const unknown = (label) => `neon tried to start a subagent${label}; its denied calls are unknown`;

test('a refusal split across two ids that a later update links fails the build, whichever id and order', () => {
  const replay = build(stream([byConv({ type_name: 'worker', status: 'ERROR' }), byLog({ error: EPERM }), link()]));
  refusedBuild(replay, ['subagent (worker): permission denied'], 'ERROR under conversation_id, EPERM under log_uri, then both');
  assert.deepEqual(replay.notes, [unknown(' (a subagent)')], 'one note for the one transcript');

  for (const [label, middle, entry] of [
    ['EPERM under log_uri first', [byLog({ error: EPERM }), byConv({ type_name: 'worker', status: 'ERROR' }), link()],
      'subagent (worker): permission denied'],
    ['ERROR under log_uri, a deny rule under conversation_id', [
      byLog({ type_name: 'worker', state: 'ERROR' }), byConv({ error: { message: DENY_RULE } }), link(),
    ], 'subagent (worker): blocked by deny rule'],
    ['an approval message under conversation_id first', [
      byConv({ type_name: 'worker', error: `approval required ${CANARY}` }), byLog({ status: 'ERROR' }), link(),
    ], 'subagent (worker): needed an approval'],
    ['ERROR under conversation_id, the link before EPERM under log_uri', [
      byConv({ type_name: 'worker', status: 'ERROR' }), link(), byLog({ error: EPERM }),
    ], 'subagent (worker): permission denied'],
    ['EPERM carried by the linking update', [byConv({ type_name: 'worker', status: 'ERROR' }), link({ error: EPERM })],
      'subagent (worker): permission denied'],
  ]) refusedBuild(build(stream(middle)), [entry], label);
});

test('a later DONE, repeated links and the linking update\'s own fields never clear or recount the refusal', () => {
  const split = [byConv({ type_name: 'worker', status: 'ERROR' }), byLog({ error: EPERM })];
  refusedBuild(build(stream([
    ...split, link(), link(), link({ status: 'DONE', error: 'command exited 1', denied_actions: [] }),
    byConv({ status: 'DONE' }), byLog({ state: 'DONE', error: '' }), link({ status: 'DONE' }),
  ])), ['subagent (worker): permission denied'], 'repeated links, then DONE under every id');

  refusedBuild(build(stream([...split, link({ type_name: 'reviewer', status: 'DONE', error: 'command exited 1' })])),
    ['subagent (worker): permission denied'], 'the linking update carries DONE, a plain error and another name');

  refusedBuild(build(stream([
    byConv({ type_name: `../${CANARY}`, status: 'ERROR' }), byLog({ type_name: 'worker', error: EPERM }), link(),
  ])), ['subagent (worker): permission denied'], 'the valid name of either id labels the entry');
});

test('every id a merged subagent held reaches it afterwards, whichever record the link keeps', () => {
  refusedBuild(build(stream([byConv({ type_name: 'worker', status: 'ERROR' }), byLog(), link(), byLog({ error: EPERM })])),
    ['subagent (worker): permission denied'], 'EPERM under log_uri after the link');
  refusedBuild(build(stream([byLog({ type_name: 'worker', status: 'ERROR' }), byConv(), link(), byConv({ error: EPERM })])),
    ['subagent (worker): permission denied'], 'EPERM under conversation_id after the link');

  refusedBuild(build(stream([
    byConv({ type_name: 'worker', status: 'ERROR' }), link({}, 'c2'), link(), byConv({ error: EPERM }, 'c2'),
  ])), ['subagent (worker): permission denied'], 'an id only the other record held, linked through log_uri');

  refusedBuild(build(stream([
    link({ type_name: 'reviewer', state: 'DENIED' }, 'c2'),
    byConv({ type_name: 'worker', status: 'ERROR', error: DENY_RULE }),
    byConv({ type_name: 'other', status: 'ERROR', error: EPERM }, 'c3'),
    link(), byConv({ status: 'DONE' }), byConv({ status: 'DONE' }, 'c2'), byLog({ error: 'command exited 1' }),
  ])), ['subagent (reviewer): denied', 'subagent (other): permission denied'], 'the earlier refusal\'s record kept, beside a distinct one');
});

test('two refused records of one subagent are one entry once linked; distinct subagents stay apart', () => {
  for (const [label, middle, entry] of [
    ['a deny rule under conversation_id, DENIED under log_uri', [
      byConv({ type_name: 'worker', status: 'ERROR', error: DENY_RULE }), byLog({ type_name: 'reviewer', state: 'DENIED' }), link(),
    ], 'subagent (worker): blocked by deny rule'],
    ['DENIED under log_uri first', [
      byLog({ type_name: 'reviewer', state: 'DENIED' }), byConv({ type_name: 'worker', status: 'ERROR', error: DENY_RULE }), link(),
    ], 'subagent (reviewer): denied'],
    ['unnamed denied_actions under log_uri first, a named refusal under conversation_id', [
      byLog({ denied_actions: [{ action: CANARY }] }), byConv({ type_name: 'worker', status: 'ERROR', error: EPERM }), link(),
    ], 'subagent (worker): needed an approval'],
    ['DENIED under log_uri, a not-found message under conversation_id', [
      byConv({ type_name: 'worker', error: 'not found' }), byLog({ state: 'DENIED' }), link(),
    ], 'subagent (worker): denied'],
  ]) refusedBuild(build(stream(middle)), [entry], label);

  const two = 'file:///no-such-fixture/two/transcript.jsonl';
  const updates = [
    byConv({ type_name: 'worker', status: 'ERROR' }), byLog({ error: EPERM }),
    byConv({ type_name: 'other', state: 'DENIED' }, 'c2'), byLog({ error: DENY_RULE }, two),
  ];
  const links = [link(), link({}, 'c2', two)];
  for (const [label, middle] of [['links last', [...updates, ...links]], ['links first', [...links, ...updates]]]) {
    refusedBuild(build(stream(middle)), ['subagent (worker): permission denied', 'subagent (other): denied'], `two linked subagents, two entries, ${label}`);
  }
});

test('split evidence that never pairs a failed state with a refusal message stays clean after a link', () => {
  for (const [label, middle] of [
    ['refusal messages under both ids, no failed state', [byConv({ error: EPERM }), byLog({ error: DENY_RULE }), link({ status: 'DONE' })]],
    ['ERROR beside a plain tool error', [byConv({ type_name: 'worker', status: 'ERROR' }), byLog({ error: 'command exited 1' }), link()]],
    ['ERROR beside not found', [byConv({ status: 'ERROR' }), byLog({ error: 'ENOENT: no such file or directory' }), link()]],
    ['CANCELLED beside a deny rule', [byConv({ status: 'CANCELLED' }), byLog({ error: DENY_RULE }), link()]],
    ['ERROR and EPERM on two subagents never linked', [
      link({ type_name: 'worker', status: 'ERROR' }), link({ type_name: 'worker', error: EPERM }, 'c2', 'file:///no-such-fixture/two/transcript.jsonl'),
    ]],
    ['ERROR under one id and EPERM under an id nothing links to it', [byConv({ type_name: 'worker', status: 'ERROR' }), byLog({ error: EPERM })]],
  ]) cleanBuild(build(stream(middle)), label);
});

test('linked refusals are bounded and counted once at scale; a refusal still outranks a model mismatch', () => {
  const n = 70;
  const uri = (i) => `file:///no-such-fixture/s${i}/transcript.jsonl`;
  const ids = Array.from({ length: n }, (_, i) => i);
  const linkAll = invoke(...ids.map((i) => ({ conversation_id: `s${i}`, log_uri: uri(i) })));
  const entry = 'subagent (worker): permission denied';

  const split = build(stream([
    ...ids.map((i) => byConv({ type_name: 'worker', status: 'ERROR' }, `s${i}`)), ...ids.map((i) => byLog({ error: EPERM }, uri(i))), linkAll,
  ]));
  refusedBuild(split, [...Array(63).fill(entry), '(7 more not listed)'], 'seventy split refusals', n);
  assert.equal(split.notes.length, 64);
  assert.equal(split.notes[63], '(7 more not listed)');

  const both = build(stream([
    ...ids.map((i) => byConv({ type_name: 'worker', status: 'ERROR', error: EPERM }, `s${i}`)), ...ids.map((i) => byLog({ state: 'DENIED' }, uri(i))), linkAll,
  ]));
  refusedBuild(both, [...Array(63).fill(entry), '(7 more not listed)'], 'seventy subagents refused under both ids', n);

  const replay = [byConv({ type_name: 'worker', status: 'ERROR' }), byLog({ error: EPERM }), link()];
  const mismatch = build(stream(replay, { model: 'different-model' }));
  assert.equal(mismatch.exit, 4, JSON.stringify(mismatch));
  assert.equal(mismatch.answer, undefined);
  assert.equal(mismatch.error, `${REFUSED(1)}; ${MISMATCH}`);
  assert.deepEqual(mismatch.denied, ['subagent (worker): permission denied']);
  assert.ok(!Object.hasOwn(mismatch, 'served'), 'no model record beside a mismatch');

  const alone = build(stream([byConv({ type_name: 'worker', status: 'ERROR' }), byLog({ error: 'command exited 1' }), link()], { model: 'different-model' }));
  assert.equal(alone.exit, 2, JSON.stringify(alone));
  assert.equal(alone.error, MISMATCH);
  assert.deepEqual(alone.denied, []);

  const plain = readOnly(stream(replay));
  assert.equal(plain.exit, undefined, JSON.stringify(plain));
  assert.equal(plain.answer, 'edited source.txt');
  assert.deepEqual(plain.denied, [], 'read-only calls do not read inline subagent evidence');
});

// The same updates with the identity-only linking update(s) at every position: each placement must give the outcome
// of the placement before every update, where agy has named one subagent before any evidence arrives.
const everyLinkPlacement = (updates, check, linking = [link()]) => {
  for (let i = 0; i <= updates.length; i++) {
    check(build(stream([...updates.slice(0, i), ...linking, ...updates.slice(i)])), `linking after ${i} update(s)`);
  }
};
const ENOENT = 'ENOENT: no such file or directory';

test('an update that replaces the message before the link never erases a refusal the same updates make linked first', () => {
  for (const clear of ['', 'command exited 1']) {
    for (const [label, updates, entry] of [
      ['ERROR under conversation_id, EPERM then DONE and the clear under log_uri', [
        byConv({ type_name: 'worker', status: 'ERROR' }), byLog({ error: EPERM }), byLog({ state: 'DONE', error: clear }),
      ], 'subagent (worker): permission denied'],
      ['ERROR under log_uri, EPERM then the clear under conversation_id', [
        byLog({ type_name: 'worker', state: 'ERROR' }), byConv({ error: { message: EPERM } }), byConv({ error: { message: clear } }),
      ], 'subagent (worker): permission denied'],
      ['EPERM under log_uri, then ERROR under conversation_id, then the clear under log_uri', [
        byLog({ error: EPERM }), byConv({ type_name: 'worker', status: 'ERROR' }), byLog({ error: clear }),
      ], 'subagent (worker): permission denied'],
      ['a deny rule under conversation_id, ERROR under log_uri, then DONE and the clear under conversation_id', [
        byConv({ type_name: 'worker', error: DENY_RULE }), byLog({ state: 'ERROR' }), byConv({ status: 'DONE', error: clear }),
      ], 'subagent (worker): blocked by deny rule'],
    ]) everyLinkPlacement(updates, (got, where) => refusedBuild(got, [entry], `${label} (${JSON.stringify(clear)}), ${where}`));
  }
});

test('a refusal message no failed state met stays unpaired when a later failure brings its own message, wherever the link falls', () => {
  for (const [label, updates] of [
    ['EPERM alone under conversation_id, then ERROR with ENOENT under log_uri', [
      byConv({ type_name: 'worker', error: EPERM }), byLog({ state: 'ERROR', error: ENOENT }),
    ]],
    ['EPERM alone under log_uri, then ERROR with ENOENT under conversation_id', [
      byLog({ error: EPERM }), byConv({ type_name: 'worker', status: 'ERROR', error: { message: ENOENT } }),
    ]],
    ['a deny rule alone, then ERROR with a plain error under the other id', [
      byConv({ error: DENY_RULE }), byLog({ type_name: 'worker', state: 'ERROR', error: 'command exited 1' }),
    ]],
    ['EPERM, then an empty error, then ERROR under the other id', [byLog({ error: EPERM }), byLog({ error: '' }), byConv({ status: 'ERROR' })]],
    ['CANCELLED, then a deny rule and a clear under the other id', [
      byConv({ status: 'CANCELLED' }), byLog({ error: DENY_RULE }), byLog({ state: 'DONE', error: '' }),
    ]],
    ['DONE throughout beside EPERM', [byConv({ status: 'DONE' }), byLog({ state: 'DONE', error: EPERM }), byConv({ status: 'DONE' })]],
  ]) everyLinkPlacement(updates, (got, where) => cleanBuild(got, `${label}, ${where}`));

  everyLinkPlacement([byLog({ type_name: 'worker', state: 'ERROR', error: ENOENT }), byConv({ error: EPERM })],
    (got, where) => refusedBuild(got, ['subagent (worker): permission denied'], `ERROR with ENOENT, then EPERM under the other id, ${where}`));
});

test('transitive and repeated links fold every update of one subagent in stream order, wherever the links fall', () => {
  const split = [byConv({ type_name: 'worker', status: 'ERROR' }), byConv({ error: EPERM }, 'c2'), byConv({ status: 'DONE', error: '' }, 'c2')];
  const chain = [link(), link({}, 'c2')];
  everyLinkPlacement(split, (got, where) => refusedBuild(got, ['subagent (worker): permission denied'], `two ids linked through log_uri, ${where}`), chain);
  refusedBuild(build(stream([chain[1], ...split, chain[0]])), ['subagent (worker): permission denied'], 'one link first, the other last');

  const twice = invoke({ conversation_id: 'c1', log_uri: LOG }, { conversation_id: 'c1', log_uri: LOG });
  everyLinkPlacement([byConv({ type_name: 'worker', status: 'ERROR' }), byLog({ error: EPERM }), byLog({ error: '' })],
    (got, where) => refusedBuild(got, ['subagent (worker): permission denied'], `one subagent named twice in the linking update, ${where}`),
    [twice, twice]);

  everyLinkPlacement([byConv({ type_name: 'worker', error: EPERM }, 'c2'), byConv({ status: 'ERROR', error: ENOENT })],
    (got, where) => cleanBuild(got, `unpaired EPERM and a later ENOENT across a transitive link, ${where}`), chain);

  const two = 'file:///no-such-fixture/two/transcript.jsonl';
  everyLinkPlacement([
    byConv({ type_name: 'worker', status: 'ERROR' }), byLog({ error: EPERM }), byLog({ error: '' }),
    byConv({ type_name: 'other', error: EPERM }, 'c2'), byLog({ state: 'ERROR', error: ENOENT }, two),
  ], (got, where) => refusedBuild(got, ['subagent (worker): permission denied'], `one refused and one unrefused subagent, ${where}`),
  [link(), link({}, 'c2', two)]);
});

test('clears before a link at scale stay counted and bounded; unpaired messages at scale stay clean', () => {
  const n = 70;
  const uri = (i) => `file:///no-such-fixture/s${i}/transcript.jsonl`;
  const ids = Array.from({ length: n }, (_, i) => i);
  const linkAll = invoke(...ids.map((i) => ({ conversation_id: `s${i}`, log_uri: uri(i) })));
  const entry = 'subagent (worker): permission denied';

  const cleared = build(stream([
    ...ids.map((i) => byConv({ type_name: 'worker', status: 'ERROR' }, `s${i}`)), ...ids.map((i) => byLog({ error: EPERM }, uri(i))),
    ...ids.map((i) => byLog({ state: 'DONE', error: '' }, uri(i))), linkAll,
  ]));
  refusedBuild(cleared, [...Array(63).fill(entry), '(7 more not listed)'], 'seventy refusals cleared before the link', n);
  assert.equal(cleared.notes.length, 64);

  cleanBuild(build(stream([
    ...ids.map((i) => byConv({ type_name: 'worker', error: EPERM }, `s${i}`)), ...ids.map((i) => byLog({ state: 'ERROR', error: ENOENT }, uri(i))), linkAll,
  ])), 'seventy unpaired EPERM messages, then ERROR with ENOENT');
});
