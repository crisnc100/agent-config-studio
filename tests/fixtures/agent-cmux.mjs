import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const home = process.env.HOME;
const file = path.join(home, 'fake-cmux.json');
const state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { n: 0, calls: [], workers: {} };
const args = process.argv.slice(2);
state.panes ||= ['pane:1'];
const verbs = ['list-panes', 'identify', 'new-pane', 'new-surface', 'focus-pane', 'send', 'send-key', 'read-screen', 'close-surface', 'list-pane-surfaces'];
const cmd = args.find(a => verbs.includes(a));
const opt = k => args[args.indexOf(k) + 1];
state.calls.push(args);
// A leaked home override must fail before synthetic sessions can touch real harness files.
const put = (f, data) => {
  const relative = path.relative(home, f);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('fake cmux refuses writes outside its temporary HOME');
  fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data);
};
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
function fail(code) {
  put(file, JSON.stringify(state));
  if (process.env.FAKE_ERROR_STYLE === 'stderr') console.error(`Error: ${code}: Surface not found for the given surface_id`);
  else console.log(JSON.stringify({ ok: false, error: { code, message: 'Surface not found for the given surface_id' } }));
  process.exit(1);
}
let out = {};
if (cmd === 'list-panes') out = { panes: state.panes.map(pane_ref => ({ pane_ref })) };
if (cmd === 'new-surface' && process.env.FAKE_NEW_SURFACE_ERROR) fail(process.env.FAKE_NEW_SURFACE_ERROR);
if (cmd === 'new-surface' && !state.panes.includes(opt('--pane'))) fail('not_found');
if (cmd === 'new-pane' && process.env.FAKE_NEW_PANE_ERROR) fail(process.env.FAKE_NEW_PANE_ERROR);
if (cmd === 'read-screen' && process.env.FAKE_READ_SCREEN_ERROR) fail(process.env.FAKE_READ_SCREEN_ERROR);
if (cmd === 'list-pane-surfaces' && !state.panes.includes(opt('--pane'))) fail('not_found');
if (cmd === 'identify') out = { caller: { workspace_ref: 'workspace:1', pane_ref: process.env.FAKE_PANE || 'pane:1' } };
if (cmd === 'new-pane' || cmd === 'new-surface') {
  const n = ++state.n;
  const script = fs.readFileSync(opt('--command'), 'utf8');
  const vendor = script.includes('exec codex ') ? 'codex' : script.includes('exec claude ') ? 'claude' : 'grok';
  const cwd = script.match(/cd '((?:[^']|'\\'')*)'/)[1].replace(/'\\''/g, "'");
  const session = `session-${randomUUID()}`;
  const w = { vendor, cwd, session, surface_id: `UUID-${n}`, surface_ref: `surface:${n + 10}` };
  if (vendor === 'codex') {
    w.transcript = path.join(process.env.CODEX_HOME || path.join(home, '.codex'), 'sessions/2026/11/14', `rollout-${session}.jsonl`);
    put(w.transcript, line({ type: 'session_meta', payload: { id: session, cwd } }));
  } else if (vendor === 'claude') {
    w.transcript = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'projects', cwd.replace(/\//g, '-'), `${session}.jsonl`);
    put(w.transcript, '');
  } else {
    w.transcript = path.join(process.env.GROK_HOME || path.join(home, '.grok'), 'sessions', cwd.replace(/\//g, '%2F'), session, 'events.jsonl');
    w.history = path.join(path.dirname(w.transcript), 'chat_history.jsonl');
    put(w.transcript, ''); put(w.history, '');
  }
  const events = path.join(home, '.cmuxterm/events.jsonl');
  if (!fs.existsSync(events)) put(events, '');
  fs.appendFileSync(events, line({ name: 'agent.hook.SessionStart', surface_id: w.surface_id, session_id: session, occurred_at: new Date().toISOString() }));
  turn(w, 'initial', !process.env.FAKE_RUNNING);
  w.pane_ref = cmd === 'new-pane' ? `pane:${n + 10}` : opt('--pane');
  if (cmd === 'new-pane') state.panes.push(w.pane_ref);
  state.workers[w.surface_ref] = w;
  out = { ...w };
}
function permission(w) {
  w.screen = 'Do you want to proceed?\n1. Yes\n2. No';
  fs.appendFileSync(path.join(home, '.cmuxterm/events.jsonl'), line({ name: 'agent.hook.PermissionRequest', surface_id: w.surface_id, occurred_at: new Date().toISOString() }));
}
if (cmd === 'send') {
  const w = state.workers[opt('--surface')]; w.pending = (w.pending || '') + args.at(-1); w.enters = 0;
  if (process.env.FAKE_PERMISSION_ON_SEND) permission(w);
}
if (cmd === 'send-key') {
  const w = state.workers[opt('--surface')];
  if (++w.enters === 1 && process.env.FAKE_PERMISSION_AFTER_ENTER) permission(w);
  if (w.enters === 2 && !process.env.FAKE_NO_SUBMIT) { turn(w, w.pending); w.pending = ''; }
}
if (cmd === 'read-screen' || cmd === 'close-surface') {
  const w = state.workers[opt('--surface')];
  if (cmd === 'read-screen' && process.env.FAKE_REMOVE_AFTER_READ && (state.removalReads = (state.removalReads || 0) + 1) > 1) w.closed = true;
  if (!w || w.closed || !state.panes.includes(w.pane_ref)) fail('not_found');
  if (cmd === 'close-surface') w.closed = true;
  else {
    const events = fs.readFileSync(path.join(home, '.cmuxterm/events.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse);
    const pending = events.some(e => e.surface_id === w.surface_id && e.name === 'agent.hook.PermissionRequest');
    out = { text: w.screen ?? (pending || w.vendor === 'grok' && !fs.existsSync(w.history) ? 'Allow this command?\n1. Yes' : 'Worker screen') };
  }
}
if (cmd === 'list-pane-surfaces') out = { surfaces: Object.values(state.workers).filter(w => !w.closed && (!args.includes('--pane') || w.pane_ref === opt('--pane'))) };
put(file, JSON.stringify(state));
console.log(JSON.stringify(out));
