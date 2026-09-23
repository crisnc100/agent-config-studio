/**
 * THE tripwire: the suite never touches the real config trees.
 *
 *   node tests/real-home.mjs save <file>    (first thing verify.sh does)
 *   node tests/real-home.mjs check <file>   (last thing)
 *
 * Also imported by the skill suites, which snapshot before redirecting HOME and
 * assert at their end, so a leak is pinned to the suite that caused it. It is
 * one file because it used to be two (this and tests/real-homes.mjs) and before
 * that four inlined copies, and copies drift.
 *
 * Three kinds of evidence, and each assertion says which one it is:
 *
 *  - CONTENT, by sha256, for everything this app or the skills feature reads
 *    or can write and nothing else churns: every file under
 *    ~/.agent-config-studio, ~/.claude/skills, ~/.codex/skills and ~/.agents
 *    (symlinks by target, not followed); every project skill tree the skills
 *    feature walks under ~/Documents/Projects and ~/Documents/Garman-Homes,
 *    found the way discovery finds them; and the files the app can edit inside
 *    the live homes — settings.json, CLAUDE.md, config.toml, AGENTS.md.
 *  - ENTRY NAMES ONLY for the live agent homes ~/.claude, ~/.codex, ~/.grok and
 *    the top two levels of the two project roots (plus a hash of the loose
 *    files at their top). Running agents write inside those all
 *    the time (a codex sqlite WAL moved in 3 of 5 idle 3-second windows, a
 *    Claude Code session appends to history.jsonl throughout), so comparing
 *    their bytes tests the machine, not the suite. What a suite could do wrong
 *    there — create a seat, write a registry, drop a file — adds or removes a
 *    name, and the in-place-edit case is the pinned files above.
 *  - The CLI CATALOGS, compared with only their own freshness stamp blanked:
 *    the CLI that owns one re-stamps it whenever it runs, and a stamp-only
 *    refresh is reported by name, not hidden. The Codex and Grok catalogs may
 *    go further. Two Codex clients on this machine take turns rewriting
 *    ~/.codex/models_cache.json with different model lists, so a change there
 *    is accepted only as a CLI rewrite: still valid JSON of that CLI's shape,
 *    and with a freshness stamp newer than at the start of the run. Anything
 *    else fails. That exception is only safe because no ACS source can write a
 *    catalog, which guard g in tests/guards.mjs enforces.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scan } from '../lib/jsontext.js';

const HOME = os.homedir();
const tilde = (p) => p.replace(HOME, '~');
const ROOTS = ['.agent-config-studio', '.claude/skills', '.codex/skills', '.agents'].map((r) => path.join(HOME, r));
const PROJECT_ROOTS = [path.join(HOME, 'Documents', 'Projects'), path.join(HOME, 'Documents', 'Garman-Homes')];
const LIVE_HOMES = ['.claude', '.codex', '.grok'].map((r) => path.join(HOME, r));
const CATALOG_DIR = path.join(HOME, '.claude', 'cache', 'model-catalog');
const EXACT = [
  path.join(HOME, '.claude', 'settings.json'),
  path.join(HOME, '.claude', 'CLAUDE.md'),
  path.join(HOME, '.codex', 'config.toml'),
  path.join(HOME, '.codex', 'AGENTS.md'),
];
const STAMP_KEYS = new Set(['fetched_at', 'renewed_at', 'fetchedAt', 'staleAt']);

/**
 * Entry names another process creates and deletes on its own, ignored in the
 * NAME-SET check and nowhere else. A class rule, not a list of files: SQLite
 * makes `-wal`, `-shm` and `-journal` siblings as connections open and close
 * (the ~/.codex listing carries six, from codex's live databases), and an
 * atomic write goes through a `*.tmp*` name before its rename. Neither churned
 * in a 20-second sample of all three homes on 2026-09-23; the rule exists so
 * that the day one does, this check does not cry wolf and get ignored.
 */
const TRANSIENT = /(-wal|-shm|-journal)$|\.tmp/;

/** The text with only TOP-LEVEL stamp values blanked; a stamp nested in a model entry still counts. */
function blankStamps(text) {
  let root;
  try { root = scan(text); } catch { return text; }
  if (root.type !== 'object') return text;
  let out = text;
  for (const m of [...root.members].reverse()) {
    if (STAMP_KEYS.has(m.key)) out = out.slice(0, m.value.start) + '*' + out.slice(m.value.end);
  }
  return out;
}
const REWRITABLE = {
  [path.join(HOME, '.codex', 'models_cache.json')]: (j) => Array.isArray(j.models) && Date.parse(j.fetched_at),
  [path.join(HOME, '.grok', 'models_cache.json')]: (j) => j.models && typeof j.models === 'object' && !Array.isArray(j.models) &&
    Math.max(Date.parse(j.renewed_at) || 0, Date.parse(j.fetched_at) || 0),
};
const catalogs = () => [
  ...Object.keys(REWRITABLE),
  ...(() => { try { return fs.readdirSync(CATALOG_DIR).filter((n) => n.endsWith('-cc.json')).map((n) => path.join(CATALOG_DIR, n)); } catch { return []; } })(),
];
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/**
 * The skill trees under a project root, found the way lib/skills.js finds them:
 * a `.claude`, `.codex` or `.agents` directory holding `skills`, at most six
 * levels down, never descending into another dot-directory or node_modules.
 * Written out again rather than imported, so a bug in discovery cannot also
 * blind the check on what discovery touched.
 */
function projectSkillTrees(root) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 6) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of entries) {
      if (!d.isDirectory()) continue;
      const abs = path.join(dir, d.name);
      if (d.name === '.claude' || d.name === '.codex' || d.name === '.agents') {
        const skills = path.join(abs, 'skills');
        try { fs.lstatSync(skills); out.push(skills); } catch {}
        continue;
      }
      if (d.name.startsWith('.') || d.name === 'node_modules') continue;
      walk(abs, depth + 1);
    }
  };
  walk(root, 0);
  return out.sort();
}

export function snapshotRealHomes() {
  const out = {};
  const walk = (entry) => {
    let st;
    try { st = fs.lstatSync(entry); } catch { return; }
    if (st.isSymbolicLink()) { out[entry] = `link:${fs.readlinkSync(entry)}`; return; }
    if (st.isFile()) { out[entry] = sha(fs.readFileSync(entry)); return; }
    if (!st.isDirectory()) return;
    let names;
    try { names = fs.readdirSync(entry); } catch { return; }
    for (const name of names) walk(path.join(entry, name));
  };
  for (const r of ROOTS) walk(r);
  for (const r of PROJECT_ROOTS) {
    const trees = projectSkillTrees(r);
    out[`trees:${r}`] = JSON.stringify(trees);
    for (const t of trees) walk(t);
  }
  const nameSet = (r) => {
    let names = null;
    try { names = fs.readdirSync(r).filter((n) => !TRANSIENT.test(n)).sort(); } catch {}
    out[`names:${r}`] = JSON.stringify(names);
  };
  for (const r of LIVE_HOMES) nameSet(r);
  // A project root one level deeper, which is what its entries' mtimes used
  // to stand for: a directory's mtime moves exactly when a child is added,
  // removed or renamed. Its loose files (a CLAUDE.md, a playbook) are hashed.
  for (const r of PROJECT_ROOTS) {
    nameSet(r);
    let entries = [];
    try { entries = fs.readdirSync(r, { withFileTypes: true }); } catch {}
    for (const d of entries) {
      const abs = path.join(r, d.name);
      if (d.isDirectory()) nameSet(abs);
      else if (d.isFile()) walk(abs);
    }
  }
  for (const f of EXACT) {
    try { out[f] = sha(fs.readFileSync(f)); } catch { /* absent */ }
  }
  for (const f of catalogs()) {
    let text;
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    out[f] = `catalog:${sha(blankStamps(text))}`;
    out[`raw:${f}`] = sha(text);
    if (REWRITABLE[f]) {
      let j = null;
      try { j = JSON.parse(text); } catch {}
      out[`meta:${f}`] = JSON.stringify({ stamp: (j && REWRITABLE[f](j)) || null, client: j?.client_version ?? j?.grok_version ?? null });
    }
  }
  return out;
}

/** What changed between two snapshots, split by the kind of evidence. */
export function compareRealHomes(before, after) {
  const content = [];
  const names = [];
  const restamped = [];
  const rewrites = [];
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (k.startsWith('meta:')) continue;
    if (k.startsWith('names:')) {
      if (before[k] !== after[k]) {
        const b = new Set(JSON.parse(before[k] || 'null') || []);
        const a = new Set(JSON.parse(after[k] || 'null') || []);
        const added = [...a].filter((n) => !b.has(n)).map((n) => `+${n}`);
        const removed = [...b].filter((n) => !a.has(n)).map((n) => `-${n}`);
        names.push(`${tilde(k.slice(6))}: ${[...added, ...removed].join(' ')}`);
      }
      continue;
    }
    if (REWRITABLE[k] && before[k] && after[k] && before[k] !== after[k]) {
      const b = JSON.parse(before[`meta:${k}`] || '{}'), a = JSON.parse(after[`meta:${k}`] || '{}');
      if (a.stamp && b.stamp && a.stamp > b.stamp) {
        rewrites.push(`${tilde(k)}: rewritten by its CLI during the run (client ${b.client ?? '?'} → ${a.client ?? '?'}, ` +
          `stamp ${new Date(b.stamp).toISOString()} → ${new Date(a.stamp).toISOString()})`);
      } else {
        content.push(`changed ${tilde(k)} — not a CLI rewrite (${a.stamp ? 'freshness stamp did not advance' : 'no longer a valid catalog'})`);
      }
      continue;
    }
    if (k.startsWith('raw:')) {
      if (before[k] && after[k] && before[k] !== after[k]) restamped.push(k.slice(4));
      continue;
    }
    if (before[k] !== after[k]) {
      content.push(`${before[k] === undefined ? 'added' : after[k] === undefined ? 'removed' : 'changed'} ${tilde(k)}`);
    }
  }
  const notes = [
    ...rewrites,
    ...restamped.filter((x) => !rewrites.some((r) => r.startsWith(tilde(x))))
      .map((f) => `${tilde(f)}: freshness stamp changed during the run; every other byte identical`),
  ];
  return { content, names, notes };
}

const hashedCount = (snap) => Object.keys(snap).filter((k) => !/^(raw|meta|names|trees):/.test(k)).length;
const CONTENT_LABEL = (n) => `${n} files under ~/.agent-config-studio, ~/.claude/skills, ~/.codex/skills, ~/.agents, ` +
  'every project skill tree and the loose files atop both project roots, plus settings.json, CLAUDE.md, config.toml, AGENTS.md and the CLI catalogs, are byte-identical (sha256)';
const NAMES_LABEL = '~/.claude, ~/.codex, ~/.grok, and ~/Documents/Projects and ~/Documents/Garman-Homes two levels deep: entry names unchanged (contents not compared)';

/** For the suites: call snapshotRealHomes() BEFORE redirecting HOME, this at the very end. */
export function assertRealHomesUnchanged(before, ok) {
  const after = snapshotRealHomes();
  const { content, names } = compareRealHomes(before, after);
  ok(CONTENT_LABEL(hashedCount(after)), content.length === 0, content.slice(0, 20).join('; '));
  ok(NAMES_LABEL, names.length === 0, names.join('; '));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, file] = process.argv.slice(2);
  if (cmd === 'save') {
    fs.writeFileSync(file, JSON.stringify(snapshotRealHomes()));
  } else if (cmd === 'check') {
    const before = JSON.parse(fs.readFileSync(file, 'utf8'));
    const after = snapshotRealHomes();
    const { content, names, notes } = compareRealHomes(before, after);
    console.log('\nreal-home');
    for (const n of notes) console.log(`  note ${n}`);
    let failed = 0;
    if (content.length) { failed++; console.log(`  FAIL the real config trees changed during the run:\n    ${content.slice(0, 20).join('\n    ')}`); }
    else console.log(`  ok   ${CONTENT_LABEL(hashedCount(after))}`);
    if (names.length) { failed++; console.log(`  FAIL entry names changed:\n    ${names.join('\n    ')}`); }
    else console.log(`  ok   ${NAMES_LABEL}`);
    console.log(`\n${2 - failed} passed, ${failed} failed\n`);
    process.exit(failed ? 1 : 0);
  } else {
    console.error('usage: real-home.mjs save|check <file>');
    process.exit(2);
  }
}
