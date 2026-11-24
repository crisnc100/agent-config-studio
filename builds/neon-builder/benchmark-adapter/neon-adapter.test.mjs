import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { prepareNeonGrade } from './neon-grade.mjs';
import { startPostgres } from './run.mjs';

const exec = promisify(execFile);
const runner = fileURLToPath(new URL('./run.mjs', import.meta.url));
const pgBin = '/opt/homebrew/opt/postgresql@17/bin';

function fixture(t, prefix = 'neon-fixture-') {
  const root = fs.mkdtempSync(path.join('/private/tmp', prefix));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  return root;
}

function run(bin, args, opts = {}) {
  const result = spawnSync(bin, args, { encoding: 'utf8', timeout: 30_000, ...opts });
  assert.equal(result.status, 0, JSON.stringify(result));
  return result.stdout.trim();
}

function runGrade(grade, command, cwd, pg) {
  const inv = grade.invocation(command, pg);
  return exec(inv.cmd, inv.args, { cwd, env: inv.env, timeout: 30_000 });
}

test('the Neon builder probes support, keeps reference tests hidden, and stops on quota or incomplete publication', (t) => {
  const root = fixture(t);
  const make = (name) => { const dir = path.join(root, name); fs.mkdirSync(dir, { recursive: true }); return dir; };
  const bin = make('bin');
  const repo = make('source');
  const tmp = make('tmp');
  const cases = make('cases/builder/fixture');
  const world = path.join(root, 'outside.txt');
  fs.writeFileSync(world, 'outside canary');

  const git = (...args) => run('git', ['-C', repo, ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' } });
  git('init', '-q');
  fs.writeFileSync(path.join(repo, 'source.mjs'), 'export default "base";\n');
  git('add', 'source.mjs');
  git('commit', '-qm', 'base');
  const baseSha = git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(repo, 'grade.mjs'), `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import source from './source.mjs';
assert.equal(process.env.FIXTURE_CREDENTIAL, undefined);
assert.throws(() => fs.readFileSync(${JSON.stringify(world)}), { code: 'EPERM' });
assert.equal(source, 'edited');
console.log('1 passed');
`);
  git('add', 'grade.mjs');
  git('commit', '-qm', 'reference');
  const refSha = git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(cases, 'case.json'), JSON.stringify({ id: 'fixture', kind: 'builder', project: 'acs', repo,
    baseSha, refSha, brief: 'Make a harmless edit.', testCommand: 'node grade.mjs', gradeTests: ['grade.mjs'] }));

  const cli = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o700 });
  cli('model-id', `case "$1" in neon) echo gemini-fixture;; fable) echo claude-fixture;; --effort) echo '{}';; *) exit 1;; esac`);
  cli('agy', 'test "$1" = --version && echo 1.5.14');
  cli('ask-model', `
if [ "$1" = --help ]; then
  echo 'usage: ask-model --family --prompt-file'
  if [ "$SCENARIO" != unsupported ]; then echo ' --build'; fi
  exit 0
fi
[ "$1 $2 $3 $4" = '--family neon --build --cwd' ] && [ "$5" = "$(pwd -P)" ] &&
[ "$6" = --prompt-file ] && [ -f "$7" ] && [ "$8 $9 ${'\$'}{10}" = '--effort high --json' ] &&
[ ! -e grade.mjs ] || exit 99
echo 'export default "edited";' > source.mjs
case "$SCENARIO" in
  quota) echo '{"error":"Individual quota reached. Resets in 1h"}'; exit 4;;
  refused) echo 'keychain sign-in unavailable' >&2; exit 3;;
  invalid) echo '{"mode":"read-only","id":"gemini-fixture","answer":"wrong mode","served":{"requested":"gemini-fixture","verified":false}}'; exit 0;;
  unpublished) echo '{"mode":"build","id":"gemini-fixture","answer":"edited","served":{"requested":"gemini-fixture","verified":false},"build":{"published":false},"changed":[]}'; exit 0;;
esac
echo '{"mode":"build","id":"gemini-fixture","answer":"edited","served":{"requested":"gemini-fixture","verified":false},"build":{"published":true},"changed":["source.mjs"]}'
`);

  const call = (scenario, destination, extra = []) => spawnSync(process.execPath, [runner, '--families', 'neon', '--kinds', 'builder',
    '--cases', path.join(root, 'cases'), '--out', path.join(root, destination), ...extra], { encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: tmp, SCENARIO: scenario, FIXTURE_CREDENTIAL: 'never-in-grade' } });
  const rows = (dest) => fs.readFileSync(path.join(root, dest, 'results.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  let r = call('unsupported', 'old', ['--dry-run']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /builder unsupported/);
  r = call('unsupported', 'old');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(rows('old')[0].outcome, 'unsupported');
  assert.equal(rows('old')[0].modelVerified, false);
  r = call('working', 'old', ['--dry-run']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /1 to run/);
  for (const [scenario, error] of [['quota', /quota reached/i], ['refused', /keychain/], ['invalid', /did not confirm/], ['unpublished', /did not confirm/]]) {
    const out = call(scenario, scenario);
    assert.equal(out.status, 3, JSON.stringify(out));
    const [row] = rows(scenario);
    assert.equal(row.outcome, 'errored');
    assert.equal(row.modelVerified, false);
    assert.equal(row.buildAttempted, true);
    assert.equal(row.grade, undefined);
    assert.match(row.error, error);
    assert.equal(row.stop.quota === true, scenario === 'quota');
  }
  r = call('working', 'quota');
  assert.equal(r.status, 0, JSON.stringify(r));
  const resumed = rows('quota').at(-1);
  assert.equal(resumed.outcome, 'built');
  assert.equal(resumed.grade.ok, true, resumed.grade.outputTail);
  assert.equal(resumed.modelVerified, false);
  assert.equal(resumed.served.verified, false);
  assert.equal(resumed.build.published, true);
  assert.deepEqual(resumed.filesChanged, ['M source.mjs']);
  assert.equal(fs.readFileSync(world, 'utf8'), 'outside canary');
  r = call('working', 'quota');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(rows('quota').length, 2);
});

test('the macOS grade sandbox contains child processes, files, credentials, and network', async (t) => {
  const root = fixture(t, 'ng-');
  const caseDir = path.join(root, 'case');
  const repo = path.join(caseDir, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  const outside = path.join(root, 'private.txt');
  const neighbor = path.join(root, 'neighbor');
  const allowed = path.join(root, 'allowed');
  fs.writeFileSync(outside, 'canary data');
  fs.symlinkSync(outside, path.join(repo, 'linked.txt'));
  const listening = (location) => new Promise((resolve, reject) => {
    const server = net.createServer((socket) => socket.end('fixture'));
    t.after(() => server.close());
    server.on('error', reject);
    server.listen(location, () => resolve(server.address()));
  });
  await listening(neighbor);
  await listening(allowed);
  const ipv4 = await listening({ host: '127.0.0.1', port: 0 });
  const ipv6 = await listening({ host: '::1', port: 0 });
  const sockets = { allowed: { path: allowed }, neighbor: { path: neighbor }, ipv4: { host: ipv4.address, port: ipv4.port }, ipv6: { host: ipv6.address, port: ipv6.port } };
  fs.writeFileSync(path.join(repo, 'fixture.mjs'), `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const outside = ${JSON.stringify(outside)};
assert.throws(() => fs.readFileSync(outside), { code: 'EPERM' });
assert.throws(() => fs.readFileSync('linked.txt'), { code: 'EPERM' });
assert.throws(() => fs.linkSync(outside, 'hardlink.txt'), { code: 'EPERM' });
assert.throws(() => fs.writeFileSync(outside, 'changed'), { code: 'EPERM' });
assert.throws(() => fs.writeFileSync('linked.txt', 'changed'), { code: 'EPERM' });
assert.equal(process.env.PATH.includes(${JSON.stringify(os.homedir())}), false);
assert.equal(process.env.SSH_AUTH_SOCK, undefined);
assert.equal(process.env.GH_TOKEN, undefined);
assert.equal(process.env.FIRSTCALL_DATABASE_URL, undefined);
fs.writeFileSync('inside', 'yes');
fs.writeFileSync(path.join(process.env.TMPDIR, 'temporary'), 'yes');
const child = spawnSync(process.execPath, ['-e', 'try { require("node:fs").readFileSync(process.argv[1]); process.exit(7) } catch (e) { process.exit(e.code === "EPERM" ? 0 : 8) }', outside], { detached: true });
assert.equal(child.status, 0, String(child.error));
const sockets = ${JSON.stringify(sockets)};
const connect = (opts) => new Promise((resolve, reject) => {
  const socket = net.connect(opts);
  socket.setTimeout(1000, () => socket.destroy(new Error('timeout')));
  socket.on('error', reject);
  socket.on('data', (data) => resolve(data.toString()));
});
const denied = (e) => e.code === 'EPERM' || e.code === 'EACCES';
for (const name of ['neighbor', 'ipv4', 'ipv6']) await assert.rejects(connect(sockets[name]), denied);
if (process.env.TEST_SOCKET === 'yes') assert.equal(await connect(sockets.allowed), 'fixture');
else await assert.rejects(connect(sockets.allowed), denied);
console.log('1 passed');
`);
  const grade = prepareNeonGrade('node fixture.mjs', { case: caseDir, repo });
  assert.match((await runGrade(grade, 'node fixture.mjs', repo)).stdout, /1 passed/);
  assert.match((await runGrade(grade, 'node fixture.mjs', repo, { socket: allowed, env: { TEST_SOCKET: 'yes' } })).stdout, /1 passed/);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'canary data');
});

test('the disposable grade database cannot act as a superuser or reach host canaries', async (t) => {
  const root = fixture(t, 'ng-pg-');
  const pg = await startPostgres({}, 'a Postgres named by GRADE_DATABASE_URL', root, { neonGrade: true });
  assert.equal(pg.error, undefined, pg.error);
  t.after(() => pg.stop());
  const params = new URLSearchParams(pg.env.GRADE_DATABASE_URL.split('?')[1]);
  const args = ['-X', '-w', '-h', params.get('host'), '-p', params.get('port'), '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'];
  const query = (user, sql) => spawnSync(path.join(pgBin, 'psql'), [...args, '-U', user, '-Atc', sql], { encoding: 'utf8', timeout: 30_000 });
  const outside = path.join(root, 'canary');
  const generated = path.join(root, 'program-ran');
  fs.writeFileSync(outside, 'harmless canary');
  assert.match(query('postgres', 'SELECT 1').stderr, /pg_hba.conf rejects connection/);
  assert.match(query('benchmark_grade', `SELECT pg_read_file('${outside}')`).stderr, /permission denied/);
  assert.match(query('benchmark_grade', `COPY (SELECT 1) TO PROGRAM 'touch ${generated}'`).stderr, /permission denied|must be superuser/);
  assert.equal(fs.existsSync(generated), false);
  assert.equal(query('benchmark_grade', 'CREATE DATABASE fixture').status, 0);
  assert.equal(query('benchmark_grade', 'DROP DATABASE fixture').status, 0);
});

test('the worker runs real Bun tests and uv with a case-local managed Python', async (t) => {
  const root = fixture(t);
  const bunRepo = path.join(root, 'bun', 'repo');
  const uvRepo = path.join(root, 'uv', 'repo');
  fs.mkdirSync(bunRepo, { recursive: true });
  fs.mkdirSync(uvRepo, { recursive: true });
  const bun = prepareNeonGrade('bun test sample.test.mjs', { case: path.dirname(bunRepo), repo: bunRepo });
  fs.writeFileSync(path.join(bunRepo, 'sample.test.mjs'), "import { expect, test } from 'bun:test'; test('fixture', () => expect(1).toBe(1));");
  assert.match((await runGrade(bun, 'bun test sample.test.mjs', bunRepo)).stderr, /1 pass/);

  const uv = prepareNeonGrade('uv run python fixture.py', { case: path.dirname(uvRepo), repo: uvRepo });
  const installed = run('uv', ['python', 'find', '--managed-python', '3.12']);
  const runtime = path.dirname(path.dirname(installed));
  fs.cpSync(runtime, path.join(uv.setupEnv.UV_PYTHON_INSTALL_DIR, path.basename(runtime)),
    { recursive: true, verbatimSymlinks: true });
  fs.writeFileSync(path.join(uvRepo, 'pyproject.toml'), '[project]\nname="fixture"\nversion="0.0.0"\nrequires-python=">=3.12,<3.13"\n');
  fs.writeFileSync(path.join(uvRepo, 'fixture.py'), 'import ssl, sqlite3\nprint("fixture ready")\n');
  run('uv', ['sync', '--offline'], { cwd: uvRepo, env: { ...process.env, ...uv.setupEnv } });
  assert.match((await runGrade(uv, 'uv run python fixture.py', uvRepo)).stdout, /fixture ready/);
  const originalLock = fs.readFileSync(path.join(uvRepo, 'uv.lock'), 'utf8');
  fs.appendFileSync(path.join(uvRepo, 'pyproject.toml'), 'dependencies=["fixture-unavailable-for-neon==1.0"]\n');
  fs.writeFileSync(path.join(uvRepo, 'fixture.py'), 'import fixture_unavailable_for_neon\n');
  await assert.rejects(runGrade(uv, 'uv run python fixture.py', uvRepo),
    (e) => e.code === 1 && /ModuleNotFoundError/.test(e.stderr));
  assert.equal(fs.readFileSync(path.join(uvRepo, 'uv.lock'), 'utf8'), originalLock);
});

test('reference check uses reference source and confined grading without consulting model CLIs', (t) => {
  const root = fixture(t);
  const repo = path.join(root, 'source');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(repo);
  fs.mkdirSync(bin);
  const git = (...args) => run('git', ['-C', repo, ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' } });
  git('init', '-q');
  fs.writeFileSync(path.join(repo, 'source.txt'), 'base');
  git('add', 'source.txt');
  git('commit', '-qm', 'base');
  const baseSha = git('rev-parse', 'HEAD');
  const canary = path.join(root, 'outside.txt');
  fs.writeFileSync(canary, 'outside');
  fs.writeFileSync(path.join(repo, 'source.txt'), 'reference');
  fs.writeFileSync(path.join(repo, 'grade.mjs'), `
import assert from 'node:assert/strict';
import fs from 'node:fs';
assert.equal(fs.readFileSync('source.txt', 'utf8'), 'reference');
assert.equal(fs.readFileSync('setup.txt', 'utf8'), 'reference');
assert.equal(process.env.FIXTURE_CREDENTIAL, undefined);
assert.throws(() => fs.readFileSync(${JSON.stringify(canary)}), { code: 'EPERM' });
assert.equal(process.argv[2], 'pass');
console.log('1 passed');
`);
  git('add', 'source.txt', 'grade.mjs');
  git('commit', '-qm', 'reference');
  const refSha = git('rev-parse', 'HEAD');
  const cases = path.join(root, 'cases');
  for (const [id, arg] of [['fixture-fail', 'fail'], ['fixture-pass', 'pass']]) {
    const dir = path.join(cases, 'builder', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'case.json'), JSON.stringify({ id, kind: 'builder', project: 'acs', repo,
      baseSha, refSha, brief: 'Fixture.', testCommand: `node grade.mjs ${arg}`, gradeTests: ['grade.mjs'],
      setup: ['cat source.txt > setup.txt', 'echo not-the-grade-tests > grade.mjs'] }));
  }
  const contacted = path.join(root, 'model-cli-called');
  for (const name of ['ask-model', 'agy', 'model-id', 'claude', 'codex']) {
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\necho "${name}" >> "$MODEL_CLI_CALLED"\nexit 99\n`, { mode: 0o700 });
  }
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: root,
    MODEL_CLI_CALLED: contacted, FIXTURE_CREDENTIAL: 'never-in-grade' };
  const call = (...args) => spawnSync(process.execPath, [runner, '--reference-check', '--cases', cases, ...args],
    { cwd: root, env, encoding: 'utf8', timeout: 30_000 });
  const separate = path.join(root, 'separate');
  const benchmark = path.join(root, 'benchmark');
  fs.mkdirSync(benchmark);
  const benchmarkResults = path.join(benchmark, 'results.jsonl');
  fs.writeFileSync(benchmarkResults, 'benchmark marker\n');
  for (const args of [[], ['--out', path.dirname(runner) + '/out'], ['--out', benchmark, '--fresh']]) {
    const r = call(...args);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /explicit --out directory separate from benchmark results/);
  }
  const mixedKinds = call('--out', separate, '--kinds', 'builder,context');
  assert.equal(mixedKinds.status, 2, mixedKinds.stderr);
  assert.match(mixedKinds.stderr, /only runs builder cases/);
  assert.equal(fs.readFileSync(benchmarkResults, 'utf8'), 'benchmark marker\n');
  const plan = call('--out', separate, '--dry-run');
  assert.equal(plan.status, 0, plan.stderr);
  assert.match(plan.stdout, /2 grade checks · 0 builder model calls · 0 judge calls/);
  assert.equal(fs.existsSync(separate), false);
  const r = call('--out', separate);
  assert.equal(r.status, 3, JSON.stringify(r));
  const results = path.join(separate, 'reference-check.jsonl');
  const rows = fs.readFileSync(results, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.map(row => [row.caseId, row.outcome, row.grade?.ok]),
    [['fixture-fail', 'reference-failed', false], ['fixture-pass', 'reference-passed', true]]);
  for (const row of rows) {
    assert.equal(row.type, 'reference-check');
    assert.equal(row.refSha, refSha);
    assert.equal(row.model, null);
    assert.equal('buildAttempted' in row, false);
    assert.equal('build' in row, false);
  }
  assert.equal(fs.existsSync(path.join(separate, 'results.jsonl')), false);
  assert.equal(fs.existsSync(path.join(separate, 'prompts')), false);
  assert.equal(fs.existsSync(contacted), false);
  const rerun = call('--out', separate, '--case', 'fixture-pass');
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.match(rerun.stdout, /1 grade checks · 0 builder model calls · 0 judge calls/);
  assert.equal(fs.existsSync(contacted), false);
});
