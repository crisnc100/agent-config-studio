#!/usr/bin/env node
/**
 * Criterion 1's oracle: every model reference in the lint scope, line by line.
 *
 *   node builds/model-registry/capture-callsites.mjs <out.json>
 *
 * Records RAW extraction only — what token each line names and the effort that
 * sits next to it — and resolves nothing, so the same script captures the
 * before state (ids, versioned names) and the after state ($(model-id x),
 * modelId('x'), family words). compare.mjs does the resolution.
 *
 * A "site" is every span below, bare family words included: prose that said
 * "GPT-6 Astra high" and now says "Astra high" must still be one site naming
 * the same id at the same effort.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HOME = process.env.HOME || os.homedir();
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const EXCLUDE_DIRS = new Set(['.git', '.system', 'synced', 'skills_retired', 'node_modules']);

export const SPAN_PATTERNS = [
  ['model-id', /\$\(\s*model-id\s+"?([A-Za-z0-9.\-]+)"?\s*(?:\|\|\s*echo\s+MODEL-ID-UNRESOLVED-[A-Za-z0-9.\-]+\s*)?\)/g],
  ['modelId', /\bmodelId\(\s*['"]([^'"]+)['"]\s*\)/g],
  ['raw', /\bclaude-(?:opus|sonnet|fable|haiku)-\d+(?:-\d+)*/g],
  ['raw', /\bgpt-\d+(?:\.\d+)?(?:-(?:astra|sol|terra|luna))?/g],
  ['raw', /\bgrok-\d+(?:\.\d+)?(?:-[a-z]+)*/g],
  ['versioned', /\b(?:Fable|Opus|Sonnet|Haiku) \d+(?:\.\d+)?/g],
  ['versioned', /\bGPT-\d+(?:\.\d+)?(?: (?:Astra|Sol|Terra|Luna))?/g],
  ['versioned', /\bGrok \d+(?:\.\d+)?/g],
  ['family', /\b(?:fable|opus|sonnet|haiku|astra|sol|terra|grok)\b/gi],
];

const EFFORT_PATTERNS = [
  /--effort[ =]([a-z]+)/g,
  /--reasoning-effort[ =]([a-z]+)/g,
  /model_reasoning_effort=([a-z]+)/g,
  /"(?:codex|fable|team)?[eE]ffort"\s*:\s*"([a-z]+)"/g,
  /REVIEW_(?:FABLE_|TEAM_)?EFFORT=([a-z]+)/g,
  /cfg\('REVIEW_\w*EFFORT',\s*'\w+',\s*'([a-z]+)'\)/g,
];

const ADJACENT_EFFORT = /^(?:\s|\*\*|`|at\b|,)*(low|medium|high|xhigh)\b/i;

export function extractSpans(line) {
  const taken = [];
  const spans = [];
  const free = (s, e) => !taken.some(([a, b]) => s < b && e > a);
  for (const [kind, re] of SPAN_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(line))) {
      const s = m.index;
      const e = s + m[0].length;
      if (!free(s, e)) continue;
      taken.push([s, e]);
      const tail = line.slice(e, e + 16).match(ADJACENT_EFFORT);
      spans.push({ kind, token: m[1] ?? m[0], at: s, effort: tail ? tail[1].toLowerCase() : null });
    }
  }
  return spans.sort((a, b) => a.at - b.at).map(({ at, ...rest }) => rest);
}

export function extractEfforts(line) {
  const out = [];
  for (const re of EFFORT_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(line))) out.push({ at: m.index, value: m[1] });
  }
  return out.sort((a, b) => a.at - b.at).map((x) => x.value);
}

function walk(dir, out) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const name of names.sort()) {
    const abs = path.join(dir, name);
    const st = fs.lstatSync(abs);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      if (!EXCLUDE_DIRS.has(name)) walk(abs, out);
    } else if (st.isFile() && !name.includes('.bak')) {
      out.push(abs);
    }
  }
}

function projectReviewConfigs(root, out, depth = 0) {
  if (depth > 6) return;
  let names;
  try { names = fs.readdirSync(root); } catch { return; }
  for (const name of names) {
    if (name === 'node_modules' || name === '.git') continue;
    const abs = path.join(root, name);
    let st;
    try { st = fs.lstatSync(abs); } catch { continue; }
    if (!st.isDirectory() || st.isSymbolicLink()) continue;
    if (name === '.claude') {
      const f = path.join(abs, 'review-config.json');
      if (fs.existsSync(f)) out.push(f);
      continue;
    }
    projectReviewConfigs(abs, out, depth + 1);
  }
}

export function scopeFiles(home = HOME) {
  const files = [];
  walk(path.join(home, '.claude', 'skills'), files);
  walk(path.join(home, '.codex', 'skills'), files);
  for (const f of ['CLAUDE.md', 'advisor-config.json', 'review-config.json', 'investigate-config.json']) {
    const abs = path.join(home, '.claude', f);
    if (fs.existsSync(abs)) files.push(abs);
  }
  projectReviewConfigs(path.join(home, 'Documents', 'Projects'), files);
  return files;
}

function acsFiles() {
  const out = [];
  walk(path.join(REPO, 'lib'), out);
  return [...out.filter((f) => f.endsWith('.js')), path.join(REPO, 'server.js'), path.join(REPO, 'public', 'app.js')];
}

const tilde = (abs) => (abs.startsWith(HOME + path.sep) ? '~' + abs.slice(HOME.length) : abs);

function captureFile(abs, { rawOnly = false } = {}) {
  const buf = fs.readFileSync(abs);
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  if (buf.includes(0)) return { file: tilde(abs), sha256, binary: true, sites: [] };
  const sites = [];
  buf.toString('utf8').split('\n').forEach((text, i) => {
    let spans = extractSpans(text);
    if (rawOnly) spans = spans.filter((s) => s.kind === 'raw');
    const efforts = rawOnly ? [] : extractEfforts(text);
    if (!spans.length && !efforts.length) return;
    sites.push({ line: i + 1, text, spans, efforts });
  });
  return { file: tilde(abs), sha256, sites };
}

async function captureAssist() {
  const { HARNESSES } = await import(pathToFileURL(path.join(REPO, 'lib', 'harness.js')).href);
  const out = {};
  for (const [id, d] of Object.entries(HARNESSES)) {
    out[id] = {
      defaultModel: d.defaultModel,
      models: Object.entries(d.models).map(([mid, m]) => ({ id: mid, label: m.label, effort: m.effort ?? null })),
    };
  }
  return out;
}

async function main() {
  const outPath = process.argv[2];
  if (!outPath) { console.error('usage: capture-callsites.mjs <out.json>'); process.exit(2); }
  const files = scopeFiles().map((f) => captureFile(f));
  const acs = acsFiles().map((f) => captureFile(f, { rawOnly: true }));
  const result = {
    capturedAt: new Date().toISOString(),
    home: HOME,
    files,
    acs,
    assist: await captureAssist(),
  };
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2) + '\n');
  const n = files.reduce((k, f) => k + f.sites.reduce((j, s) => j + s.spans.length, 0), 0);
  const bearing = files.reduce((k, f) => k + f.sites.filter((s) => s.spans.some((x) => x.kind !== 'family')).length, 0);
  console.log(`${files.length} files, ${n} model spans, ${bearing} lines naming an id/version/resolver → ${outPath}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
