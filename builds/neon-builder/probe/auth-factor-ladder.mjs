import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { agyAfterCall, agyTokenLeft, agyWallParams, agyWallProblem } from '../../../tools/ask-model.mjs';

const bootstrapFile = new URL('./auth-bootstrap-controls.mjs', import.meta.url);
const normalFile = new URL('./auth-normal-home-control.mjs', import.meta.url);
const baselineDigests = {
  [bootstrapFile.href]: 'be6624573630fad70dbdbb17cbef3d75465ba40508a96ad520fa0e32c415946e',
  [normalFile.href]: '295d0afd4b964328412b60e86b4d106a8eeb0907ef0296042b5bff53800267b2',
};
const askModelRelative = '../../../tools/ask-model.mjs';
const builderRelative = '../../../tools/agy-builder.mjs';
const proxyVariables = ['HTTP_PROXY', 'HTTPS_PROXY', 'SSL_CERT_FILE'];
const arms = [
  { name: 'normal-home-safe-env', proxy: false, privateHome: false },
  { name: 'normal-home-safe-broker', proxy: true, privateHome: false },
  { name: 'private-home-safe-broker', proxy: true, privateHome: true },
];

function replaceOne(source, before, after) {
  if (source.split(before).length !== 2) throw new Error('diagnostic source anchor changed');
  return source.replace(before, () => after);
}

function lockedModule(url, exports) {
  const bytes = fs.readFileSync(url);
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== baselineDigests[url.href]) {
    throw new Error('baseline diagnostic changed');
  }
  const pieces = bytes.toString('utf8').split('\nconst args = process.argv.slice(2);\n');
  if (pieces.length !== 2) throw new Error('baseline diagnostic entry point changed');
  const source = replaceOne(pieces[0], "} from '" + askModelRelative + "';",
    '} from ' + JSON.stringify(new URL(askModelRelative, url).href) + ';');
  return source + '\nexport { ' + exports.join(', ') + ' };\n';
}

function absoluteUrl(source, relative, base) {
  return replaceOne(source, "new URL('" + relative + "', import.meta.url)",
    'new URL(' + JSON.stringify(new URL(relative, base).href) + ')');
}

async function temporaryModule(directory, name, source) {
  const file = path.join(directory, name);
  fs.writeFileSync(file, source, { flag: 'wx', mode: 0o600 });
  return import(pathToFileURL(file).href);
}

async function loadHelpers(directory) {
  let normalSource = lockedModule(normalFile, ['loadDiagnosticHelpers', 'walled', 'modelsCommand', 'launch', 'selfTest']);
  for (const relative of ['./auth-bootstrap-controls.mjs', askModelRelative, builderRelative]) {
    normalSource = absoluteUrl(normalSource, relative, normalFile);
  }
  const normal = await temporaryModule(directory, 'ladder-normal.mjs', normalSource);
  const checks = await normal.loadDiagnosticHelpers(directory);
  let bootstrapSource = lockedModule(bootstrapFile, ['loadHelper', 'allowedUpstream', 'audit', 'privateInputs', 'selfTest']);
  bootstrapSource = absoluteUrl(bootstrapSource, builderRelative, bootstrapFile);
  const seam = "  const file = path.join(directory, 'auth-bootstrap-helper.mjs');";
  bootstrapSource = replaceOne(bootstrapSource, seam,
    "  replacements.push(['function seedAgyState(', 'export function seedAgyState(']);\n" + seam);
  const bootstrap = await temporaryModule(directory, 'ladder-bootstrap.mjs', bootstrapSource);
  const builder = await bootstrap.loadHelper(directory);
  return { normal, checks, bootstrap, builder };
}

function safeEnv(builder, home, runtime, broker) {
  const env = builder.agyBuildEnv({ home, runtime, broker: broker ?? { url: '', certificate: '' } });
  if (!broker) for (const name of proxyVariables) delete env[name];
  return env;
}

async function verifyBinary(file, pin) {
  const hash = crypto.createHash('sha256');
  const before = fileStamp(file);
  for await (const bytes of fs.createReadStream(file)) hash.update(bytes);
  if (hash.digest('hex') !== pin || fs.realpathSync.native(file) !== file || fileStamp(file) !== before) {
    throw new Error('original executable does not match the pin');
  }
  return before;
}

function fileStamp(file) {
  const stat = fs.lstatSync(file, { bigint: true, throwIfNoEntry: false });
  return stat ? [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':') : null;
}

function operatorState(home) {
  const state = path.join(home, '.gemini', 'antigravity-cli');
  return {
    loginKeychain: fileStamp(path.join(home, 'Library', 'Keychains', 'login.keychain-db')),
    settings: fileStamp(path.join(state, 'settings.json')),
    seed: ['installation_id', 'jetski_state.pbtxt', 'cache/default_project_id.txt', 'cache/onboarding.json']
      .map((file) => fileStamp(path.join(state, file))).join('|'),
  };
}

function positiveMetadata(result, reply, auth, cleanPostflight) {
  return result.code === 0 && !result.interrupted && !result.timedOut && reply?.status === 'SUCCESS' &&
    reply.num_turns === 0 && Array.isArray(reply.command?.data?.models) && reply.command.data.models.length > 0 &&
    auth.keychainLoaded && auth.keychainAuthenticated && cleanPostflight;
}

async function runArm(helpers, directory, root, actualHome, bin, binaryStamp, arm) {
  const { builder, normal, bootstrap, checks } = helpers;
  const input = path.join(directory, arm.name);
  fs.mkdirSync(input, { mode: 0o700 });
  const layout = builder.agyBuildLayout(input);
  if (agyWallProblem() || checks.agyWorkspaceFiles(root).length || checks.agyConfigProblem(actualHome) ||
      agyTokenLeft(actualHome) || agyTokenLeft(layout.privateHome) ||
      fs.realpathSync.native(bin) !== bin || fileStamp(bin) !== binaryStamp) {
    throw new Error('ladder preflight refused');
  }
  if (arm.privateHome) {
    builder.seedAgyState(actualHome, layout.privateHome);
    fs.mkdirSync(path.join(layout.privateHome, 'Library'), { mode: 0o700 });
    fs.symlinkSync(path.join(actualHome, 'Library', 'Keychains'), path.join(layout.privateHome, 'Library', 'Keychains'));
  }
  const privateBefore = arm.privateHome ? bootstrap.privateInputs(layout, actualHome) : null;
  if (privateBefore && !privateBefore.aliasMatches) throw new Error('private login keychain alias changed');

  let broker;
  try {
    if (arm.proxy) {
      broker = await builder.agyGoogleBroker(layout.ca, {
        requestUpstream(options, callback) {
          if (!bootstrap.allowedUpstream(options)) throw new Error('unexpected ladder upstream refused');
          return https.request(options, callback);
        },
      });
    }
    const logFile = path.join(layout.runtime, 'agy.log');
    const { params } = agyWallParams({ root, callTmp: input, logFile, bin, home: actualHome });
    if (!params || agyTokenLeft(actualHome) || agyTokenLeft(layout.privateHome)) throw new Error('ladder launch refused');
    const before = operatorState(actualHome);
    const env = safeEnv(builder, arm.privateHome ? layout.privateHome : actualHome, layout.runtime, broker);
    const result = await normal.launch(normal.walled(params, normal.modelsCommand(bin, root, logFile)), root, env);
    const after = operatorState(actualHome);
    const stat = fs.lstatSync(logFile, { throwIfNoEntry: false });
    const safeLog = stat?.isFile() && stat.nlink === 1 && fs.realpathSync.native(logFile) === logFile;
    const log = safeLog ? fs.readFileSync(logFile, 'utf8') : '';
    const auth = checks.authFlags(log, result.stdout + result.stderr);
    const privateAfter = arm.privateHome ? bootstrap.privateInputs(layout, actualHome) : null;
    const aliasMatchesAfter = !privateAfter || privateAfter.aliasMatches && privateAfter.login === privateBefore.login;
    const seedsMatchAfter = !privateAfter || privateBefore.seeds.every((seed, index) => seed === privateAfter.seeds[index]);
    const plaintextAbsent = !agyTokenLeft(actualHome) && !agyTokenLeft(layout.privateHome);
    const cleanPostflight = Boolean(safeLog) && plaintextAbsent &&
      !agyAfterCall(logFile, arm.privateHome ? layout.privateHome : actualHome);
    let reply;
    try { reply = JSON.parse(result.stdout); } catch {}
    const turns = Number.isInteger(reply?.num_turns) && reply.num_turns >= 0 ? reply.num_turns : null;
    const modelList = reply?.command?.data?.models;
    const brokerEvents = broker ? bootstrap.audit(broker.events) : [];
    return {
      name: arm.name, code: result.code, signal: result.signal, timedOut: result.timedOut, interrupted: result.interrupted,
      turns, reportedZeroTurns: turns === 0, modelCount: Array.isArray(modelList) ? modelList.length : null,
      passed: Boolean(aliasMatchesAfter && positiveMetadata(result, reply, auth, cleanPostflight)),
      plaintextAbsent, cleanPostflight, aliasMatchesAfter, seedsMatchAfter, ...auth,
      keychainLookupCommandMentioned: /find-generic-password/i.test(log),
      backendAuthSuccessMarker: /ChainedAuth: authenticated via /i.test(log),
      nonKeyringBackendAuthSuccessMarker: /ChainedAuth: authenticated via (?!keyring\b)\S+/i.test(log),
      interactiveBackendCompletionMarker: /ChainedAuth: interactive auth completed via /i.test(log),
      noStoredCredentialMarker: /not authenticated: no stored credentials found/i.test(log + result.stderr),
      oauthObserved: brokerEvents.some(({ origin, method }) => origin === 'oauth2.googleapis.com' && method === 'POST'),
      tokenRefreshMarker: /token refreshed|token refresh succeeded/i.test(log),
      operatorKeychainChanged: before.loginKeychain !== after.loginKeychain,
      operatorSettingsChanged: before.settings !== after.settings,
      operatorSeedChanged: before.seed !== after.seed,
      brokerEvents,
    };
  } finally {
    broker?.close();
  }
}

async function ladder(helpers, directory) {
  const actualHome = fs.realpathSync.native(os.homedir());
  const executable = helpers.checks.which('agy');
  if (!executable) throw new Error('agy executable unavailable');
  const bin = fs.realpathSync.native(executable);
  const binaryStamp = await verifyBinary(bin, helpers.checks.pin);
  const root = path.join(directory, 'empty-root');
  fs.mkdirSync(root, { mode: 0o700 });
  const observed = [];
  let preflightFailedAt = null;
  for (const arm of arms) {
    let result;
    try { result = await runArm(helpers, directory, root, actualHome, bin, binaryStamp, arm); }
    catch {
      preflightFailedAt = arm.name;
      break;
    }
    observed.push(result);
    if (!result.passed) break;
  }
  console.log(JSON.stringify({ mode: 'metadata-factor-ladder', originalPinVerified: true,
    modelsCliResults: observed.length, preflightFailedAt, allPassed: observed.length === arms.length &&
      observed.every(({ passed }) => passed), arms: observed }, null, 2));
  if (preflightFailedAt || !observed.at(-1)?.cleanPostflight || observed.some(({ turns }) => turns > 0)) process.exitCode = 1;
}

async function selfTest(helpers, directory) {
  const { normal, checks, bootstrap, builder } = helpers;
  normal.selfTest(checks);
  const unproxied = safeEnv(builder, '/fixture/home', '/fixture/runtime');
  const proxied = safeEnv(builder, '/fixture/home', '/fixture/runtime', { url: 'http://localhost:12345', certificate: '/fixture/ca' });
  for (const name of proxyVariables) delete proxied[name];
  assert.deepEqual(unproxied, proxied);
  assert.equal(unproxied.HOME, '/fixture/home');
  const result = { code: 0, interrupted: false, timedOut: false };
  const reply = { status: 'SUCCESS', num_turns: 0, command: { data: { models: [{}] } } };
  const auth = { keychainLoaded: true, keychainAuthenticated: true };
  assert.equal(positiveMetadata(result, reply, auth, true), true);
  assert.equal(positiveMetadata(result, reply, { ...auth, keychainLoaded: false }, true), false);
  assert.equal(positiveMetadata(result, { ...reply, num_turns: null }, auth, true), false);
  assert.equal(positiveMetadata(result, reply, auth, false), false);
  const fixture = path.join(directory, 'broker-test');
  fs.mkdirSync(fixture);
  await bootstrap.selfTest(builder, fixture);
  console.log('fake-only stock wall, fixed models argv, SAFE env and authenticated stop gate passed');
}

const args = process.argv.slice(2);
if (!args.length) {
  console.log(JSON.stringify({ mode: 'disabled', childLaunches: 0 }));
} else if (args.length === 1 && ['--self-test', '--observe-auth-factors'].includes(args[0])) {
  const directory = fs.mkdtempSync('/private/tmp/acs-agy-auth-ladder-');
  try {
    const helpers = await loadHelpers(directory);
    if (args[0] === '--self-test') await selfTest(helpers, directory);
    else await ladder(helpers, directory);
  } catch {
    process.stderr.write('Auth factor ladder failed a local safety check.\n');
    process.exitCode = 1;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
} else {
  process.stderr.write('usage: auth-factor-ladder.mjs --self-test | --observe-auth-factors\n');
  process.exitCode = 64;
}
