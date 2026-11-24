import assert from 'node:assert/strict';
import test from 'node:test';
import { candidates } from './interface-controls.mjs';
import { matchControls, observe, parseListeners } from './listener-observation.mjs';

const child = { pid: 101 };
const agy = 102;
const ids = new Set([child.pid, agy]);
const broker = 'p101\ncnode\nf20\nn127.0.0.1:12345\nf21\nn[::1]:12345\n';
const pinned = 'p102\ncagy\nf25\nn127.0.0.1:23456\n';
const interfaces = candidates({
  test0: [{ address: '192.0.2.18', family: 'IPv4', internal: false }],
  test1: [{ address: 'fe80::d', family: 'IPv6', internal: false }],
});
const listening = { status: 'listening', durationMs: 1 };
const accepted = { status: 'connected', accepted: true, durationMs: 1 };
const refused = { status: 'refused', errno: 'ECONNREFUSED', durationMs: 1 };
const timeout = { status: 'timeout', durationMs: 2000 };
const results = interfaces.map(({ ordinal, family, scope }, index) => ({
  ordinal, family, scope, reservation: listening, exactBind: listening, loopbackBind: listening,
  loopbackAccept: accepted, exactAccept: index === 0 ? accepted : timeout,
  candidateToLoopback: index === 0 ? refused : timeout,
}));

async function fixture({ samples = [broker + pinned], replies = [refused, timeout], controls = results,
  aborted = false, inventory = interfaces, run = matchControls(interfaces, { results: controls, aborted }) } = {}) {
  let index = 0;
  const cancelled = [];
  const calls = [];
  const evidence = await observe(child, () => index >= samples.length, (signal) => cancelled.push(signal), run, {
    candidates: () => inventory,
    pause: async () => {},
    snapshot: async () => {
      const sample = samples[index++];
      if (sample instanceof Error) throw sample;
      return parseListeners(sample, ids);
    },
    probe: async (host, port) => {
      const candidateIndex = interfaces.findIndex((candidate) => candidate.host === host);
      assert.notEqual(candidateIndex, -1);
      calls.push([candidateIndex, port]);
      const reply = replies[candidateIndex];
      if (!reply) throw new Error('missing active probe');
      return reply;
    },
  });
  return { evidence, cancelled, calls };
}

test('matched unusable path stays supplementary while every row is retained', async () => {
  const { evidence, cancelled, calls } = await fixture();
  assert.equal(evidence.proved, true);
  assert.equal(evidence.brokerPair, true);
  assert.equal(evidence.records.length, 3);
  assert.deepEqual(cancelled, []);
  assert.equal(calls.length, 6);
  assert.deepEqual(evidence.controls.results[1].exactAccept, timeout);
  assert.deepEqual(evidence.controls.results[1].loopbackAccept, accepted);
  for (const record of evidence.records) {
    assert.deepEqual(record.probes.map(({ ordinal, evidence }) => [ordinal, evidence]),
      [[1, 'refused'], [2, 'supplementary-unproven']]);
    assert.equal(record.probes[1].status, 'timeout');
  }
  for (const raw of ['192.0.2.18', 'fe80::d', 'test0', 'test1', '12345', '23456']) {
    assert.equal(JSON.stringify(evidence).includes(raw), false);
  }
});

test('wildcards or non-loopback endpoints cancel even with all timeout controls', async () => {
  const controls = results.map((row) => ({ ...row, exactAccept: timeout, candidateToLoopback: timeout }));
  for (const endpoint of ['*:34567', '0.0.0.0:34567', '[::]:34567', '192.0.2.18:34567', '[2001:db8::1]:34567']) {
    const { evidence, cancelled } = await fixture({
      samples: [broker + pinned + 'f26\nn' + endpoint + '\n'], replies: [timeout, timeout], controls,
    });
    assert.equal(evidence.proved, false);
    assert.equal(evidence.records.at(-1).probes[0].status, 'timeout');
    assert.deepEqual(cancelled, ['SIGTERM']);
  }
});

test('any successful external connect fails despite clean loopback binds', async () => {
  const { evidence, cancelled } = await fixture({ replies: [refused, accepted] });
  assert.equal(evidence.proved, false);
  assert.equal(evidence.brokerPair, true);
  assert.ok(evidence.records.every(({ scope }) => scope === 'loopback'));
  assert.deepEqual(cancelled, ['SIGTERM']);
});

test('usable path timeout, missing evidence and mismatched controls all fail', async () => {
  for (const config of [
    { replies: [timeout, timeout] },
    { replies: [refused, undefined] },
    { controls: results.slice(0, 1) },
    { controls: [results[1], results[0]] },
    { controls: [results[0], { ...results[1], loopbackAccept: { ...accepted, accepted: false } }] },
    { controls: [results[0], { ...results[1], exactAccept: { ...accepted, accepted: false } }] },
    { aborted: true },
    { inventory: [...interfaces].reverse() },
    { samples: [] },
    { samples: [broker] },
    { samples: [pinned] },
    { samples: [broker.replace('[::1]:12345', '[::1]:34567') + pinned] },
    { samples: ['p101\ncnode\nf20\nn127.0.0.1:12345\n' + pinned, 'p101\ncnode\nf21\nn[::1]:12345\n'] },
  ]) {
    const { evidence, cancelled } = await fixture(config);
    assert.equal(evidence.proved, false, JSON.stringify(config));
    assert.deepEqual(cancelled, ['SIGTERM']);
  }
});

test('sampling and parsing errors cancel and retain explicit error counts', async () => {
  const failure = await fixture({ samples: [broker + pinned, new Error('synthetic error')] });
  assert.equal(failure.evidence.proved, false);
  assert.equal(failure.evidence.sampleErrors, 1);
  assert.deepEqual(failure.cancelled, ['SIGTERM']);
  for (const output of [
    broker + pinned + 'f26\nnlocalhost:34567\n', broker + pinned + 'f26\n',
    broker + pinned + 'f26\nn127.domain:34567\n', broker + pinned + 'f26\nn[::1]:99999\n',
  ]) {
    const { evidence, cancelled } = await fixture({ samples: [output] });
    assert.equal(evidence.proved, false);
    assert.ok(evidence.parseErrors > 0);
    assert.deepEqual(cancelled, ['SIGTERM']);
  }
});
