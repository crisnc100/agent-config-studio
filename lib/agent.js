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
function all() { return children(dir()).filter(d => d.isFile() && d.name.endsWith('.json')).map(d => JSON.parse(readUserText(path.join(dir(), d.name)))); }
function cmux(args) {
  const r = spawnSync('cmux', ['--json', '--id-format', 'both', ...args], { encoding: 'utf8', env: { ...process.env, CMUX_QUIET: '1' }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000, maxBuffer: 8 * 1024 * 1024 });
  if (r.error || r.status !== 0) throw new Error(`cmux: ${r.error?.message || r.stderr.trim() || r.stdout.trim()}`);
  let result;
  try { result = JSON.parse(r.stdout); } catch {
    if (args[0] === 'read-screen') return r.stdout;
    throw new Error('cmux returned invalid JSON');
  }
  if (result.ok === false || result.error) throw new Error(`cmux: ${JSON.stringify(result.error || result)}`);
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
export function worker(id, ctx) {
  if (!/^[a-f\d-]{36}$/i.test(id || '')) throw bad('invalid worker id');
  const w = JSON.parse(readUserText(path.join(dir(), `${id}.json`)));
  if (!owned(w, ctx)) throw bad('worker belongs to another orchestrator');
  return w;
}
function candidates(w) {
  const home = homeDir();
  if (w.vendor === 'codex') {
    const root = path.join(home, '.codex', 'sessions');
    let dirs = [root];
    for (let i = 0; i < 3; i++) dirs = dirs.flatMap(d => children(d).filter(e => e.isDirectory()).map(e => path.join(d, e.name)));
    return dirs.flatMap(d => children(d).filter(e => e.isFile() && /^rollout-.*\.jsonl$/.test(e.name)).map(e => path.join(d, e.name)));
  }
  if (w.vendor === 'claude') {
    const root = path.join(home, '.claude', 'projects', w.cwd.replace(/\//g, '-'));
    return children(root).filter(e => e.isFile() && e.name.endsWith('.jsonl')).map(e => path.join(root, e.name));
  }
  const root = path.join(home, '.grok', 'sessions', w.cwd.replace(/\//g, '%2F'));
  return children(root).filter(e => e.isDirectory()).map(e => path.join(root, e.name, 'events.jsonl'));
}
function hooks(w) {
  return [...new Map(lines(eventFile()).slice(w.eventStart).filter(e => String(e.surface_id || '').toLowerCase() === String(w.surface_id).toLowerCase()).map(e => [JSON.stringify(e), e])).values()];
}
function discover(w, events) {
  if (w.transcript) return;
  const start = events.find(e => e.name === 'agent.hook.SessionStart' && (e.session_id || e.payload?.session_id));
  w.session ||= start?.session_id || start?.payload?.session_id || null;
  const peers = all().filter(r => r.id !== w.id);
  const claimed = new Set(peers.map(r => r.transcript).filter(Boolean));
  if (!w.session && peers.some(r => r.vendor === w.vendor && r.cwd === w.cwd && !r.session && r.status !== 'closed')) return;
  const matches = candidates(w).filter(f => {
    if (claimed.has(f) || w.baseline.includes(f)) return false;
    if (w.vendor === 'codex') {
      const meta = lines(f)[0]?.payload;
      return meta?.cwd === w.cwd && (!w.session || meta.id === w.session);
    }
    const id = w.vendor === 'grok' ? path.basename(path.dirname(f)) : path.basename(f, '.jsonl');
    return !w.session || id === w.session;
  });
  // An ambiguous cwd is not proof of ownership. Wait for the surface's SessionStart.
  if (matches.length !== 1) return;
  w.transcript = matches[0];
  w.session ||= w.vendor === 'codex' ? lines(w.transcript)[0]?.payload?.id : w.vendor === 'grok' ? path.basename(path.dirname(w.transcript)) : path.basename(w.transcript, '.jsonl');
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
export function snapshot(w) {
  const events = hooks(w);
  discover(w, events);
  const transcript = w.transcript ? lines(w.transcript) : [];
  const history = w.vendor === 'grok' && w.transcript ? lines(path.join(path.dirname(w.transcript), 'chat_history.jsonl')) : transcript;
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
  const final = complete.at(-1) || claudeEnds.at(-1);
  const timestamp = Date.parse(final?.timestamp || final?.ts || final?.occurred_at || '');
  const finishedAt = Number.isFinite(timestamp) ? timestamp : w.transcript ? fs.statSync(w.transcript).mtimeMs : Date.now();
  const stat = w.transcript ? fs.statSync(w.transcript) : null;
  if (stat && (w.observedBytes === undefined || stat.size > w.observedBytes)) w.lastGrowthAt = stat.mtimeMs;
  if (stat) w.observedBytes = stat.size;
  const historySteps = w.vendor === 'grok' ? lastSteps(history) : [];
  return { events, started, steps: historySteps.length ? historySteps : lastSteps(transcript), users: users.length, complete: Math.max(complete.length, claudeEnds.length), answer, finishedAt };
}
function screen(w) {
  const out = cmux(['read-screen', '--workspace', w.workspace, '--surface', w.surface_ref]);
  return typeof out === 'string' ? out : out.text ?? out.screen ?? out.contents ?? '';
}
function refresh(w, includePrompt = false, { now = Date.now, stallAfter = 300 } = {}) {
  if (w.status === 'closed') return { status: 'done', state: 'done', closed: true };
  const at = now();
  const s = snapshot(w);
  if (w.pendingSend && s.started > w.pendingSend.startedBefore) w.pendingSend.confirmedAt ||= at;
  if (s.complete > w.completed) {
    w.completed = s.complete;
    w.finishedAt = s.finishedAt;
    w.lastActivityAt = Math.max(w.lastActivityAt, w.finishedAt);
  }
  const fresh = s.events.slice(w.turnEventStart || 0);
  const stuck = fresh.find(e => e.name === 'agent.hook.PermissionRequest' || (e.name === 'agent.hook.Notification' && (!w.finishedAt || Math.abs(Date.parse(e.occurred_at || '') - w.finishedAt) > 65000 || !e.occurred_at)));
  const blocked = stuck && (s.complete <= w.turnComplete || Date.parse(stuck.occurred_at || '') > w.finishedAt);
  const pending = w.pendingSend && !w.pendingSend.confirmedAt;
  const signals = [];
  if (blocked) {
    w.blockedAt ||= Number.isFinite(Date.parse(stuck.occurred_at)) ? Date.parse(stuck.occurred_at) : at;
    signals.push({ state: 'stuck', at: w.blockedAt });
  } else w.blockedAt = null;
  if (!pending && s.complete > w.turnComplete) signals.push({ state: 'done', at: w.finishedAt });
  if (pending && at >= w.pendingSend.sentAt + 10000) signals.push({ state: 'unsent', at: w.pendingSend.sentAt + 10000 });
  if (!w.transcript && !w.session && at >= w.openedAt + 60000) signals.push({ state: 'no_start', at: w.openedAt + 60000 });
  const runningTurn = s.started > (w.turnStarted || 0) && s.complete <= w.turnComplete;
  if (!pending && runningTurn && w.lastGrowthAt !== undefined && at >= w.lastGrowthAt + stallAfter * 1000) {
    signals.push({ state: 'stalled', at: w.lastGrowthAt + stallAfter * 1000 });
  }
  signals.sort((a, b) => a.at - b.at);
  const state = signals[0]?.state || 'running';
  w.status = state;
  save(w);
  const result = { status: state, state };
  if (includePrompt && state === 'stuck') result.prompt = screen(w);
  if (includePrompt && state === 'unsent') {
    const output = screen(w);
    const rows = output.split('\n').map(s => s.trim()).filter(Boolean);
    result.input = rows.filter(s => /^[›❯>]|\[Pasted Content|input|composer/i.test(s)).at(-1) || rows.at(-1) || '';
    result.screen = output;
  }
  if (state === 'stalled') result.steps = s.steps;
  const finalAnswer = state === 'done' && s.answer === null && w.vendor === 'grok' && includePrompt ? screen(w) : s.answer;
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
    // Linked worktrees keep writable Git metadata outside the sandbox's cwd.
    const gitAccess = vendor === 'codex' ? [
      'common=$(git rev-parse --git-common-dir 2>/dev/null) || common=',
      'if [ -n "$common" ]; then',
      '  common=$(cd "$common" && pwd -P) || exit 1',
      '  case "$common/" in "${PWD%/}/"*) ;; *) set -- "$@" --add-dir "$common" ;; esac',
      'fi',
    ].join('\n') + '\n' : '';
    atomic(w.launcher, `#!/bin/sh\ncd ${quote(cwd)} || exit 1\nprintf '%s\\n' "$$" > ${quote(w.pidFile)}\ncaffeinate -i -w "$$" </dev/null > ${quote(path.join(w.runDir, 'caffeinate.log'))} 2>&1 &\nset -- ${args.map(quote).join(' ')}\n${gitAccess}exec ${testMode && process.env.AGENT_TEST_BINARY ? quote(binary) : vendor} "$@" "$(cat ${quote(w.promptFile)})"\n`, 0o700);
    const prior = all().find(r => owned(r, ctx) && r.vendor !== 'grok' && r.status !== 'closed');
    const paneArgs = vendor !== 'grok' && prior ? ['new-surface', '--pane', prior.pane_ref] : ['new-pane', '--direction', 'right'];
    const result = cmux([...paneArgs, '--workspace', ctx.workspace, '--focus', vendor === 'grok' ? 'true' : 'false', '--command', w.launcher]);
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
    if (expire(w, ctx, now()).status === 'closed') return { id, status: 'done', state: 'done', closed: true };
    if (result.state !== 'running') return { id, ...result };
    if (now() >= end) return { id, status: 'timeout', state: 'timeout' };
    await pause(Math.min(250, end - now()));
  } while (true);
}
export function closeWorker(id, ctx) {
  const w = worker(id, ctx);
  if (w.status !== 'closed') {
    cmux(['close-surface', '--workspace', w.workspace, '--surface', w.surface_ref, '--force']);
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
  const s = snapshot(w);
  save(w);
  if (s.answer !== null) return s.answer;
  if (w.vendor === 'grok') return screen(w);
  throw new Error('worker has no assistant answer yet');
}
async function sendTurn(id, message, ctx, runtime) {
  const now = runtime.now || Date.now;
  const pause = runtime.sleep || sleep;
  const w = worker(id, ctx);
  if (w.status === 'closed') throw bad('worker is closed');
  if (!message.length) throw bad('a nonempty message is required');
  const before = snapshot(w);
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
    cmux(['send-key', '--workspace', w.workspace, '--surface', w.surface_ref, 'enter']);
    const deadline = attempt === 3 ? end : Math.min(end, now() + 1200);
    do {
      const s = snapshot(w);
      if (s.started > before.started) {
        w.pendingSend.confirmedAt = now();
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
      refresh(w, false, runtime);
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
