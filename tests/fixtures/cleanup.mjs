/**
 * Every suite's temp folders and children, gone however the run ends: a
 * pass, a failure, a thrown error, process.exit(), SIGINT or SIGTERM.
 *
 * tempDir(prefix) is fs.mkdtempSync under os.tmpdir() (the same path it
 * returns), remembered for the sweep. track(child) stops a child still
 * running at exit, SIGTERM then SIGKILL (its whole process group with
 * { group: true }, for a detached one). onExit(fn) runs a suite's own
 * synchronous teardown first.
 *
 * A suite's own SIGINT/SIGTERM handler keeps the last word on the exit
 * code: this module exits on a signal only when no other handler is
 * listening, and sweeps either way. tests/fixtures/packs-sandbox.mjs keeps
 * its own sweep, which also asserts that nothing it made is left.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dirs = new Set();
const children = new Set();
const hooks = [];

export function tempDir(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.add(d);
  return d;
}

/** A path made some other way (a fixed name, a fixture's mkdtemp): removed at exit too. */
export function removeOnExit(p) {
  dirs.add(p);
  return p;
}

export function track(child, { group = false } = {}) {
  const entry = { child, group };
  children.add(entry);
  child.once('exit', () => children.delete(entry));
  return child;
}

export function onExit(fn) { hooks.push(fn); }

function remove(d) {
  try { fs.rmSync(d, { recursive: true, force: true }); return; } catch {}
  // A suite that chmods a folder unreadable (an EACCES case) may die before restoring it.
  spawnSync('/bin/chmod', ['-R', 'u+rwX', d]);
  try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
}

// lib/harness.js keeps prompt files in one fixed folder under the temp dir, and a server
// a suite starts with TMPDIR set to os.tmpdir() makes it there. When this run made it, it
// goes too: files whose owner pid has exited, then the folder if that left it empty.
const PROMPTS = path.join(os.tmpdir(), 'acs-harness-prompts');
const promptsBefore = fs.existsSync(PROMPTS);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
function removePrompts() {
  if (promptsBefore) return;
  let names;
  try { names = fs.readdirSync(PROMPTS); } catch { return; }
  for (const n of names) {
    const pid = Number.parseInt(n, 10);
    if (pid > 0 && !alive(pid)) { try { fs.unlinkSync(path.join(PROMPTS, n)); } catch {} }
  }
  try { fs.rmdirSync(PROMPTS); } catch {}
}

let swept = false;
function sweep() {
  if (swept) return;
  swept = true;
  for (const fn of hooks) { try { fn(); } catch {} }
  // SIGTERM first, so a launcher shell's trap can stop the server it started; then SIGKILL.
  const live = [...children].filter(({ child }) => child.exitCode === null && child.signalCode === null);
  const send = (sig) => {
    for (const { child, group } of live) { try { if (group) process.kill(-child.pid, sig); else child.kill(sig); } catch {} }
  };
  if (live.length) { send('SIGTERM'); spawnSync('/bin/sleep', ['0.3']); send('SIGKILL'); }
  children.clear();
  for (const d of dirs) remove(d);
  removePrompts();
}

process.on('exit', sweep);
for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  process.on(sig, function onSignal() {
    sweep();
    if (process.listeners(sig).every((l) => l === onSignal)) process.exit(code);
  });
}
