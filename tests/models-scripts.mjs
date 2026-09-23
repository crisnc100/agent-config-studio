/**
 * Criterion 4's script half: the live review scripts resolve their models
 * through the registry. Each runs for real against a throwaway repo with stub
 * `codex`/`claude` binaries (builds/model-registry/inspect-scripts.mjs) and a
 * temp HOME, with THIS checkout's bin/model-id on PATH. The skill scripts are
 * only read and executed; nothing is written under ~/.claude.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect, SCRIPTS } from '../builds/model-registry/inspect-scripts.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULTS = JSON.parse(fs.readFileSync(path.join(ROOT, 'models.default.json'), 'utf8'));

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

console.log('\nmodels/scripts');
const missing = Object.entries(SCRIPTS).filter(([, p]) => !fs.existsSync(p)).map(([k]) => k);
ok('the three review scripts are installed', missing.length === 0, missing.join(', '));

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'acs-scripts-'));
const bin = path.join(work, 'bin');
fs.mkdirSync(bin);
fs.symlinkSync(path.join(ROOT, 'bin', 'model-id'), path.join(bin, 'model-id'));
const bump = path.join(work, 'models.json');
fs.writeFileSync(bump, JSON.stringify({ models: { opus: 'claude-opus-5-5' } }));

const call = (res, key, role) => res[`none/${key}`]?.calls.find((c) => c.role === role);

const base = inspect({ modelIdDir: bin, homes: ['none'] });
ok('control: with no user file the opus lens is the registry default',
   call(base, 'review.mjs/claude-team', 'lens:correctness')?.model === DEFAULTS.models.opus, JSON.stringify(base['none/review.mjs/claude-team']));
ok('control: codex runs the registry astra at high', call(base, 'review.mjs/default', 'codex')?.model === DEFAULTS.models.astra &&
   call(base, 'review.mjs/default', 'codex')?.effort === 'high');

const bumped = inspect({ modelIdDir: bin, homes: ['none'], homeFile: bump });
ok('one edit: review.mjs opus lens → claude-opus-5-5', call(bumped, 'review.mjs/claude-team', 'lens:correctness')?.model === 'claude-opus-5-5',
   JSON.stringify(bumped['none/review.mjs/claude-team']));
ok('one edit: review-loop.mjs verifier → claude-opus-5-5, effort unchanged', call(bumped, 'review-loop.mjs/default', 'verifier')?.model === 'claude-opus-5-5' &&
   call(bumped, 'review-loop.mjs/default', 'verifier')?.effort === 'xhigh', JSON.stringify(bumped['none/review-loop.mjs/default']));
ok('one edit: review-loop-claude.mjs opus lens → claude-opus-5-5', call(bumped, 'review-loop-claude.mjs/default', 'lens:correctness')?.model === 'claude-opus-5-5');
ok('one edit: the sonnet lenses stay the `sonnet` alias', call(bumped, 'review.mjs/claude-team', 'lens:regressions')?.model === 'sonnet');
ok('one edit: nothing else moved', call(bumped, 'review.mjs/default', 'codex')?.model === DEFAULTS.models.astra &&
   call(bumped, 'review-loop.mjs/fixer-claude', 'codex')?.model === DEFAULTS.models.astra);

// A missing resolver must fail loudly, never hand a CLI an empty model.
const empty = path.join(work, 'empty');
fs.mkdirSync(empty);
const lost = inspect({ modelIdDir: empty, homes: ['none'] });
const m = call(lost, 'review.mjs/default', 'codex')?.model;
ok('no model-id on PATH → the codex model is MODEL-ID-UNRESOLVED-astra, not empty', m === 'MODEL-ID-UNRESOLVED-astra', String(m));

fs.rmSync(work, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
