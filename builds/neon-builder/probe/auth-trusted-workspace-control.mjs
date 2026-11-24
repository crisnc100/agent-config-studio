import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { agyTokenLeft, agyWallProblem } from '../../../tools/ask-model.mjs';

const pairFile = new URL('./auth-wall-pair-control.mjs', import.meta.url);
const pairDigest = 'b70e648368bc68b609c3aac0f69909e1ce01323ab7158f2b53780eee029c95d6';
const modes = [
  { name: 'read-only-capture', strict: false, trustedSeed: false, expected: 'pass' },
  { name: 'strict-empty-control', strict: true, trustedSeed: false, expected: 'fail' },
  { name: 'strict-trusted-preseed', strict: true, trustedSeed: true, expected: 'pass' },
  { name: 'strict-withdrawal', strict: true, trustedSeed: false, expected: 'fail' },
  { name: 'strict-restore', strict: true, trustedSeed: true, expected: 'pass' },
].map((arm) => ({ ...arm, privateHome: true, proxy: true }));

function replaceOne(source, before, after) {
  if (source.split(before).length !== 2) throw new Error('diagnostic source anchor changed');
  return source.replace(before, () => after);
}

function stripEntry(source) {
  const parts = source.split('\nconst args = process.argv.slice(2);\n');
  if (parts.length !== 2) throw new Error('baseline diagnostic entry point changed');
  return parts[0];
}

async function writeModule(directory, name, source) {
  const file = path.join(directory, name);
  fs.writeFileSync(file, source, { flag: 'wx', mode: 0o600 });
  return import(pathToFileURL(file).href);
}

async function loadPair(directory) {
  const raw = fs.readFileSync(pairFile);
  if (crypto.createHash('sha256').update(raw).digest('hex') !== pairDigest) throw new Error('wall pair baseline changed');
  const ladderRelative = './auth-factor-ladder.mjs';
  const limited = replaceOne(stripEntry(raw.toString('utf8')), "new URL('" + ladderRelative + "', import.meta.url)",
    'new URL(' + JSON.stringify(new URL(ladderRelative, pairFile).href) + ')');
  const pair = await writeModule(directory, 'settings-pair-source.mjs', limited + '\nexport { modifiedLadder };\n');
  let source = stripEntry(pair.modifiedLadder());
  source = replaceOne(source, 'function preparePairedInputs({ builder, bootstrap }, directory, home) {',
    'function preparePairedInputs({ builder, bootstrap }, directory, home, requestedArms) {');
  source = replaceOne(source, '  const prepared = arms.map((arm) => {',
    '  const prepared = requestedArms.map((arm) => {');
  source = replaceOne(source, '  if (!samePrivateInputs(prepared[0].privateBefore, prepared[1].privateBefore)) {',
    '  if (prepared.slice(1).some(({ privateBefore }) => !samePrivateInputs(prepared[0].privateBefore, privateBefore))) {');
  return writeModule(directory, 'settings-pair.mjs', source +
    '\nexport { loadHelpers, preparePairedInputs, runArm, verifyBinary, operatorState, selfTest };\n');
}

function readSettings(arm) {
  const file = path.join(arm.layout.privateHome, '.gemini', 'antigravity-cli', 'settings.json');
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.nlink !== 1 || stat.size > 64 * 1024 || fs.realpathSync.native(file) !== file) {
    throw new Error('unsafe private settings file');
  }
  return { file, text: fs.readFileSync(file, 'utf8') };
}

function projectSettings(text, root) {
  const invalid = { validObject: false, trustedWorkspacesPresent: false, trustedWorkspacesType: null,
    trustedWorkspacesCount: null, includesRoot: false, unknownKeyCount: null, safeKind: null };
  let settings;
  try { settings = JSON.parse(text); } catch { return invalid; }
  if (settings === null || Array.isArray(settings) || typeof settings !== 'object') return invalid;
  const trustedWorkspacesPresent = Object.hasOwn(settings, 'trustedWorkspaces');
  const workspaces = settings.trustedWorkspaces;
  const isList = Array.isArray(workspaces);
  const includesRoot = isList && workspaces.includes(root);
  const unknownKeyCount = Object.keys(settings).filter((key) => key !== 'trustedWorkspaces').length;
  const trustedWorkspacesType = !trustedWorkspacesPresent ? null : isList ? 'list' :
    workspaces === null ? 'null' : typeof workspaces;
  let safeKind = null;
  if (trustedWorkspacesPresent && isList && unknownKeyCount === 0) {
    if (workspaces.length === 0) safeKind = 'empty-list';
    else if (workspaces.length === 1 && includesRoot) safeKind = 'owned-root';
  }
  return { validObject: true, trustedWorkspacesPresent, trustedWorkspacesType,
    trustedWorkspacesCount: isList ? workspaces.length : null, includesRoot, unknownKeyCount, safeKind };
}

function preseedWorkspaceSetting(bootstrap, arm, root, home, safeKind) {
  const { file, text } = readSettings(arm);
  if (text.trim() !== '{}' || fs.realpathSync.native(root) !== root || !['empty-list', 'owned-root'].includes(safeKind)) {
    throw new Error('trusted workspace preseed refused');
  }
  const trustedWorkspaces = safeKind === 'empty-list' ? [] : [root];
  fs.writeFileSync(file, JSON.stringify({ trustedWorkspaces }), { flag: 'w' });
  const seeded = bootstrap.privateInputs(arm.layout, home);
  if (!seeded.aliasMatches || seeded.login !== arm.privateBefore.login ||
      !seeded.seeds.slice(0, 4).every((seed, index) => seed === arm.privateBefore.seeds[index])) {
    throw new Error('other private inputs changed during preseed');
  }
  return { ...arm, privateBefore: seeded };
}

function classifyArm(arm, result) {
  if (result.interrupted || result.timedOut || !result.cleanPostflight || !result.plaintextAbsent ||
      !result.aliasMatchesAfter || result.turns > 0 || arm.strict && result.seedsChangedAfter?.['settings.json']) return 'safety-or-result-inconclusive';
  if (result.oauthObserved || result.tokenRefreshMarker ||
      result.operatorKeychainChanged || result.operatorSettingsChanged || result.operatorSeedChanged) {
    return 'operator-state-changed';
  }
  if (arm.expected === 'pass') return result.passed ? null : 'metadata-not-rescued';
  if (result.passed) return 'empty-settings-control-passed';
  return result.code === 1 && result.signInNeeded ? null : 'negative-control-inconclusive';
}

async function observe(pair, helpers, directory) {
  const home = fs.realpathSync.native(os.homedir());
  const root = path.join(directory, 'empty-root');
  fs.mkdirSync(root, { mode: 0o700 });
  if (fs.realpathSync.native(root) !== root || agyWallProblem() || helpers.checks.agyConfigProblem(home) ||
      helpers.checks.agyWorkspaceFiles(root).length || agyTokenLeft(home)) throw new Error('control preflight refused');
  const original = helpers.checks.which('agy');
  if (!original) throw new Error('agy executable unavailable');
  const bin = fs.realpathSync.native(original);
  const stamp = await pair.verifyBinary(bin, helpers.checks.pin);
  const prepared = pair.preparePairedInputs(helpers, directory, home, modes);
  const initialOperator = pair.operatorState(home);
  const observed = [];
  let captured = null;
  let stopped = null;
  for (const initial of prepared) {
    try {
      const now = pair.operatorState(home);
      if (Object.keys(initialOperator).some((key) => initialOperator[key] !== now[key])) {
        stopped = 'operator-state-changed';
        break;
      }
      const arm = initial.trustedSeed ? preseedWorkspaceSetting(helpers.bootstrap, initial, root, home, captured?.safeKind) : initial;
      const result = await pair.runArm(helpers, directory, root, home, bin, stamp, arm);
      observed.push(result);
      stopped = classifyArm(arm, result);
      if (stopped) break;
      if (!arm.strict) {
        captured = projectSettings(readSettings(arm).text, root);
        if (!captured.safeKind) {
          stopped = 'settings-schema-not-exact';
          break;
        }
      }
    } catch {
      stopped = 'local-safety-or-input-check-failed';
      break;
    }
  }
  const reproduced = !stopped && observed.length === modes.length;
  console.log(JSON.stringify({ mode: 'trusted-workspace-bootstrap-control', matchedInitialPrivateInputs: true,
    originalPinVerified: true, captured, modelsCliResults: observed.length, stopped,
    reproducibleMetadataDependency: reproduced, arms: observed }, null, 2));
}

async function selfTest(pair, helpers, directory) {
  const root = '/private/tmp/owned-fixture';
  assert.deepEqual(projectSettings(JSON.stringify({ trustedWorkspaces: [root] }), root), {
    validObject: true, trustedWorkspacesPresent: true, trustedWorkspacesType: 'list', trustedWorkspacesCount: 1,
    includesRoot: true, unknownKeyCount: 0, safeKind: 'owned-root',
  });
  assert.deepEqual(projectSettings('{"trustedWorkspaces":[]}', root), {
    validObject: true, trustedWorkspacesPresent: true, trustedWorkspacesType: 'list', trustedWorkspacesCount: 0,
    includesRoot: false, unknownKeyCount: 0, safeKind: 'empty-list',
  });
  for (const invalid of ['unparseable', '{}', '[]', JSON.stringify({ trustedWorkspaces: [root], fixtureSecret: 'never emit' }),
    JSON.stringify({ trustedWorkspaces: [root, '/outside'] }), JSON.stringify({ trustedWorkspaces: ['/outside'] }),
    JSON.stringify({ trustedWorkspaces: root })]) {
    const evidence = projectSettings(invalid, root);
    assert.equal(evidence.safeKind, null);
    assert.doesNotMatch(JSON.stringify(evidence), /owned-fixture|outside|fixtureSecret|never emit/);
  }
  const base = { cleanPostflight: true, plaintextAbsent: true, aliasMatchesAfter: true };
  const good = { ...base, code: 0, passed: true, turns: 0 };
  const bad = { ...base, code: 1, passed: false, signInNeeded: true, turns: null };
  assert.deepEqual(modes.map(({ expected }) => expected), ['pass', 'fail', 'pass', 'fail', 'pass']);
  assert.equal(classifyArm(modes[1], bad), null);
  assert.equal(classifyArm(modes[1], good), 'empty-settings-control-passed');
  assert.equal(classifyArm(modes[2], bad), 'metadata-not-rescued');
  assert.equal(classifyArm(modes[2], { ...good, oauthObserved: true }), 'operator-state-changed');
  assert.equal(classifyArm(modes[2], good), null);
  assert.equal(classifyArm(modes[2], { ...good, seedsChangedAfter: { 'settings.json': true } }),
    'safety-or-result-inconclusive');
  const ownedRoot = path.join(directory, 'owned-root');
  const privateHome = path.join(directory, 'private-home');
  const settingsDir = path.join(privateHome, '.gemini', 'antigravity-cli');
  fs.mkdirSync(ownedRoot);
  fs.mkdirSync(settingsDir, { recursive: true });
  const settingsFile = path.join(settingsDir, 'settings.json');
  fs.writeFileSync(settingsFile, '{}', { mode: 0o600 });
  const initial = { aliasMatches: true, login: '/fixture/login-db', seeds: ['a', 'b', 'c', 'd', 'before'] };
  const updated = { ...initial, seeds: ['a', 'b', 'c', 'd', 'after'] };
  for (const [kind, expectedList] of [['empty-list', []], ['owned-root', [ownedRoot]]]) {
    fs.writeFileSync(settingsFile, '{}', { mode: 0o600 });
    const seeded = preseedWorkspaceSetting({ privateInputs: () => updated },
      { layout: { privateHome }, privateBefore: initial }, ownedRoot, '/fixture/home', kind);
    assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, 'utf8')), { trustedWorkspaces: expectedList });
    assert.deepEqual(seeded.privateBefore, updated);
  }
  await pair.selfTest(helpers, directory);
  console.log('fake-only trusted workspace schema, result retention and reversible outcome gates passed');
}

const args = process.argv.slice(2);
if (!args.length) {
  console.log(JSON.stringify({ mode: 'disabled', childLaunches: 0 }));
} else if (args.length === 1 && ['--self-test', '--observe-trusted-workspaces'].includes(args[0])) {
  const directory = fs.mkdtempSync('/private/tmp/acs-agy-trusted-workspace-control-');
  try {
    const pair = await loadPair(directory);
    const helpers = await pair.loadHelpers(directory);
    if (args[0] === '--self-test') await selfTest(pair, helpers, directory);
    else await observe(pair, helpers, directory);
  } catch {
    process.stderr.write('Trusted workspace control failed a local safety check.\n');
    process.exitCode = 1;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
} else {
  process.stderr.write('usage: auth-trusted-workspace-control.mjs --self-test | --observe-trusted-workspaces\n');
  process.exitCode = 64;
}
