import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readUserText } from './paths.js';
import { homeDir, resolveModel, vendorOf, EFFORTS } from './models.js';
import { ROLE_RE } from './roles.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const quote = s => `'${String(s).replace(/'/g, `'\\''`)}'`;
const bad = message => Object.assign(new Error(message), { exitCode: 2 });
const dir = () => path.join(homeDir(), '.agent-config-studio', 'agents');
const eventFile = () => path.join(homeDir(), '.cmuxterm', 'events.jsonl');
function text(file) {
  try { return readUserText(file); } catch (e) { if (e.code === 'ENOENT') return ''; throw e; }
}
function lines(file) {
  return text(file).split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
}
function children(folder) {
  try { return fs.readdirSync(folder, { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}
function atomic(file, body, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${crypto.randomUUID()}`;
  try { fs.writeFileSync(tmp, body, { flag: 'wx', mode }); fs.renameSync(tmp, file); }
  finally { fs.rmSync(tmp, { force: true }); }
}
function save(w) { atomic(path.join(dir(), `${w.id}.json`), JSON.stringify(w, null, 2) + '\n'); }
function decodeSession(value, vendor) {
  if (typeof value !== 'string' || !value) return null;
  if (!value.startsWith('cmux-feed-v1:')) return value;
  const parts = value.split(':');
  if (parts.length !== 3) return null;
  const decoded = parts.slice(1).map(part => {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(part)) return null;
    const bytes = Buffer.from(part, 'base64');
    return bytes.toString('base64').replace(/=+$/, '') === part.replace(/=+$/, '') ? bytes.toString('utf8') : null;
  });
  return decoded[0] === vendor && decoded[1] && !/[\0\ufffd]/.test(decoded[1]) ? decoded[1] : null;
}
function normalizeWorker(w) { w.session = decodeSession(w.session, w.vendor); return w; }
function all() { return children(dir()).filter(d => d.isFile() && d.name.endsWith('.json')).map(d => normalizeWorker(JSON.parse(readUserText(path.join(dir(), d.name))))); }
function cmuxError(message) { return Object.assign(new Error(`cmux: ${message}`), { cmuxCode: /\bnot_found\b/.test(message) ? 'not_found' : null }); }
function cmux(args) {
  const r = spawnSync('cmux', ['--json', '--id-format', 'both', ...args], { encoding: 'utf8', env: { ...process.env, CMUX_QUIET: '1' }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000, maxBuffer: 8 * 1024 * 1024 });
  if (r.error || r.status !== 0) throw cmuxError(r.error?.message || r.stderr.trim() || r.stdout.trim());
  let result;
  try { result = JSON.parse(r.stdout); } catch {
    if (args[0] === 'read-screen') return r.stdout;
    throw new Error('cmux returned invalid JSON');
  }
  if (result.ok === false || result.error) throw cmuxError(JSON.stringify(result.error || result));
  return result.result || result;
}
function ref(value, type) {
  if (typeof value !== 'string' || (!value.startsWith(`${type}:`) && !/^[a-f\d-]{36}$/i.test(value))) throw new Error(`cmux did not return a ${type} ref`);
  return value;
}
export function context() {
  if (!process.env.CMUX_SOCKET_PATH) throw bad('agent needs cmux: run it inside a cmux terminal');
  let identity;
  try { identity = cmux(['identify']); } catch { throw bad('agent needs cmux: its socket is unreachable'); }
  const caller = identity.caller || {};
  const workspace = process.env.CMUX_WORKSPACE_ID || caller.workspace_ref || identity.workspace_ref;
  let pane = caller.pane_ref;
  if (!pane && process.env.CMUX_SURFACE_ID) {
    const out = cmux(['identify', '--workspace', ref(workspace, 'workspace'), '--surface', process.env.CMUX_SURFACE_ID]);
    pane = out.caller?.pane_ref || out.surface?.pane_ref || out.pane_ref;

  }
  return { workspace: ref(workspace, 'workspace'), pane: ref(pane, 'pane') };
}
function owned(w, ctx) { return w.workspace === ctx.workspace && w.orchestratorPane === ctx.pane; }
function homeVariable(vendor) { return { codex: 'CODEX_HOME', claude: 'CLAUDE_CONFIG_DIR', grok: 'GROK_HOME' }[vendor]; }
export function worker(id, ctx) {
  if (!/^[a-f\d-]{36}$/i.test(id || '')) throw bad('invalid worker id');
  const w = normalizeWorker(JSON.parse(readUserText(path.join(dir(), `${id}.json`))));
  if (!owned(w, ctx)) throw bad('worker belongs to another orchestrator');
  return w;
}
function candidates(w) {
  const home = homeDir();
  const harnessHome = w.harnessHome || path.join(home, `.${w.vendor}`);
  if (w.vendor === 'codex') {
    const root = path.join(harnessHome, 'sessions');
    let dirs = [root];
    for (let i = 0; i < 3; i++) dirs = dirs.flatMap(d => children(d).filter(e => e.isDirectory()).map(e => path.join(d, e.name)));
    return dirs.flatMap(d => children(d).filter(e => e.isFile() && /^rollout-.*\.jsonl$/.test(e.name)).map(e => path.join(d, e.name)));
  }
  if (w.vendor === 'claude') {
    const root = path.join(harnessHome, 'projects');
    return children(root).filter(e => e.isDirectory()).flatMap(d => children(path.join(root, d.name)).filter(e => e.isFile() && e.name.endsWith('.jsonl') && (!w.session || e.name === `${w.session}.jsonl`)).map(e => path.join(root, d.name, e.name)));
  }
  const root = path.join(harnessHome, 'sessions', w.cwd.replace(/\//g, '%2F'));
  return children(root).filter(e => e.isDirectory()).map(e => path.join(root, e.name, 'events.jsonl'));
}
function hooks(w) {
  return [...new Map(lines(eventFile()).slice(w.eventStart).filter(e => String(e.surface_id || '').toLowerCase() === String(w.surface_id).toLowerCase()).map(e => [JSON.stringify(e), e])).values()];
}
function discover(w, events, at = Date.now()) {
  normalizeWorker(w);
  const session = e => decodeSession(e.session_id, w.vendor) || decodeSession(e.payload?.session_id, w.vendor);
  const start = events.find(e => e.name === 'agent.hook.SessionStart' && session(e) && (!w.session || session(e) === w.session));
  w.session ||= start ? session(start) : null;
  if (w.session && w.sessionStartedAt == null) {
    const stamp = Date.parse(start?.occurred_at || start?.timestamp || start?.ts || '');
    w.sessionStartedAt = Number.isFinite(stamp) ? stamp : at;
  }
  if (w.transcript) return;
  const peers = all().filter(r => r.id !== w.id);
  const claimed = new Set(peers.map(r => r.transcript).filter(Boolean));
  if (!w.session && peers.some(r => r.vendor === w.vendor && r.cwd === w.cwd && !r.session && r.status !== 'closed')) return;
  const matches = candidates(w).filter(f => {
    if (claimed.has(f) || w.baseline.includes(f)) return false;
    if (w.vendor === 'codex') {
      const meta = lines(f)[0]?.payload;
      return meta?.cwd === w.cwd && (!w.session || decodeSession(meta.id, w.vendor) === w.session);
    }
    if (w.vendor === 'claude' && !w.session) return lines(f).some(e => e.cwd === w.cwd);
    const id = w.vendor === 'grok' ? path.basename(path.dirname(f)) : path.basename(f, '.jsonl');
    return !w.session || id === w.session;
  });
  // An ambiguous cwd is not proof of ownership. Wait for the surface's SessionStart.
  if (matches.length !== 1) return;
  w.transcript = matches[0];
  w.session ||= decodeSession(w.vendor === 'codex' ? lines(w.transcript)[0]?.payload?.id : w.vendor === 'grok' ? path.basename(path.dirname(w.transcript)) : path.basename(w.transcript, '.jsonl'), w.vendor);
  if (w.session) w.sessionStartedAt ??= at;
}
function lastSteps(entries) {
  const steps = [];
  for (const e of entries) {
    const blocks = e.message?.content ?? e.content;
    const items = Array.isArray(blocks) ? blocks : [e.payload || e];
    for (const item of items) {
      if (!['function_call', 'custom_tool_call', 'tool_use', 'tool_call', 'tool_started', 'command'].includes(item.type || item.kind)) continue;
      let input = item.arguments ?? item.input ?? item.command ?? item.data ?? item.content ?? '';
      if (typeof input === 'string') { try { input = JSON.parse(input); } catch {} }
      const detail = typeof input === 'object' && input !== null ? input.cmd ?? input.command ?? JSON.stringify(input) : input;
      steps.push(`${item.name || item.tool_name || item.type}: ${detail}`.slice(0, 2000));
    }
  }
  return steps.slice(-3);
}
function toolCommand(item) {
  let input = item.arguments ?? item.rawInput ?? item.input ?? item.command ?? item.data ?? item.content ?? '';
  if (typeof input === 'string') { try { input = JSON.parse(input); } catch {} }
  if (input && typeof input === 'object' && !Array.isArray(input)) input = input.cmd ?? input.command ?? JSON.stringify(input);
  return Array.isArray(input) ? input.join(' ') : String(input || item.name || item.toolName || 'tool (input unavailable)');
}
function toolsIn(entries) {
  const open = new Map();
  let results = [];
  let structured = false;
  for (const [index, e] of entries.entries()) {
    const body = e.message?.content ?? e.content;
    const item = e.payload || e;
    if (['task_started', 'task_complete', 'turn_started', 'turn_ended'].includes(item.type || e.event)
      || (e.type === 'user' || e.role === 'user') && (typeof body === 'string' || Array.isArray(body) && body.some(b => b.type === 'text'))) { open.clear(); results = []; structured = false; }
    const blocks = [...(Array.isArray(body) ? body : [item]), ...(e.tool_calls || []).map(t => ({ ...t, type: 'tool_call' }))];
    for (const [block, t] of blocks.entries()) {
      const type = t.type || t.kind;
      const id = t.call_id ?? t.tool_use_id ?? t.tool_call_id ?? t.toolCallId ?? t.id;
      const key = id ? `call:${id}` : `anonymous:${index}:${block}`;
      if (['function_call_output', 'custom_tool_call_output', 'tool_result', 'exec_command_end', 'custom_tool_call_end', 'tool_completed'].includes(type)
        || type === 'tool_call_update' && ['completed', 'failed', 'cancelled'].includes(t.status)) {
        const stamp = e.timestamp ?? e.ts ?? e.occurred_at ?? t.timestamp;
        results.push({ key: id ? key : null, at: typeof stamp === 'number' ? stamp : Date.parse(stamp || '') });
        if (id) open.delete(key);
        else {
          const anonymous = [...open.keys()].find(k => k.startsWith('anonymous:'));
          if (anonymous) open.delete(anonymous);
        }
      } else if (['function_call', 'custom_tool_call', 'tool_use', 'tool_call', 'exec_command_begin', 'custom_tool_call_begin', 'tool_started'].includes(type)) {
        structured = true;
        if (!open.has(key)) {
          const stamp = e.timestamp ?? e.ts ?? e.occurred_at ?? t.timestamp;
          const at = typeof stamp === 'number' ? stamp : Date.parse(stamp || '');
          open.set(key, { key, command: toolCommand(t), at: Number.isFinite(at) ? at : null });
        }
      }
    }
    if (e.message?.stop_reason === 'end_turn' || e.stop_reason === 'end_turn') open.clear();
  }
  return { open: [...open.values()], results, structured };
}
export function snapshot(w, at = Date.now()) {
  const events = hooks(w);
  discover(w, events, at);
  const transcript = w.transcript ? lines(w.transcript) : [];
  const historyFile = w.vendor === 'grok' && w.transcript ? path.join(path.dirname(w.transcript), 'chat_history.jsonl') : null;
  const history = historyFile ? lines(historyFile) : transcript;
  const users = history.filter(e => {
    if (w.vendor === 'codex') return e.type === 'event_msg' && e.payload?.type === 'user_message';
    if (!(e.type === 'user' || e.role === 'user' || e.message?.role === 'user')) return false;
    const content = e.message?.content ?? e.content;
    return typeof content === 'string' || Array.isArray(content) && content.some(b => b.type === 'text');
  });
  const started = w.vendor === 'claude' ? users.length : transcript.filter(e => w.vendor === 'codex' ? e.type === 'event_msg' && e.payload?.type === 'task_started' : e.type === 'turn_started' || e.event === 'turn_started').length;
  const complete = w.vendor === 'codex' ? transcript.filter(e => e.type === 'event_msg' && e.payload?.type === 'task_complete')
    : w.vendor === 'grok' ? transcript.filter(e => e.type === 'turn_ended' || e.event === 'turn_ended')
      : events.filter(e => e.name === 'agent.hook.Stop');
  let answer = null;
  if (w.vendor === 'codex') answer = complete.at(-1)?.payload?.last_agent_message ?? null;
  else {
    const assistant = history.filter(e => e.type === 'assistant' || e.role === 'assistant' || e.message?.role === 'assistant').at(-1);
    const content = assistant?.message?.content ?? assistant?.content;
    if (typeof content === 'string') answer = content;
    else if (Array.isArray(content)) answer = content.filter(b => b.type === 'text').map(b => b.text).join('');
  }
  const claudeEnds = w.vendor === 'claude' ? transcript.filter(e => e.type === 'assistant' && (e.message?.stop_reason === 'end_turn' || e.stop_reason === 'end_turn')) : [];
  let lastStart = null, lastStartIndex = -1, lastEndIndex = -1;
  for (const [index, e] of transcript.entries()) {
    const type = e.payload?.type || e.event || e.type;
    const body = e.message?.content ?? e.content;
    const user = (e.type === 'user' || e.role === 'user') && (typeof body === 'string' || Array.isArray(body) && body.some(b => b.type === 'text'));
    if (w.vendor === 'claude' ? user : type === (w.vendor === 'codex' ? 'task_started' : 'turn_started')) { lastStart = e; lastStartIndex = index; }
    if (w.vendor === 'claude' ? e.message?.stop_reason === 'end_turn' || e.stop_reason === 'end_turn' : type === (w.vendor === 'codex' ? 'task_complete' : 'turn_ended')) lastEndIndex = index;
  }
  const lastStartAt = Date.parse(lastStart?.timestamp || lastStart?.ts || lastStart?.occurred_at || '');
  let turnRunning = lastStartIndex > lastEndIndex;
  if (w.vendor === 'claude' && turnRunning && claudeEnds.length === 0) {
    const stopAt = Date.parse(complete.at(-1)?.occurred_at || complete.at(-1)?.timestamp || '');
    if (Number.isFinite(stopAt) && Number.isFinite(lastStartAt) ? stopAt >= lastStartAt : complete.length >= started) turnRunning = false;
  }
  const final = claudeEnds.at(-1) || complete.at(-1);
  const timestamp = Date.parse(final?.timestamp || final?.ts || final?.occurred_at || '');
  const finishedAt = Number.isFinite(timestamp) ? timestamp : w.transcript ? fs.statSync(w.transcript).mtimeMs : Date.now();
  const stat = w.transcript ? fs.statSync(w.transcript) : null;
  const historyStat = historyFile && fs.existsSync(historyFile) ? fs.statSync(historyFile) : null;
  const bytes = (stat?.size || 0) + (historyStat?.size || 0);
  if (stat && (w.observedBytes === undefined || bytes > w.observedBytes)) w.lastGrowthAt = Math.max(stat.mtimeMs, historyStat?.mtimeMs || 0);
  if (stat) w.observedBytes = bytes;
  const historySteps = w.vendor === 'grok' ? lastSteps(history) : [];
  const historyTools = w.vendor === 'grok' ? toolsIn(history) : null;
  const tools = historyTools?.structured ? historyTools : toolsIn(transcript);
  return { events, started, turnRunning, lastStartAt: Number.isFinite(lastStartAt) ? lastStartAt : null, lastStartIndex, tools, steps: historySteps.length ? historySteps : lastSteps(transcript), users: users.length, complete: claudeEnds.length || complete.length, answer, finishedAt };
}
function screen(w) {
  const out = cmux(['read-screen', '--workspace', w.workspace, '--surface', w.surface_ref]);
  return typeof out === 'string' ? out : out.text ?? out.screen ?? out.contents ?? '';
}
function cleanScreen(output) {
  return output.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
}
function dialogRows(output) {
  // Scrollback can contain past dialogs or quoted questions from an answer.
  return cleanScreen(output).trimEnd().split('\n').slice(-20);
}
function choiceRows(rows, yes, no) {
  const labels = rows.map(row => row.replace(/^\s*[│┃>❯›●○ ]*\s*(?:(?:\d+[.)]|[yn])\s+)?/i, '').trim());
  return labels.some(row => yes.test(row)) && labels.some(row => no.test(row));
}
function trustDialog(vendor, output) {
  const rows = dialogRows(output);
  const start = rows.findIndex(row => vendor === 'codex' ? /^\s*[│╭─ ]*Trust this folder\?/.test(row)
    : vendor === 'claude' ? /^(?:\s*[│ ]*)?(?:Quick safety check:|Accessing workspace:)/.test(row)
      : /^\s*[│ ]*(?:Do you trust the contents of|Trust this folder\?)/.test(row));
  if (start < 0) return null;
  const dialog = rows.slice(start);
  const choices = vendor === 'codex' ? choiceRows(dialog, /^Trust and continue\b/, /^(?:Quit|Open restricted)\b/)
    : vendor === 'claude' ? choiceRows(dialog, /^Yes, I trust this folder\b/, /^No, (?:exit|continue without these permissions)\b/)
      : choiceRows(dialog, /^Yes, proceed\b/, /^No, quit\b/);
  return choices ? dialog.join('\n').trim() : null;
}
function approvalDialog(w, output) {
  const trust = trustDialog(w.vendor, output);
  if (trust) return { kind: 'trust', prompt: trust };
  const rows = dialogRows(output);
  const index = rows.findIndex(row => /^\s*[│╭─ ]*(?:(?:Allow|Approve)\b.*\?|Do you want to\b|Would you like to (?:run|allow|proceed)\b.*\?|Permission (?:required|request))/i.test(row));
  if (index < 0 || !choiceRows(rows.slice(index), /^Yes\b/i, /^No\b/i)) return null;
  return { kind: 'permission', prompt: rows.slice(index).join('\n').trim() };
}
function activeDialog(dialog, s) {
  // Finished assistant choices are answer text; hooks still independently prove permission requests.
  return dialog?.kind === 'permission' && s.complete > 0 && !s.turnRunning ? null : dialog;
}
function runningSeconds(vendor, output) {
  const rows = output.split('\n').filter(row => vendor === 'codex' ? /^\s*[•·●*]?\s*Working\s*\(/.test(row)
    : vendor === 'claude' ? /^\s*[·✻✽✢✳✶✷*]?\s*[\p{L}'-]+[…\.]+\s*\(/u.test(row) && /esc to interrupt/i.test(row)
      : /^\s*[•·●*]?\s*(?:Thinking|Responding|Working)[…\.\s(]/.test(row));
  for (const row of rows.reverse()) {
    const duration = row.match(/\b(?:(\d+)h\s*)?(?:(\d+)m\s*)?(\d+(?:\.\d+)?)s\b/);
    if (duration) return Number(duration[1] || 0) * 3600 + Number(duration[2] || 0) * 60 + Number(duration[3]);
    const clock = row.match(/\b(\d+):(\d{2})(?::(\d{2}))?\b/);
    if (clock) return clock[3] ? Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3]) : Number(clock[1]) * 60 + Number(clock[2]);
  }
  return null;
}
function refresh(w, includePrompt = false, { now = Date.now, stallAfter = 300, commandAfter = 600 } = {}) {
  if (w.status === 'closed') return { status: 'closed', state: 'closed', closed: true };
  try { return refreshLive(w, includePrompt, { now, stallAfter, commandAfter }); }
  catch (error) {
    if (error.cmuxCode !== 'not_found') throw error;
    w.status = 'closed'; w.closedAt = now(); save(w);
    return { status: 'closed', state: 'closed', closed: true };
  }
}
function refreshLive(w, includePrompt, { now, stallAfter, commandAfter }) {
  const at = now();
  let output;
  const getScreen = () => output ??= screen(w);
  // A transcript can outlive its surface, even after the turn finished.
  if (includePrompt) getScreen();
  const s = snapshot(w, at);
  if (w.pendingSend && s.started > Math.max(1, w.pendingSend.startedBefore)) w.pendingSend.confirmedAt ||= at;
  if (s.complete !== w.completed) {
    w.completed = s.complete;
    w.finishedAt = s.finishedAt;
    w.lastActivityAt = Math.max(w.lastActivityAt, w.finishedAt);
  }
  if (s.started > (w.observedStarted || 0)) {
    w.observedStarted = s.started;
    if (s.turnRunning) {
      w.turnComplete = s.complete;
      w.finishedAt = null;
      w.lastActivityAt = Math.max(w.lastActivityAt, s.lastStartAt ?? at);
    }
  }
  const retired = new Set(w.retiredPermissions || []);
  const observations = w.permissionObservations ||= {};
  let stuck = null, blockedKey = null;
  const inspectDialog = includePrompt || s.turnRunning || !w.session || s.events.some((e, index) => index >= (w.turnEventStart || 0) && !retired.has(index) && ['agent.hook.PermissionRequest', 'agent.hook.Notification'].includes(e.name));
  const dialog = inspectDialog ? approvalDialog(w, getScreen()) : null;
  w.trustPrompt = !w.session && dialog?.kind === 'trust' ? dialog.prompt : null;
  for (const [index, e] of s.events.entries()) {
    if (index < (w.turnEventStart || 0) || retired.has(index)) continue;
    if (!(e.name === 'agent.hook.PermissionRequest' || e.name === 'agent.hook.Notification' && (!w.finishedAt || Math.abs(Date.parse(e.occurred_at || '') - w.finishedAt) > 65000 || !e.occurred_at))) continue;
    const eventAt = Date.parse(e.occurred_at || e.timestamp || '');
    const id = e.tool_use_id ?? e.payload?.tool_use_id ?? e.call_id ?? e.payload?.call_id ?? e.payload?.tool_call_id;
    const observed = observations[index] ||= { started: s.started, results: s.tools.results.length };
    const dismissed = observed.hadDialog && !dialog;
    if (dialog) observed.hadDialog = true;
    const matched = id && s.tools.results.some(r => r.key === `call:${id}`);
    const laterTurn = s.lastStartAt !== null && Number.isFinite(eventAt) && s.lastStartAt > eventAt || s.started > observed.started;
    const laterResult = !id && !dialog && s.tools.results.some(r => Number.isFinite(eventAt) && Number.isFinite(r.at) && r.at >= eventAt) || !id && !dialog && s.tools.results.length > observed.results;
    const finished = !s.turnRunning && s.complete > w.turnComplete && (!Number.isFinite(eventAt) || eventAt <= w.finishedAt);
    if (matched || laterTurn || laterResult || finished || dismissed) { retired.add(index); continue; }
    if (!stuck) { stuck = e; blockedKey = index; }
  }
  w.retiredPermissions = [...retired];
  const currentDialog = activeDialog(dialog, s);
  const blocked = stuck !== null || currentDialog?.kind === 'permission';
  w.approvalPending = blocked || currentDialog !== null;
  const pending = w.pendingSend && !w.pendingSend.confirmedAt;
  const runningTurn = s.turnRunning;
  const open = runningTurn ? [...s.tools.open] : [];
  if (runningTurn && w.vendor === 'grok' && !s.tools.structured) {
    const command = cleanScreen(getScreen()).split('\n').map(row => row.match(/^\s*(?:[•●⏺]\s*)?(?:Running|Executing):\s*(\S.*)$/)).find(Boolean)?.[1];
    if (command) open.push({ key: `screen:${command}`, command, at: null });
  }
  w.toolObservations = Object.fromEntries(open.map(t => [t.key, { command: t.command, openedAt: w.toolObservations?.[t.key]?.openedAt ?? Math.min(t.at ?? at, at) }]));
  const tool = Object.values(w.toolObservations).sort((a, b) => a.openedAt - b.openedAt)[0];
  if (tool) w.indicator = null;
  if (w.indicator?.turn !== s.started) w.indicator = null;
  const quietSince = () => Math.max(w.lastGrowthAt ?? at, w.indicator?.advancedAt ?? -Infinity);
  const stallDue = !pending && runningTurn && !tool && at >= quietSince() + stallAfter * 1000;
  if ((!w.session || runningTurn) && (w.screenCheckedAt === undefined || at - w.screenCheckedAt >= 3000 || stallDue)) {
    const output = cleanScreen(getScreen());
    w.screenCheckedAt = at;
    w.trustPrompt = !w.session ? trustDialog(w.vendor, output) : null;
    if (runningTurn && !tool) {
      const seconds = runningSeconds(w.vendor, output);
      if (seconds !== null) {
        // The first reading needs a later sample to distinguish thinking from a frozen timer.
        const advancedAt = !w.indicator || seconds > w.indicator.seconds ? at : w.indicator.advancedAt;
        w.indicator = { turn: s.started, seconds, advancedAt };
      }
    }
  }
  if (!w.session && w.trustPrompt) {
    w.status = 'stuck';
    save(w);
    return { status: 'stuck', state: 'stuck', kind: 'trust', prompt: w.trustPrompt };
  }
  const signals = [];
  if (blocked) {
    if (w.blockedEvent !== blockedKey || w.blockedAt == null) w.blockedAt = Number.isFinite(Date.parse(stuck?.occurred_at)) ? Date.parse(stuck.occurred_at) : at;
    w.blockedEvent = blockedKey;
    signals.push({ state: 'stuck', at: w.blockedAt });
  } else w.blockedAt = null;
  if (!pending && !s.turnRunning && s.complete > 0) signals.push({ state: 'done', at: w.finishedAt });
  if (pending && at >= w.pendingSend.sentAt + 10000) signals.push({ state: 'unsent', at: w.pendingSend.sentAt + 10000 });
  if (!w.transcript && !w.session && at >= w.openedAt + 60000) signals.push({ state: 'no_start', at: w.openedAt + 60000 });
  if (!pending && tool && at >= tool.openedAt + commandAfter * 1000) signals.push({ state: 'long_command', at: tool.openedAt + commandAfter * 1000 });
  if (!pending && runningTurn && !tool && w.lastGrowthAt !== undefined && at >= quietSince() + stallAfter * 1000) {
    signals.push({ state: 'stalled', at: quietSince() + stallAfter * 1000 });
  }
  signals.sort((a, b) => a.at - b.at);
  const state = blocked ? 'stuck' : signals[0]?.state || 'running';
  w.status = state;
  save(w);
  const result = { status: state, state };
  if (w.session && !w.transcript && at >= w.sessionStartedAt + 30000) result.transcriptMissing = true;
  if (state === 'long_command') result.command = tool.command;
  if (includePrompt && state === 'stuck') result.prompt = getScreen();
  if (includePrompt && state === 'unsent') {
    const output = getScreen();
    const rows = output.split('\n').map(s => s.trim()).filter(Boolean);
    result.input = rows.filter(s => /^[›❯>]|\[Pasted Content|input|composer/i.test(s)).at(-1) || rows.at(-1) || '';
    result.screen = output;
  }
  if (state === 'stalled') result.steps = s.steps;
  const finalAnswer = state === 'done' && s.answer === null && w.vendor === 'grok' && includePrompt ? getScreen() : s.answer;
  if (state === 'done' && finalAnswer?.split('\n').map(s => s.trim()).filter(Boolean).at(-1)?.startsWith('QUESTION:')) {
    result.question = true;
    result.text = finalAnswer;
  }
  return result;
}
async function openLock(fn) {
  fs.mkdirSync(dir(), { recursive: true, mode: 0o700 });
  const lock = path.join(dir(), '.open-lock');
  const deadline = Date.now() + 30000;
  while (true) {
    try { fs.mkdirSync(lock); break; }
    catch (e) { if (e.code !== 'EEXIST') throw e; if (Date.now() >= deadline) throw new Error('agent open is busy; retry (remove .open-lock if a previous open crashed)'); await sleep(100); }
  }
  try { return await fn(); } finally { fs.rmdirSync(lock); }
}
export async function openWorker(family, opts, ctx) {
  const resolved = resolveModel(family);
  if (resolved.error) throw bad(resolved.error);
  const vendor = vendorOf(resolved.id);
  if (!vendor) throw bad(`no harness for ${resolved.id}`);
  if (opts.effort && !EFFORTS.has(opts.effort)) throw bad('invalid effort');
  if (opts.role && !ROLE_RE.test(opts.role)) throw bad('invalid role');
  const cwd = fs.realpathSync(path.resolve(opts.cwd || process.cwd()));
  if (!fs.statSync(cwd).isDirectory()) throw bad('cwd must be a directory');
  const prompt = opts.promptFile ? readUserText(path.resolve(opts.promptFile)) : opts.prompt;
  if (typeof prompt !== 'string' || !prompt.length) throw bad('a nonempty task or --prompt-file is required');
  while (true) {
    const opened = await openLock(async () => {
    const active = all().filter(w => w.status !== 'closed').filter(w => { refresh(w); return !['done', 'closed'].includes(w.status); });
    if (active.length >= 4) return null;
    const id = crypto.randomUUID();
    const w = { id, family, model: resolved.id, vendor, effort: opts.effort || null, mcp: !!opts.mcp, role: opts.role || null, cwd, workspace: ctx.workspace, orchestratorPane: ctx.pane, status: 'running', session: null, transcript: null, openedAt: Date.now(), lastActivityAt: Date.now(), finishedAt: null, completed: 0, turnComplete: 0, eventStart: lines(eventFile()).length, turnEventStart: 0 };
    const homeKey = homeVariable(vendor);
    const homeOverride = process.env[homeKey];
    w.harnessHome = path.resolve(homeOverride || path.join(homeDir(), `.${vendor}`));
    const homeSetting = homeOverride ? `export ${homeKey}=${quote(w.harnessHome)}` : `unset ${homeKey}`;
    w.runDir = path.join(dir(), id);
    fs.mkdirSync(w.runDir, { mode: 0o700 });
    w.pidFile = path.join(w.runDir, 'harness.pid');
    w.baseline = candidates(w);
    w.promptFile = path.join(dir(), `${id}.prompt`);
    w.launcher = path.join(dir(), `${id}.sh`);
    atomic(w.promptFile, prompt);
    const args = vendor === 'codex' ? ['-m', w.model, ...(w.effort ? ['-c', `model_reasoning_effort=${w.effort}`] : []), '-s', 'workspace-write', '-a', 'never'] : vendor === 'claude' ? ['--model', w.model, ...(w.effort ? ['--effort', w.effort] : []), '--permission-mode', 'auto', ...(!w.mcp ? ['--strict-mcp-config'] : [])] : ['-m', w.model, '--always-approve'];
    const testMode = process.env.AGENT_TEST_MODE === '1';
    const binary = testMode && process.env.AGENT_TEST_BINARY || vendor;
    let extra = [];
    if (testMode && process.env.AGENT_TEST_LAUNCH_EXTRA) {
      try { extra = JSON.parse(process.env.AGENT_TEST_LAUNCH_EXTRA); } catch { throw bad('invalid test launch args'); }
      if (!Array.isArray(extra) || extra.some(a => typeof a !== 'string' || a.includes('\0'))) throw bad('invalid test launch args');
    }
    args.push(...extra);
    // Git config and hooks affect every worktree and must remain outside the write grant.
    const gitAccess = vendor === 'codex' ? [
      'common=$(git rev-parse --git-common-dir 2>/dev/null) || common=',
      'gitdir=$(git rev-parse --absolute-git-dir 2>/dev/null) || gitdir=',
      'if [ -n "$common" ] && [ -n "$gitdir" ]; then',
      '  common=$(cd "$common" 2>/dev/null && pwd -P) || common=',
      '  gitdir=$(cd "$gitdir" 2>/dev/null && pwd -P) || gitdir=',
      '  worktree=$(pwd -P)',
      '  if [ -n "$common" ] && [ -n "$gitdir" ]; then',
      '    case "$common/" in "$worktree/"*) ;; *)',
      '      case "$gitdir" in "$common"/worktrees/*)',
      '        IFS= read -r backlink 2>/dev/null <"$gitdir/gitdir" || backlink=',
      '        if [ "$backlink" = "$worktree/.git" ]; then',
      '          for name in objects refs logs; do',
      '            physical=$(cd "$common/$name" 2>/dev/null && pwd -P) || physical=',
      '            if [ "$physical" = "$common/$name" ]; then set -- "$@" --add-dir "$physical"; fi',
      '          done',
      '          set -- "$@" --add-dir "$gitdir"',
      '        fi',
      '      ;; esac',
      '    ;; esac',
      '  fi',
      'fi',
    ].join('\n') + '\n' : '';
    atomic(w.launcher, `#!/bin/sh\ncd ${quote(cwd)} || exit 1\n${homeSetting}\nprintf '%s\\n' "$$" > ${quote(w.pidFile)}\ncaffeinate -i -w "$$" </dev/null > ${quote(path.join(w.runDir, 'caffeinate.log'))} 2>&1 &\nset -- ${args.map(quote).join(' ')}\n${gitAccess}exec ${testMode && process.env.AGENT_TEST_BINARY ? quote(binary) : vendor} "$@" -- "$(cat ${quote(w.promptFile)})"\n`, 0o700);
    let prior = vendor !== 'grok' ? all().filter(r => owned(r, ctx) && r.vendor !== 'grok' && r.status !== 'closed').sort((a, b) => b.openedAt - a.openedAt)[0] : null;
    if (prior) {
      try { cmux(['list-pane-surfaces', '--workspace', ctx.workspace, '--pane', prior.pane_ref]); }
      catch (error) { if (error.cmuxCode !== 'not_found') throw error; prior = null; }
    }
    const paneArgs = vendor !== 'grok' && prior ? ['new-surface', '--pane', prior.pane_ref] : ['new-pane', '--direction', 'right'];
    const launch = args => cmux([...args, '--workspace', ctx.workspace, '--focus', vendor === 'grok' ? 'true' : 'false', '--command', w.launcher]);
    let result;
    try { result = launch(paneArgs); }
    catch (error) {
      if (!prior || error.cmuxCode !== 'not_found') throw error;
      prior = null;
      result = launch(['new-pane', '--direction', 'right']);
    }
    w.surface_ref = ref(result.surface_ref, 'surface');
    w.surface_id = result.surface_id || w.surface_ref;
    w.pane_ref = ref(result.pane_ref || prior?.pane_ref, 'pane');
    save(w);
    if (vendor === 'grok') {
      try {
        const end = Date.now() + 6000;
        do { discover(w, hooks(w)); if (w.transcript) break; await sleep(100); } while (Date.now() < end);
      } finally { cmux(['focus-pane', '--workspace', ctx.workspace, '--pane', ctx.pane]); }
    }
    save(w);
    return w;
    });
    if (opened) return opened;
    await sleep(250);
  }
}
export async function waitWorker(id, timeout, ctx, runtime = {}) {
  const now = runtime.now || Date.now;
  const pause = runtime.sleep || sleep;
  const end = now() + timeout * 1000;
  do {
    const w = worker(id, ctx);
    const result = refresh(w, true, runtime);
    if (result.state === 'closed') return { id, ...result };
    if (expire(w, ctx, now()).status === 'closed') return { id, status: 'closed', state: 'closed', closed: true };
    if (result.state !== 'running') return { id, ...result };
    if (now() >= end) return { id, ...result, status: 'timeout', state: 'timeout' };
    await pause(Math.min(250, end - now()));
  } while (true);
}
export function closeWorker(id, ctx) {
  const w = worker(id, ctx);
  if (w.status !== 'closed') {
    try { cmux(['close-surface', '--workspace', w.workspace, '--surface', w.surface_ref, '--force']); }
    catch (error) { if (error.cmuxCode !== 'not_found') throw error; }
    w.status = 'closed'; w.closedAt = Date.now(); save(w);
  }
  return w;
}
function expire(w, ctx, at = Date.now()) {
  if (w.status === 'done' && at - w.lastActivityAt >= 30 * 60000) return closeWorker(w.id, ctx);
  return w;
}
export function listWorkers(ctx) {
  return all().filter(w => owned(w, ctx)).map(w => { refresh(w); return expire(w, ctx); });
}
export function answerWorker(id, ctx) {
  const w = worker(id, ctx);
  const { state } = refresh(w);
  const s = snapshot(w);
  save(w);
  if (!s.complete || s.turnRunning || !['done', 'closed'].includes(state)) throw new Error(`no answer yet (state ${state})`);
  if (s.answer !== null) return s.answer;
  if (w.vendor === 'grok' && state === 'done') return screen(w);
  throw new Error(`no answer yet (state ${state})`);
}
function assertSendable(w, runtime) {
  const result = refresh(w, true, runtime);
  if (result.state === 'closed') throw bad('worker is closed');
  const dialog = activeDialog(approvalDialog(w, screen(w)), snapshot(w, (runtime.now || Date.now)()));
  if (w.approvalPending || result.state === 'stuck' || dialog) {
    w.status = 'stuck'; save(w);
    throw Object.assign(new Error(`worker is stuck${dialog ? ` (${dialog.kind})` : ''}; agent never answers approval dialogs`), { exitCode: 3 });
  }
}
async function sendTurn(id, message, ctx, runtime) {
  const now = runtime.now || Date.now;
  const pause = runtime.sleep || sleep;
  const w = worker(id, ctx);
  if (w.status === 'closed') throw bad('worker is closed');
  if (!message.length) throw bad('a nonempty message is required');
  assertSendable(w, runtime);
  const before = snapshot(w, now());
  if (w.pendingSend && !w.pendingSend.confirmedAt) {
    w.status = 'unsent'; save(w);
    throw Object.assign(new Error(`worker is unsent; leftover input: ${screen(w)}; submit it in the worker pane or close the worker before sending again`), { exitCode: 5 });
  }
  if (before.started < 1) throw new Error('worker startup is not established; wait for its launch turn before sending');
  w.turnComplete = before.complete;
  w.completed = before.complete;
  w.turnStarted = before.started;
  w.turnEventStart = before.events.length;
  w.status = 'running'; w.lastActivityAt = now(); w.blockedAt = null;
  w.pendingSend = { sentAt: now(), startedBefore: before.started };
  w.runDir ||= path.join(dir(), w.id);
  let sent = message;
  if (message.length > 400) {
    const file = path.join(w.runDir, `message-${crypto.randomUUID()}.txt`);
    atomic(file, message);
    sent = `Read ${file} and follow it.`;
    w.pendingSend.messageFile = file;
  }
  save(w);
  cmux(['send', '--workspace', w.workspace, '--surface', w.surface_ref, sent]);
  const end = w.pendingSend.sentAt + 10000;
  for (let attempt = 0; attempt < 4; attempt++) {
    assertSendable(w, runtime);
    if (w.pendingSend.confirmedAt) return { id, status: 'running', state: 'running' };
    cmux(['send-key', '--workspace', w.workspace, '--surface', w.surface_ref, 'enter']);
    const deadline = attempt === 3 ? end : Math.min(end, now() + 1200);
    do {
      assertSendable(w, runtime);
      if (w.pendingSend.confirmedAt) {
        save(w);
        return { id, status: 'running', state: 'running' };
      }
      if (now() >= deadline) break;
      await pause(Math.min(100, deadline - now()));
    } while (true);
  }
  w.status = 'unsent';
  save(w);
  throw new Error('could not verify message submission within 10s after four Enter presses; agent wait will report unsent');
}

export async function sendWorker(id, message, ctx, runtime = {}) {
  while (true) {
    const sent = await openLock(async () => {
      const w = worker(id, ctx);
      if (w.status === 'closed') throw bad('worker is closed');
      assertSendable(w, runtime);
      if (w.status === 'done') {
        const active = all().filter(r => r.id !== id && r.status !== 'closed').filter(r => {
          refresh(r);
          return !['done', 'closed'].includes(r.status);
        });
        if (active.length >= 4) return null;
      }
      return sendTurn(id, message, ctx, runtime);
    });
    if (sent) return sent;
    await sleep(250);
  }
}
