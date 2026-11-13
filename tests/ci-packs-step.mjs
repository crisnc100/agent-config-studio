/**
 * The offline job's "does this change touch packs/" step, taken from ci.yml
 * itself and run the way GitHub runs a `run:` block with no `shell:` key
 * (`bash -e`), in scratch git repos. Every case must exit 0, since a failed
 * step turns the required check red, and must write `run=`: false only when
 * a PR's merge commit provably leaves packs/ unchanged, true otherwise. The
 * pack steps after it must test `!= 'false'`, so a step that wrote nothing
 * still runs the packs.
 *
 * Node 20.0.0 runs this in CI: no API newer than that.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './fixtures/cleanup.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CI = path.join(ROOT, '.github', 'workflows', 'ci.yml');
const STEP = 'does this change touch packs/';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

// The same reader as tests/ci-syntax-step.mjs; importing that file would run its checks.
function stepScript(text, name) {
  const lines = text.split('\n');
  const at = lines.findIndex((l) => l.trim() === `- name: ${name}`);
  if (at === -1) return null;
  const stepIndent = lines[at].indexOf('-');
  for (let i = at + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() && (l.search(/\S/) <= stepIndent)) return null;
    const m = l.match(/^(\s*)run:\s*\|\s*$/);
    if (!m) continue;
    const body = [];
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() && lines[j].search(/\S/) <= m[1].length) break;
      body.push(lines[j]);
    }
    const indent = Math.min(...body.filter((b) => b.trim()).map((b) => b.search(/\S/)));
    return body.map((b) => b.slice(indent)).join('\n').trimEnd() + '\n';
  }
  return null;
}

const ciText = fs.readFileSync(CI, 'utf8');
const script = stepScript(ciText, STEP);
console.log('\nci.yml packs condition step');
ok(`ci.yml has a "${STEP}" step that diffs HEAD^1 against HEAD under packs/ and writes run=`, !!script
  && /git diff --quiet HEAD\^1 HEAD -- packs\//.test(script) && /GITHUB_OUTPUT/.test(script), script || 'no step');

const conds = ciText.split('\n').filter((l) => /^\s*if:.*steps\.packs\.outputs\.run/.test(l)).map((l) => l.trim());
ok('the two pack steps after it each run unless the output is exactly false (an empty output runs them)',
  conds.length === 2 && conds.every((c) => /steps\.packs\.outputs\.run != 'false'/.test(c) && !/==/.test(c)), conds.join(' | ') || 'no if: reads steps.packs');

const SCRATCH = tempDir('acs-packs-step-');
const GIT_ENV = {
  PATH: process.env.PATH, HOME: SCRATCH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(SCRATCH, 'no-gitconfig'),
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
  ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
};
function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'init.defaultBranch=main', ...args], { cwd, env: GIT_ENV, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
const put = (root, rel, body) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), body); };

/** A repo whose HEAD is a PR merge commit: first parent the base tip, second a branch that changed `changed`. */
function mergeRepo(name, changed) {
  const root = path.join(SCRATCH, name);
  fs.mkdirSync(root);
  git(root, 'init', '-q');
  put(root, 'packs/p/a.js', 'a\n');
  put(root, 'lib/b.js', 'b\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'base');
  git(root, 'checkout', '-qb', 'feature');
  put(root, changed, 'changed\n');
  git(root, 'commit', '-qam', 'feature');
  git(root, 'checkout', '-q', '--detach', 'main');
  put(root, 'README', 'the base moved on\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'base moves on');
  git(root, 'merge', '-q', '--no-ff', '-m', 'merge feature', 'feature');
  return root;
}
function rootCommitRepo(name) {
  const root = path.join(SCRATCH, name);
  fs.mkdirSync(root);
  git(root, 'init', '-q');
  put(root, 'packs/p/a.js', 'a\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'only');
  return root;
}

// A git that fails every diff with git's own fatal code; everything else goes to the real git.
const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
const SHIM = path.join(SCRATCH, 'shim');
fs.mkdirSync(SHIM);
fs.writeFileSync(path.join(SHIM, 'git'), `#!/bin/sh\nif [ "$1" = diff ]; then echo 'fatal: bad object' >&2; exit 128; fi\nexec ${JSON.stringify(realGit)} "$@"\n`, { mode: 0o755 });

function step(cwd, event, { shim = false } = {}) {
  const file = path.join(SCRATCH, 'step.sh');
  fs.writeFileSync(file, script);
  const out = path.join(SCRATCH, `output-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(out, '');
  const r = spawnSync('bash', ['--noprofile', '--norc', '-e', file], {
    cwd, encoding: 'utf8',
    env: { ...GIT_ENV, PATH: shim ? `${SHIM}${path.delimiter}${process.env.PATH}` : process.env.PATH, EVENT: event, GITHUB_OUTPUT: out },
  });
  const lines = fs.readFileSync(out, 'utf8').split('\n').filter(Boolean);
  return { status: r.status, lines, log: `${r.stdout}${r.stderr}`.trim() };
}

if (script) {
  const cases = [
    ['a PR whose merge commit changes packs/', () => step(mergeRepo('packs', 'packs/p/a.js'), 'pull_request'), 'run=true'],
    ['a PR whose merge commit changes only lib/', () => step(mergeRepo('lib', 'lib/b.js'), 'pull_request'), 'run=false'],
    ['a PR with no HEAD^1 (a root commit)', () => step(rootCommitRepo('root'), 'pull_request'), 'run=true'],
    ['a push', () => step(mergeRepo('push', 'lib/b.js'), 'push'), 'run=true'],
    ['a PR where git diff fails (exit 128)', () => step(mergeRepo('broken', 'lib/b.js'), 'pull_request', { shim: true }), 'run=true'],
  ];
  for (const [name, go, want] of cases) {
    const r = go();
    ok(`${name}: the step exits 0 under bash -e and writes ${want}`, r.status === 0 && r.lines.length === 1 && r.lines[0] === want,
      `exit ${r.status}, output ${JSON.stringify(r.lines)}: ${r.log}`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
