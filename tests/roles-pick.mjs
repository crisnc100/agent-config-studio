import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadRegistry } from '../lib/models.js';
import { BUILDER_PICK_ESCAPE, checkRoles, loadRoles, pickBuilder, resolveRole } from '../lib/roles.js';
import { credentialStat } from '../lib/usage/seats.js';
import { tempDir } from './fixtures/cleanup.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const BIN = path.join(ROOT, 'bin', 'model-id.mjs');
const NOW = Date.parse('2026-11-24T15:00:00Z');
const studio = (home, name) => path.join(home, '.agent-config-studio', name);
const ordered = ['sol', 'opus', 'neon'];
const write = (file, body) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
};
const writeJson = (file, json) => write(file, JSON.stringify(json));
const makeRoles = (builder, flavor) => ({ version: 2, roles: { builder }, ...(flavor ? { flavor } : {}) });
function saveRoles(home, builder, flavor) {
  writeJson(studio(home, 'roles.json'), makeRoles(builder, flavor));
}
function makeHome(builder = { use: ordered }, flavor) {
  const home = fs.realpathSync(tempDir('acs-builder-pick-'));
  saveRoles(home, builder, flavor);
  return home;
}
const pick = (home, opts = {}) => pickBuilder({ home, now: NOW, env: {}, ...opts });
const run = (home, argv, { bin = process.execPath, cwd, env = {} } = {}) => spawnSync(bin, argv, {
  cwd, env: { HOME: home, PATH: '/usr/bin:/bin', ...env }, encoding: 'utf8', timeout: 9000,
});
const cli = (home, ...args) => run(home, [BIN, ...args]);
const cliPick = (home, ...args) => cli(home, '--pick', 'builder', '--json', ...args);
const unexpected = () => assert.fail('another selection strategy ran');

test('builder-only policy is validated and merged as one optional object', () => {
  const home = makeHome();
  const families = Object.keys(loadRegistry({ home }).registry.models);
  const validate = (policy, role = 'builder') => checkRoles({
    version: 2, roles: { [role]: { use: ordered, pick: policy } },
  }, 'roles', { families });
  for (const policy of [
    { mode: 'ordered' },
    { mode: 'random', design: 'opus', reservePercent: 0 },
    { mode: 'jev', reservePercent: 12.5 },
    { mode: 'jev', design: 'terra', reservePercent: 100 },
  ]) {
    validate(policy);
    saveRoles(home, { use: ordered, pick: policy });
    assert.deepEqual(loadRoles({ home }).roles.builder.pick, policy);
  }
  assert.throws(() => validate({ mode: 'ordered' }, 'advisor'), /only the builder role/);
  for (const policy of [null, [], 'ordered', {}, { mode: 'first' }, { mode: 'jev', enabled: false }]) {
    assert.throws(() => validate(policy), /roles\.builder\.pick/);
  }
  for (const reservePercent of [-0.1, 100.1, true, null, '0', Infinity, NaN]) {
    assert.throws(() => validate({ mode: 'random', reservePercent }), /reservePercent/);
  }
  for (const design of ['unknown-family', '', null, 1]) {
    assert.throws(() => validate({ mode: 'ordered', design }), /pick\.design/);
  }
});

test('ordered pick preserves legacy role bytes, effort precedence and the second opinion', () => {
  const home = makeHome();
  const builder = { use: [{ family: 'opus', effort: 'xhigh' }, 'sol'], effort: 'medium', alt: 'neon' };
  const flavor = { opus: { effort: 'high' }, sol: { effort: 'max' } };
  saveRoles(home, builder, flavor);
  const first = pick(home, { randomIndex: unexpected, choose: unexpected });
  const before = ['--role builder', '--role builder --json'].map((argv) => cli(home, ...argv.split(' ')));
  saveRoles(home, { ...builder, pick: { mode: 'random', design: 'sol', reservePercent: 0 } }, flavor);
  const after = ['--role builder', '--role builder --json'].map((argv) => cli(home, ...argv.split(' ')));
  for (let i = 0; i < before.length; i++) {
    assert.equal(before[i].status, 0);
    assert.equal(after[i].status, before[i].status);
    assert.equal(after[i].stdout, before[i].stdout);
    assert.equal(after[i].stderr, before[i].stderr);
  }
  const legacy = resolveRole('builder', { home });
  assert.equal(first.family, legacy.family);
  assert.equal(first.id, legacy.id);
  assert.equal(first.effort, 'xhigh');
  assert.equal(first.effortSource, 'member');
  assert.equal(first.mode, 'ordered');
  assert.equal(legacy.alt, 'neon');
  const second = pick(home, { exclude: ['opus'], randomIndex: () => 0 });
  assert.equal(second.family, 'sol');
  assert.equal(second.effort, 'medium');
  assert.equal(second.effortSource, 'role');
  assert.equal(pick(home, { exclude: ['opus', 'sol'] }).error, 'no eligible builder');
});

test('one random index per pick, with no weight from position, flavor or a saved design preference', () => {
  const home = makeHome({ use: ordered, pick: { mode: 'random', design: 'opus' } }, {
    opus: { likes: ['Frontend and visual design'] },
  });
  const calls = [];
  const draws = ordered.map((_, index) => pick(home, {
    randomIndex: (upper) => { calls.push(upper); return index; },
    choose: unexpected,
  }).family);
  assert.deepEqual(calls, [3, 3, 3]);
  assert.deepEqual(draws, ordered);
  assert.equal(pick(home, { design: true, randomIndex: unexpected }).family, 'opus');
  assert.equal(pick(home, { design: true, exclude: ['opus'], randomIndex: () => 1 }).family, 'neon');
  saveRoles(home, { use: ordered, pick: { mode: 'random', design: 'terra' } });
  assert.equal(pick(home, { design: true, randomIndex: () => 2 }).family, 'neon');
  assert.match(pick(home, { design: 'yes' }).error, /design/);
  assert.match(pick(home, { exclude: 'opus' }).error, /exclusion/);
  assert.match(pick(home, { exclude: ['opusss'] }).error, /known model family/);
});

test('vendor and family pauses and explicit exclusions remove candidates without admitting the alt', () => {
  const home = makeHome({ use: ['astra', ...ordered], alt: 'fable', pick: { mode: 'random', design: 'opus' } });
  writeJson(studio(home, 'paused.json'), { paused: [{ name: 'codex' }, { name: 'opus' }, { name: 'neon', until: new Date(1).toISOString() }] });
  const result = pick(home, { design: true, randomIndex: (count) => { assert.equal(count, 1); return 0; } });
  assert.equal(result.family, 'neon');
  assert.deepEqual(result.skipped, [
    { family: 'astra', reason: 'paused by codex' },
    { family: 'sol', reason: 'paused by codex' },
    { family: 'opus', reason: 'paused by opus' },
  ]);
  const unavailable = cliPick(home, '--exclude', 'neon', '--exclude', 'fable');
  assert.equal(unavailable.status, 2, unavailable.stderr);
  const out = JSON.parse(unavailable.stdout);
  assert.deepEqual(out.eligible, []);
  assert.equal(out.error, 'no eligible builder');
  assert.equal(Object.hasOwn(out, 'family'), false);
  assert.ok(out.skipped.some(({ family, reason }) => family === 'neon' && reason === 'explicitly excluded'));
  writeJson(studio(home, 'paused.json'), { paused: [{ name: 'codex' }, { name: 'claude' }, { name: 'gemini' }] });
  assert.equal(pick(home).skipped.length, 4);
});

const window = (usedPercent, extra = {}) => ({ usedPercent, resetsAt: NOW + 60_000, ...extra });
const seat = (vendor, windows, extra = {}) => ({ vendor, windows, ok: true, observedAt: NOW - 20_000, ...extra });
const claude = (windows, extra = {}) => seat('claude', windows, { home: null, credentialSource: 'keychain', ...extra });
const gemini = (windows, extra = {}) => seat('gemini', windows, { harness: 'agy', ...extra });
const snapshot = (home, seats, takenAt = NOW - 1000) => writeJson(studio(home, 'usage-snapshot.json'), { takenAt, seats });
function account(home, dir) {
  const accountHome = path.join(home, dir);
  write(path.join(accountHome, 'auth.json'), '{"fixture":true}');
  return { home: accountHome, credentialStat: credentialStat(accountHome), signedIn: true };
}

test('Codex is matched by effective home and credential, with opposite headroom across accounts', () => {
  const home = makeHome({ use: ['sol', 'opus'], pick: { mode: 'ordered', reservePercent: 0 } });
  const primary = account(home, '.codex');
  const secondary = account(home, 'work seat');
  snapshot(home, [seat('codex', [window(100)], primary), seat('codex', [window(3)], secondary)]);
  assert.equal(pick(home).family, 'opus');
  const alternate = pick(home, { env: { CODEX_HOME: secondary.home } });
  assert.equal(alternate.family, 'sol');
  assert.equal(alternate.usage[0].status, 'available');
  const alias = path.join(home, 'different-name');
  fs.symlinkSync(primary.home, alias);
  assert.equal(pick(home, { env: { CODEX_HOME: alias } }).family, 'opus');
  const unmapped = pick(home, { env: { CODEX_HOME: path.join(home, 'unmapped') } });
  assert.equal(unmapped.family, 'sol');
  assert.match(unmapped.usage[0].reason, /active codex account/);
  const auth = path.join(primary.home, 'auth.json');
  write(`${auth}.new`, '{"different":true}');
  fs.renameSync(`${auth}.new`, auth);
  const changed = pick(home);
  assert.equal(changed.family, 'sol');
  assert.equal(changed.usage[0].status, 'unknown');
  assert.match(changed.usage[0].reason, /current credential/);
});

test('an older Codex snapshot needs a credential that predates its reading', () => {
  const home = makeHome({ use: ['sol', 'opus'], pick: { mode: 'ordered', reservePercent: 0 } });
  const primary = account(home, '.codex');
  const auth = path.join(primary.home, 'auth.json');
  snapshot(home, [seat('codex', [window(100)], { home: primary.home, signedIn: true })]);
  const old = new Date(NOW - 60_000);
  fs.utimesSync(auth, old, old);
  assert.equal(pick(home).family, 'opus');
  const rotated = new Date(NOW - 10_000);
  fs.utimesSync(auth, rotated, rotated);
  const unknown = pick(home);
  assert.equal(unknown.family, 'sol');
  assert.match(unknown.usage[0].reason, /current credential/);
});

test('optional reserve protects headroom, skips exhaustion at zero, and keeps unknown eligible', () => {
  const home = makeHome({ use: ['opus', 'neon'] });
  const readings = [claude([window(100, { kind: 'session' })]), gemini([window(95)])];
  snapshot(home, readings);
  assert.equal(pick(home).family, 'opus');
  assert.deepEqual(pick(home).usage, []);
  saveRoles(home, { use: ['opus', 'neon'], pick: { mode: 'ordered', reservePercent: 0 } });
  assert.equal(pick(home).family, 'neon');
  saveRoles(home, { use: ['opus', 'neon'], pick: { mode: 'ordered', reservePercent: 5 } });
  assert.equal(pick(home).family, 'neon');
  saveRoles(home, { use: ['opus', 'neon'], pick: { mode: 'jev', reservePercent: 5.1, design: 'opus' } });
  const unavailable = pick(home, { design: true, randomIndex: unexpected, choose: unexpected });
  assert.equal(unavailable.error, 'no eligible builder');
  assert.deepEqual(unavailable.eligible, []);
  assert.deepEqual(unavailable.usage.map(({ status }) => status), ['limited', 'limited']);
  assert.match(unavailable.skipped[0].reason, /exhausted/);
  assert.match(unavailable.skipped[1].reason, /reserve/);
  fs.unlinkSync(studio(home, 'usage-snapshot.json'));
  const missing = pick(home, { design: true, choose: unexpected });
  assert.equal(missing.family, 'opus');
  assert.deepEqual(missing.usage.map(({ status }) => status), ['unknown', 'unknown']);
});

test('fresh snapshot cannot validate stale, duplicate, reset, malformed or unmapped readings', () => {
  const home = makeHome({ use: ['opus'], pick: { mode: 'ordered', reservePercent: 10 } });
  const exhausted = window(100, { kind: 'weekly_all' });
  const old = NOW - 3_600_001;
  for (const [readings, takenAt, reason] of [
    [[claude([exhausted], { rateLimited: true, observedAt: old })], NOW - 10, /reading is stale/],
    [[claude([exhausted], { observedAt: old })], old, /snapshot is stale/],
    [[claude([exhausted], { observedAt: NOW + 1 })], NOW - 10, /reading is stale/],
    [[claude([exhausted], { duplicateOf: 'other-seat' })], NOW - 10, /ambiguous or duplicated/],
    [[claude([exhausted]), claude([window(0)])], NOW - 10, /ambiguous or duplicated/],
    [[claude([exhausted], { home: path.join(home, '.claude-work') })], NOW - 10, /active claude account/],
    [[claude([exhausted], { credentialSource: 'env' })], NOW - 10, /active claude account/],
    [[claude([{ ...exhausted, resetsAt: NOW }])], NOW - 10, /no current applicable window/],
    [[claude([{ ...exhausted, resetsAt: null }, { ...exhausted, usedPercent: '100' }])], NOW - 10, /no current applicable window/],
  ]) {
    snapshot(home, readings, takenAt);
    const result = pick(home);
    assert.equal(result.family, 'opus');
    assert.equal(result.usage[0].status, 'unknown');
    assert.match(result.usage[0].reason, reason);
  }
  snapshot(home, [claude([exhausted])]);
  const alternate = pick(home, { env: { CLAUDE_CONFIG_DIR: path.join(home, '.claude-work') } });
  assert.equal(alternate.family, 'opus');
  assert.match(alternate.usage[0].reason, /active claude account/);
  assert.equal(pick(home).error, 'no eligible builder');
  const alternateHome = path.join(home, '.claude-work');
  snapshot(home, [claude([exhausted], { home: alternateHome, credentialSource: 'credentials-file' })]);
  assert.equal(pick(home).family, 'opus');
  assert.equal(pick(home, { env: { CLAUDE_CONFIG_DIR: alternateHome } }).error, 'no eligible builder');
});

test('Claude model-scoped labels and Gemini Argon quota cannot exclude a builder', () => {
  const home = makeHome({ use: ['opus', 'neon'], pick: { mode: 'ordered', reservePercent: 10 } });
  const scoped = window(100, { kind: 'weekly_scoped', label: 'Weekly (Opus)' });
  const withArgon = gemini([window(30)], { extraWindows: [window(100, { label: 'Argon weekly' })] });
  snapshot(home, [claude([scoped]), withArgon]);
  assert.deepEqual(pick(home).usage.map(({ status }) => status), ['unknown', 'available']);
  snapshot(home, [claude([scoped, window(94, { kind: 'session' })]), withArgon]);
  const result = pick(home);
  assert.equal(result.family, 'neon');
  assert.equal(result.usage[1].remainingPercent, 70);
});

test('Jev uses normal strategy when a design preference is absent and runs only when it can decide', () => {
  const home = makeHome({ use: ordered, pick: { mode: 'jev' } });
  const choose = () => ({ answer: { type: 'choice', choice: 'neon', confidence: 0.7 } });
  assert.equal(pick(home, { design: true, choose }).family, 'neon');
  assert.equal(pick(home, { exclude: ['sol', 'opus'], choose: unexpected }).family, 'neon');
  saveRoles(home, { use: ordered, pick: { mode: 'jev', design: 'opus' } });
  assert.equal(pick(home, { design: true, choose: unexpected }).family, 'opus');
  assert.equal(pick(home, { design: false, choose }).family, 'neon');
  assert.equal(pick(home, { design: true, exclude: ['opus'], choose }).family, 'neon');
});

function installJevStub(home) {
  const fake = path.join(home, 'stub-bin');
  const executable = path.join(fake, 'jev');
  const capture = path.join(home, 'capture.json');
  write(executable, `#!${process.execPath}
const fs = require('node:fs');
const { STUB_RESULT, STUB_CAPTURE } = process.env;
const request = JSON.parse(fs.readFileSync(0, 'utf8'));
fs.writeFileSync(STUB_CAPTURE, JSON.stringify({ request, args: process.argv.slice(2) }));
if (STUB_RESULT === 'exit') {
  process.stderr.write('synthetic diagnostic with task contents');
  process.exit(7);
}
if (STUB_RESULT === 'invalid') process.stdout.write('broken JSON');
else if (STUB_RESULT === 'large') process.stdout.write('x'.repeat(128 * 1024));
else if (STUB_RESULT === 'timeout') {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
} else process.stdout.write(STUB_RESULT);
`);
  fs.chmodSync(executable, 0o755);
  return { fake, capture };
}
const choice = (family = 'neon', confidence = 0.9, type = 'choice') => JSON.stringify({
  answers: { builder: { type, choice: family, confidence } },
});
const pickWithStub = (home, args, stub, answer, opts = {}) => run(home, [BIN, '--pick', 'builder', '--json', ...args], {
  ...opts,
  env: { PATH: `${stub.fake}:/usr/bin:/bin`, STUB_RESULT: answer, STUB_CAPTURE: stub.capture, ...opts.env },
});

test('installed picker reads bounded task text and sends eligible saved profiles as fixed Jev JSON on stdin', () => {
  const likes = ['Fast schema work `$HOME`'];
  const quirks = ['Watch for scope changes'];
  const home = makeHome({ use: ordered, pick: { mode: 'jev' } }, {
    sol: { likes, quirks, avoid: ['advisor'] },
    neon: { effort: 'high' },
  });
  const stub = installJevStub(home);
  const task = path.join(home, 'task with spaces.txt');
  const snippet = 'Database logic $(echo example) '.padEnd(4096, '.');
  write(task, `${snippet}outside the limit`);
  const src = tempDir('acs-pick-install-');
  for (const rel of ['bin/model-id.mjs', 'lib/roles.js', 'lib/roles.default.json', 'lib/models.js', 'models.default.json', 'package.json']) {
    write(path.join(src, rel), fs.readFileSync(path.join(ROOT, rel)));
  }
  assert.equal(run(home, [path.join(src, 'bin', 'model-id.mjs'), '--install']).status, 0);
  fs.rmSync(src, { recursive: true });
  const installed = path.join(home, '.local', 'bin', 'model-id');
  const result = run(home, ['--json', '--pick', 'builder', '--task-file', task, '--exclude', 'opus'], {
    bin: installed, env: { PATH: `${stub.fake}:/usr/bin:/bin`, STUB_RESULT: choice(), STUB_CAPTURE: stub.capture },
  });
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.equal(out.family, 'neon');
  assert.equal(out.id, loadRegistry({ home }).registry.models.neon);
  assert.equal(out.effort, loadRoles({ home }).flavor.neon.effort);
  assert.equal(out.selectedBy, 'jev');
  const { request, args } = JSON.parse(fs.readFileSync(stub.capture));
  assert.deepEqual(args, ['--json-out', '--timeout', '4']);
  assert.equal(request.state.task, snippet);
  assert.equal(request.questions.builder.type, 'choice');
  const { criteria } = request.questions.builder;
  assert.deepEqual(Object.keys(criteria), ['sol', 'neon', BUILDER_PICK_ESCAPE]);
  assert.deepEqual(JSON.parse(criteria.sol), { likes, quirks, avoid: ['advisor'] });
  assert.equal(result.stdout.includes(snippet), false);
});

test('Jev failure, invalid, ineligible and uncertain answers fall back to first eligible', () => {
  const home = makeHome({ use: ordered, pick: { mode: 'jev' } });
  const stub = installJevStub(home);
  const task = path.join(home, 'summary');
  write(task, 'A narrow task');
  const args = ['--task-file', task, '--exclude', 'sol'];
  for (const [answer, reason] of [
    ['exit', /CLI failed/], ['invalid', /invalid JSON/], ['large', /output exceeded/],
    ['{}', /invalid choice/], [choice('neon', 0.9, 'score'), /invalid choice/],
    [choice('neon', '0.9'), /invalid choice/], [choice('neon', 1.1), /invalid choice/],
    ['{"answers":{"builder":{"type":"choice","choice":"neon","confidence":1e999}}}', /invalid choice/],
    [choice('neon', 0.69), /confidence was below/],
    [choice('sol'), /ineligible/], [choice(BUILDER_PICK_ESCAPE), /did not find/],
  ]) {
    const result = pickWithStub(home, args, stub, answer);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    const out = JSON.parse(result.stdout);
    assert.equal(out.family, 'opus');
    assert.equal(out.selectedBy, 'fallback');
    assert.match(out.reason, reason);
  }
  const relative = path.relative(home, stub.fake);
  const missing = pickWithStub(home, args, stub, choice(), { cwd: home, env: { PATH: relative } });
  assert.match(JSON.parse(missing.stdout).reason, /CLI was not found/);
  assert.match(JSON.parse(cliPick(home).stdout).reason, /needs a task summary/);
  assert.match(JSON.parse(cliPick(home, '--task-file', home).stdout).reason, /regular file/);
  assert.match(JSON.parse(cliPick(home, '--task-file', path.join(home, 'absent')).stdout).reason, /could not read/);
});

test('a timed out Jev that ignores SIGTERM falls back within the CLI bound', () => {
  const home = makeHome({ use: ordered, pick: { mode: 'jev' } });
  const stub = installJevStub(home);
  const task = path.join(home, 'summary');
  write(task, 'A narrow task');
  const result = pickWithStub(home, ['--task-file', task], stub, 'timeout');
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  const out = JSON.parse(result.stdout);
  assert.equal(out.family, 'sol');
  assert.match(out.reason, /timed out/);
});

test('ordered and random ignore task input even with a Jev executable on PATH', () => {
  const home = makeHome({ use: ordered, pick: { mode: 'ordered' } });
  const stub = installJevStub(home);
  const task = path.join(home, 'summary');
  write(task, 'New visual design for a web page');
  for (const mode of ['ordered', 'random']) {
    saveRoles(home, { use: ordered, pick: { mode } });
    const result = pickWithStub(home, ['--task-file', task], stub, choice());
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).selectedBy, mode);
    assert.equal(fs.existsSync(stub.capture), false);
  }
});

test('picker rejects unsupported role, ambiguous flags and invalid settings cleanly', () => {
  const home = makeHome();
  for (const args of [
    ['--pick', 'advisor', '--json'], ['--pick', 'builder'],
    ['--pick', 'builder', '--json', '--design', '--design'],
    ['--pick', 'builder', '--json', '--exclude'],
    ['--pick', 'builder', '--json', '--task-file', '--design'],
    ['--pick', 'builder', '--json', '--role', 'builder'],
  ]) {
    const result = cli(home, ...args);
    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^model-id: /);
    assert.equal(result.stderr.trim().split('\n').length, 1);
  }
  assert.match(JSON.parse(cliPick(home, '--exclude', 'bogus').stdout).error, /exclusion/);
  saveRoles(home, { use: ordered, pick: { mode: 'rotate' } });
  const invalid = cliPick(home);
  assert.equal(invalid.status, 2);
  assert.match(JSON.parse(invalid.stdout).error, /pick\.mode/);
  fs.unlinkSync(studio(home, 'roles.json'));
  assert.match(JSON.parse(cliPick(home).stdout).error, /role "builder" is not set/);
});
