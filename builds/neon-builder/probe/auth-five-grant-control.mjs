import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { agyTokenLeft, agyWallProblem } from '../../../tools/ask-model.mjs';

const traceFile = new URL('./auth-decision-trace.mjs', import.meta.url);
const traceDigest = '0b0c18553525b87ea16db8fdeb807e157facb8976a614a43cc0daa243df9e38a';
const grants = [
  '(allow file-read-metadata (literal (string-append (param "HOME") "/Library/Keychains")))',
  '(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo"))',
  '(allow mach-lookup (global-name "com.apple.system.opendirectoryd.membership"))',
  '(allow mach-lookup (global-name "com.apple.bsd.dirhelper"))',
  '(allow file-read-data (literal "/Library/Preferences/.GlobalPreferences.plist"))',
];
const modes = [
  { name: 'strict-baseline', grantGroup: false },
  { name: 'five-grant-group', grantGroup: true },
  { name: 'strict-withdrawal', grantGroup: false },
  { name: 'five-grant-restore', grantGroup: true },
].map((arm) => ({ ...arm, strict: true, privateHome: true, proxy: true }));

function replaceOne(source, before, after) {
  if (source.split(before).length !== 2) throw new Error('diagnostic anchor changed');
  return source.replace(before, () => after);
}

async function traceHelpers(directory) {
  const bytes = fs.readFileSync(traceFile);
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== traceDigest) throw new Error('trace baseline changed');
  const parts = bytes.toString('utf8').split('\nconst args = process.argv.slice(2);\n');
  if (parts.length !== 2) throw new Error('trace baseline entry point changed');
  const ask = '../../../tools/ask-model.mjs';
  const baseline = './auth-trusted-workspace-control.mjs';
  let source = replaceOne(parts[0], "from '" + ask + "';", 'from ' + JSON.stringify(new URL(ask, traceFile).href) + ';');
  source = replaceOne(source, "new URL('" + baseline + "', import.meta.url)",
    'new URL(' + JSON.stringify(new URL(baseline, traceFile).href) + ')');
  const file = path.join(directory, 'five-grant-trace.mjs');
  fs.writeFileSync(file, source + '\nexport { loadPair, captureSinks, selfTest };\n', { mode: 0o600, flag: 'wx' });
  return import(pathToFileURL(file).href);
}

function profileWithGroup(original, params, command) {
  const args = original(params, command);
  const profile = args.indexOf('-p') + 1;
  const policy = args[profile];
  if (profile < 1 || typeof policy !== 'string' || !policy.includes('(deny default)') ||
      !policy.includes('"/home/.gemini/antigravity-cli/settings.json"') || grants.some((line) => policy.includes(line))) {
    throw new Error('production profile or diagnostic grant group changed');
  }
  args[profile] = [policy, ...grants].join('\n');
  return args;
}

function classify(arm, result) {
  if (result.interrupted || result.timedOut || result.turns > 0 || !result.cleanPostflight ||
      !result.plaintextAbsent || !result.aliasMatchesAfter || result.seedsChangedAfter?.['settings.json']) {
    return 'safety-or-auth-result-inconclusive';
  }
  if (result.operatorKeychainChanged || result.operatorSettingsChanged || result.operatorSeedChanged ||
      result.oauthObserved || result.tokenRefreshMarker) return 'operator-state-changed';
  if (!arm.grantGroup) {
    if (result.passed) return 'strict-control-unexpectedly-passed';
    return result.code === 1 && result.signInNeeded ? null : 'strict-control-inconclusive';
  }
  if (result.passed) return null;
  if (result.code === 1 && result.signInNeeded) {
    return arm.name === 'five-grant-group' ? 'five-grant-group-insufficient' : 'restore-did-not-reproduce';
  }
  return 'group-result-inconclusive';
}

async function observe(trace, pair, helpers, directory) {
  const home = fs.realpathSync.native(os.homedir());
  const root = path.join(directory, 'empty-root');
  fs.mkdirSync(root, { mode: 0o700 });
  const { checks, builder, normal } = helpers;
  if (agyWallProblem() || fs.realpathSync.native(root) !== root ||
      checks.agyWorkspaceFiles(root).length || checks.agyConfigProblem(home) || agyTokenLeft(home)) {
    throw new Error('five grant control preflight refused');
  }
  const found = checks.which('agy');
  if (!found) throw new Error('pinned executable unavailable');
  const exe = fs.realpathSync.native(found);
  const stamp = await pair.verifyBinary(exe, checks.pin);
  const prepared = pair.preparePairedInputs(helpers, directory, home, modes);
  const originalState = pair.operatorState(home);
  const observed = [];
  let stopped = null;
  for (const arm of prepared) {
    try {
      const current = pair.operatorState(home);
      if (Object.keys(originalState).some((key) => originalState[key] !== current[key])) {
        stopped = 'operator-state-changed';
        break;
      }
      let sinks;
      const instrumented = {
        ...helpers,
        builder: arm.grantGroup ? {
          ...builder,
          agyBuildWall: (params, command) => profileWithGroup(builder.agyBuildWall, params, command),
        } : builder,
        normal: {
          ...normal,
          async launch(args, cwd, env) {
            const result = await normal.launch(args, cwd, env);
            sinks = trace.captureSinks(args, result);
            return result;
          },
        },
      };
      const result = await pair.runArm(instrumented, directory, root, home, exe, stamp, arm);
      observed.push({ ...result, grantGroup: arm.grantGroup, sinks });
      stopped = classify(arm, result);
      if (stopped) break;
    } catch {
      stopped = 'local-safety-or-input-check-failed';
      break;
    }
  }
  console.log(JSON.stringify({ mode: 'auth-five-grant-control', freshPrivateInputsMatched: true,
    originalPinVerified: true, modelsCliResults: observed.length, stopped,
    groupDependencyReproduced: !stopped && observed.length === modes.length, arms: observed }, null, 2));
}

async function selfTest(trace, pair, helpers, directory) {
  const params = { source: '/fixture/source', runtime: '/fixture/runtime', bin: '/fixture/agy',
    certificate: '/fixture/ca', home: '/fixture/home', port: 42402 };
  const command = ['/fixture/agy', '--output-format', 'json', 'models'];
  const actual = helpers.builder.agyBuildWall(params, command);
  const index = actual.indexOf('-p') + 1;
  const expected = actual.slice();
  expected[index] = [actual[index],
    '(allow file-read-metadata (literal (string-append (param "HOME") "/Library/Keychains")))',
    '(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo"))',
    '(allow mach-lookup (global-name "com.apple.system.opendirectoryd.membership"))',
    '(allow mach-lookup (global-name "com.apple.bsd.dirhelper"))',
    '(allow file-read-data (literal "/Library/Preferences/.GlobalPreferences.plist"))',
  ].join('\n');
  assert.deepEqual(profileWithGroup(helpers.builder.agyBuildWall, params, command), expected);
  assert.doesNotMatch(expected[index].slice(actual[index].length), /network|process-exec|systemkeychaincheck|file-write|subpath/);
  const base = { cleanPostflight: true, plaintextAbsent: true, aliasMatchesAfter: true };
  const good = { ...base, code: 0, passed: true, turns: 0 };
  const bad = { ...base, code: 1, passed: false, signInNeeded: true, turns: null };
  assert.deepEqual(modes.map(({ grantGroup }) => grantGroup), [false, true, false, true]);
  assert.equal(classify(modes[0], bad), null);
  assert.equal(classify(modes[0], good), 'strict-control-unexpectedly-passed');
  assert.equal(classify(modes[1], bad), 'five-grant-group-insufficient');
  assert.equal(classify(modes[1], good), null);
  assert.equal(classify(modes[2], bad), null);
  assert.equal(classify(modes[3], good), null);
  assert.equal(classify(modes[3], bad), 'restore-did-not-reproduce');
  assert.equal(classify(modes[1], { ...good, oauthObserved: true }), 'operator-state-changed');
  assert.equal(classify(modes[1], { ...good, timedOut: true }), 'safety-or-auth-result-inconclusive');
  await trace.selfTest(pair, helpers, directory);
  console.log('fake-only exact five-grant difference and reversible auth proof gates passed');
}

const args = process.argv.slice(2);
if (!args.length) {
  console.log(JSON.stringify({ mode: 'disabled', childLaunches: 0 }));
} else if (args.length === 1 && ['--self-test', '--observe-five-grant-group'].includes(args[0])) {
  const directory = fs.mkdtempSync('/private/tmp/acs-agy-auth-grant-control-');
  try {
    const trace = await traceHelpers(directory);
    const pair = await trace.loadPair(directory);
    const helpers = await pair.loadHelpers(directory);
    if (args[0] === '--self-test') await selfTest(trace, pair, helpers, directory);
    else await observe(trace, pair, helpers, directory);
  } catch {
    process.stderr.write('Five grant auth control failed a local safety check.\n');
    process.exitCode = 1;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
} else {
  process.stderr.write('usage: auth-five-grant-control.mjs --self-test | --observe-five-grant-group\n');
  process.exitCode = 64;
}
