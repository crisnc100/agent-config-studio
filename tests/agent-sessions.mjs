import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './fixtures/cleanup.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = fs.realpathSync(tempDir('acs-agent-sessions-'));
process.env.HOME = home;
const bin = path.join(home, 'bin'); fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, 'cmux'), `#!${process.execPath}\nconsole.log(JSON.stringify(process.argv.includes('identify')?{caller:{workspace_ref:'workspace:1',pane_ref:'pane:1'}}:{text:'Worker screen'}));\n`, { mode: 0o755 });
process.env.PATH = `${bin}:${process.env.PATH}`;
const { waitWorker } = await import('../lib/agent.js');
const ctx = { workspace: 'workspace:1', pane: 'pane:1' };
const records = path.join(home, '.agent-config-studio/agents'); fs.mkdirSync(records, { recursive: true });
const eventFile = path.join(home, '.cmuxterm/events.jsonl'); fs.mkdirSync(path.dirname(eventFile)); fs.writeFileSync(eventFile, '');
const epoch = 1800000000000;
let clock = epoch;
const runtime = { now: () => clock, sleep: async ms => { clock += ms; }, commandAfter: 30 };
const stamp = new Date(epoch).toISOString();
const encode = (vendor, id) => `cmux-feed-v1:${Buffer.from(vendor).toString('base64')}:${Buffer.from(id).toString('base64')}`;
const encoded = 'cmux-feed-v1:Y2xhdWRl:MDljZTA3N2ItYzUzNy00MjQ0LTkyZjktYWEyYTJlNGE0Zjgx';
const exactId = '09ce077b-c537-4244-92f9-aa2a2e4a4f81';
const put = (file, content) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); };
const jsonl = entries => entries.map(e => JSON.stringify(e) + '\n').join('');
function worker(vendor, fields = {}) {
  const id = crypto.randomUUID(), cwd = path.join(home, `project.with punctuation_${id}`);
  fs.mkdirSync(cwd);
  const w = { id, vendor, cwd, surface_id: id, surface_ref: `surface:${id}`, workspace: ctx.workspace, orchestratorPane: ctx.pane, status: 'running', session: null, transcript: null, openedAt: epoch, lastActivityAt: epoch, completed: 0, turnComplete: 0, eventStart: 0, baseline: [], ...fields };
  put(path.join(records, `${id}.json`), JSON.stringify(w)); return w;
}
const record = w => JSON.parse(fs.readFileSync(path.join(records, `${w.id}.json`)));
function hook(w, session, payload = false, timestamp = stamp) {
  fs.appendFileSync(eventFile, jsonl([{ name: 'agent.hook.SessionStart', surface_id: w.surface_id, occurred_at: timestamp, ...(payload ? { payload: { session_id: session } } : { session_id: session }) }]));
}
function transcript(w, session, entries = []) {
  const file = w.vendor === 'claude' ? path.join(home, '.claude/projects', `different-project-encoding-${w.id}`, `${session}.jsonl`)
    : w.vendor === 'codex' ? path.join(home, '.codex/sessions/2027/01/15', `rollout-${session}.jsonl`)
      : path.join(home, '.grok/sessions', w.cwd.replace(/\//g, '%2F'), session, 'events.jsonl');
  const initial = w.vendor === 'codex' ? [{ type: 'session_meta', payload: { id: session, cwd: w.cwd } }, { type: 'event_msg', payload: { type: 'task_started' } }]
    : w.vendor === 'claude' ? [{ type: 'user', cwd: w.cwd, message: { content: 'task' } }] : [{ type: 'turn_started' }];
  put(file, jsonl([...initial, ...entries])); fs.utimesSync(file, epoch / 1000, epoch / 1000); return file;
}
const claude = worker('claude');
hook(claude, encoded);
const file = transcript(claude, exactId, [{ type: 'assistant', timestamp: stamp, message: { content: [{ type: 'tool_use', id: 'sleep', name: 'Bash', input: { command: 'python3 -c "import time; time.sleep(600)"' } }] } }]);
clock += 30000;
const result = await waitWorker(claude.id, 0, ctx, runtime);
assert.equal(result.state, 'long_command', 'exact live encoded session resolves the open tool');
assert.match(result.command, /time.sleep/); assert.equal(record(claude).session, exactId); assert.equal(record(claude).transcript, file);
assert.ok(!result.transcriptMissing);
for (const vendor of ['codex', 'grok']) {
  clock = epoch;
  const w = worker(vendor), session = crypto.randomUUID();
  hook(w, encode(vendor, session), true);
  const file = transcript(w, session);
  await waitWorker(w.id, 0, ctx, runtime);
  assert.equal(record(w).session, session); assert.equal(record(w).transcript, file, `${vendor}: encoded hook before file discovery`);
}
clock = epoch;
const late = worker('codex'), session = crypto.randomUUID();
const rollout = transcript(late, session);
await waitWorker(late.id, 0, ctx, runtime);
assert.equal(record(late).transcript, rollout, 'Codex cwd discovery works before a hook exists');
hook(late, encode('codex', session));
await waitWorker(late.id, 0, ctx, runtime);
assert.equal(record(late).session, session, 'late encoded hooks do not break pinned rollouts');
const pinned = worker('codex'), pinnedSession = crypto.randomUUID();
const pinnedFile = transcript(pinned, pinnedSession);
put(path.join(records, `${pinned.id}.json`), JSON.stringify({ ...pinned, session: encode('codex', pinnedSession), transcript: pinnedFile }));
await waitWorker(pinned.id, 0, ctx, runtime);
assert.equal(record(pinned).session, pinnedSession, 'already pinned records also normalize encoded session ids');
clock = epoch;
const migrated = worker('claude', { session: encode('claude', exactId + '-saved') });
const migratedFile = transcript(migrated, exactId + '-saved');
await waitWorker(migrated.id, 0, ctx, runtime);
assert.equal(record(migrated).session, exactId + '-saved'); assert.equal(record(migrated).transcript, migratedFile, 'existing encoded registry records recover');
for (const vendor of ['claude', 'codex', 'grok']) {
  clock = epoch;
  const missing = worker(vendor), id = crypto.randomUUID(); hook(missing, encode(vendor, id));
  clock += 29999;
  assert.ok(!(await waitWorker(missing.id, 0, ctx, runtime)).transcriptMissing);
  clock++;
  assert.equal((await waitWorker(missing.id, 0, ctx, runtime)).transcriptMissing, true, `${vendor}: exact 30-second boundary`);
  const file = transcript(missing, id);
  assert.ok(!(await waitWorker(missing.id, 0, ctx, runtime)).transcriptMissing, 'a late transcript clears the diagnostic');
  assert.equal(record(missing).transcript, file);
}
clock = epoch;
const undated = worker('claude'); hook(undated, encode('claude', crypto.randomUUID()), false, 'invalid');
assert.ok(!(await waitWorker(undated.id, 0, ctx, runtime)).transcriptMissing);
clock += 30000;
assert.equal((await waitWorker(undated.id, 0, ctx, runtime)).transcriptMissing, true, 'missing event timestamp uses persistent first observation');
clock = epoch;
const doneMissing = worker('claude'); hook(doneMissing, encode('claude', crypto.randomUUID()));
fs.appendFileSync(eventFile, jsonl([{ name: 'agent.hook.Stop', surface_id: doneMissing.surface_id, occurred_at: stamp }]));
clock += 30000;
const doneResult = await waitWorker(doneMissing.id, 0, ctx, runtime);
assert.equal(doneResult.state, 'done'); assert.equal(doneResult.transcriptMissing, true, 'completion from hooks still reports a missing transcript');
for (const session of ['cmux-feed-v1:!!!:bad', encode('grok', 'foreign'), 'cmux-feed-v1:Y2xhdWRl:']) {
  clock = epoch;
  const malformed = worker('claude'); hook(malformed, session);
  await waitWorker(malformed.id, 0, ctx, runtime);
  assert.equal(record(malformed).session, null, 'invalid or foreign encodings cannot pin a session');
}
const cliWorker = worker('claude'); hook(cliWorker, encoded, false, new Date(Date.now() - 31000).toISOString());
const cli = spawnSync(process.execPath, [path.join(root, 'bin/agent.mjs'), 'wait', cliWorker.id, '--timeout', '0', '--json'], { env: { ...process.env, CMUX_SOCKET_PATH: 'fake', CMUX_WORKSPACE_ID: ctx.workspace }, encoding: 'utf8' });
assert.equal(cli.status, 4, cli.stderr); assert.equal(JSON.parse(cli.stdout).transcriptMissing, true);
console.log('agent encoded sessions, Claude filename discovery, Codex ordering, registry recovery and missing-transcript diagnostics passed');
