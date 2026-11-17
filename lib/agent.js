import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readUserText, isCredentialStat } from './paths.js';
import { homeDir, resolveModel, vendorOf, loadRegistry, EFFORTS, ID_RE } from './models.js';
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
function gitTamperResult(w) {
  return { status: 'stuck', state: 'stuck', kind: 'git_tamper', paths: w.gitTamper, prompt: `git_tamper: unsafe Git paths: ${w.gitTamper.join(', ')}` };
}
function gitTamperError(w) {
  return Object.assign(new Error(gitTamperResult(w).prompt), { exitCode: 3, kind: 'git_tamper', paths: w.gitTamper });
}
function checkGitIntegrity(w) {
  if (w.vendor !== 'codex') return null;
  const unsafe = new Set(w.gitTamper || []);
  const inspect = (file, directory = false) => {
    let stat;
    try { stat = fs.lstatSync(file); }
    catch (error) { if (error.code !== 'ENOENT') unsafe.add(file); return; }
    if (directory ? stat.isDirectory() : stat.isFile()) {
      if (directory) {
        try {
          for (const entry of fs.readdirSync(file, { withFileTypes: true })) inspect(path.join(file, entry.name), entry.isDirectory());
        } catch { unsafe.add(file); }
      }
      return;
    }
    unsafe.add(file);
    // Unlink the directory entry, never its target; nonempty unexpected directories stay blocked.
    try { if (stat.isDirectory()) fs.rmdirSync(file); else fs.unlinkSync(file); }
    catch (error) { if (error.code !== 'ENOENT') unsafe.add(file); }
  };
  const entries = w.gitGrantFile ? text(w.gitGrantFile).split('\0') : [];
  for (let i = 0; i + 1 < entries.length; i += 2) inspect(entries[i + 1], entries[i] === 'logs');
  if (!unsafe.size) return null;
  w.gitTamper = [...unsafe];
  const result = gitTamperResult(w);
  Object.assign(w, { status: result.status, kind: result.kind, paths: result.paths, prompt: result.prompt });
  save(w);
  return result;
}
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
  if (!process.env.CMUX_SOCKET_PATH) throw bad('acs-agent needs cmux: run it inside a cmux terminal');
  let identity;
  try { identity = cmux(['identify']); } catch { throw bad('acs-agent needs cmux: its socket is unreachable'); }
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
  checkGitIntegrity(w);
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
  const start = rows.findIndex(row => vendor === 'codex' ? /^\s*[│╭─ ]*(?:Folder access\s*$|Trust this folder\?|Config, hooks, and exec policies\b|This existing task may retain settings\b)/.test(row)
    : vendor === 'claude' ? /^(?:\s*[│ ]*)?(?:Quick safety check:|Accessing workspace:)/.test(row)
      : /^\s*[│ ]*(?:Do you trust the contents of|Trust this folder\?)/.test(row));
  if (start < 0) return null;
  const dialog = rows.slice(start);
  const choices = vendor === 'codex' ? choiceRows(dialog, /^(?:Trust and continue|Open restricted|Open existing task)\b/, /^(?:Quit|Back to Agent Command Center|Keep current directory)\b/)
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
  const tamper = checkGitIntegrity(w);
  if (tamper) return tamper;
  if (w.status === 'closed') return { status: 'closed', state: 'closed', closed: true };
  let result;
  try { result = refreshLive(w, includePrompt, { now, stallAfter, commandAfter }); }
  catch (error) {
    if (error.cmuxCode !== 'not_found') throw error;
    w.status = 'closed'; w.surfaceClosed = true; w.closedAt = now(); save(w);
    result = { status: 'closed', state: 'closed', closed: true };
  }
  return checkGitIntegrity(w) || result;
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
/** A tab title: what runs, which family, where. Its parts can come from a folder or branch name, so it is cleaned and capped. */
function tabTitle(kind, family, place) {
  return shown(`${shown(kind, 32)} · ${shown(family, 32)}${place ? ` · ${shown(place, 48)}` : ''}`, 80);
}
/** The branch checked out at `cwd`, from Git's HEAD file (a linked worktree's `.git` file names its own), else the folder name. */
function branchOf(cwd) {
  try {
    for (let d = cwd; ; d = path.dirname(d)) {
      let stat;
      try { stat = fs.statSync(path.join(d, '.git')); }
      catch { if (path.dirname(d) === d) break; continue; }
      let gitDir = path.join(d, '.git');
      if (stat.isFile()) {
        const link = readUserText(gitDir, { maxBytes: 4096 }).match(/^gitdir: (.+)$/m);
        if (!link) break;
        gitDir = path.resolve(d, link[1].trim());
      }
      const head = readUserText(path.join(gitDir, 'HEAD'), { maxBytes: 4096 }).match(/^ref: refs\/heads\/(.+)$/m);
      if (head) return head[1].trim();
      break;
    }
  } catch {}
  return path.basename(cwd);
}
async function openLock(fn) {
  fs.mkdirSync(dir(), { recursive: true, mode: 0o700 });
  const lock = path.join(dir(), '.open-lock');
  const deadline = Date.now() + 30000;
  while (true) {
    try { fs.mkdirSync(lock); break; }
    catch (e) { if (e.code !== 'EEXIST') throw e; if (Date.now() >= deadline) throw new Error('acs-agent open is busy; retry (remove .open-lock if a previous open crashed)'); await sleep(100); }
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
    const active = all().filter(w => w.status !== 'closed' && !w.surfaceClosed).filter(w => { refresh(w); return !['done', 'closed'].includes(w.status); });
    if (active.length >= 4) return null;
    const id = crypto.randomUUID();
    const w = { id, family, model: resolved.id, vendor, effort: opts.effort || null, mcp: !!opts.mcp, role: opts.role || null, cwd, workspace: ctx.workspace, orchestratorPane: ctx.pane, status: 'running', session: null, transcript: null, openedAt: Date.now(), lastActivityAt: Date.now(), finishedAt: null, completed: 0, turnComplete: 0, eventStart: lines(eventFile()).length, turnEventStart: 0 };
    const homeKey = homeVariable(vendor);
    const homeOverride = process.env[homeKey];
    w.harnessHome = path.resolve(homeOverride || path.join(homeDir(), `.${vendor}`));
    const homeSetting = homeOverride ? `export ${homeKey}=${quote(w.harnessHome)}` : `unset ${homeKey}`;
    w.runDir = path.join(dir(), id);
    fs.mkdirSync(w.runDir, { mode: 0o700 });
    if (vendor === 'codex') {
      fs.mkdirSync(path.join(w.runDir, 'tmp'), { mode: 0o700 });
      w.tmpDir = fs.realpathSync(path.join(w.runDir, 'tmp'));
      w.gitGrantFile = path.join(w.runDir, 'git-grants');
      atomic(w.gitGrantFile, '');
    }
    w.pidFile = path.join(w.runDir, 'harness.pid');
    w.baseline = candidates(w);
    w.promptFile = path.join(dir(), `${id}.prompt`);
    w.launcher = path.join(dir(), `${id}.sh`);
    atomic(w.promptFile, prompt);
    const args = vendor === 'codex' ? ['-m', w.model, ...(w.effort ? ['-c', `model_reasoning_effort=${w.effort}`] : []), '-s', 'workspace-write', '-a', 'never', '-c', 'sandbox_workspace_write.writable_roots=[]', '-c', 'sandbox_workspace_write.exclude_tmpdir_env_var=true', '-c', 'sandbox_workspace_write.exclude_slash_tmp=true', '--add-dir', w.tmpDir] : vendor === 'claude' ? ['--model', w.model, ...(w.effort ? ['--effort', w.effort] : []), '--permission-mode', 'auto', ...(!w.mcp ? ['--strict-mcp-config'] : [])] : ['-m', w.model, '--always-approve'];
    const testMode = process.env.AGENT_TEST_MODE === '1';
    const binary = testMode && process.env.AGENT_TEST_BINARY || vendor;
    let extra = [];
    if (testMode && process.env.AGENT_TEST_LAUNCH_EXTRA) {
      try { extra = JSON.parse(process.env.AGENT_TEST_LAUNCH_EXTRA); } catch { throw bad('invalid test launch args'); }
      if (!Array.isArray(extra) || extra.some(a => typeof a !== 'string' || a.includes('\0'))) throw bad('invalid test launch args');
    }
    args.push(...extra);
    // File grants leave config redirects outside the boundary, including files Git may create later.
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
      '          for name in index index.lock HEAD HEAD.lock COMMIT_EDITMSG; do',
      '            target=$gitdir/$name',
      '            if [ ! -L "$target" ] && { [ ! -e "$target" ] || [ -f "$target" ]; }; then',
      '              set -- "$@" --add-dir "$target"',
      `              printf '%s\\0%s\\0' file "$target" >> ${quote(w.gitGrantFile || '')} || exit 1`,
      '            fi',
      '          done',
      '          physical=$(cd "$gitdir/logs" 2>/dev/null && pwd -P) || physical=',
      '          if [ "$physical" = "$gitdir/logs" ] || { [ ! -e "$gitdir/logs" ] && [ ! -L "$gitdir/logs" ]; }; then',
      '            set -- "$@" --add-dir "$gitdir/logs"',
      `            printf '%s\\0%s\\0' logs "$gitdir/logs" >> ${quote(w.gitGrantFile || '')} || exit 1`,
      '          fi',
      '        fi',
      '      ;; esac',
      '    ;; esac',
      '  fi',
      'fi',
    ].join('\n') + '\n' : '';
    // Split-index refreshes create unpredictable admin filenames; keep worker indexes ordinary.
    const configCount = 'const n = Number(process.env.GIT_CONFIG_COUNT || 0); if (!Number.isSafeInteger(n) || n < 0 || n >= Number.MAX_SAFE_INTEGER) throw new Error("invalid GIT_CONFIG_COUNT"); process.stdout.write(String(n));';
    const codexEnvironment = vendor === 'codex' ? [
      `export TMPDIR=${quote(w.tmpDir)} TMP=${quote(w.tmpDir)} TEMP=${quote(w.tmpDir)}`,
      `git_config_count=$(${quote(process.execPath)} -e ${quote(configCount)}) || exit 1`,
      'export "GIT_CONFIG_KEY_$git_config_count=core.splitIndex" "GIT_CONFIG_VALUE_$git_config_count=false"',
      'export GIT_CONFIG_COUNT=$((git_config_count + 1))',
    ].join('\n') + '\n' : '';
    atomic(w.launcher, `#!/bin/sh\ncd ${quote(cwd)} || exit 1\n${homeSetting}\n${codexEnvironment}printf '%s\\n' "$$" > ${quote(w.pidFile)}\ncaffeinate -i -w "$$" </dev/null > ${quote(path.join(w.runDir, 'caffeinate.log'))} 2>&1 &\nset -- ${args.map(quote).join(' ')}\n${gitAccess}exec ${testMode && process.env.AGENT_TEST_BINARY ? quote(binary) : vendor} "$@" -- "$(cat ${quote(w.promptFile)})"\n`, 0o700);
    // A worker is a background tab in the caller's own pane, so the caller's screen stays as it is. Grok's TUI
    // starts only while visible and focused, and a focused tab would cover the caller: it gets a pane of its own.
    const place = vendor === 'grok' ? ['new-pane', '--direction', 'right'] : ['new-surface', '--pane', ctx.pane];
    const result = cmux([...place, '--workspace', ctx.workspace, '--focus', vendor === 'grok' ? 'true' : 'false', '--command', w.launcher]);
    w.surface_ref = ref(result.surface_ref, 'surface');
    w.surface_id = result.surface_id || w.surface_ref;
    w.pane_ref = ref(result.pane_ref || (vendor === 'grok' ? null : ctx.pane), 'pane');
    save(w);
    // The title only labels the tab: a worker that started is never failed over it.
    try { cmux(['rename-tab', '--workspace', ctx.workspace, '--surface', w.surface_ref, '--', tabTitle('builder', family, branchOf(cwd))]); } catch {}
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
    const expired = expire(w, ctx, now());
    if (expired.gitTamper) return { id, ...gitTamperResult(expired) };
    if (expired.status === 'closed') return { id, status: 'closed', state: 'closed', closed: true };
    if (result.state !== 'running') return { id, ...result };
    if (now() >= end) return { id, ...result, status: 'timeout', state: 'timeout' };
    await pause(Math.min(250, end - now()));
  } while (true);
}
export function closeWorker(id, ctx) {
  const w = worker(id, ctx);
  if (w.status !== 'closed' && !w.surfaceClosed) {
    try { cmux(['close-surface', '--workspace', w.workspace, '--surface', w.surface_ref, '--force']); }
    catch (error) { if (error.cmuxCode !== 'not_found') { if (w.gitTamper) throw gitTamperError(w); throw error; } }
    w.status = 'closed'; w.surfaceClosed = true; w.closedAt = Date.now(); save(w);
  }
  if (checkGitIntegrity(w)) throw gitTamperError(w);
  return w;
}
function expire(w, ctx, at = Date.now()) {
  if (w.status === 'done' && at - w.lastActivityAt >= 30 * 60000) {
    try { return closeWorker(w.id, ctx); }
    catch (error) { if (error.kind !== 'git_tamper') throw error; return worker(w.id, ctx); }
  }
  return w;
}
export function listWorkers(ctx) {
  return all().filter(w => owned(w, ctx)).map(w => { refresh(w); return expire(w, ctx); });
}
export function answerWorker(id, ctx) {
  const w = worker(id, ctx);
  const { state, kind } = refresh(w);
  if (kind === 'git_tamper') throw gitTamperError(w);
  const s = snapshot(w);
  save(w);
  if (!s.complete || s.turnRunning || !['done', 'closed'].includes(state)) throw new Error(`no answer yet (state ${state})`);
  if (s.answer !== null) return s.answer;
  if (w.vendor === 'grok' && state === 'done') return screen(w);
  throw new Error(`no answer yet (state ${state})`);
}
function assertSendable(w, runtime) {
  const result = refresh(w, true, runtime);
  if (result.kind === 'git_tamper') throw gitTamperError(w);
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
  throw new Error('could not verify message submission within 10s after four Enter presses; acs-agent wait will report unsent');
}

export async function sendWorker(id, message, ctx, runtime = {}) {
  while (true) {
    const sent = await openLock(async () => {
      const w = worker(id, ctx);
      if (w.status === 'closed') throw bad('worker is closed');
      assertSendable(w, runtime);
      if (w.status === 'done') {
        const active = all().filter(r => r.id !== id && r.status !== 'closed' && !r.surfaceClosed).filter(r => {
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

export const WATCH_VERSION = 1;
// What `watch --version` prints: 2 knows --log-only, which the gates start outside cmux only when the probe says so.
export const WATCH_CLI_VERSION = 2;
const runsDir = () => path.join(homeDir(), '.agent-config-studio', 'runs');
export const KIND_RE = /^[a-z][a-z0-9-]{0,31}$/;
export const RUN_ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const KEY_RE = /^review-[A-Za-z0-9-]{1,64}-\d{1,6}$/;
const SURFACE_RE = /^(?:surface:\d+|[a-f\d-]{36})$/i;
const PANE_RE = /^(?:pane:\d+|[a-f\d-]{36})$/i;
export const WORKSPACE_RE = /^(?:workspace:\d+|[a-f\d-]{36})$/i;
// Only a test (AGENT_TEST_MODE=1) may point the inspectors at its fakes; tests/guards.mjs pins this line.
const inspector = (bin, name) => process.env.AGENT_TEST_MODE === '1' && process.env[name] || bin;
const watchTest = name => process.env.AGENT_TEST_MODE === '1' && process.env[name] !== undefined ? Number(process.env[name]) : null;
/**
 * Tool input comes from a reviewer reading a hostile diff: no escape sequence or control, bidi or
 * zero-width character may reach the pane or the sidebar, and nothing is unbounded.
 */
export function shown(value, max = 120) {
  const s = String(value ?? '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, ' ')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ' ')
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/\s+/g, ' ').trim();
  const points = [...s];
  return points.length > max ? points.slice(0, max - 1).join('') + '…' : s;
}
function readJson(file) { try { return JSON.parse(readUserText(file, { maxBytes: 1024 * 1024 })); } catch { return null; } }
function processTable() {
  const r = spawnSync(inspector('/bin/ps', 'AGENT_TEST_PS'), ['-axww', '-o', 'pid,ppid,command'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, maxBuffer: 256 * 1024 * 1024 });
  if (r.error || r.status !== 0) return null;
  const table = new Map();
  // macOS ps prints a newline inside an argument as \012, so a prompt cannot forge a row.
  for (const row of r.stdout.split('\n')) {
    const m = row.match(/^\s*(\d+)\s+(\d+)\s(.*)$/);
    if (m) table.set(Number(m[1]), { pid: Number(m[1]), ppid: Number(m[2]), command: m[3].trim() });
  }
  return table;
}
/** A headless model call of one of the three CLIs, run directly or through a Node launcher. */
function cliOf(command) {
  const tokens = command.split(/\s+/).filter(Boolean);
  let i = 0;
  if (/^(?:node|bun|deno)[\d.]*$/.test(path.basename(tokens[0] || ''))) {
    i = 1;
    while (tokens[i]?.startsWith('-')) i++;
  }
  const vendor = path.basename(tokens[i] || '');
  if (!['claude', 'codex', 'grok'].includes(vendor)) return null;
  const rest = tokens.slice(i + 1);
  const headless = vendor === 'codex' ? ['exec', 'e'].includes(rest[0]) : rest.some(t => t === '-p' || t === '--print');
  return headless ? { vendor, rest } : null;
}
/**
 * The prompt sits in the same argv, and ps joins it with spaces: a diff quoting `--model x` adds a
 * second id. Two different ids prove nothing, so the label falls back to the vendor.
 */
function modelOf(rest) {
  const ids = new Set();
  for (let j = 0; j < rest.length; j++) {
    const t = rest[j];
    let v = t === '-m' || t === '--model' ? rest[j + 1] : t.startsWith('--model=') ? t.slice(8) : t === '-c' && /^model=/.test(rest[j + 1] || '') ? rest[j + 1].slice(6) : null;
    if (typeof v !== 'string') continue;
    v = v.replace(/^["']|["']$/g, '');
    if (ID_RE.test(v)) ids.add(v);
  }
  return ids.size === 1 ? [...ids][0] : null;
}
/**
 * The review gate's security worker is `node <review.mjs> --security-worker <job>`, the flag right after the script.
 * Model CLIs never count: their argv holds the prompt, and a diff can quote that very command line.
 */
function securityWorker(command) {
  const tokens = String(command || '').split(/\s+/).filter(Boolean);
  return /^node[\d.]*$/.test(path.basename(tokens[0] || '')) && path.basename(tokens[1] || '') === 'review.mjs' && tokens[2] === '--security-worker';
}
function familyOf(id, vendor) {
  if (!id) return vendor;
  // Several families can share an id (an alias kept for the previous version); the first listed is the base one.
  const family = Object.entries(loadRegistry().registry.models || {}).find(([, v]) => v === id)?.[0];
  return family || id;
}
function elapsed(ms) {
  const m = Math.floor(ms / 60000);
  return m < 1 ? '<1m' : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}
function shellCommand(argv) {
  const parts = argv.map(String);
  return parts.length >= 3 && /(?:^|\/)(?:ba|z)?sh$/.test(parts[0]) && /^-l?c$/.test(parts[1]) ? parts.slice(2).join(' ') : parts.join(' ');
}
function describe(name, input, cwd) {
  const n = String(name || 'tool').toLowerCase();
  const i = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const rel = p => typeof p !== 'string' ? '' : cwd && (p === cwd || p.startsWith(`${cwd}/`)) ? path.relative(cwd, p) || '.' : p;
  const command = Array.isArray(i.command) ? shellCommand(i.command) : i.command ?? i.cmd;
  if (typeof command === 'string' && command) return `run ${command}`;
  const file = i.file_path ?? i.filePath ?? i.path ?? i.notebook_path;
  if (/glob/.test(n)) return `glob ${i.pattern ?? ''}`;
  if (/grep|search/.test(n) || i.pattern !== undefined) return `grep ${i.pattern ?? i.query ?? ''}`;
  if (/^(?:list|ls)\b|list_dir/.test(n)) return `list ${rel(file) || '.'}`;
  if (typeof file === 'string') return `${/write|edit/.test(n) ? 'edit' : 'read'} ${rel(file)}`;
  if (typeof input === 'string' && input) return `${name} ${input}`;
  return `${name}${Object.keys(i).length ? ` ${JSON.stringify(i)}` : ''}`;
}
/** Codex's exec tool takes a script; the shell commands it runs are its `cmd:"…"` arguments. */
function describeCodexScript(name, script, cwd) {
  const cmds = [...String(script || '').matchAll(/\bcmd\s*:\s*("(?:[^"\\]|\\.)*")/g)].flatMap(m => { try { return [JSON.parse(m[1])]; } catch { return []; } });
  if (!cmds.length) return describe(name, script, cwd);
  return `run ${cmds[0]}${cmds.length > 1 ? ` (+${cmds.length - 1} more)` : ''}`;
}
function stepsOf(call, e) {
  if (call.vendor === 'claude') {
    const blocks = e?.message?.content;
    if (e?.type !== 'assistant' || !Array.isArray(blocks)) return [];
    return blocks.filter(b => b?.type === 'tool_use').map(b => describe(b.name, b.input, call.cwd));
  }
  if (call.vendor === 'codex') {
    const p = e?.payload;
    if (e?.type === 'session_meta' && typeof p?.cwd === 'string') call.cwd ??= p.cwd;
    if (e?.type !== 'response_item') return [];
    if (p?.type === 'function_call') {
      let args = p.arguments;
      try { args = JSON.parse(args); } catch {}
      return [describe(p.name, args, call.cwd)];
    }
    return p?.type === 'custom_tool_call' ? [describeCodexScript(p.name, p.input, call.cwd)] : [];
  }
  const u = e?.params?.update;
  return u?.sessionUpdate === 'tool_call' ? [describe(u.title || u._meta?.['x.ai/tool']?.name || u.kind, u.rawInput, call.cwd)] : [];
}
/** Only what was appended since the last read; a long transcript is never parsed twice. */
/** The complete new lines in call.file since call.offset, as one string (or null); a partial last line waits. */
function readLines(call) {
  let fd;
  try { fd = fs.openSync(call.file, 'r'); } catch { return null; }
  try {
    const stat = fs.fstatSync(fd);
    // The same descriptor checks as paths.js openUserFile: its excerpts reach the pane's log file.
    if (!stat.isFile() || stat.nlink !== 1 || isCredentialStat(stat)) return null;
    const size = stat.size;
    if (size < call.offset) { call.offset = 0; call.partial = Buffer.alloc(0); }
    const length = Math.min(size - call.offset, 8 * 1024 * 1024);
    if (length <= 0) return null;
    const chunk = Buffer.alloc(length);
    const got = fs.readSync(fd, chunk, 0, length, call.offset);
    call.offset += got;
    let buf = Buffer.concat([call.partial, chunk.subarray(0, got)]);
    const end = buf.lastIndexOf(0x0a);
    if (end < 0) { call.partial = buf.length > 64 * 1024 * 1024 ? Buffer.alloc(0) : buf; return null; }
    call.partial = buf.subarray(end + 1);
    return buf.subarray(0, end).toString('utf8');
  } finally { fs.closeSync(fd); }
}
function readNew(call) {
  const got = readLines(call);
  return got === null ? [] : got.split('\n').flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } });
}
function claudeHomes() {
  return [...new Set([process.env.CLAUDE_CONFIG_DIR, path.join(homeDir(), '.claude')].filter(Boolean).map(d => path.resolve(d)))];
}
/** Claude writes <home>/sessions/<pid>.json while it runs; its sessionId names the transcript. */
function claudeTranscript(pids) {
  for (const home of claudeHomes()) {
    for (const pid of pids) {
      const s = readJson(path.join(home, 'sessions', `${pid}.json`));
      if (!s || s.pid !== pid || typeof s.sessionId !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(s.sessionId)) continue;
      for (const root of claudeHomes().map(h => path.join(h, 'projects'))) {
        for (const d of children(root)) {
          const file = path.join(root, d.name, `${s.sessionId}.jsonl`);
          if (d.isDirectory() && fs.existsSync(file)) return { file, cwd: typeof s.cwd === 'string' ? s.cwd : null };
        }
      }
    }
  }
  return null;
}
/** Files each pid holds open for writing: a Codex rollout or a Grok session's events.jsonl. */
function writtenFiles(pids) {
  const out = new Map();
  if (!pids.length) return out;
  const r = spawnSync(inspector('/usr/sbin/lsof', 'AGENT_TEST_LSOF'), ['-w', '-nP', '-F', 'pfan', '-p', pids.join(',')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, maxBuffer: 64 * 1024 * 1024 });
  if (r.error) return out;
  let pid = null, mode = '';
  for (const row of String(r.stdout || '').split('\n')) {
    const tag = row[0], value = row.slice(1);
    if (tag === 'p') { pid = Number(value); mode = ''; }
    else if (tag === 'f') mode = '';
    else if (tag === 'a') mode = value;
    else if (tag === 'n' && pid !== null && /[wu]/.test(mode)) {
      if (!out.has(pid)) out.set(pid, []);
      out.get(pid).push(value);
    }
  }
  return out;
}
function transcriptIn(vendor, names) {
  for (const name of names) {
    if (vendor === 'codex' && /\/rollout-[^/]*\.jsonl$/.test(name)) return { file: name, cwd: null };
    if (vendor === 'grok' && path.basename(name) === 'events.jsonl') {
      let cwd = null;
      try { const group = decodeURIComponent(path.basename(path.dirname(path.dirname(name)))); if (group.startsWith('/')) cwd = group; } catch {}
      // events.jsonl proves which session is this pid's; its tool calls are in updates.jsonl beside it.
      return { file: path.join(path.dirname(name), 'updates.jsonl'), cwd };
    }
  }
  return null;
}
function cmuxPlain(args) {
  // The gate never waits on the watcher, but a hung socket must not freeze every line either.
  const r = spawnSync('cmux', args, { encoding: 'utf8', env: { ...process.env, CMUX_QUIET: '1' }, stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000, maxBuffer: 1024 * 1024 });
  return r.error || r.status !== 0 ? null : r.stdout;
}
/** Each reviewer's own log, `<run id>.<call>.log`, which its tab tails. */
function removeCallLogs(id) {
  for (const d of children(runsDir())) {
    if (d.isFile() && d.name.startsWith(`${id}.`) && /^\d+\.log$/.test(d.name.slice(id.length + 1))) fs.rmSync(path.join(runsDir(), d.name), { force: true });
  }
}
function runFiles() {
  const out = [];
  for (const d of children(runsDir())) {
    if (!d.isFile() || !d.name.endsWith('.json')) continue;
    const watch = d.name.endsWith('.watch.json');
    const id = d.name.slice(0, -(watch ? '.watch.json' : '.json').length);
    if (!RUN_ID_RE.test(id)) continue;
    const file = path.join(runsDir(), d.name);
    const body = readJson(file);
    if (body?.version !== WATCH_VERSION) continue;
    out.push({ id, watch, file, body, mtime: (() => { try { return fs.statSync(file).mtimeMs; } catch { return 0; } })() });
  }
  return out;
}
/** A watcher or gate killed outright leaves its lines and pane behind; the next watcher removes them. */
function sweepRuns(table, ownId, logOnly) {
  const files = runFiles();
  const liveWatchers = new Set(files.filter(f => f.watch && table.has(f.body.watcherPid)).map(f => f.id));
  for (const f of files) {
    if (f.id === ownId) continue;
    if (f.watch) {
      if (table.has(f.body.watcherPid)) continue;
      const ws = f.body.workspace;
      if (typeof ws === 'string' && WORKSPACE_RE.test(ws)) {
        // Its sidebar lines and pane need cmux to clear, which a log-only watcher never calls: a cmux watcher sweeps it.
        if (logOnly) continue;
        for (const key of Array.isArray(f.body.keys) ? f.body.keys : []) if (typeof key === 'string' && KEY_RE.test(key)) cmuxPlain(['clear-status', '--workspace', ws, key]);
        const surfaces = new Set([f.body.surface, ...(Array.isArray(f.body.surfaces) ? f.body.surfaces : [])]);
        for (const s of surfaces) if (typeof s === 'string' && SURFACE_RE.test(s)) cmuxPlain(['close-surface', '--workspace', ws, '--surface', s, '--force']);
      }
      fs.rmSync(f.file, { force: true });
      fs.rmSync(path.join(runsDir(), `${f.id}.log`), { force: true });
      removeCallLogs(f.id);
    } else if (!table.has(f.body.pid) && !liveWatchers.has(f.id)) fs.rmSync(f.file, { force: true });
  }
}
/**
 * Follows one top-level run (a review, a Grade) by its process tree, not by files: each model CLI
 * under --pid is mapped to its own transcript through evidence tied to that process, so concurrent
 * calls in one cwd never share a line. Owns its sidebar keys and pane, and clears them on the way out.
 */
export async function watchRun({ pid, kind, workspace = null, pane = false, logOnly = false }) {
  const pollMs = watchTest('AGENT_TEST_POLL_MS') ?? 1000;
  const lingerMs = watchTest('AGENT_TEST_LINGER_MS') ?? 30000;
  const unseenMs = watchTest('AGENT_TEST_NO_TRANSCRIPT_MS') ?? 10000;
  let stop = false;
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { stop = true; });
  let table = processTable();
  const own = table && runFiles().filter(f => !f.watch && f.body.pid === pid && table.has(pid)).sort((a, b) => b.mtime - a.mtime)[0];
  const runId = own?.id || `w${pid}-${crypto.randomBytes(4).toString('hex')}`;
  if (table) sweepRuns(table, runId, logOnly);
  const sidecar = path.join(runsDir(), `${runId}.watch.json`);
  const log = path.join(runsDir(), `${runId}.log`);
  const gateRun = own?.body || {};
  // surface is the pane's first tab, kept for watchers that predate tabs and sweep only that field.
  const state = { version: WATCH_VERSION, runId, pid, watcherPid: process.pid, workspace, keys: [], surface: null, pane: null, surfaces: [] };
  const persist = () => { try { atomic(sidecar, JSON.stringify(state) + '\n'); } catch {} };
  persist();
  // Written in every mode: the pane tails it inside cmux, `acs-agent tail` anywhere.
  try { fs.writeFileSync(log, '', { flag: 'a', mode: 0o600 }); } catch {}
  const callLogs = [];
  const paneLine = (text, call = null) => {
    const t = new Date();
    const stamp = [t.getHours(), t.getMinutes(), t.getSeconds()].map(x => String(x).padStart(2, '0')).join(':');
    const row = `${stamp} ${shown(text, 300)}\n`;
    try { fs.appendFileSync(log, row, { mode: 0o600 }); } catch {}
    if (call?.log) try { fs.appendFileSync(call.log, row, { mode: 0o600 }); } catch {}
  };
  // One pane per run, opened by its first call; every later call is a tab in it. Each tab tails only its call's log.
  const openTab = call => {
    if (!pane || logOnly || state.pane === '') return;
    call.log = path.join(runsDir(), `${runId}.${call.n}.log`);
    callLogs.push(call.log);
    try { fs.writeFileSync(call.log, '', { flag: 'a', mode: 0o600 }); } catch {}
    const command = ['--focus', 'false', '--command', `tail -n +1 -F ${quote(call.log)}`];
    const first = state.pane === null;
    if (first) state.pane = '';
    const out = cmuxPlain(['--json', '--id-format', 'both', ...(first ? ['new-pane', '--workspace', workspace, '--direction', 'right'] : ['new-surface', '--workspace', workspace, '--pane', state.pane]), ...command]);
    let result = null;
    try { const parsed = JSON.parse(out); result = parsed.result || parsed; } catch {}
    const surface = typeof result?.surface_ref === 'string' && SURFACE_RE.test(result.surface_ref) ? result.surface_ref : null;
    if (first && surface && typeof result.pane_ref === 'string' && PANE_RE.test(result.pane_ref)) state.pane = result.pane_ref;
    if (!surface) return;
    if (first) state.surface = surface;
    state.surfaces.push(surface);
    persist();
    cmuxPlain(['rename-tab', '--workspace', workspace, '--surface', surface, '--', call.title]);
  };
  const calls = new Map();
  const claimed = new Set();
  let followed = new Set([pid]), count = 0, failures = 0;
  const setStatus = (call, value) => {
    if (value === call.value) return;
    call.value = value;
    if (!logOnly) cmuxPlain(['set-status', '--workspace', workspace, call.key, value]);
  };
  const clear = key => {
    if (!logOnly) cmuxPlain(['clear-status', '--workspace', workspace, key]);
    state.keys = state.keys.filter(k => k !== key);
    persist();
  };
  const finish = call => {
    if (call.file) for (const e of readNew(call)) for (const step of stepsOf(call, e)) { call.step = shown(step, 200); paneLine(`[${call.tag}] ${call.step}`, call); }
    clear(call.key);
    paneLine(`[${call.tag}] finished after ${elapsed(Date.now() - call.firstSeen)}`, call);
    if (call.file) claimed.delete(call.file);
    calls.delete(call.pid);
  };
  while (!stop) {
    if (table) {
      failures = 0;
      const kids = new Map();
      for (const p of table.values()) { if (!kids.has(p.ppid)) kids.set(p.ppid, []); kids.get(p.ppid).push(p.pid); }
      // A process seen once stays followed after its parent dies: the detached security worker outlives a Ctrl-C.
      const next = new Set();
      const queue = [...followed].filter(p => table.has(p));
      while (queue.length) {
        const p = queue.pop();
        if (next.has(p)) continue;
        next.add(p);
        queue.push(...(kids.get(p) || []));
      }
      followed = next;
      const cli = new Map([...followed].map(p => [p, cliOf(table.get(p).command)]).filter(([, c]) => c));
      const insideCall = p => { for (let q = table.get(p)?.ppid, n = 0; q && n < 64; q = table.get(q)?.ppid, n++) if (cli.has(q)) return true; return false; };
      for (const call of [...calls.values()]) if (!cli.has(call.pid)) finish(call);
      const runs = new Map(runFiles().filter(f => !f.watch && Number.isSafeInteger(f.body.pid)).map(f => [f.body.pid, f.body]));
      for (const [p, c] of cli) {
        if (calls.has(p) || insideCall(p)) continue;
        let security = false, run = null;
        for (let q = table.get(p)?.ppid, n = 0; q && n < 64; q = table.get(q)?.ppid, n++) {
          if (securityWorker(table.get(q)?.command)) security = true;
          run ||= runs.get(q) || null;
        }
        run ||= gateRun;
        const id = modelOf(c.rest);
        // The kind, not the run's free-text intent: an intent is a sentence, and the line has room for a word.
        const label = security ? 'security' : KIND_RE.test(run.kind || '') ? run.kind : kind;
        const family = shown(familyOf(id, c.vendor), 32);
        const slice = run.slice !== undefined && run.slice !== null ? ` · ${shown(run.slice, 24)}` : '';
        const branch = typeof run.branch === 'string' && shown(run.branch, 40) ? shown(run.branch, 40) : null;
        const call = { pid: p, n: ++count, vendor: c.vendor, id, tag: `${label} · ${family}`, prefix: `${label} · ${family}${branch ? ` · ${branch}` : ''}${slice}`, title: tabTitle(label, family, branch), firstSeen: Date.now(), file: null, cwd: null, offset: 0, partial: Buffer.alloc(0), step: null, value: null, honest: false, log: null };
        call.key = `review-${runId}-${call.n}`;
        calls.set(p, call);
        state.keys.push(call.key);
        persist();
        openTab(call);
        paneLine(`[${call.tag}] started${id ? ` (${id})` : ''}`, call);
      }
      const subtree = p => { const out = [], queue = [p]; while (queue.length) { const q = queue.pop(); if (!followed.has(q)) continue; out.push(q); queue.push(...(kids.get(q) || [])); } return out; };
      const pending = [...calls.values()].filter(c => !c.file);
      const open = writtenFiles(pending.filter(c => c.vendor !== 'claude').flatMap(c => subtree(c.pid)));
      for (const call of pending) {
        const pids = subtree(call.pid);
        const found = call.vendor === 'claude' ? claudeTranscript(pids) : transcriptIn(call.vendor, pids.flatMap(q => open.get(q) || []));
        if (found && !claimed.has(found.file)) { call.file = found.file; call.cwd = found.cwd; claimed.add(found.file); }
      }
      for (const call of calls.values()) {
        if (call.file) for (const e of readNew(call)) for (const step of stepsOf(call, e)) { call.step = shown(step, 200); paneLine(`[${call.tag}] ${call.step}`, call); }
        const age = Date.now() - call.firstSeen;
        if (!call.file && age >= unseenMs && !call.honest) { call.honest = true; paneLine(`[${call.tag}] no transcript found; showing time only`, call); }
        const step = call.step || (call.file || age >= unseenMs ? 'running' : 'starting');
        setStatus(call, shown(`${call.prefix} · ${elapsed(age)} · ${step}`, 120));
      }
      if (!table.has(pid) && !calls.size) break;
    } else if (++failures >= 5) break;
    await sleep(pollMs);
    if (stop) break;
    table = processTable();
  }
  for (const call of [...calls.values()]) finish(call);
  for (const key of [...state.keys]) clear(key);
  paneLine('run finished');
  if (state.surfaces.length) {
    if (!stop) await sleep(lingerMs);
    for (const surface of state.surfaces) cmuxPlain(['close-surface', '--workspace', workspace, '--surface', surface, '--force']);
  } else if (!stop) await sleep(Math.min(lingerMs, 2000)); // a tail polling the log still reads its last lines

  fs.rmSync(sidecar, { force: true });
  fs.rmSync(log, { force: true });
  for (const file of callLogs) fs.rmSync(file, { force: true });
  if (own) fs.rmSync(own.file, { force: true });
  return 0;
}
function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
/** Each run by id, from its gate's run file and its watcher's sidecar, either of which may be missing. */
function runsById() {
  const byId = new Map();
  for (const f of runFiles()) {
    const r = byId.get(f.id) || { id: f.id, gate: null, watch: null, mtime: 0 };
    r[f.watch ? 'watch' : 'gate'] = f.body;
    r.mtime = Math.max(r.mtime, f.mtime);
    byId.set(f.id, r);
  }
  for (const r of byId.values()) {
    r.pid = r.gate?.pid ?? r.watch?.pid;
    r.kind = KIND_RE.test(r.gate?.kind || '') ? r.gate.kind : 'run';
  }
  return byId;
}
const FINISHED_RE = /^\d\d:\d\d:\d\d run finished$/;
/**
 * Prints a run's log as the watcher writes it: what the cmux pane shows, in any terminal. With no id it follows the
 * newest run whose gate is alive and, when that ends, waits for the next, so a pane left open keeps showing reviews.
 */
export async function tailRun({ id = null, once = false, write = s => process.stdout.write(s) }) {
  const pollMs = watchTest('AGENT_TEST_POLL_MS') ?? 250;
  let stop = false;
  if (!once) for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { stop = true; });
  // The log holds cleaned text already; it is still a file anyone could have written, so it is cleaned again.
  const say = text => write(`${shown(text, 1000)}\n`);
  const follow = async run => {
    const call = { file: path.join(runsDir(), `${run.id}.log`), offset: 0, partial: Buffer.alloc(0) };
    let seen = false, ending = false;
    for (;;) {
      const got = readLines(call);
      if (got !== null) {
        seen = true;
        for (const l of got.split('\n')) {
          if (FINISHED_RE.test(l)) { say(`${run.kind} ${run.id} finished`); return; }
          if (l) say(l);
        }
        continue;
      }
      if (once || stop) return;
      // A watcher killed outright never writes its last line: the run is over once neither process is left.
      if (ending) { say(`${run.kind} ${run.id} finished`); return; }
      const now = runsById().get(run.id);
      ending = seen && !fs.existsSync(call.file) || !alive(now?.pid ?? run.pid) && !alive(now?.watch?.watcherPid);
      if (!ending) await sleep(pollMs);
    }
  };
  if (id) {
    const run = runsById().get(id);
    if (!run) throw Object.assign(new Error(`no run ${id}`), { exitCode: 1 });
    await follow(run);
    return 0;
  }
  const done = new Set();
  let waiting = false;
  while (!stop) {
    const run = [...runsById().values()].filter(r => !done.has(r.id) && alive(r.pid)).sort((a, b) => b.mtime - a.mtime)[0];
    if (!run) {
      if (once) { say('no review is running'); return 0; }
      if (!waiting) { say('no review is running; waiting for the next one (Ctrl-C to stop)'); waiting = true; }
      await sleep(pollMs);
      continue;
    }
    waiting = false;
    if (!once) say(`following ${run.kind} ${run.id}`);
    await follow(run);
    if (once) return 0;
    done.add(run.id);
  }
  return 0;
}
