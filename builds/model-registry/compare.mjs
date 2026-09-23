#!/usr/bin/env node
/**
 * Proves criteria 1 and 2 from the before/after captures.
 *
 *   node builds/model-registry/compare.mjs
 *
 * Criterion 1: every site in every in-scope file resolves to the same id at the
 * same effort. A site's id comes from what it names — a raw id is itself, a
 * versioned name maps through VERSIONED, a family word / $(model-id x) /
 * modelId('x') maps through models.default.json. Per file, the ordered list of
 * (id, adjacent effort) and the ordered list of effort flags must match
 * exactly, except for the EXPLAINED rows below.
 *
 * Criterion 2: scripts.before.json and scripts.after.json must be identical
 * scenario for scenario — every CLI call's model and effort, and the labels.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const read = (f) => JSON.parse(fs.readFileSync(path.join(HERE, f), 'utf8'));
const MODELS = JSON.parse(fs.readFileSync(path.join(REPO, 'models.default.json'), 'utf8')).models;

/** What a versioned name in prose meant when it was written. */
const VERSIONED = {
  'Fable 5.1': 'claude-fable-5-1', 'Fable 5': 'claude-fable-5', 'Opus 5': 'claude-opus-5', 'Opus 5.5': 'claude-opus-5-5',
  'Sonnet 5': 'claude-sonnet-5', 'Haiku 4.5': 'claude-haiku-4-5-20251001',
  'GPT-6 Astra': 'gpt-6-astra', 'GPT-6 Sol': 'gpt-6-sol', 'GPT-5.6 Sol': 'gpt-5.6-sol', 'GPT-5.6 Terra': 'gpt-5.6-terra',
  'Grok 4.5': 'grok-4.5', 'Grok 4.6': 'grok-4.6', 'Grok 4.7': 'grok-4.7',
};

/**
 * Diffs that are not regressions, each with its reason. A row matches one
 * site: same file suffix, before id → after id.
 */
const EXPLAINED = [
  {
    file: '.claude/skills/fable-safe-prompt/SKILL.md', from: 'claude-fable-5', to: 'claude-fable-5-1',
    why: 'prose "Fable 5"/"Opus 5" about the product generally; rule 4 names families, which resolve to the current id. No invocation.',
  },
];

/**
 * Spans present only after, that are not model sites. Matched by file, token
 * and a substring of the line.
 */
const NOT_A_SITE = [
  {
    file: '.claude/skills/deep-review/review-loop-claude.mjs', token: 'sonnet', line: "claudeFixer({ model: MODEL !== 'sonnet'",
    why: "the team-mode sentinel literal guarding the fixer: 'sonnet' is passed through unresolved, exactly as before",
  },
];

/** The files this build writes — anything else that changed was changed by someone else. */
const WRITTEN = new Set([...fs.readFileSync(path.join(HERE, 'rewrite-skills.py'), 'utf8').matchAll(/^'(\.[^']+)': \[/gm)].map((m) => `~/${m[1]}`));

function resolve(span) {
  switch (span.kind) {
    case 'raw': return span.token;
    case 'versioned': return VERSIONED[span.token] ?? `?versioned:${span.token}`;
    case 'family': return MODELS[span.token.toLowerCase()] ?? `?family:${span.token}`;
    default: return MODELS[span.token] ?? span.token;
  }
}

function sequence(file, ignored = []) {
  const sites = [];
  const efforts = [];
  for (const s of file.sites) {
    for (const sp of s.spans) {
      const skip = NOT_A_SITE.find((x) => file.file.endsWith(x.file) && x.token === sp.token && s.text.includes(x.line));
      if (skip) { ignored.push(`${file.file}:${s.line} '${sp.token}' — ${skip.why}`); continue; }
      sites.push({ line: s.line, id: resolve(sp), effort: sp.effort, token: sp.token });
    }
    efforts.push(...s.efforts.map((e) => ({ line: s.line, e })));
  }
  return { sites, efforts };
}

let failures = 0;
const explainedUsed = [];
const fail = (msg) => { failures++; console.log(`  FAIL ${msg}`); };

console.log('criterion 1 — call sites');
const before = read('callsites.before.json');
const after = read('callsites.after.json');
const afterBy = new Map(after.files.map((f) => [f.file, f]));
let nBefore = 0, nAfter = 0, nBearing = 0, filesChanged = 0;
const ignored = [];
const external = [];
for (const bf of before.files) {
  const af = afterBy.get(bf.file);
  if (!af) { fail(`${bf.file} is gone`); continue; }
  if (af.sha256 !== bf.sha256) {
    if (!WRITTEN.has(bf.file)) { external.push(bf.file); continue; }
    filesChanged++;
  }
  const b = sequence(bf), a = sequence(af, ignored);
  nBefore += b.sites.length; nAfter += a.sites.length;
  nBearing += bf.sites.filter((s) => s.spans.some((x) => x.kind !== 'family')).length;
  if (b.sites.length !== a.sites.length) {
    fail(`${bf.file}: ${b.sites.length} sites before, ${a.sites.length} after`);
    continue;
  }
  b.sites.forEach((s, i) => {
    const t = a.sites[i];
    if (s.id === t.id && s.effort === t.effort) return;
    const ex = EXPLAINED.find((x) => bf.file.endsWith(x.file) && x.from === s.id && x.to === t.id && s.effort === t.effort);
    if (ex) { explainedUsed.push(`${bf.file}:${s.line} ${s.token} → ${t.token}`); return; }
    fail(`${bf.file}:${s.line}→${t.line} site ${i}: ${s.id}@${s.effort ?? '-'} (${s.token}) became ${t.id}@${t.effort ?? '-'} (${t.token})`);
  });
  const be = b.efforts.map((x) => x.e).join(','), ae = a.efforts.map((x) => x.e).join(',');
  if (be !== ae) fail(`${bf.file}: effort flags changed: [${be}] → [${ae}]`);
}
for (const af of after.files) if (!before.files.some((f) => f.file === af.file)) fail(`${af.file} is new in scope`);
const unresolved = after.files.flatMap((f) => sequence(f).sites.filter((s) => s.id.startsWith('?')).map((s) => `${f.file}:${s.line} ${s.token}`));
if (unresolved.length) fail(`after has sites that resolve to nothing: ${unresolved.join(', ')}`);
console.log(`  ${before.files.length} files, ${filesChanged} rewritten; ${nBearing} model-bearing lines before; ${nBefore} sites before = ${nAfter} after`);
for (const e of explainedUsed) console.log(`  explained  ${e}`);
for (const e of ignored) console.log(`  not a site ${e}`);
for (const e of external) console.log(`  EXTERNAL   ${e} changed during the build, not by it (not in rewrite-skills.py) — not compared`);

// Stated change 1: ACS Assist Fable id (and so its derived label). Everything else identical.
console.log('\ncriterion 1 — ACS Assist picker');
{
  const b = before.assist, a = after.assist;
  for (const h of Object.keys(b)) {
    const bm = b[h].models, am = a[h]?.models || [];
    if (b[h].defaultModel !== a[h]?.defaultModel) fail(`${h} default ${b[h].defaultModel} → ${a[h]?.defaultModel}`);
    if (bm.length !== am.length) { fail(`${h}: ${bm.length} models → ${am.length}`); continue; }
    bm.forEach((m, i) => {
      const n = am[i];
      const same = m.id === n.id && m.label === n.label && m.effort === n.effort;
      const stated = h === 'claude' && m.id === 'claude-fable-5' && n.id === 'claude-fable-5-1' &&
        n.label === m.label.replace('Fable 5 ', 'Fable 5.1 ') && m.effort === n.effort;
      if (stated) console.log(`  stated     claude: ${m.id} "${m.label}" → ${n.id} "${n.label}" (effort ${n.effort})`);
      else if (!same) fail(`${h}[${i}] ${JSON.stringify(m)} → ${JSON.stringify(n)}`);
    });
  }
  const leftovers = after.acs.flatMap((f) => f.sites.map((s) => `${f.file}:${s.line}`))
    .filter((s) => !/lib\/usage\/seats\.js:/.test(s));
  if (leftovers.length) fail(`ACS source still names raw ids: ${leftovers.join(', ')}`);
  else console.log('  ACS lib/, server.js, public/app.js: no raw ids left (seats.js `grok-1` is a seat id)');
}

console.log('\ncriterion 2 — review scripts');
{
  const b = read('scripts.before.json').scenarios, a = read('scripts.after.json').scenarios;
  const keys = new Set([...Object.keys(b), ...Object.keys(a)]);
  let same = 0;
  for (const k of keys) {
    const x = b[k], y = a[k];
    if (!x || !y) { fail(`${k} missing ${x ? 'after' : 'before'}`); continue; }
    const strip = (v) => JSON.stringify({ exit: v.exit, calls: v.calls, labels: v.labels, showConfig: v.showConfig });
    if (strip(x) === strip(y)) { same++; continue; }
    fail(`${k}:\n      before ${strip(x)}\n      after  ${strip(y)}`);
  }
  console.log(`  ${same}/${keys.size} scenarios identical (codex model+effort, verifier model+effort, every lens model+effort, labels)`);
}

console.log(`\n${failures ? `FAILED — ${failures} unexplained difference(s)` : 'PASS — no unexplained differences'}`);
process.exit(failures ? 1 : 0);
