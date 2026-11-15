import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './fixtures/cleanup.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = fs.realpathSync(tempDir('acs-agent-reliability-'));
process.env.HOME = home;
const fake = path.join(home, 'bin');
fs.mkdirSync(fake);
fs.writeFileSync(path.join(fake, 'cmux'), `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(path.join(home, 'cmux-calls'))}, JSON.stringify(process.argv.slice(2))+'\\n');console.log(JSON.stringify(process.argv.includes('identify') ? {caller:{workspace_ref:'workspace:1',pane_ref:'pane:1'}} : {text:process.env.FAKE_AGENT_SCREEN || 'history\\n› [Pasted Content]'}));\n`, { mode: 0o755 });
process.env.PATH = `${fake}:${process.env.PATH}`;
const { waitWorker, sendWorker } = await import('../lib/agent.js');
const ctx = { workspace: 'workspace:1', pane: 'pane:1' };
const records = path.join(home, '.agent-config-studio/agents');
fs.mkdirSync(records, { recursive: true });
fs.mkdirSync(path.join(home, '.cmuxterm'));
fs.writeFileSync(path.join(home, '.cmuxterm/events.jsonl'), '');
const write = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
const append = (f, e) => fs.appendFileSync(f, JSON.stringify(e) + '\n');
const epoch = 1800000000000;
let clock = epoch;
const runtime = { now: () => clock, sleep: async ms => { clock += ms; } };
function worker(vendor, entries = [], missing = false) {
  const id = crypto.randomUUID();
  const runDir = path.join(records, id);
  fs.mkdirSync(runDir);
  const transcript = missing ? null : path.join(runDir, 'events.jsonl');
  if (transcript) { write(transcript, entries.map(e => JSON.stringify(e) + '\n').join('')); fs.utimesSync(transcript, epoch / 1000, epoch / 1000); }
  const w = { id, vendor, family: vendor, cwd: runDir, workspace: ctx.workspace, orchestratorPane: ctx.pane, surface_ref: `surface:${id}`, surface_id: id, session: missing ? null : id, transcript, runDir, status: 'running', openedAt: epoch, lastActivityAt: epoch, finishedAt: null, completed: 0, turnComplete: 0, eventStart: 0, turnEventStart: 0, baseline: [] };
  write(path.join(records, `${id}.json`), JSON.stringify(w));
  return w;
}
function record(w) { return JSON.parse(fs.readFileSync(path.join(records, `${w.id}.json`))); }
function change(w, fields) { write(path.join(records, `${w.id}.json`), JSON.stringify({ ...record(w), ...fields })); }
const ev = (type, fields = {}) => ({ type: 'event_msg', payload: { type, ...fields }, timestamp: new Date(epoch).toISOString() });
clock = epoch + 59999;
const absent = worker('codex', [], true);
assert.equal((await waitWorker(absent.id, 0, ctx, { ...runtime, stallAfter: 30 })).state, 'timeout');
clock++;
assert.equal((await waitWorker(absent.id, 0, ctx, runtime)).state, 'no_start');
clock = epoch;
const question = worker('codex', [ev('task_started'), ev('task_complete', { last_agent_message: 'Need a choice.\nQUESTION: Which branch?\n\n' })]);
const q = await waitWorker(question.id, 0, ctx, runtime);
assert.equal(q.state, 'done'); assert.equal(q.question, true); assert.equal(q.text, 'Need a choice.\nQUESTION: Which branch?\n\n');
const notLast = worker('codex', [ev('task_complete', { last_agent_message: 'QUESTION: Old question\nResolved.' })]);
assert.ok(!(await waitWorker(notLast.id, 0, ctx, runtime)).question);
const steps = [1, 2, 3, 4].map(i => ({ type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: `step ${i}` }) } }));
const stalled = worker('codex', [ev('task_started'), ...steps]);
clock = epoch + 29999;
assert.equal((await waitWorker(stalled.id, 0, ctx, { ...runtime, stallAfter: 30 })).state, 'timeout');
clock++;
const stall = await waitWorker(stalled.id, 0, ctx, { ...runtime, stallAfter: 30 });
assert.equal(stall.state, 'stalled'); assert.equal(stall.steps.length, 3); assert.match(stall.steps[0], /step 2/); assert.match(stall.steps[2], /step 4/);
append(stalled.transcript, ev('token_count'));
fs.utimesSync(stalled.transcript, clock / 1000, clock / 1000);
assert.equal((await waitWorker(stalled.id, 0, ctx, { ...runtime, stallAfter: 30 })).state, 'timeout');
clock += 30000;
assert.equal((await waitWorker(stalled.id, 0, ctx, { ...runtime, stallAfter: 30 })).state, 'stalled');
const noTurn = worker('codex', [ev('user_message', { message: 'composer only' })]);
assert.equal((await waitWorker(noTurn.id, 0, ctx, { ...runtime, stallAfter: 1 })).state, 'timeout');
const blocked = worker('claude', [{ type: 'user', message: { role: 'user', content: 'task' } }]);
append(path.join(home, '.cmuxterm/events.jsonl'), { name: 'agent.hook.PermissionRequest', surface_id: blocked.surface_id });
assert.equal((await waitWorker(blocked.id, 0, ctx, runtime)).state, 'stuck');
for (const vendor of ['codex', 'claude', 'grok']) {
  clock = epoch;
  const w = worker(vendor);
  change(w, { pendingSend: { sentAt: epoch, startedBefore: 0 } });
  if (vendor === 'codex') append(w.transcript, ev('user_message', { message: 'not started' }));
  clock += 9999;
  assert.equal((await waitWorker(w.id, 0, ctx, runtime)).state, 'timeout');
  clock++;
  const unsent = await waitWorker(w.id, 0, ctx, runtime);
  assert.equal(unsent.state, 'unsent'); assert.match(unsent.input, /Pasted Content/);
  append(w.transcript, vendor === 'codex' ? ev('task_started') : vendor === 'claude' ? { type: 'user', message: { content: 'submitted' } } : { type: 'turn_started' });
  fs.utimesSync(w.transcript, clock / 1000, clock / 1000);
  assert.equal((await waitWorker(w.id, 0, ctx, runtime)).state, 'timeout');
}
// Sending waits for task_started, even when a user-message line already exists.
clock = epoch;
const send = worker('codex');
let emittedUser = false;
const successful = { now: () => clock, sleep: async ms => {
  clock += ms;
  if (!emittedUser) { emittedUser = true; append(send.transcript, ev('user_message', { message: 'received' })); }
  if (clock - epoch >= 1500 && !record(send).pendingSend?.confirmedAt) append(send.transcript, ev('task_started'));
} };
assert.equal((await sendWorker(send.id, 'short message', ctx, successful)).status, 'running');
assert.ok(clock - epoch >= 1500);
const long = worker('codex');
clock = epoch;
let started = false;
const longRuntime = { now: () => clock, sleep: async ms => { clock += ms; if (!started) { append(long.transcript, ev('task_started')); started = true; } } };
const longText = 'a'.repeat(401);
await sendWorker(long.id, longText, ctx, longRuntime);
const calls = fs.readFileSync(path.join(home, 'cmux-calls'), 'utf8').trim().split('\n').map(JSON.parse);
const sent = calls.filter(a => a.includes('send')).at(-1).at(-1);
assert.match(sent, /^Read .+ and follow it\.$/);
const messagePath = sent.slice(5, -15);
assert.equal(fs.readFileSync(messagePath, 'utf8'), longText);
assert.ok(messagePath.startsWith(long.runDir + path.sep));
clock = epoch;
const failed = worker('codex');
await assert.rejects(sendWorker(failed.id, 'unsubmitted', ctx, runtime), /submission/);
assert.ok(clock - epoch >= 10000);
assert.equal((await waitWorker(failed.id, 0, ctx, runtime)).state, 'unsent');
console.log('agent reliability states, fake clock, turn proof and long sends passed');

clock = epoch + 59000;
const waking = worker('codex', [], true);
assert.equal((await waitWorker(waking.id, 5, ctx, runtime)).state, 'no_start');
assert.equal(clock, epoch + 60000);
for (const vendor of ['claude', 'grok']) {
  clock = epoch + 30000;
  const toolEntries = vendor === 'claude' ? [
    { type: 'user', message: { content: 'task' } },
    ...[1, 2, 3, 4].map(i => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: `command ${i}` } }] } })),
  ] : [{ type: 'turn_started' }, ...[1, 2, 3, 4].map(i => ({ type: 'tool_call', name: 'shell', input: { command: `command ${i}` } }))];
  const toolWorker = worker(vendor, toolEntries);
  const toolStall = await waitWorker(toolWorker.id, 0, ctx, { ...runtime, stallAfter: 30 });
  assert.equal(toolStall.state, 'stalled'); assert.equal(toolStall.steps.length, 3); assert.match(toolStall.steps[2], /command 4/);
}
const defaultStall = worker('codex', [ev('task_started')]);
clock = epoch + 299999;
assert.equal((await waitWorker(defaultStall.id, 0, ctx, runtime)).state, 'timeout');
clock++;
assert.equal((await waitWorker(defaultStall.id, 0, ctx, runtime)).state, 'stalled');
const earlier = worker('codex', [ev('task_started')]);
append(path.join(home, '.cmuxterm/events.jsonl'), { name: 'agent.hook.PermissionRequest', surface_id: earlier.surface_id, occurred_at: new Date(epoch + 10000).toISOString() });
clock = epoch + 60000;
assert.equal((await waitWorker(earlier.id, 0, ctx, { ...runtime, stallAfter: 30 })).state, 'stuck');
assert.equal((await waitWorker(earlier.id, 0, ctx, { ...runtime, stallAfter: 5 })).state, 'stalled');
const cli = args => spawnSync(process.execPath, [path.join(root, 'bin/agent.mjs'), ...args], { env: { ...process.env, CMUX_SOCKET_PATH: 'fake', CMUX_WORKSPACE_ID: 'workspace:1' }, encoding: 'utf8' });
const noStartCli = worker('codex', [], true);
change(noStartCli, { openedAt: Date.now() - 61000 });
const unsentCli = worker('codex');
change(unsentCli, { pendingSend: { sentAt: Date.now() - 11000, startedBefore: 0 } });
const stalledCli = worker('codex', [ev('task_started'), ...steps]);
fs.utimesSync(stalledCli.transcript, (Date.now() - 31000) / 1000, (Date.now() - 31000) / 1000);
for (const [w, state, code, extra] of [[noStartCli, 'no_start', 6, []], [unsentCli, 'unsent', 5, []], [stalledCli, 'stalled', 7, ['--stall-after', '30']], [question, 'done', 0, []]]) {
  const r = cli(['wait', w.id, '--timeout', '0', '--json', ...extra]);
  assert.equal(r.status, code, r.stderr); assert.equal(JSON.parse(r.stdout).state, state);
}
assert.equal(cli(['wait', stalledCli.id, '--stall-after', '-1']).status, 2);
console.log('agent all vendors, first signal, default stall threshold and CLI exit codes passed');

for (const vendor of ['claude', 'grok']) {
  clock = epoch;
  const w = worker(vendor, vendor === 'claude' ? [{ type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'QUESTION: Continue?' }] } }] : [{ type: 'turn_ended' }]);
  if (vendor === 'grok') write(path.join(w.runDir, 'chat_history.jsonl'), JSON.stringify({ role: 'assistant', content: 'QUESTION: Continue?' }) + '\n');
  const result = await waitWorker(w.id, 0, ctx, runtime);
  assert.equal(result.state, 'done'); assert.equal(result.question, true); assert.equal(result.text, 'QUESTION: Continue?');
}
const screenQuestion = worker('grok', [{ type: 'turn_ended' }]);
process.env.FAKE_AGENT_SCREEN = 'QUESTION: Screen fallback?';
assert.equal((await waitWorker(screenQuestion.id, 0, ctx, runtime)).question, true);
delete process.env.FAKE_AGENT_SCREEN;
console.log('agent question detection covers all vendors and Grok screen fallback');

clock = epoch + 30000;
const historyTools = worker('grok', [{ type: 'turn_started' }]);
write(path.join(historyTools.runDir, 'chat_history.jsonl'), [1, 2, 3, 4].map(i => JSON.stringify({ type: 'tool_call', name: 'shell', content: `history command ${i}` }) + '\n').join(''));
assert.match((await waitWorker(historyTools.id, 0, ctx, { ...runtime, stallAfter: 30 })).steps.at(-1), /history command 4/);
console.log('agent stalled diagnostics use Grok chat history when available');
