import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { agyTokenLeft, agyWallProblem } from '../../../tools/ask-model.mjs';

const baseline = new URL('./auth-trusted-workspace-control.mjs', import.meta.url);
const baselineHash = 'a5836010851b6db496488065358094a98bf1dcfe3bf1e72628f5f615e6895b34';
const arms = [
  { name: 'trace-read-only', strict: false }, { name: 'trace-strict', strict: true },
].map((arm) => ({ ...arm, privateHome: true, proxy: true }));
const traceLimit = 512;

function replaceOne(source, before, after) {
  if (source.split(before).length !== 2) throw new Error('trace source anchor changed');
  return source.replace(before, () => after);
}

async function loadPair(directory) {
  const raw = fs.readFileSync(baseline);
  if (crypto.createHash('sha256').update(raw).digest('hex') !== baselineHash) throw new Error('trace baseline changed');
  const parts = raw.toString('utf8').split('\nconst args = process.argv.slice(2);\n');
  if (parts.length !== 2) throw new Error('trace baseline entry point changed');
  const ask = '../../../tools/ask-model.mjs';
  const pair = './auth-wall-pair-control.mjs';
  let source = replaceOne(parts[0], "from '" + ask + "';", 'from ' + JSON.stringify(new URL(ask, baseline).href) + ';');
  source = replaceOne(source, "new URL('" + pair + "', import.meta.url)",
    'new URL(' + JSON.stringify(new URL(pair, baseline).href) + ')');
  const file = path.join(directory, 'trace-pair-source.mjs');
  fs.writeFileSync(file, source + '\nexport { loadPair };\n', { mode: 0o600, flag: 'wx' });
  return (await import(pathToFileURL(file).href)).loadPair(directory);
}

const appMarkers = {
  noStoredCredentials: 'not authenticated: no stored credentials found',
  noAuthProvider: 'no auth provider configured',
  nilAuthProvider: 'auth provider is nil',
  genericAuthFailed: 'error: authentication failed:',
  authFailedOrTimedOut: 'authentication failed or timed out',
  keyringPrefix: 'keyringauth:',
  chainedKeyringSuccess: 'chainedauth: authenticated via keyring',
  signInNeeded: 'please sign in to view available models',
  credentialCommandMentioned: 'find-generic-password',
  invalidStoredToken: 'keyringauth: saved token invalid:',
  failedTokenRemoval: 'keyringauth: failed to remove token:',
  failedUserInfo: 'keyringauth: failed to fetch user info:',
  failedOAuthParams: 'keyringauth: failed to get oauth params:',
  failedStoredTokenLookup: 'keyringauth: failed to load stored token:',
  keychainLoaded: 'keyringauth: loaded token,',
  cancelledKeyring: 'keyringauth: context cancelled,',
  missingWifEmailClaim: 'keyringauth: no email claim stored for wif credential',
  keyringTimedOut: 'keyringauth: timed out after ',
  keyringValidationNetworkError: 'keyringauth: token validation failed due to network error',
  incompleteGcpOnboarding: 'keyringauth: incomplete gcp onboarding',
  tokenStorageInitializationError: 'failed to initialize token storage:',
  keyringMarkerHomeError: 'failed to get user home directory for keyring marker:',
  keyringMarkerStatError: 'failed to stat keyring timeout marker ',
  keyringMarkerCleanupError: 'failed to remove stale keyring timeout marker ',
  keyringMarkerWriteError: 'failed to write keyring marker:',
  keyringMarkerRenameError: 'failed to rename keyring marker file:',
  keyringMarkerDirectoryError: 'failed to create keyring marker directory:',
  keyringMarkerTempCreateError: 'failed to create temporary keyring marker file:',
  keyringMarkerTempCloseError: 'failed to close temporary keyring marker file:',
  keyringMarkerPermissionsError: 'failed to set permissions on temporary keyring marker file:',
  tokenFallbackMarker: 'using file-based token storage because ',
  failedOnboardingLoad: 'failed to load onboarding status:',
  settingsWriteFailed: 'failed to write validated settings:',
};
const securityStatuses = new Map([
  [-25300, 'item-not-found'],
  [-25308, 'interaction-not-allowed'],
  [-25293, 'authentication-failed'],
  [-25294, 'keychain-not-found'],
  [-25295, 'invalid-keychain'],
  [-25291, 'keychain-unavailable'],
  [-34018, 'missing-entitlement'],
  [-128, 'user-canceled'],
  [-50, 'invalid-parameter'],
]);
const securityPhrases = new Map([
  ['the specified item could not be found in the keychain', 'item-not-found'],
  ['user interaction is not allowed', 'interaction-not-allowed'],
  ['the user name or passphrase you entered is not correct', 'authentication-failed'],
  ['the specified keychain could not be found', 'keychain-not-found'],
  ['the specified keychain is not a valid keychain file', 'invalid-keychain'],
  ['no keychain is available', 'keychain-unavailable'],
  ['a required entitlement is not present', 'missing-entitlement'],
]);
const fixedTargets = new Map([
  ['com.apple.system.opendirectoryd.libinfo', 'directory-libinfo'],
  ['com.apple.system.opendirectoryd.membership', 'directory-membership'],
  ['com.apple.bsd.dirhelper', 'directory-helper'],
  ['com.apple.securityd', 'securityd'],
  ['com.apple.SecurityServer', 'security-server'],
  ['com.apple.logd', 'logd'],
  ['com.apple.system.notification_center', 'notification-center'],
  ['/private/var/run/systemkeychaincheck.socket', 'system-keychain-check-socket'],
  ['/private/var/run/systemkeychaincheck.done', 'system-keychain-check-marker'],
  ['/private/var/run/mDNSResponder', 'system-dns-socket'],
  ['/Library/Preferences/.GlobalPreferences.plist', 'global-preferences'],
  ['/usr/bin/open', 'browser-open'],
  ['/usr/bin/security', 'security-executable'],
]);
const operations = new Set(['file-read-data', 'file-read-metadata', 'file-write-unlink', 'mach-lookup',
  'process-exec', 'process-exec*', 'network-outbound', 'system-socket']);

function nativeProjection(message) {
  const operation = /\bSecKeychainSearchCopyNext\b/.test(message) ? 'keychain-item-search' :
    /\bSecKeychainFindGenericPassword\b/.test(message) ? 'keychain-generic-item-search' :
      /\bSecItemCopyMatching\b/.test(message) ? 'keychain-item-match' :
        /\bSecKeychainCopySettings\b/.test(message) ? 'keychain-settings-query' :
          /\bSecKeychainOpen\b/.test(message) ? 'keychain-open' : null;
  const value = /\bOSStatus(?: error)?\s*[:=]?\s*(-\d{1,9})\b/i.exec(message)?.[1];
  const numeric = value ? Number(value) : null;
  const text = message.toLowerCase();
  const phrase = Array.from(securityPhrases).find(([candidate]) => text.includes(candidate))?.[1];
  const status = numeric === null ? phrase ?? null : securityStatuses.get(numeric) ?? 'other-osstatus';
  return { operation, status, ...(numeric !== null && securityStatuses.has(numeric) && { osStatus: numeric }) };
}

const publicGoSources = new Set(['auth.go', 'keyring.go', 'token_storage.go', 'oauth.go', 'oauth2.go', 'auth_client.go',
  'code_assist_client.go', 'cli_setting_manager.go', 'common.go', 'errorreport.go', 'manager.go', 'server.go']);

function appProjection(output) {
  const lines = output.split(/\r?\n/).filter(Boolean);
  const markers = {};
  const native = [];
  const severityCounts = {};
  const sourceCounts = {};
  let unclassifiedLines = 0;
  let truncated = false;
  const count = (map, key) => { map[key] = (map[key] ?? 0) + 1; };
  for (const line of lines) {
    const prefix = /^([IWEF])\d{4}\s+\d{2}:\d{2}:\d{2}\.\d+\s+\d+\s+([a-z0-9_]+[.]go):\d+\]/i.exec(line);
    const level = prefix ? { I: 'info', W: 'warning', E: 'error', F: 'fatal' }[prefix[1].toUpperCase()] : 'unstructured';
    const source = prefix ? publicGoSources.has(prefix[2]) ? prefix[2] : 'other-public-code' : 'unstructured';
    count(severityCounts, level);
    count(sourceCounts, source);
    const text = line.toLowerCase();
    const categories = Object.entries(appMarkers).filter(([, marker]) => text.includes(marker));
    for (const [name] of categories) count(markers, name);
    const status = nativeProjection(line);
    if (status.operation || status.status) {
      if (native.length < 32) native.push(status);
      else truncated = true;
    } else if (!categories.length) ++unclassifiedLines;
  }
  return { empty: output.length === 0, nonemptyLines: lines.length, unclassifiedLines,
    markerCounts: markers, severityCounts, sourceCounts, sensitiveContentOmitted: true, truncated, native };
}

function validPid(value) {
  return Number.isSafeInteger(value) && value >= 1 && value <= 2 ** 31 - 1 ? value : null;
}

function sandboxProjection(message) {
  const match = /^Sandbox: (?:agy|security)\((\d+)\) deny(?:\(\d+\))? ([a-z*-]+)(?: (.+))?$/i.exec(message);
  const pid = match && validPid(Number(match[1]));
  if (!pid) return null;
  const op = match[2].toLowerCase();
  const value = match[3] ?? '';
  const target = fixedTargets.get(value) ?? (value.endsWith('/Library/Keychains/login.keychain-db') ? 'login-keychain-db' :
    value.endsWith('/Library/Keychains') ? 'keychain-directory' :
      value.endsWith('/.gemini/antigravity-cli/settings.json') ? 'private-cli-settings' : 'other-target');
  return { pid, operation: operations.has(op) ? op : 'other-operation', target };
}

function unifiedProjection(record, pids) {
  const message = record?.eventMessage;
  if (typeof message !== 'string') return null;
  const sandbox = sandboxProjection(message);
  if (sandbox) return pids.has(sandbox.pid) ? { kind: 'sandbox-denial', ...sandbox } : null;
  const direct = validPid(record.processID ?? record.processIdentifier ?? record.pid);
  const client = /\bclient(?:_process)?[ _]pid(?:\s*[:=]\s*|\s+)(\d+)\b/i.exec(message)?.[1];
  const byDirect = pids.has(direct);
  const byClient = pids.has(client ? validPid(Number(client)) : null);
  if (!byDirect && !byClient) return null;
  const native = nativeProjection(message);
  if (!native.operation && !native.status) return null;
  return { kind: 'native-category', pid: byDirect ? direct : Number(client),
    attribution: byDirect ? 'direct-process' : 'explicit-client-pid', ...native };
}

async function projectUnified(pids) {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const matched = [];
  let parseFailures = 0;
  let truncated = false;
  for await (const line of input) {
    let record;
    if (!line.trim()) continue;
    try { record = JSON.parse(line); } catch { ++parseFailures; continue; }
    const result = unifiedProjection(record, pids);
    if (!result) continue;
    if (matched.length === traceLimit) truncated = true;
    else matched.push(result);
  }
  console.log(JSON.stringify({ mode: 'unified-log-public-projection', parseFailures, truncated, matched }, null, 2));
}

function captureSinks(args, result) {
  const idx = args.lastIndexOf('--log-file');
  const logFile = args[idx + 1];
  if (idx < 0 || typeof logFile !== 'string') throw new Error('owned log argument unavailable');
  const stat = fs.lstatSync(logFile, { throwIfNoEntry: false });
  const safeLog = stat?.isFile() && stat.nlink === 1 && fs.realpathSync.native(logFile) === logFile;
  return {
    stdout: appProjection(result.stdout), stderr: appProjection(result.stderr),
    ownedLog: safeLog ? appProjection(fs.readFileSync(logFile, 'utf8')) : null,
  };
}

async function observeModels(pair, helpers, directory) {
  const home = fs.realpathSync.native(os.homedir());
  const root = path.join(directory, 'empty-root');
  fs.mkdirSync(root, { mode: 0o700 });
  const { checks } = helpers;
  if (agyWallProblem() || checks.agyWorkspaceFiles(root).length || checks.agyConfigProblem(home) || agyTokenLeft(home)) {
    throw new Error('trace preflight refused');
  }
  const found = checks.which('agy');
  if (!found) throw new Error('pinned executable unavailable');
  const exe = fs.realpathSync.native(found);
  const stamp = await pair.verifyBinary(exe, checks.pin);
  const prepared = pair.preparePairedInputs(helpers, directory, home, arms);
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
        ...helpers, normal: {
          ...helpers.normal,
          async launch(args, cwd, env) {
            const result = await helpers.normal.launch(args, cwd, env);
            sinks = captureSinks(args, result);
            return result;
          },
        },
      };
      const result = await pair.runArm(instrumented, directory, root, home, exe, stamp, arm);
      observed.push({ ...result, sinks });
      if (result.interrupted || result.timedOut || result.turns > 0 || !result.cleanPostflight ||
          !result.plaintextAbsent || !result.aliasMatchesAfter) {
        stopped = 'metadata-safety-check-failed';
        break;
      }
      if (result.oauthObserved || result.tokenRefreshMarker || result.operatorKeychainChanged ||
          result.operatorSettingsChanged || result.operatorSeedChanged) {
        stopped = 'operator-state-changed';
        break;
      }
      if (!arm.strict && !result.passed) {
        stopped = 'read-only-auth-positive-not-reproduced';
        break;
      }
    } catch {
      stopped = 'local-safety-or-input-check-failed';
      break;
    }
  }
  console.log(JSON.stringify({ mode: 'matched-auth-sinks', modelsCliResults: observed.length,
    freshPrivateInputsMatched: true, originalPinVerified: true, stopped, arms: observed }, null, 2));
}

async function selfTest(pair, helpers, directory) {
  const pids = new Set([41, 42]);
  const events = [
    { eventMessage: 'Sandbox: security(41) deny(1) mach-lookup com.apple.system.opendirectoryd.membership' },
    { eventMessage: 'Sandbox: security(41) deny(1) file-read-metadata /private/secret-account/Library/Keychains' },
    { processID: 42, eventMessage: 'SecKeychainFindGenericPassword: OSStatus error -25308 secret-account' },
    { processID: 100, eventMessage: 'client pid=42 SecItemCopyMatching: OSStatus -25300 secret-service' },
  ];
  const sanitized = events.map((event) => unifiedProjection(event, pids));
  assert.deepEqual(sanitized, [
    { kind: 'sandbox-denial', pid: 41, operation: 'mach-lookup', target: 'directory-membership' },
    { kind: 'sandbox-denial', pid: 41, operation: 'file-read-metadata', target: 'keychain-directory' },
    { kind: 'native-category', pid: 42, attribution: 'direct-process', operation: 'keychain-generic-item-search',
      status: 'interaction-not-allowed', osStatus: -25308 },
    { kind: 'native-category', pid: 42, attribution: 'explicit-client-pid', operation: 'keychain-item-match',
      status: 'item-not-found', osStatus: -25300 },
  ]);
  assert.equal(unifiedProjection({ processID: 100, eventMessage: 'SecItemCopyMatching target 42' }, pids), null);
  assert.doesNotMatch(JSON.stringify(sanitized), /secret-account|secret-service/);
  assert.equal(appProjection('').empty, true);
  const projected = appProjection('Error: authentication failed: secret fixture\nSecKeychainSearchCopyNext: user interaction is not allowed');
  assert.equal(projected.empty, false);
  assert.equal(projected.markerCounts.genericAuthFailed, 1);
  assert.deepEqual(projected.native, [{ operation: 'keychain-item-search', status: 'interaction-not-allowed' }]);
  assert.doesNotMatch(JSON.stringify(projected), /secret fixture/);
  const unknown = appProjection('E1124 09:44:32.123456 123 errorreport.go:282] secret message\n' +
    'I1124 09:44:32.123457 123 private_account.go:123] keyringAuth: loaded token, expiry=private');
  assert.deepEqual(unknown.severityCounts, { error: 1, info: 1 });
  assert.deepEqual(unknown.sourceCounts, { 'errorreport.go': 1, 'other-public-code': 1 });
  assert.equal(unknown.unclassifiedLines, 1);
  assert.doesNotMatch(JSON.stringify(unknown), /private_account|secret message|expiry|private/);
  await pair.selfTest(helpers, directory);
  console.log('fake-only auth sink and PID-scoped native/sandbox trace projections passed');
}

const args = process.argv.slice(2);
if (!args.length) {
  console.log(JSON.stringify({ mode: 'disabled', childLaunches: 0 }));
} else if (args.length === 3 && args[0] === '--project-unified' && args[1] === '--pids' &&
    /^[1-9]\d{0,9}(?:,[1-9]\d{0,9}){0,31}$/.test(args[2])) {
  const pids = new Set(args[2].split(',').map(Number).map(validPid));
  if (pids.has(null)) process.exitCode = 64;
  else await projectUnified(pids);
} else if (args.length === 1 && ['--self-test', '--observe-metadata-sinks'].includes(args[0])) {
  const directory = fs.mkdtempSync('/private/tmp/acs-agy-auth-trace-');
  try {
    const pair = await loadPair(directory);
    const helpers = await pair.loadHelpers(directory);
    if (args[0] === '--self-test') await selfTest(pair, helpers, directory);
    else await observeModels(pair, helpers, directory);
  } catch {
    process.stderr.write('Auth trace projection failed a local safety check.\n');
    process.exitCode = 1;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
} else {
  process.stderr.write('usage: auth-decision-trace.mjs --self-test | --observe-metadata-sinks | --project-unified --pids <pid,pid,...>\n');
  process.exitCode = 64;
}
