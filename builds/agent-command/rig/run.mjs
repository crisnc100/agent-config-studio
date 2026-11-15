#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (!process.env.CMUX_SOCKET_PATH) throw new Error('Run this rig inside cmux with agent installed on PATH.');
const repo = fs.realpathSync(fileURLToPath(new URL('../../../', import.meta.url)));
const temp = fs.realpathSync(fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'agent-fault-rig-')));
const scratch = path.join(temp, 'worktree');
let worktreeAdded = false;
const owned = new Set();
const rows = [];
let activeChild = null;
let interrupted = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { interrupted = true; activeChild?.kill('SIGTERM'); });
const baseEnv = { ...process.env, AGENT_TEST_MODE: '1' };
delete baseEnv.AGENT_TEST_BINARY;
delete baseEnv.AGENT_TEST_LAUNCH_EXTRA;
function command(binary, args, { env = baseEnv, timeout = 90000, cwd = repo, cleanup = false } = {}) {
  return new Promise((resolve, reject) => {
    if (interrupted && !cleanup && !(binary === 'agent' && ['close', 'list'].includes(args[0]))) return reject(new Error('rig interrupted'));
    const child = spawn(binary, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    activeChild = child;
    let out = '', err = '';
    child.stdout.on('data', b => out += b);
    child.stderr.on('data', b => err += b);
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, timeout);
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', (code, signal) => { activeChild = null; clearTimeout(timer); resolve({ code, signal, out, err }); });
  });
}
async function open(family, folder, task, env = baseEnv) {
  const cwd = path.isAbsolute(folder) ? folder : path.join(scratch, folder);
  fs.mkdirSync(cwd, { recursive: true });
  const r = await command('agent', ['open', family, '--cwd', cwd, task, '--json'], { env });
  if (r.code !== 0) throw new Error(r.err || `open failed: ${r.signal}`);
  const w = JSON.parse(r.out);
  owned.add(w.id);
  return w;
}
async function wait(w, seconds, extra = []) {
  const r = await command('agent', ['wait', w.id, '--timeout', String(seconds), '--json', ...extra], { timeout: (seconds + 5) * 1000 });
  if (!r.out.trim()) throw new Error(r.err || `wait failed: ${r.signal}`);
  return JSON.parse(r.out);
}
async function close(w) {
  if (!w) return;
  const r = await command('agent', ['close', w.id], { timeout: 15000 });
  if (r.code !== 0) throw new Error(`close ${w.id}: ${r.err || r.signal}`);
  owned.delete(w.id);
}
async function scenario(name, harness, expected, limit, body) {
  const started = Date.now();
  let w, got = 'error', pass = false, seconds = 0;
  try {
    const result = await body(worker => { w = worker; });
    got = result.state;
    seconds = (Date.now() - started) / 1000;
    pass = got === expected && (limit === null || seconds <= limit) && (name !== 'question' || result.question === true) && (name !== 'fresh folder trust' || result.kind === 'trust') && (name !== 'permission' || result.kind !== 'trust');
  } catch (e) { got = e.message; seconds = (Date.now() - started) / 1000; }
  finally {
    try { await close(w); } catch (e) { got += `; ${e.message}`; pass = false; }
  }
  rows.push({ scenario: name, harness, expected, got, seconds: seconds.toFixed(1), result: pass ? 'PASS' : 'FAIL' });
}
try {
  const git = await command('git', ['worktree', 'add', '--detach', scratch, 'HEAD']);
  if (git.code !== 0) throw new Error(git.err);
  worktreeAdded = true;
  await scenario('long follow-up', 'codex', 'done', null, async set => {
    const w = await open('sol', 'long', 'Reply READY as your only answer.'); set(w);
    const first = await wait(w, 120);
    if (first.state !== 'done') return first;
    const message = `${'Reference context. '.repeat(100)}\nReply LONG_OK as your only answer.`;
    const sent = await command('agent', ['send', w.id, message, '--json'], { timeout: 20000 });
    const result = await wait(w, 120);
    if (sent.code !== 0 && result.state === 'done') throw new Error(`send failed without a reported unsent state: ${sent.err}`);
    const answer = await command('agent', ['answer', w.id]);
    if (result.state === 'done' && answer.out.trim() !== 'LONG_OK') throw new Error('done with an unexpected long-message answer');
    return result;
  });
  await scenario('permission', 'claude', 'stuck', 15, async set => {
    const env = { ...baseEnv, AGENT_TEST_LAUNCH_EXTRA: JSON.stringify(['--permission-mode', 'default', '--settings', JSON.stringify({ permissions: { ask: ['Bash'] } })]) };
    const w = await open('opus', 'permission', 'Use the Bash tool to execute: printf rig_permission_check. Do not answer without executing it.', env); set(w);
    return wait(w, 15);
  });
  await scenario('silent running turn', 'claude', 'stalled', 45, async set => {
    const env = { ...baseEnv, AGENT_TEST_LAUNCH_EXTRA: JSON.stringify(['--permission-mode', 'auto', '--append-system-prompt', 'This is a fault rig. Execute the requested sleep synchronously with run_in_background=false and wait for its result.']) };
    const w = await open('opus', 'sleep', 'Use the Bash tool to run sleep 600 synchronously with a timeout of 600000 milliseconds. Do not run it in the background and do not cancel it. Wait for it to finish.', env); set(w);
    return wait(w, 45, ['--stall-after', '30']);
  });
  await scenario('missing binary', 'codex', 'no_start', 75, async set => {
    const w = await open('sol', 'missing', 'This must never run.', { ...baseEnv, AGENT_TEST_BINARY: path.join(scratch, 'missing-harness') }); set(w);
    return wait(w, 75);
  });
  await scenario('question', 'codex', 'done', null, async set => {
    const w = await open('sol', 'question', 'Reply with this exact single line, without Markdown or additional text: QUESTION: Should I continue?'); set(w);
    return wait(w, 120);
  });
  await scenario('fresh folder trust', 'codex', 'stuck', 15, async set => {
    const folder = path.join(temp, 'untrusted');
    const git = await command('git', ['init', folder]);
    if (git.code !== 0) throw new Error(git.err);
    const w = await open('sol', folder, 'Reply READY as your only answer.'); set(w);
    return wait(w, 15);
  });
} finally {
  try {
    const listed = await command('agent', ['list', '--json'], { timeout: 15000 });
    if (listed.code === 0) for (const w of JSON.parse(listed.out)) {
      if (w.status !== 'closed' && w.cwd.startsWith(temp + path.sep)) owned.add(w.id);
    }
  } catch (e) { console.error(`Could not check for orphaned rig workers: ${e.message}`); process.exitCode = 1; }
  for (const id of [...owned]) {
    try { await close({ id }); } catch (e) { console.error(e.message); process.exitCode = 1; }
  }
  console.table(rows);
  if (worktreeAdded && owned.size === 0) {
    const removed = await command('git', ['worktree', 'remove', '--force', scratch], { cleanup: true });
    if (removed.code !== 0) { console.error(`Could not remove rig worktree ${scratch}: ${removed.err}`); process.exitCode = 1; }
    else worktreeAdded = false;
  }
  if (!worktreeAdded && owned.size === 0) fs.rmSync(temp, { recursive: true, force: true });
  console.log(worktreeAdded || owned.size ? `Scratch retained for cleanup: ${temp}` : 'Scratch worktree removed; harness transcripts remain in the CLI session folders.');
  if (rows.length !== 6 || rows.some(r => r.result !== 'PASS')) process.exitCode = 1;
}
