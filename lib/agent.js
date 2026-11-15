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
  const r = spawnSync('cmux', ['--json', '--id-format', 'both', ...args], { encoding: 'utf8', env: { ...process.env, CMUX_QUIET: '1' }, timeout: 10000, maxBuffer: 8 * 1024 * 1024 });
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
  return { events, users: users.length, complete: Math.max(complete.length, claudeEnds.length), answer, finishedAt };
}
function screen(w) {
  const out = cmux(['read-screen', '--workspace', w.workspace, '--surface', w.surface_ref]);
  return typeof out === 'string' ? out : out.text ?? out.screen ?? out.contents ?? '';
}
function refresh(w, includePrompt = false) {
  if (w.status === 'closed') return { status: 'done', closed: true };
  const s = snapshot(w);
  if (s.complete > w.completed) {
    w.completed = s.complete;
    w.finishedAt = s.finishedAt;
    w.lastActivityAt = Math.max(w.lastActivityAt, w.finishedAt);
  }
  const fresh = s.events.slice(w.turnEventStart || 0);
  const stuck = fresh.find(e => e.name === 'agent.hook.PermissionRequest' || (e.name === 'agent.hook.Notification' && (!w.finishedAt || Math.abs(Date.parse(e.occurred_at || '') - w.finishedAt) > 65000 || !e.occurred_at)));
  const blocked = stuck && (s.complete <= w.turnComplete || Date.parse(stuck.occurred_at || '') > w.finishedAt);
  if (blocked) w.status = 'stuck';
  else if (s.complete > w.turnComplete) w.status = 'done';
  else w.status = 'running';
  save(w);
  return { status: w.status, ...(w.status === 'stuck' && includePrompt ? { prompt: screen(w) } : {}) };
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
    const active = all().filter(w => w.status !== 'closed').filter(w => { refresh(w); return ['running', 'stuck'].includes(w.status); });
    if (active.length >= 4) return null;
    const id = crypto.randomUUID();
    const w = { id, family, model: resolved.id, vendor, effort: opts.effort || null, role: opts.role || null, cwd, workspace: ctx.workspace, orchestratorPane: ctx.pane, status: 'running', session: null, transcript: null, openedAt: Date.now(), lastActivityAt: Date.now(), finishedAt: null, completed: 0, turnComplete: 0, eventStart: lines(eventFile()).length, turnEventStart: 0 };
    w.baseline = candidates(w);
    w.promptFile = path.join(dir(), `${id}.prompt`);
    w.launcher = path.join(dir(), `${id}.sh`);
    atomic(w.promptFile, prompt);
    const args = vendor === 'codex' ? ['-m', w.model, ...(w.effort ? ['-c', `model_reasoning_effort=${w.effort}`] : []), '-s', 'workspace-write', '-a', 'never'] : vendor === 'claude' ? ['--model', w.model, ...(w.effort ? ['--effort', w.effort] : []), '--permission-mode', 'auto'] : ['-m', w.model, '--always-approve'];
    atomic(w.launcher, `#!/bin/sh\ncd ${quote(cwd)} || exit 1\nexec ${vendor === 'claude' ? 'claude' : vendor} ${args.map(quote).join(' ')} "$(cat ${quote(w.promptFile)})"\n`, 0o700);
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
export async function waitWorker(id, timeout, ctx) {
  const end = Date.now() + timeout * 1000;
  do {
    const w = worker(id, ctx);
    const result = refresh(w, true);
    if (expire(w, ctx).status === 'closed') return { id, status: 'done', closed: true };
    if (result.status !== 'running') return { id, ...result };
    if (Date.now() >= end) return { id, status: 'timeout' };
    await sleep(Math.min(250, end - Date.now()));
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
function expire(w, ctx) {
  if (w.status === 'done' && Date.now() - w.lastActivityAt >= 30 * 60000) return closeWorker(w.id, ctx);
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
async function sendTurn(id, message, ctx) {
  const w = worker(id, ctx);
  if (w.status === 'closed') throw bad('worker is closed');
  if (!message.length) throw bad('a nonempty message is required');
  const before = snapshot(w);
  w.turnComplete = before.complete;
  w.completed = before.complete;
  w.turnEventStart = before.events.length;
  w.status = 'running'; w.lastActivityAt = Date.now();
  save(w);
  cmux(['send', '--workspace', w.workspace, '--surface', w.surface_ref, message]);
  for (let attempt = 0; attempt < 4; attempt++) {
    cmux(['send-key', '--workspace', w.workspace, '--surface', w.surface_ref, 'enter']);
    const deadline = Date.now() + 1200;
    do {
      const s = snapshot(w);
      if (s.users > before.users) { save(w); return { id, status: 'running' }; }
      await sleep(100);
    } while (Date.now() < deadline);
  }
  save(w);
  throw new Error('could not verify message submission after four Enter presses; inspect the worker before retrying');
}

export async function sendWorker(id, message, ctx) {
  while (true) {
    const sent = await openLock(async () => {
      const w = worker(id, ctx);
      if (w.status === 'closed') throw bad('worker is closed');
      refresh(w);
      if (w.status === 'done') {
        const active = all().filter(r => r.id !== id && r.status !== 'closed').filter(r => {
          refresh(r);
          return ['running', 'stuck'].includes(r.status);
        });
        if (active.length >= 4) return null;
      }
      return sendTurn(id, message, ctx);
    });
    if (sent) return sent;
    await sleep(250);
  }
}
