import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './fixtures/cleanup.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = fs.realpathSync(tempDir('acs-agent-commands-'));
process.env.HOME = home;
const bin = path.join(home, 'bin'); fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, 'cmux'), `#!${process.execPath}\nconsole.log(JSON.stringify(process.argv.includes('identify')?{caller:{workspace_ref:'workspace:1',pane_ref:'pane:1'}}:{text:process.env.FAKE_SCREEN||'Working (30s • esc to interrupt)'}));\n`, { mode: 0o755 });
process.env.PATH = `${bin}:${process.env.PATH}`;
const { waitWorker } = await import('../lib/agent.js');
const ctx = { workspace: 'workspace:1', pane: 'pane:1' };
const records = path.join(home, '.agent-config-studio/agents'); fs.mkdirSync(records, { recursive: true });
const epoch = 1800000000000;
let clock = epoch;
const runtime = { now: () => clock, sleep: async ms => { clock += ms; }, stallAfter: 1, commandAfter: 30 };
const timestamp = new Date(epoch).toISOString();
const task = { type: 'event_msg', payload: { type: 'task_started' }, timestamp };
const command = 'python3 -c "import time; time.sleep(600)"';
const begin = (vendor, id = 'a', stamp = timestamp) => vendor === 'claude'
  ? { type: 'assistant', timestamp: stamp, message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } }
  : vendor === 'codex' ? { type: 'response_item', timestamp: stamp, payload: { type: 'function_call', name: 'exec_command', call_id: id, arguments: JSON.stringify({ cmd: command }) } }
    : { type: 'assistant', timestamp: stamp, tool_calls: [{ id, name: 'shell', arguments: JSON.stringify({ command }) }], content: '' };
const end = (vendor, id = 'a') => vendor === 'claude' ? { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'finished', is_error: true }] } }
  : vendor === 'codex' ? { type: 'response_item', payload: { type: 'function_call_output', call_id: id, output: 'finished' } }
    : { type: 'tool_result', tool_call_id: id, content: 'finished' };
const started = vendor => vendor === 'codex' ? task : vendor === 'claude' ? { type: 'user', message: { content: 'task' } } : { type: 'turn_started' };
function worker(vendor, entries) {
  const id = crypto.randomUUID(), runDir = path.join(records, id); fs.mkdirSync(runDir);
  const transcript = path.join(runDir, 'events.jsonl');
  fs.writeFileSync(transcript, [started(vendor), ...(vendor === 'grok' ? [] : entries)].map(e => JSON.stringify(e) + '\n').join(''));
  const source = vendor === 'grok' ? path.join(runDir, 'chat_history.jsonl') : transcript;
  if (vendor === 'grok') fs.writeFileSync(source, entries.map(e => JSON.stringify(e) + '\n').join(''));
  fs.utimesSync(transcript, epoch / 1000, epoch / 1000);
  const w = { id, vendor, cwd: runDir, runDir, transcript, session: id, surface_ref: `surface:${id}`, surface_id: id, workspace: ctx.workspace, orchestratorPane: ctx.pane, status: 'running', openedAt: epoch, lastActivityAt: epoch, completed: 0, turnComplete: 0, eventStart: 0, baseline: [] };
  fs.writeFileSync(path.join(records, `${id}.json`), JSON.stringify(w));
  return { ...w, source };
}
const append = (w, entry) => { fs.appendFileSync(w.source, JSON.stringify(entry) + '\n'); fs.utimesSync(w.source, clock / 1000, clock / 1000); };
for (const vendor of ['claude', 'codex', 'grok']) {
  clock = epoch;
  process.env.FAKE_SCREEN = vendor === 'claude' ? '✻ Churning… (1s · esc to interrupt)' : vendor === 'grok' ? 'Thinking… 1s' : 'Working (1s • esc to interrupt)';
  const w = worker(vendor, [begin(vendor)]);
  assert.equal((await waitWorker(w.id, 0, ctx, runtime)).state, 'timeout');
  clock += 29999;
  process.env.FAKE_SCREEN = process.env.FAKE_SCREEN.replace('1s', '30s');
  assert.equal((await waitWorker(w.id, 0, ctx, runtime)).state, 'timeout', 'open tool is not stalled at the thinking threshold');
  clock++;
  const long = await waitWorker(w.id, 0, ctx, runtime);
  assert.equal(long.state, 'long_command', vendor); assert.equal(long.command, command);
  append(w, end(vendor, 'different'));
  assert.equal((await waitWorker(w.id, 0, ctx, runtime)).state, 'long_command', 'only matching results close a call');
  clock += 1000; append(w, { type: 'progress', content: 'still running' });
  assert.equal((await waitWorker(w.id, 0, ctx, runtime)).state, 'long_command', 'progress and output growth do not reset command age');
  append(w, end(vendor));
  assert.equal((await waitWorker(w.id, 0, ctx, runtime)).state, 'timeout', 'an error result also closes its call');
  process.env.FAKE_SCREEN = 'No running indicator'; clock += 30000;
  assert.equal((await waitWorker(w.id, 0, ctx, runtime)).state, 'stalled', 'a quiet turn after the tool result can stall');
  clock = epoch;
  const parallel = worker(vendor, [begin(vendor, 'a'), begin(vendor, 'b', new Date(epoch + 5000).toISOString())]);
  append(parallel, end(vendor, 'b')); clock += 30000;
  assert.equal((await waitWorker(parallel.id, 0, ctx, runtime)).state, 'long_command', 'another tool result does not hide the oldest open call');
  const younger = worker(vendor, [begin(vendor, 'a'), begin(vendor, 'b', new Date(epoch + 5000).toISOString()), end(vendor, 'a')]);
  assert.equal((await waitWorker(younger.id, 0, ctx, runtime)).state, 'timeout', 'the remaining call keeps its own younger age');
  clock += 5000;
  assert.equal((await waitWorker(younger.id, 0, ctx, runtime)).state, 'long_command');
  clock = epoch;
  const anonymous = worker(vendor, [begin(vendor, null)]);
  await waitWorker(anonymous.id, 0, ctx, runtime);
  clock += 30000;
  assert.equal((await waitWorker(anonymous.id, 0, ctx, runtime)).state, 'long_command', 'missing IDs do not hide an open tool');
  append(anonymous, end(vendor, null));
  assert.equal((await waitWorker(anonymous.id, 0, ctx, runtime)).state, 'timeout');
}
process.env.FAKE_SCREEN = 'No running indicator';
for (const [call, output] of [
  [{ type: 'response_item', timestamp, payload: { type: 'custom_tool_call', call_id: 'custom', name: 'apply_patch', input: 'patch text' } }, { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'custom', output: 'ok' } }],
  [{ type: 'event_msg', timestamp, payload: { type: 'exec_command_begin', call_id: 'exec', command: ['sleep', '600'] } }, { type: 'event_msg', payload: { type: 'exec_command_end', call_id: 'exec', exit_code: 0 } }],
]) {
  clock = epoch + 30000;
  const w = worker('codex', [call]);
  assert.equal((await waitWorker(w.id, 0, ctx, runtime)).state, 'long_command');
  append(w, output);
  assert.equal((await waitWorker(w.id, 0, ctx, runtime)).state, 'timeout');
}
clock = epoch;
const observed = worker('claude', [begin('claude', 'undated', undefined)]);
const undated = JSON.parse(fs.readFileSync(observed.source, 'utf8').trim().split('\n').at(-1)); delete undated.timestamp;
fs.writeFileSync(observed.source, JSON.stringify(started('claude')) + '\n' + JSON.stringify(undated) + '\n');
await waitWorker(observed.id, 0, ctx, runtime);
clock += 30000;
assert.equal((await waitWorker(observed.id, 0, ctx, runtime)).state, 'long_command', 'undated calls retain their first observation between waits');
clock = epoch + 599999;
const defaults = worker('codex', [begin('codex')]);
assert.equal((await waitWorker(defaults.id, 0, ctx, { ...runtime, commandAfter: undefined })).state, 'timeout');
clock++;
assert.equal((await waitWorker(defaults.id, 0, ctx, { ...runtime, commandAfter: undefined })).state, 'long_command');
clock = epoch; const screenTool = worker('grok', []);
process.env.FAKE_SCREEN = `Running: ${command}`;
assert.equal((await waitWorker(screenTool.id, 0, ctx, runtime)).state, 'timeout');
clock += 30000;
assert.equal((await waitWorker(screenTool.id, 0, ctx, runtime)).command, command, 'Grok falls back to an explicit running-command screen row');
process.env.FAKE_SCREEN = 'Thinking… 30s';
assert.equal((await waitWorker(screenTool.id, 0, ctx, runtime)).state, 'timeout');
const cli = args => spawnSync(process.execPath, [path.join(root, 'bin/agent.mjs'), ...args], { env: { ...process.env, CMUX_SOCKET_PATH: 'fake', CMUX_WORKSPACE_ID: ctx.workspace }, encoding: 'utf8' });
const cliLong = worker('claude', [begin('claude', 'cli', new Date(Date.now() - 31000).toISOString())]);
const result = cli(['wait', cliLong.id, '--timeout', '0', '--command-after', '30', '--json']);
assert.equal(result.status, 9, result.stderr); assert.equal(JSON.parse(result.stdout).command, command);
const plain = cli(['wait', cliLong.id, '--timeout', '0', '--command-after', '30']);
assert.equal(plain.status, 9); assert.match(plain.stdout, /^long_command\npython3/);
for (const invalid of ['-1', 'NaN', 'Infinity']) assert.equal(cli(['wait', cliLong.id, '--command-after', invalid]).status, 2);
assert.match(cli(['--help']).stdout, /--command-after/);
console.log('agent open-tool matching, command age, parallel calls, Grok fallback, true stalls, default deadline and CLI exit 9 passed');
