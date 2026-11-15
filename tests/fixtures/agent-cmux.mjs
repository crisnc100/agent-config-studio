import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const home = process.env.HOME;
const file = path.join(home, 'fake-cmux.json');
const state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { n: 0, calls: [], workers: {} };
const args = process.argv.slice(2);
const verbs = ['identify', 'new-pane', 'new-surface', 'focus-pane', 'send', 'send-key', 'read-screen', 'close-surface', 'list-pane-surfaces'];
const cmd = args.find(a => verbs.includes(a));
const opt = k => args[args.indexOf(k) + 1];
state.calls.push(args);
const put = (f, data) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); };
const line = x => JSON.stringify(x) + '\n';
function turn(w, text, complete = true) {
  if (w.vendor === 'codex') {
    fs.appendFileSync(w.transcript, line({ type: 'event_msg', payload: { type: 'task_started' } }));
    fs.appendFileSync(w.transcript, line({ type: 'event_msg', payload: { type: 'user_message', message: text } }));
    if (complete) fs.appendFileSync(w.transcript, line({ type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'exact\nanswer  ' } }));
  } else if (w.vendor === 'claude') {
    fs.appendFileSync(w.transcript, line({ type: 'user', message: { role: 'user', content: text } }));
    if (complete) {
      fs.appendFileSync(w.transcript, line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'exact\nanswer  ' }] }, stop_reason: 'end_turn' }));
      fs.appendFileSync(path.join(home, '.cmuxterm/events.jsonl'), line({ name: 'agent.hook.Stop', surface_id: w.surface_id, session_id: w.session, occurred_at: new Date().toISOString() }));
    }
  } else {
    fs.appendFileSync(w.transcript, line({ type: 'turn_started' }));
    fs.appendFileSync(w.history, line({ role: 'user', content: text }));
    if (complete) {
      fs.appendFileSync(w.history, line({ role: 'assistant', content: 'exact\nanswer  ' }));
      fs.appendFileSync(w.transcript, line({ type: 'turn_ended' }));
    }
  }
}
if (process.env.FAKE_OFFLINE) { console.error('socket unreachable'); process.exit(1); }
let out = {};
if (cmd === 'identify') out = { caller: { workspace_ref: 'workspace:1', pane_ref: process.env.FAKE_PANE || 'pane:1' } };
if (cmd === 'new-pane' || cmd === 'new-surface') {
  const n = ++state.n;
  const script = fs.readFileSync(opt('--command'), 'utf8');
  const vendor = script.includes('exec codex ') ? 'codex' : script.includes('exec claude ') ? 'claude' : 'grok';
  const cwd = script.match(/cd '((?:[^']|'\\'')*)'/)[1].replace(/'\\''/g, "'");
  const session = `session-${n}`;
  const w = { vendor, cwd, session, surface_id: `UUID-${n}`, surface_ref: `surface:${n + 10}` };
  if (vendor === 'codex') {
    w.transcript = path.join(home, '.codex/sessions/2026/11/14', `rollout-${session}.jsonl`);
    put(w.transcript, line({ type: 'session_meta', payload: { id: session, cwd } }));
  } else if (vendor === 'claude') {
    w.transcript = path.join(home, '.claude/projects', cwd.replace(/\//g, '-'), `${session}.jsonl`);
    put(w.transcript, '');
  } else {
    w.transcript = path.join(home, '.grok/sessions', cwd.replace(/\//g, '%2F'), session, 'events.jsonl');
    w.history = path.join(path.dirname(w.transcript), 'chat_history.jsonl');
    put(w.transcript, ''); put(w.history, '');
  }
  const events = path.join(home, '.cmuxterm/events.jsonl');
  if (!fs.existsSync(events)) put(events, '');
  fs.appendFileSync(events, line({ name: 'agent.hook.SessionStart', surface_id: w.surface_id, session_id: session, occurred_at: new Date().toISOString() }));
  turn(w, 'initial', !process.env.FAKE_RUNNING);
  state.workers[w.surface_ref] = w;
  out = { ...w, pane_ref: cmd === 'new-pane' ? `pane:${n + 10}` : opt('--pane') };
}
if (cmd === 'send') { state.workers[opt('--surface')].pending = args.at(-1); state.workers[opt('--surface')].enters = 0; }
if (cmd === 'send-key') {
  const w = state.workers[opt('--surface')];
  if (++w.enters === 2 && !process.env.FAKE_NO_SUBMIT) turn(w, w.pending);
}
if (cmd === 'read-screen') out = { text: 'Allow this command?\n1. Yes' };
if (cmd === 'list-pane-surfaces') out = { surfaces: Object.values(state.workers).map(w => ({ ...w, pane_ref: 'pane:1' })) };
put(file, JSON.stringify(state));
console.log(JSON.stringify(out));
