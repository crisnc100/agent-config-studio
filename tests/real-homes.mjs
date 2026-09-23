/**
 * THE tripwire: proof that a suite never touched the user's real config.
 *
 * This lives in one file because it existed in three, and they drifted — a fix
 * applied to two of them left the third failing, which is exactly how a safety
 * check quietly stops being one.
 *
 * Two kinds of root, checked two different ways, because fingerprinting a LIVE
 * agent home by mtime does not test the suite — it tests whether anything else
 * on the machine happened to tick a file while the suite ran. Measured, with
 * nothing of ours running: ~/.codex/logs_2.sqlite-wal moved in 3 of 5 idle
 * 3-second windows; its checkpoint then moved logs_2.sqlite; and a running
 * Claude Code session appends to ~/.claude/history.jsonl throughout. Each fix
 * by exemption produced the next false alarm, which is the signal that the rule
 * was wrong rather than the exemption list. A tripwire that cries wolf trains
 * you to ignore it, and this is the one that must never be ignored.
 *
 * So the trees a skill feature actually WALKS are fingerprinted exactly and
 * recursively — nothing else writes those, and a stray write shows instantly.
 * The live harness homes are held to the invariant that is both stable and the
 * one that matters: THE SET OF ENTRY NAMES. Anything a suite could do wrong to
 * them — creating a seat, writing a registry, dropping a file — adds or removes
 * a name.
 *
 * Names alone cannot see an in-place write to a file that already exists, so
 * the handful of files this app can legitimately EDIT are additionally pinned
 * byte-exactly. None of those is touched by a background agent process, unlike
 * the sqlite logs beside them, so they are stable enough to compare precisely.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const realHome = os.homedir();

/** Exact, recursive: for trees nothing else writes. */
const deep = (root, depth = 0) => {
  if (depth > 6) return '…';
  let names;
  try { names = fs.readdirSync(root).sort(); } catch { return null; }
  return names.map((n) => {
    const p = path.join(root, n);
    let s;
    try { s = fs.lstatSync(p); } catch { return `${n}:?`; }
    if (s.isDirectory()) return `${n}/[${deep(p, depth + 1)}]`;
    return `${n}:${s.size}:${s.mtimeMs}`;
  }).join('|');
};

/** Exact, one level: for large trees where recursing is not affordable. */
const shallow = (root) => {
  try {
    return fs.readdirSync(root).sort().map((n) => {
      try { const s = fs.lstatSync(path.join(root, n)); return `${n}:${s.size}:${s.mtimeMs}`; }
      catch { return `${n}:?`; }
    }).join('|');
  } catch { return null; }
};

/** Names only: for homes a live agent process is writing right now. */
const liveNames = (root) => {
  try { return fs.readdirSync(root).sort().join('|'); } catch { return null; }
};

/** The files this app can legitimately edit — pinned exactly. */
const PINNED = [
  path.join(realHome, '.claude', 'settings.json'),
  path.join(realHome, '.claude', 'CLAUDE.md'),
  path.join(realHome, '.codex', 'config.toml'),
  path.join(realHome, '.codex', 'AGENTS.md'),
  path.join(realHome, '.agent-config-studio', 'seats.json'),
  path.join(realHome, '.agent-config-studio', 'accounts.json'),
];
const pinned = () => PINNED.map((f) => {
  try { const s = fs.lstatSync(f); return `${path.basename(f)}:${s.size}:${s.mtimeMs}`; }
  catch { return `${path.basename(f)}:absent`; }
}).join('|');

const ROOTS = [
  ['~/.claude', path.join(realHome, '.claude'), liveNames],
  ['~/.claude/skills', path.join(realHome, '.claude', 'skills'), deep],
  ['~/.codex', path.join(realHome, '.codex'), liveNames],
  ['~/.grok', path.join(realHome, '.grok'), liveNames],
  ['~/.agent-config-studio', path.join(realHome, '.agent-config-studio'), liveNames],
  ['~/.agents', path.join(realHome, '.agents'), deep],
  ['~/Documents/Projects', path.join(realHome, 'Documents', 'Projects'), shallow],
  ['~/Documents/Garman-Homes', path.join(realHome, 'Documents', 'Garman-Homes'), shallow],
];

/** Call BEFORE the suite redirects HOME and builds fixtures. */
export function snapshotRealHomes() {
  return { roots: ROOTS.map(([label, p, fn]) => [label, fn(p)]), pins: pinned() };
}

/** Call at the very end, passing the suite's own ok() so failures are reported in place. */
export function assertRealHomesUnchanged(before, ok) {
  ROOTS.forEach(([label, p, fn], i) => {
    const after = fn(p);
    ok(`${label} is unchanged after this run`, before.roots[i][1] === after, 'it changed');
  });
  ok('the files this app can edit are byte-for-byte untouched',
     before.pins === pinned(), `${before.pins} -> ${pinned()}`);
}
