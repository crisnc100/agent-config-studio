import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { ROOT, sandbox, tests } from './fixtures/packs-sandbox.mjs';
import { bootPage, routesFor, settle } from './fixtures/shell-page.mjs';

const { ok, done } = tests();
const equal = (name, actual, expected) => { assert.deepEqual(actual, expected); ok(name, true); };
const sb = sandbox('cursor-usage', { clis: [], modelId: false });
const studio = path.join(sb.home, '.agent-config-studio');
const log = path.join(studio, 'cursor', 'turns.jsonl');
const script = path.join(ROOT, 'packs', 'cursor', 'turns', 'turn-count.mjs');
const hooks = path.join(sb.home, '.cursor', 'hooks.json');
const readHooks = () => JSON.parse(fs.readFileSync(hooks, 'utf8'));
const readLog = () => fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
const fixture = {
  hook_event_name: 'stop', conversation_id: 'conversation', generation_id: 'generation',
  model_id: 'selected-a', model: 'fallback-b', status: 'completed',
  prompt: 'private prompt', reply: 'private answer', user_email: 'fixture@example.test', transcript_path: '/fixture/private',
};
const invoke = (input, entry = [process.execPath, script], extra) => {
  const [command, ...args] = entry;
  const r = sb.run(command, args, { input: typeof input === 'string' ? input : JSON.stringify(input), extra });
  return r.code === 0 && r.stdout === '{}\n' && r.stderr === '';
};
const pack = (action, ...args) => {
  const res = sb.packs([action, 'cursor', ...args, '--yes']);
  ok(`${action} cursor ${args.join(' ')} succeeds`, res.code === 0, res.out);
};
const day = 86_400_000;
const zeros = { models: [], total: { today: 0, days7: 0, days30: 0 } };
process.env.HOME = sb.home;
const { countCursorTurns } = await import('../lib/usage/cursor.js');
const { createApp } = await import('../server.js');
const { server } = createApp();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
async function usage() {
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/usage`);
  assert.equal(res.status, 200);
  return (await res.json()).cursor;
}

let missing, waiting, withCounts;
try {
  missing = await usage();
  equal('Usage reports counting disabled in an empty home', missing, { installed: false, ...zeros });
  pack('install', '--part', 'session-context');
  equal('the previous Cursor part alone leaves counting disabled', await usage(), missing);
  const previous = readHooks();
  previous.hooks.beforeShellExecution = [{ command: 'review-guard --cursor', failClosed: true }];
  previous.hooks.stop = [{ command: 'user-stop', timeout: 2 }];
  fs.writeFileSync(hooks, JSON.stringify(previous));

  pack('install');
  const launcher = path.join(studio, 'cursor', 'hooks', 'turns', 'turn-count');
  const command = readHooks().hooks.sessionEnd[0].command;
  const installed = {
    ...previous, hooks: {
      ...previous.hooks, stop: [...previous.hooks.stop, { command: launcher }], sessionEnd: [{ command: launcher }],
    },
  };
  equal('install adds exactly two entries beside the session, guard and user hooks', readHooks(), installed);
  const recorded = sb.state();
  pack('install');
  equal('reinstall preserves exact hook entries and ownership', [readHooks(), sb.state()], [installed, recorded]);
  const status = () => sb.json(['status', '--no-trust-check']).data.packs.find((p) => p.id === 'cursor').parts.find((p) => p.id === 'turn-count');
  equal('status reports counting installed', status().statuses, ['installed']);
  waiting = await usage();
  equal('Usage reports zero counts before any turns', waiting, { installed: true, ...zeros });

  ok('the installed launcher uses its pinned Node and emits an empty object',
    invoke(fixture, ['/bin/sh', '-c', command], { PATH: 'relative:/bin' }));
  ok('stop records aborted and errored outcomes for fallback suppression',
    invoke({ ...fixture, generation_id: 'g2', status: 'aborted' })
    && invoke({ ...fixture, generation_id: 'g3', status: 'error' }));
  ok('sessionEnd accepts final_status and then reason, with a model fallback',
    invoke({ ...fixture, hook_event_name: 'sessionEnd', conversation_id: 'cli', model_id: undefined, final_status: 'completed', reason: 'error' })
    && invoke({ ...fixture, hook_event_name: 'sessionEnd', conversation_id: 'cli-2', reason: 'aborted' })
    && invoke({ ...fixture, hook_event_name: 'sessionEnd', conversation_id: 'cli-3', final_status: 'error' }));
  const records = readLog();
  ok('all records have an ISO timestamp', records.every(({ ts }) => new Date(ts).toISOString() === ts));
  equal('the log contains exactly the allowed fields and values', records.map(({ ts, ...item }) => item), [
    { event: 'stop', conversation_id: 'conversation', generation_id: 'generation', model: 'selected-a', status: 'completed' },
    { event: 'stop', conversation_id: 'conversation', generation_id: 'g2', model: 'selected-a', status: 'aborted' },
    { event: 'stop', conversation_id: 'conversation', generation_id: 'g3', model: 'selected-a', status: 'error' },
    { event: 'sessionEnd', conversation_id: 'cli', generation_id: 'generation', model: 'fallback-b', status: 'completed' },
    { event: 'sessionEnd', conversation_id: 'cli-2', generation_id: 'generation', model: 'selected-a', status: 'aborted' },
    { event: 'sessionEnd', conversation_id: 'cli-3', generation_id: 'generation', model: 'selected-a', status: 'error' },
  ]);
  ok('invalid JSON, incomplete payloads and unrelated events are silent',
    invoke('{broken') && invoke('null') && invoke({ ...fixture, generation_id: undefined })
    && invoke({ ...fixture, hook_event_name: 'sessionEnd' }) && invoke({ ...fixture, hook_event_name: 'sessionStart' }));
  const pin = path.join(path.dirname(launcher), 'node-path');
  const nodePath = fs.readFileSync(pin);
  fs.writeFileSync(pin, '/missing/node\n');
  ok('a missing Node with relative PATH entries still emits just an empty object',
    invoke(fixture, ['/bin/sh', '-c', command], { PATH: sb.root + '/missing:relative' }));
  fs.writeFileSync(pin, nodePath);
  equal('invalid and unavailable invocations leave the log untouched', readLog(), records);
  fs.renameSync(log, `${log}.saved`);
  fs.mkdirSync(log);
  ok('an unwritable log path is silent', invoke(fixture));
  fs.rmdirSync(log);
  fs.renameSync(`${log}.saved`, log);

  const old = { ...records[0], ts: new Date(Date.now() - 31 * day).toISOString(), model: 'x'.repeat(1024 * 1024) };
  fs.appendFileSync(log, `${JSON.stringify(old)}\n`);
  ok('a large log trims records beyond 30 days', invoke(fixture) && fs.statSync(log).size < 1024 * 1024);
  equal('trimming preserves the recent records plus the new append', readLog().slice(0, -1), records);
  const abandoned = `${log}.lock`;
  fs.mkdirSync(abandoned);
  fs.writeFileSync(path.join(abandoned, 'owner-2147483647-test'), '');
  ok('a dead writer cannot leave counting permanently locked', invoke(fixture) && !fs.existsSync(abandoned));

  fs.appendFileSync(log, `${JSON.stringify(old)}\n`);
  const append = (generation_id) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { env: sb.env, stdio: ['pipe', 'pipe', 'pipe'] });
    child.on('error', reject);
    child.on('close', (code) => resolve(code === 0));
    child.stdin.end(JSON.stringify({ ...fixture, generation_id, status: 'aborted' }));
  });
  const parallel = await Promise.all([append('parallel-a'), append('parallel-b')]);
  const generations = readLog().map((record) => record.generation_id);
  ok('parallel appends both survive compaction', parallel.every(Boolean)
    && generations.includes('parallel-a') && generations.includes('parallel-b') && fs.statSync(log).size < 1024 * 1024);

  withCounts = await usage();
  equal('live Usage returns aggregate counts excluding duplicates and failed turns', withCounts, {
    installed: true,
    models: [
      { model: 'fallback-b', today: 1, days7: 1, days30: 1 },
      { model: 'selected-a', today: 1, days7: 1, days30: 1 },
    ],
    total: { today: 2, days7: 2, days30: 2 },
  });

  const edited = readHooks();
  edited.hooks.stop.pop();
  edited.hooks.sessionEnd.unshift({ command, timeout: 2 });
  fs.writeFileSync(hooks, JSON.stringify(edited));
  ok('status identifies a missing stop entry', status().details.some((line) => line.includes('stop') && line.includes('--replace')));
  pack('update');
  equal('ordinary update preserves the manually edited config', readHooks(), edited);
  pack('update', '--replace');
  equal('repair keeps user hooks and leaves the existing sessionEnd entry in place', readHooks(), {
    ...installed, hooks: { ...installed.hooks, sessionEnd: edited.hooks.sessionEnd },
  });
  equal('status describes the repaired part as installed', status().statuses, ['installed']);

  pack('uninstall', '--part', 'turn-count');
  equal('uninstall removes owned entries and preserves user variants', readHooks(), {
    ...previous, hooks: { ...previous.hooks, sessionEnd: [{ command, timeout: 2 }] },
  });
  ok('uninstall removes the turn runtime and preserves the earlier runtime and local records',
    !fs.existsSync(launcher) && fs.existsSync(path.join(studio, 'cursor', 'hooks', 'session-context')) && fs.existsSync(log));
  equal('Usage disables counting after uninstall even with a retained log', await usage(), missing);
} finally {
  await new Promise((resolve) => server.close(resolve));
}

{
  const now = new Date(2026, 6, 13, 15).getTime();
  const turn = (conversation_id, generation_id, age, data = {}) => ({
    ts: new Date(now - age).toISOString(), event: 'stop', conversation_id, generation_id,
    model: 'selected-a', status: 'completed', ...data,
  });
  const end = { event: 'sessionEnd', model: 'fallback-b' };
  const records = [
    turn('both', 'end', 0, end), turn('both', 'g1', 1000), turn('both', 'g1', 0),
    turn('both', 'g2', day), turn('separate', 'g1', 8 * day),
    turn('cli', 'g1', day, end), turn('cli', 'g2', 0, end),
    turn('aborted', 'g1', 0, end), turn('aborted', 'g1', 0, { status: 'aborted' }),
    turn('error', 'g1', 0, { status: 'error' }), turn('old', 'g1', 31 * day),
    turn('future', 'g1', -1000), turn('at-cutoff', 'g1', 30 * day),
    turn('failed-cli', 'g1', 0, { ...end, status: 'error' }),
  ];
  equal('the reader deduplicates stops, counts one CLI fallback and applies all three windows', countCursorTurns(
    [...records.map((record) => JSON.stringify(record)), 'not JSON', 'null', '{"ts":"2026-07-13"}'].join('\n'), now,
  ), {
    models: [
      { model: 'fallback-b', today: 0, days7: 1, days30: 1 },
      { model: 'selected-a', today: 1, days7: 2, days30: 4 },
    ],
    total: { today: 1, days7: 3, days30: 5 },
  });
}

for (const [data, seats, message] of [
  [missing, [], 'acs packs install cursor'],
  [waiting, [], 'No completed turns counted yet.'],
  [withCounts, [{ seatId: 'fixture', label: 'Quota account', vendor: 'codex', ok: true, windows: [{ label: 'Week', usedPercent: 40 }] }], 'Last 30 days'],
]) {
  const page = await bootPage({ hash: '#usage', routes: routesFor({ 'GET /api/usage': () => ({ seats, cursor: data }) }) });
  await settle(20);
  const cards = page.$('content').querySelectorAll('.usage-seat');
  const card = cards.at(-1);
  ok(`Usage renders "${message}" in the Cursor card after quota accounts`,
    cards.length === seats.length + 1 && card?.getAttribute('aria-label') === 'Cursor'
    && card.textContent.includes("Completed turns counted on this Mac; not Cursor's plan usage.")
    && card.textContent.includes(message) && !card.querySelector('button') && !card.textContent.includes('%')
    && !page.errors.length, page.errors.join('\n'));
  if (data === withCounts) {
    const rows = card.querySelectorAll('tbody tr').map((row) => row.children.map((cell) => cell.textContent));
    equal('the card shows each model and the total across all three windows', rows, [
      ['fallback-b', '1', '1', '1'], ['selected-a', '1', '1', '1'], ['Total', '2', '2', '2'],
    ]);
    ok('local counts stay out of subscription routing', page.$('content').querySelector('.usage-route-seat')?.textContent === 'Quota account');
  }
  page.done();
}

done();
