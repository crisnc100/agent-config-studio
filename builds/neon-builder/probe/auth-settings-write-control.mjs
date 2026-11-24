import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { agyTokenLeft, agyWallProblem } from '../../../tools/ask-model.mjs';

const baseline = new URL('./auth-trusted-workspace-control.mjs', import.meta.url);
const baselineHash = 'a5836010851b6db496488065358094a98bf1dcfe3bf1e72628f5f615e6895b34';
const settingsLiteral = ' (literal (string-append (param "RUNTIME") "/home/.gemini/antigravity-cli/settings.json"))';
const modes = [
  { name: 'strict-blocked-baseline', writable: false, clone: false },
  { name: 'private-settings-write', writable: true, clone: false },
  { name: 'strict-withdrawal', writable: false, clone: false },
  { name: 'private-settings-write-restored', writable: true, clone: false },
  { name: 'private-clone-confirmation', writable: true, clone: true },
].map((arm) => ({ ...arm, strict: true, privateHome: true, proxy: true }));

function replaceOne(source, before, after) {
  if (source.split(before).length !== 2) throw new Error('diagnostic anchor changed');
  return source.replace(before, () => after);
}

async function loadPair(directory) {
  const bytes = fs.readFileSync(baseline);
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== baselineHash) throw new Error('settings baseline changed');
  const parts = bytes.toString('utf8').split('\nconst args = process.argv.slice(2);\n');
  if (parts.length !== 2) throw new Error('settings baseline entry point changed');
  let source = parts[0];
  const askModel = '../../../tools/ask-model.mjs';
  source = replaceOne(source, "from '" + askModel + "';", 'from ' + JSON.stringify(new URL(askModel, baseline).href) + ';');
  const pairRelative = './auth-wall-pair-control.mjs';
  source = replaceOne(source, "new URL('" + pairRelative + "', import.meta.url)",
    'new URL(' + JSON.stringify(new URL(pairRelative, baseline).href) + ')');
  const file = path.join(directory, 'settings-write-source.mjs');
  fs.writeFileSync(file, source + '\nexport { loadPair };\n', { mode: 0o600, flag: 'wx' });
  return (await import(pathToFileURL(file).href)).loadPair(directory);
}

function withPrivateWrite(helpers) {
  const original = helpers.builder.agyBuildWall;
  return {
    ...helpers,
    builder: {
      ...helpers.builder,
      agyBuildWall(params, command) {
        const args = original(params, command);
        const profile = args.indexOf('-p') + 1;
        const line = args[profile]?.split('\n').find((value) => value.includes(settingsLiteral));
        if (!line?.startsWith('(deny file-write* ') || !line.includes('(param "RUNTIME")')) {
          throw new Error('settings write protection changed');
        }
        args[profile] = replaceOne(args[profile], settingsLiteral, '');
        return args;
      },
    },
  };
}

function projectSettings(bytes) {
  const invalid = { validObject: false, keyCount: null, typeCounts: null, semanticEmpty: false };
  let settings;
  try { settings = JSON.parse(bytes); } catch { return invalid; }
  if (settings === null || Array.isArray(settings) || typeof settings !== 'object') return invalid;
  const types = Object.values(settings).map((value) =>
    value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value);
  const typeCounts = {};
  for (const kind of types) typeCounts[kind] = (typeCounts[kind] ?? 0) + 1;
  return { validObject: true, keyCount: types.length, typeCounts, semanticEmpty: types.length === 0 };
}

function inspectSettings(arm) {
  const file = path.join(arm.layout.privateHome, '.gemini', 'antigravity-cli', 'settings.json');
  const stat = fs.lstatSync(file, { bigint: true, throwIfNoEntry: false });
  if (!stat?.isFile() || stat.nlink !== 1n || stat.size > 64n * 1024n || fs.realpathSync.native(file) !== file) {
    throw new Error('unsafe settings observation');
  }
  return { identity: [stat.dev, stat.ino].join(':'), projection: projectSettings(fs.readFileSync(file, 'utf8')) };
}

function concludeArm(arm, result, settings) {
  if (result.interrupted || result.timedOut || result.turns > 0 || !result.cleanPostflight ||
      !result.plaintextAbsent || !result.aliasMatchesAfter || !settings.semanticEmpty) return 'inconclusive-safety-or-settings';
  if (result.operatorKeychainChanged || result.operatorSettingsChanged || result.operatorSeedChanged ||
      result.oauthObserved || result.tokenRefreshMarker) return 'operator-state-changed';
  if (!arm.writable) {
    if (result.settingsReplaced || result.seedsChangedAfter?.['settings.json']) return 'blocked-settings-changed';
    if (result.passed) return 'blocked-control-unexpectedly-passed';
    return result.code === 1 && result.signInNeeded ? null : 'blocked-control-inconclusive';
  }
  return result.passed && !result.nativeSettingsWriteDenied ? null :
    arm.clone ? 'clone-confirmation-failed' : 'settings-write-did-not-rescue';
}

async function observe(pair, helpers, directory) {
  const home = fs.realpathSync.native(os.homedir());
  const root = path.join(directory, 'empty-root');
  fs.mkdirSync(root, { mode: 0o700 });
  if (fs.realpathSync.native(root) !== root || agyWallProblem() || helpers.checks.agyConfigProblem(home) ||
      helpers.checks.agyWorkspaceFiles(root).length || agyTokenLeft(home)) throw new Error('settings write control preflight refused');
  const found = helpers.checks.which('agy');
  if (!found) throw new Error('agy executable unavailable');
  const original = fs.realpathSync.native(found);
  const originalStamp = await pair.verifyBinary(original, helpers.checks.pin);
  const prepared = pair.preparePairedInputs(helpers, directory, home, modes);
  const mutable = withPrivateWrite(helpers);
  const initialOperator = pair.operatorState(home);
  const observed = [];
  let stopped = null;
  let originalProof = false;
  let cloneConfirmed = false;
  for (const arm of prepared) {
    try {
      const now = pair.operatorState(home);
      if (Object.keys(initialOperator).some((key) => initialOperator[key] !== now[key])) {
        stopped = 'operator-state-changed';
        break;
      }
      const before = inspectSettings(arm);
      if (!before.projection.semanticEmpty) throw new Error('settings must start as an empty object');
      let exe = original;
      let stamp = originalStamp;
      if (arm.clone) {
        if (!originalProof) throw new Error('clone cannot run before original proof');
        exe = path.join(arm.layout.assembly, 'agy');
        fs.copyFileSync(original, exe, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE);
        fs.chmodSync(exe, 0o500);
        stamp = await pair.verifyBinary(exe, helpers.checks.pin);
      }
      const result = await pair.runArm(arm.writable ? mutable : helpers, directory, root, home, exe, stamp, arm);
      const after = inspectSettings(arm);
      const evidence = { ...result, settingsReplaced: before.identity !== after.identity, settings: after.projection };
      observed.push(evidence);
      stopped = concludeArm(arm, evidence, after.projection);
      if (stopped) break;
      if (arm.name === 'private-settings-write-restored') originalProof = true;
      if (arm.clone) cloneConfirmed = true;
    } catch {
      stopped = 'local-safety-or-input-check-failed';
      break;
    }
  }
  console.log(JSON.stringify({ mode: 'private-settings-write-control', matchedInitialPrivateInputs: true,
    modelsCliResults: observed.length, stopped, originalDependencyReproduced: originalProof,
    privateCloneConfirmed: cloneConfirmed, arms: observed }, null, 2));
}

async function selfTest(pair, helpers, directory) {
  const input = { source: '/fixture/source', runtime: '/fixture/runtime', certificate: '/fixture/ca',
    bin: '/fixture/agy', home: '/fixture/home', port: 42402 };
  const command = ['/fixture/agy', '--output-format', 'json', 'models'];
  const baselineArgs = helpers.builder.agyBuildWall(input, command);
  const index = baselineArgs.indexOf('-p') + 1;
  assert.ok(baselineArgs[index].includes(settingsLiteral));
  baselineArgs[index] = baselineArgs[index].replace(settingsLiteral, '');
  assert.deepEqual(withPrivateWrite(helpers).builder.agyBuildWall(input, command), baselineArgs);
  assert.deepEqual(projectSettings('{}\n'), { validObject: true, keyCount: 0, typeCounts: {}, semanticEmpty: true });
  assert.deepEqual(projectSettings('{"withheldKey":"withheldValue","withheldList":[]}'),
    { validObject: true, keyCount: 2, typeCounts: { string: 1, array: 1 }, semanticEmpty: false });
  const base = { cleanPostflight: true, plaintextAbsent: true, aliasMatchesAfter: true };
  const good = { ...base, code: 0, passed: true, turns: 0 };
  const bad = { ...base, code: 1, passed: false, signInNeeded: true, turns: null };
  const empty = { semanticEmpty: true };
  assert.deepEqual(modes.map(({ writable, clone }) => [writable, clone]),
    [[false, false], [true, false], [false, false], [true, false], [true, true]]);
  assert.equal(concludeArm(modes[0], bad, empty), null);
  assert.equal(concludeArm(modes[0], good, empty), 'blocked-control-unexpectedly-passed');
  assert.equal(concludeArm(modes[1], bad, empty), 'settings-write-did-not-rescue');
  assert.equal(concludeArm(modes[1], good, empty), null);
  assert.equal(concludeArm(modes[1], good, { semanticEmpty: false }), 'inconclusive-safety-or-settings');
  assert.equal(concludeArm(modes[4], bad, empty), 'clone-confirmation-failed');
  await pair.selfTest(helpers, directory);
  console.log('fake-only exact profile delta, settings redaction and reversible outcome gates passed');
}

const args = process.argv.slice(2);
if (!args.length) {
  console.log(JSON.stringify({ mode: 'disabled', childLaunches: 0 }));
} else if (args.length === 1 && ['--self-test', '--observe-settings-write'].includes(args[0])) {
  const directory = fs.mkdtempSync('/private/tmp/acs-agy-settings-write-control-');
  try {
    const pair = await loadPair(directory);
    const helpers = await pair.loadHelpers(directory);
    if (args[0] === '--self-test') await selfTest(pair, helpers, directory);
    else await observe(pair, helpers, directory);
  } catch {
    process.stderr.write('Private settings write control failed a local safety check.\n');
    process.exitCode = 1;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
} else {
  process.stderr.write('usage: auth-settings-write-control.mjs --self-test | --observe-settings-write\n');
  process.exitCode = 64;
}
