/**
 * Criterion 9: the suite never touches the real config trees.
 *
 *   node tests/real-home.mjs save <file>    (first thing verify.sh does)
 *   node tests/real-home.mjs check <file>   (last thing)
 *
 * Hashes every file under the real ~/.agent-config-studio, ~/.claude/skills and
 * ~/.codex/skills (symlinks by target, not followed) and fails on any change.
 *
 * Plus the exact files the Models panel reads or can write — settings.json,
 * config.toml and the three CLI catalogs — by name, not by tree: the rest of
 * ~/.claude and ~/.codex churns under any running session.
 *
 * A catalog is compared with only its own freshness stamp blanked: the CLI
 * that owns it re-stamps it whenever it runs, and a stamp-only refresh is
 * reported by name, not hidden.
 *
 * The Codex and Grok catalogs may go further. Two Codex clients on this
 * machine take turns rewriting ~/.codex/models_cache.json with different model
 * lists, so a change there is accepted only as a CLI rewrite: still valid
 * JSON of that CLI's shape, and with a freshness stamp newer than at the start
 * of the run. Anything else fails. That exception is only safe because no ACS
 * source can write a catalog, which guard g in tests/guards.mjs enforces.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scan } from '../lib/jsontext.js';

const HOME = os.homedir();
const ROOTS = ['.agent-config-studio', '.claude/skills', '.codex/skills'].map((r) => path.join(HOME, r));
const CATALOG_DIR = path.join(HOME, '.claude', 'cache', 'model-catalog');
const EXACT = [path.join(HOME, '.claude', 'settings.json'), path.join(HOME, '.codex', 'config.toml')];
const STAMP_KEYS = new Set(['fetched_at', 'renewed_at', 'fetchedAt', 'staleAt']);

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

function snapshot() {
  const out = {};
  const walk = (dir) => {
    let names;
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const name of names) {
      const abs = path.join(dir, name);
      const st = fs.lstatSync(abs);
      if (st.isSymbolicLink()) out[abs] = `link:${fs.readlinkSync(abs)}`;
      else if (st.isDirectory()) walk(abs);
      else if (st.isFile()) out[abs] = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
    }
  };
  for (const r of ROOTS) walk(r);
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

const [cmd, file] = process.argv.slice(2);
if (cmd === 'save') {
  fs.writeFileSync(file, JSON.stringify(snapshot()));
} else if (cmd === 'check') {
  const before = JSON.parse(fs.readFileSync(file, 'utf8'));
  const after = snapshot();
  const diff = [];
  const restamped = [];
  const rewrites = [];
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (k.startsWith('meta:')) continue;
    if (REWRITABLE[k] && before[k] && after[k] && before[k] !== after[k]) {
      const b = JSON.parse(before[`meta:${k}`] || '{}'), a = JSON.parse(after[`meta:${k}`] || '{}');
      if (a.stamp && b.stamp && a.stamp > b.stamp) {
        rewrites.push(`${k.replace(HOME, '~')}: rewritten by its CLI during the run (client ${b.client ?? '?'} → ${a.client ?? '?'}, ` +
          `stamp ${new Date(b.stamp).toISOString()} → ${new Date(a.stamp).toISOString()})`);
      } else {
        diff.push(`changed ${k} — not a CLI rewrite (${a.stamp ? 'freshness stamp did not advance' : 'no longer a valid catalog'})`);
      }
      continue;
    }
    if (k.startsWith('raw:')) {
      if (before[k] && after[k] && before[k] !== after[k]) restamped.push(k.slice(4));
      continue;
    }
    if (before[k] !== after[k]) diff.push(`${before[k] === undefined ? 'added' : after[k] === undefined ? 'removed' : 'changed'} ${k}`);
  }
  console.log('\nreal-home');
  if (diff.length) {
    console.log(`  FAIL the real config trees changed during the run:\n    ${diff.slice(0, 20).join('\n    ')}`);
    console.log('\n0 passed, 1 failed\n');
    process.exit(1);
  }
  for (const r of rewrites) console.log(`  note ${r}`);
  for (const f of restamped.filter((x) => !rewrites.some((r) => r.startsWith(x.replace(HOME, '~'))))) console.log(`  note ${f.replace(HOME, '~')}: freshness stamp changed during the run; every other byte identical`);
  console.log(`  ok   ${Object.keys(after).filter((k) => !/^(raw|meta):/.test(k)).length} files under ~/.agent-config-studio, ~/.claude/skills, ~/.codex/skills, plus settings.json, config.toml and the CLI catalogs, are byte-identical`);
  console.log('\n1 passed, 0 failed\n');
} else {
  console.error('usage: real-home.mjs save|check <file>');
  process.exit(2);
}
