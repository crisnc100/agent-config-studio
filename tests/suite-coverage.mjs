/**
 * tests/SUITE is the only test list, and a test file can never be in no
 * gate without saying so. Fails when:
 *  - a test file (tests/*.mjs, packs/<pack>/tests/*.mjs) is not listed, a
 *    listed file does not exist, or a file is listed twice;
 *  - a line is malformed, or a local, manual or helper line has no reason;
 *  - a ci:<group> has no job in .github/workflows/ci.yml that runs it, ci.yml
 *    runs a group the list does not have, or a job runs a test file directly
 *    that the list does not give that job;
 *  - verify.sh does not run `node tests/run.mjs --local`, or runs a test file
 *    directly (only helpers may be called by name there).
 *
 * Then the controls: each of those cases built in a fixture tree must fail,
 * and tests/run.mjs, run against fixture trees, must keep list order, stop at
 * the first failing file with its exit code, and refuse an unknown group, an
 * empty selection, a missing list, a malformed list and a missing file.
 *
 * Node 20.0.0 runs this in CI: no API newer than that.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSuite } from './run.mjs';
import { tempDir } from './fixtures/cleanup.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const RUNNER = path.join(HERE, 'run.mjs');

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const mjsIn = (dir) => {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile() && d.name.endsWith('.mjs')).map((d) => d.name).sort(); }
  catch { return []; }
};

/** Every file a gate could own: top-level tests/*.mjs and each pack's tests/*.mjs. */
export function testFiles(root) {
  const out = mjsIn(path.join(root, 'tests')).map((f) => `tests/${f}`);
  let packs = [];
  try { packs = fs.readdirSync(path.join(root, 'packs'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort(); } catch {}
  for (const p of packs) out.push(...mjsIn(path.join(root, 'packs', p, 'tests')).map((f) => `packs/${p}/tests/${f}`));
  return out;
}

const NODE_FILE = /\bnode\s+((?:tests|packs)\/[^\s"'`;|&)]+\.mjs)/g;
const RUN_GROUP = /\bnode\s+tests\/run\.mjs\s+([^\s"'`;|&)#]+)/g;
const codeLines = (text) => text.split('\n').filter((l) => !l.trim().startsWith('#'));

/**
 * The jobs under ci.yml's top-level `jobs:` key, split by their two-space
 * indented ids. Not a YAML parser: it reads only what this guard needs, and
 * ci.yml is written in that block style.
 */
export function ciJobs(text) {
  const jobs = new Map();
  let inJobs = false, current = null;
  for (const l of text.split('\n')) {
    if (/^\S/.test(l)) { inJobs = /^jobs:\s*(#.*)?$/.test(l); current = null; continue; }
    if (!inJobs) continue;
    const m = l.match(/^ {2}([A-Za-z0-9_-]+):\s*(#.*)?$/);
    if (m) { current = m[1]; jobs.set(current, []); continue; }
    if (current) jobs.get(current).push(l);
  }
  const out = new Map();
  for (const [id, lines] of jobs) {
    const code = codeLines(lines.join('\n')).join('\n');
    const groups = [...code.matchAll(RUN_GROUP)].map((m) => m[1]);
    const files = [...code.matchAll(NODE_FILE)].map((m) => m[1]).filter((f) => f !== 'tests/run.mjs');
    out.set(id, { groups, files });
  }
  return out;
}

/** Everything wrong with the tree at root, one line each; empty means it passes. */
export function coverage(root) {
  const problems = [];
  const suiteText = read(path.join(root, 'tests', 'SUITE'));
  if (suiteText === null) return ['tests/SUITE is missing'];
  const { entries, errors } = parseSuite(suiteText);
  problems.push(...errors.map((e) => `tests/SUITE ${e}`));

  const seen = new Map();
  for (const e of entries) {
    if (seen.has(e.file)) problems.push(`tests/SUITE lists ${e.file} twice (lines ${seen.get(e.file)} and ${e.line})`);
    else seen.set(e.file, e.line);
    if (!fs.existsSync(path.join(root, e.file))) problems.push(`tests/SUITE line ${e.line}: ${e.file} does not exist`);
  }
  for (const f of testFiles(root)) if (!seen.has(f)) problems.push(`${f} is not in tests/SUITE`);

  const byFile = new Map(entries.map((e) => [e.file, e]));
  const groups = new Map();
  for (const e of entries) for (const g of e.groups) { if (!groups.has(g)) groups.set(g, []); groups.get(g).push(e.file); }

  const ciText = read(path.join(root, '.github', 'workflows', 'ci.yml'));
  if (ciText === null) problems.push('.github/workflows/ci.yml is missing');
  else {
    const jobs = ciJobs(ciText);
    for (const [g, files] of groups) {
      const viaRunner = [...jobs.values()].some((j) => j.groups.includes(g));
      // package and bunx call their files by name (they pass the tarball): the job named for the group must name every one.
      const direct = jobs.has(g) && files.every((f) => jobs.get(g).files.includes(f));
      if (!viaRunner && !direct) problems.push(`ci:${g} has no job in ci.yml that runs it (node tests/run.mjs ${g}, or a job named ${g} that runs each of its files)`);
    }
    for (const [id, j] of jobs) {
      for (const g of j.groups) if (!groups.has(g)) problems.push(`ci.yml job ${id} runs group "${g}", which no line of tests/SUITE is in`);
      for (const f of j.files) if (!byFile.get(f)?.groups.includes(id)) problems.push(`ci.yml job ${id} runs ${f}, which tests/SUITE does not put in ci:${id}`);
    }
  }

  const verifyText = read(path.join(root, 'verify.sh'));
  if (verifyText === null) problems.push('verify.sh is missing');
  else {
    const code = codeLines(verifyText).join('\n');
    if (!/^\s*node\s+tests\/run\.mjs\s+--local\s*$/m.test(code)) problems.push('verify.sh does not run node tests/run.mjs --local');
    for (const m of code.matchAll(NODE_FILE)) {
      const f = m[1];
      if (f !== 'tests/run.mjs' && byFile.get(f)?.lane !== 'helper') problems.push(`verify.sh runs ${f} by name; tests/SUITE owns the order (only helpers are called directly)`);
    }
  }
  return problems;
}

/* ── the checkout ─────────────────────────────────────────────────────── */
console.log('\nsuite coverage: this checkout');
{
  const problems = coverage(ROOT);
  ok('tests/SUITE lists every test file once, each ci group has a job, verify.sh and ci.yml read it', problems.length === 0, `\n    ${problems.join('\n    ')}`);
  const n = testFiles(ROOT).length;
  ok('the walk finds the test files (tests/ and every pack)', n > 100 && testFiles(ROOT).some((f) => f.startsWith('packs/')), `${n} files`);
}

/* ── controls: a fixture tree, then each break of it ──────────────────── */
const GOOD = {
  'tests/SUITE': [
    '# a comment',
    'tests/a.mjs        ci:offline',
    'tests/b.mjs        ci:offline ci:mac',
    'tests/c.mjs        local           # needs the real machine',
    'tests/d.mjs        ci:package      ',
    'tests/e.mjs        ci:offline ci-only',
    'tests/f.mjs        manual          # runs until Ctrl-C',
    'tests/h.mjs        helper          # verify.sh calls it',
    'packs/p/tests/x.test.mjs  ci:packs ci-only',
    '',
  ].join('\n'),
  '.github/workflows/ci.yml': [
    'name: CI',
    'on: [push]',
    'jobs:',
    '  offline:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - run: node tests/run.mjs offline',
    "      - if: steps.packs.outputs.run != 'false'",
    '        run: node tests/run.mjs packs',
    '  mac:',
    '    steps:',
    '      # node tests/c.mjs is only a comment here',
    '      - run: |',
    '          node tests/run.mjs mac',
    '  package:',
    '    steps:',
    '      - run: node tests/d.mjs "$PWD/x.tgz"',
    '',
  ].join('\n'),
  'verify.sh': ['#!/usr/bin/env bash', 'node tests/h.mjs save', 'node tests/run.mjs --local', 'node tests/h.mjs check', ''].join('\n'),
  'tests/a.mjs': '', 'tests/b.mjs': '', 'tests/c.mjs': '', 'tests/d.mjs': '', 'tests/e.mjs': '',
  'tests/f.mjs': '', 'tests/h.mjs': '', 'packs/p/tests/x.test.mjs': '',
};

function tree(files) {
  const root = tempDir('acs-suite-');
  for (const [rel, body] of Object.entries(files)) {
    if (body === null) continue;
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
  return root;
}
const edit = (rel, from, to) => ({ [rel]: GOOD[rel].replace(from, to) });

console.log('\nsuite coverage: controls');
{
  const problems = coverage(tree(GOOD));
  ok('the fixture tree passes as built (so each break below fails for its own reason)', problems.length === 0, problems.join('; '));
}
const BREAKS = [
  ['one unlisted file in tests/', { 'tests/z.mjs': '' }, 'tests/z.mjs is not in tests/SUITE'],
  ['one unlisted pack test', { 'packs/q/tests/y.test.mjs': '' }, 'packs/q/tests/y.test.mjs is not in tests/SUITE'],
  ['a listed file that does not exist', { 'tests/a.mjs': null }, 'tests/a.mjs does not exist'],
  ['a file listed twice', edit('tests/SUITE', '# a comment', 'tests/c.mjs local # again'), 'lists tests/c.mjs twice'],
  ['a local line with no reason', edit('tests/SUITE', 'local           # needs the real machine', 'local'), 'is local and needs a reason'],
  ['a manual line with no reason', edit('tests/SUITE', 'manual          # runs until Ctrl-C', 'manual'), 'is manual and needs a reason'],
  ['a pending-ci line (the lane is gone)', edit('tests/SUITE', 'ci:packs ci-only', 'pending-ci  # later'), 'unknown lane "pending-ci"'],
  ['an unknown lane', edit('tests/SUITE', 'ci:offline ci-only', 'ci:offline ci-onyl'), 'unknown lane "ci-onyl"'],
  ['ci-only with no group', edit('tests/SUITE', 'ci:offline ci-only', 'ci-only'), 'ci-only needs a ci:<group>'],
  ['a line with no lane', edit('tests/SUITE', 'tests/a.mjs        ci:offline', 'tests/a.mjs'), 'tests/a.mjs has no lane'],
  ['a ci group no job runs', edit('tests/SUITE', 'tests/a.mjs        ci:offline', 'tests/a.mjs        ci:linux'), 'ci:linux has no job in ci.yml'],
  ['a group run only from a comment', edit('.github/workflows/ci.yml', '          node tests/run.mjs mac', '          # node tests/run.mjs mac'), 'ci:mac has no job in ci.yml'],
  ['a typo in a group name in ci.yml', edit('.github/workflows/ci.yml', 'node tests/run.mjs offline', 'node tests/run.mjs ofline'), 'runs group "ofline"'],
  ['a job running a file the list does not give it', edit('.github/workflows/ci.yml', 'node tests/d.mjs', 'node tests/c.mjs'), 'runs tests/c.mjs, which tests/SUITE does not put in ci:package'],
  ['verify.sh not calling the runner', edit('verify.sh', 'node tests/run.mjs --local', 'node tests/a.mjs'), 'verify.sh does not run node tests/run.mjs --local'],
  ['verify.sh running a test by name', edit('verify.sh', 'node tests/h.mjs check', 'node tests/c.mjs'), 'verify.sh runs tests/c.mjs by name'],
  ['no tests/SUITE', { 'tests/SUITE': null }, 'tests/SUITE is missing'],
  ['no ci.yml', { '.github/workflows/ci.yml': null }, 'ci.yml is missing'],
];
for (const [name, change, want] of BREAKS) {
  const problems = coverage(tree({ ...GOOD, ...change }));
  ok(`fails on ${name}`, problems.some((p) => p.includes(want)), `want "${want}", got: ${problems.join('; ') || 'no problems'}`);
}

/* ── the runner, against fixture trees ────────────────────────────────── */
console.log('\nsuite runner: tests/run.mjs');
const LOGGER = (name, code) => `import fs from 'node:fs';\nfs.appendFileSync(process.env.SUITE_LOG, '${name} ' + process.cwd() + '\\n');\nprocess.exit(${code});\n`;
function runTree(suite, files, args) {
  const root = tree({ 'tests/SUITE': suite, ...files });
  const log = path.join(root, 'log.txt');
  const r = spawnSync(process.execPath, [RUNNER, '--root', root, ...args], { encoding: 'utf8', env: { ...process.env, SUITE_LOG: log } });
  const ran = (read(log) || '').trim().split('\n').filter(Boolean).map((l) => l.split(' '));
  return { root: fs.realpathSync(root), status: r.status, out: r.stdout + r.stderr, ran };
}
{
  const suite = ['tests/c.mjs ci:g', 'tests/a.mjs ci:g', 'tests/x.mjs ci:other', 'tests/b.mjs ci:g ci-only', 'tests/l.mjs local # here only', 'tests/m.mjs manual # by hand', ''].join('\n');
  const files = { 'tests/a.mjs': LOGGER('a', 0), 'tests/b.mjs': LOGGER('b', 0), 'tests/c.mjs': LOGGER('c', 0), 'tests/x.mjs': LOGGER('x', 0), 'tests/l.mjs': LOGGER('l', 0), 'tests/m.mjs': LOGGER('m', 0) };

  const g = runTree(suite, files, ['g']);
  ok('a group runs its files in list order, one process each, from the tree root', g.status === 0
    && g.ran.map((x) => x[0]).join() === 'c,a,b' && g.ran.every((x) => fs.realpathSync(x[1]) === g.root), `${g.status} ${JSON.stringify(g.ran)}`);
  ok('it prints seconds per file', (g.out.match(/=== ok {3}tests\/\w\.mjs: \d+\.\d+s/g) || []).length === 3, g.out);

  const local = runTree(suite, files, ['--local']);
  ok('--local runs every ci line without ci-only and every local line, in list order, and never a manual one', local.status === 0
    && local.ran.map((x) => x[0]).join() === 'c,a,x,l', `${local.status} ${JSON.stringify(local.ran)}`);

  const listed = runTree(suite, files, ['--local', '--list']);
  ok('--list prints the files in order and runs none', listed.status === 0 && listed.ran.length === 0
    && listed.out.trim().split('\n').join() === 'tests/c.mjs,tests/a.mjs,tests/x.mjs,tests/l.mjs', listed.out);
}
{
  const suite = ['tests/a.mjs ci:g', 'tests/b.mjs ci:g', 'tests/c.mjs ci:g', ''].join('\n');
  const r = runTree(suite, { 'tests/a.mjs': LOGGER('a', 0), 'tests/b.mjs': LOGGER('b', 7), 'tests/c.mjs': LOGGER('c', 0) }, ['g']);
  ok('it stops at the first failing file and exits with that file\'s code', r.status === 7 && r.ran.map((x) => x[0]).join() === 'a,b'
    && /FAIL tests\/b\.mjs: exit 7/.test(r.out) && /1 file\(s\) not run/.test(r.out), `${r.status} ${JSON.stringify(r.ran)} ${r.out}`);
}
{
  const suite = ['tests/a.mjs ci:g', 'tests/m.mjs manual # by hand', ''].join('\n');
  const files = { 'tests/a.mjs': LOGGER('a', 0), 'tests/m.mjs': LOGGER('m', 0) };
  const refusals = [
    ['an unknown group', suite, files, ['gg'], /no file in tests\/SUITE is in group "gg" \(groups: g\)/],
    ['an empty --local selection', 'tests/m.mjs manual # by hand\n', files, ['--local'], /nothing for verify\.sh to run/],
    ['a missing tests/SUITE', null, files, ['g'], /cannot read .*SUITE/],
    ['a malformed list', 'tests/a.mjs ci:g\ntests/m.mjs manual\n', files, ['g'], /malformed[\s\S]*needs a reason/],
    ['a listed file that does not exist', 'tests/a.mjs ci:g\ntests/gone.mjs ci:g\n', files, ['g'], /do not exist: tests\/gone\.mjs/],
    ['no group at all', suite, files, [], /usage/],
    ['two groups at once', suite, files, ['g', '--local'], /usage/],
  ];
  for (const [name, s, f, args, want] of refusals) {
    const r = runTree(s, f, args);
    ok(`it refuses ${name}, non-zero, before running anything`, r.status !== 0 && r.status !== null && r.ran.length === 0 && want.test(r.out), `${r.status} ${JSON.stringify(r.ran)} ${r.out}`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
