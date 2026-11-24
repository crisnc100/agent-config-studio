import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { AGY_ENV, AGY_WALL, SANDBOX_EXEC, agyAfterCall, agyTokenLeft,
  agyWall, agyWallParams, agyWallProblem, argvFor } from '../../../tools/ask-model.mjs';

const bootstrapFile = new URL('./auth-bootstrap-controls.mjs', import.meta.url);
const askModelFile = new URL('../../../tools/ask-model.mjs', import.meta.url);
const builderFile = new URL('../../../tools/agy-builder.mjs', import.meta.url);
const bootstrapDigest = 'be6624573630fad70dbdbb17cbef3d75465ba40508a96ad520fa0e32c415946e';
const noPlaintext = '(deny file-write* (regex #"(^|/)antigravity-oauth-token$"))';
const noBrowser = '(deny process-exec (literal "/usr/bin/open"))';

function replaceOne(source, before, after) {
  if (source.split(before).length !== 2) throw new Error('diagnostic source changed shape');
  return source.replace(before, () => after);
}

async function temporaryModule(directory, name, data) {
  const file = path.join(directory, name);
  fs.writeFileSync(file, data, { mode: 0o600, flag: 'wx' });
  return import(pathToFileURL(file).href);
}

async function loadDiagnosticHelpers(directory) {
  const bootstrap = fs.readFileSync(bootstrapFile);
  if (crypto.createHash('sha256').update(bootstrap).digest('hex') !== bootstrapDigest) {
    throw new Error('auth projector source changed');
  }
  const seam = 'const args = process.argv.slice(2);';
  const parts = bootstrap.toString('utf8').split(seam);
  if (parts.length !== 2) throw new Error('auth projector entry point changed');
  const projector = replaceOne(parts[0], "from '../../../tools/ask-model.mjs';",
    'from ' + JSON.stringify(askModelFile.href) + ';');
  const { authFlags } = await temporaryModule(directory, 'auth-projector.mjs', projector + '\nexport { authFlags };\n');

  let preflight = fs.readFileSync(askModelFile, 'utf8');
  for (const name of ['models.js', 'roles.js']) {
    const original = '../lib/' + name;
    preflight = replaceOne(preflight, "from '" + original + "';", 'from ' + JSON.stringify(new URL(original, askModelFile).href) + ';');
  }
  preflight = replaceOne(preflight, 'if (isMain) process.exitCode = await main(process.argv.slice(2));',
    'export { AGY_VERSION, agyConfigProblem, agyWorkspaceFiles, which };');
  const { AGY_VERSION, agyConfigProblem, agyWorkspaceFiles, which } =
    await temporaryModule(directory, 'auth-preflight.mjs', preflight);
  const pin = /^const AGY_DIGEST = '([a-f0-9]{64})';$/m.exec(fs.readFileSync(builderFile, 'utf8'))?.[1];
  if (AGY_VERSION !== '1.5.14' || !pin) throw new Error('agy pin is unavailable');
  return { AGY_VERSION, pin, agyConfigProblem, agyWorkspaceFiles, which, authFlags };
}

function walled(params, command) {
  const args = agyWall(params, command);
  const profile = args.indexOf('-p') + 1;
  if (args[profile] !== AGY_WALL) throw new Error('read-only profile changed shape');
  args[profile] += '\n' + noPlaintext + '\n' + noBrowser;
  return args;
}

function modelsCommand(bin, root, logFile) {
  const readOnly = argvFor('agy', { cwd: root, mode: 'read-only', logFile });
  const settingsAt = readOnly.indexOf('--settings');
  if (settingsAt < 0 || !JSON.parse(readOnly[settingsAt + 1]).permissions?.deny?.includes('command(*)')) {
    throw new Error('read-only settings changed shape');
  }
  return [bin, '--disable-slash-commands', '--settings', readOnly[settingsAt + 1],
    '--log-file', logFile, '--output-format', 'json', 'models'];
}

function launch(args, cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(SANDBOX_EXEC, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const killGroup = () => { try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch {} };
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    let interrupted = false;
    let timedOut = false;
    const interrupt = () => { interrupted = true; killGroup(); };
    const timer = setTimeout(() => { timedOut = true; killGroup(); }, 25_000);
    for (const signal of signals) process.on(signal, interrupt);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (bytes) => { stdout += bytes; });
    child.stderr.on('data', (bytes) => { stderr += bytes; });
    child.once('exit', killGroup);
    child.once('error', () => reject(new Error('could not start sandboxed child')));
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      for (const name of signals) process.off(name, interrupt);
      resolve({ code, signal, interrupted, timedOut, stdout, stderr });
    });
  });
}

async function observe(helpers, directory) {
  const home = fs.realpathSync.native(os.homedir());
  const root = path.join(directory, 'empty-root');
  const callTmp = path.join(directory, 'call-tmp');
  for (const name of [root, callTmp]) fs.mkdirSync(name, { mode: 0o700 });
  const logFile = path.join(callTmp, 'agy.log');
  if (agyWallProblem() || helpers.agyWorkspaceFiles(root).length || helpers.agyConfigProblem(home) || agyTokenLeft(home)) {
    throw new Error('read-only preflight refused');
  }
  const original = helpers.which('agy');
  if (!original) throw new Error('agy executable unavailable');
  const bin = fs.realpathSync.native(original);
  const hash = crypto.createHash('sha256');
  for await (const bytes of fs.createReadStream(bin)) hash.update(bytes);
  if (hash.digest('hex') !== helpers.pin) throw new Error('agy executable does not match the builder pin');

  const { params } = agyWallParams({ root, callTmp, logFile, bin, home });
  if (!params) throw new Error('read-only wall parameters unavailable');
  const env = { ...process.env, ...AGY_ENV, TMPDIR: params.CALL_TMP };
  const version = await launch(walled(params, [bin, '--version']), root, env);
  if (version.code !== 0 || version.interrupted || version.timedOut ||
      version.stdout.trim() !== helpers.AGY_VERSION || agyTokenLeft(home)) {
    throw new Error('read-only version or plaintext guard failed');
  }
  const result = await launch(walled(params, modelsCommand(bin, root, logFile)), root, env);
  const logStat = fs.lstatSync(logFile, { throwIfNoEntry: false });
  const safeLog = logStat?.isFile() && logStat.nlink === 1 && fs.realpathSync.native(logFile) === logFile;
  const log = safeLog ? fs.readFileSync(logFile, 'utf8') : '';
  const plaintextAbsent = !agyTokenLeft(home);
  const cleanPostflight = Boolean(safeLog) && plaintextAbsent && !agyAfterCall(logFile, home);
  let data;
  try { data = JSON.parse(result.stdout); } catch {}
  const turns = Number.isInteger(data?.num_turns) && data.num_turns >= 0 ? data.num_turns : null;
  const models = data?.command?.data?.models;
  const markers = helpers.authFlags(log, result.stdout + result.stderr);
  const cleanMetadata = result.code === 0 && data?.status === 'SUCCESS' && turns === 0 && Array.isArray(models) && models.length > 0;
  const evidence = {
    mode: 'normal-home-read-only-models', modelsCliLaunches: 1,
    code: result.code, signal: result.signal, timedOut: result.timedOut, interrupted: result.interrupted,
    reportedZeroTurns: turns === 0, turns, modelCount: Array.isArray(models) ? models.length : null,
    cleanMetadata, authenticatedKeyringMetadata: Boolean(cleanMetadata && markers.keychainLoaded &&
      markers.keychainAuthenticated && cleanPostflight),
    plaintextAbsent, cleanPostflight, ...markers,
    keychainLookupCommandMentioned: /find-generic-password/i.test(log),
    backendAuthSuccessMarker: /ChainedAuth: authenticated via /i.test(log),
    nonKeyringBackendAuthSuccessMarker: /ChainedAuth: authenticated via (?!keyring\b)\S+/i.test(log),
    interactiveBackendCompletionMarker: /ChainedAuth: interactive auth completed via /i.test(log),
    noStoredCredentialMarker: /not authenticated: no stored credentials found/i.test(log + result.stderr),
  };
  console.log(JSON.stringify(evidence, null, 2));
  if (!cleanPostflight || result.interrupted || turns > 0) process.exitCode = 1;
}

function selfTest(helpers) {
  const params = { ROOT: '/fixture/source', CALL_TMP: '/fixture/tmp', LOG: '/fixture/tmp/log',
    AGY: '/fixture/agy', HOME: '/fixture/home', TMP: '/fixture/temp', USER_TMP: '/fixture/user-tmp' };
  const command = modelsCommand(params.AGY, params.ROOT, params.LOG);
  const expected = argvFor('agy', { cwd: params.ROOT, mode: 'read-only', logFile: params.LOG });
  assert.deepEqual(command, [params.AGY, '--disable-slash-commands', '--settings', expected[expected.indexOf('--settings') + 1],
    '--log-file', params.LOG, '--output-format', 'json', 'models']);
  assert.ok(!command.includes('-p'));
  const stock = agyWall(params, command);
  const index = stock.indexOf('-p') + 1;
  stock[index] = [AGY_WALL, noPlaintext, noBrowser].join('\n');
  assert.deepEqual(walled(params, command), stock);
  const flags = helpers.authFlags('keyringAuth: loaded token, expiry=private fixture\nChainedAuth: authenticated via keyring',
    'Please sign in to view available models');
  assert.equal(flags.signInNeeded, true);
  assert.equal(flags.keychainLoaded, true);
  assert.equal(flags.keychainAuthenticated, true);
  assert.doesNotMatch(JSON.stringify(flags), /private fixture/);
  assert.equal(typeof helpers.agyWorkspaceFiles, 'function');
  assert.equal(typeof helpers.agyConfigProblem, 'function');
  console.log('fake-only models argv, read-only wall restrictions and redacted auth projection passed');
}

const args = process.argv.slice(2);
if (!args.length) {
  console.log(JSON.stringify({ mode: 'disabled', childLaunches: 0 }));
} else if (args.length === 1 && ['--self-test', '--observe-normal-home'].includes(args[0])) {
  const directory = fs.mkdtempSync('/private/tmp/acs-agy-normal-home-control-');
  try {
    const helpers = await loadDiagnosticHelpers(directory);
    if (args[0] === '--self-test') selfTest(helpers);
    else await observe(helpers, directory);
  } catch {
    process.stderr.write('Normal-HOME auth control failed a local safety check.\n');
    process.exitCode = 1;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
} else {
  process.stderr.write('usage: auth-normal-home-control.mjs --self-test | --observe-normal-home\n');
  process.exitCode = 64;
}
