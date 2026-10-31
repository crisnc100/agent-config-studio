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
  if (child.pid) ownPids.add(child.pid);
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

// lib/harness.js keeps prompt files in one shared folder under the temp dir, each named
// <pid>-<ts>-<rand>.txt by the process that wrote it; a server a suite starts with TMPDIR set
// to os.tmpdir() writes there too. Only this run's files go: this process's and those of the
// children it tracked. Another run's stay, live or dead. The folder goes only when it was not
// there at import and is empty after that (rmdir never removes a file).
const PROMPTS = path.join(os.tmpdir(), 'acs-harness-prompts');
const promptsBefore = fs.existsSync(PROMPTS);
const ownPids = new Set([process.pid]);
function removePrompts() {
  let names;
  try { names = fs.readdirSync(PROMPTS); } catch { return; }
  for (const n of names) {
    if (ownPids.has(Number.parseInt(n, 10))) { try { fs.unlinkSync(path.join(PROMPTS, n)); } catch {} }
  }
  if (!promptsBefore) { try { fs.rmdirSync(PROMPTS); } catch {} }
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
