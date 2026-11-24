import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const baseline = new URL('./auth-decision-trace.mjs', import.meta.url);
const baselineHash = '0b0c18553525b87ea16db8fdeb807e157facb8976a614a43cc0daa243df9e38a';
const lineLimit = 512;
const templates = {
  'stored-credentials-missing': 'not authenticated: no stored credentials found',
  'credential-command': 'find-generic-password',
  'auth-provider-absent': 'no auth provider configured',
  'auth-provider-nil': 'auth provider is nil',
  'authentication-failed': 'Error: authentication failed:',
  'authentication-failed-or-timeout': 'authentication failed or timed out',
  'models-sign-in-needed': 'Please sign in to view available models.',
  'keyring-loaded': 'keyringAuth: loaded token,',
  'keyring-load-failed': 'keyringAuth: failed to load stored token:',
  'keyring-oauth-params-failed': 'keyringAuth: failed to get oauth params:',
  'keyring-invalid': 'keyringAuth: saved token invalid:',
  'keyring-incomplete-onboarding': 'keyringAuth: incomplete GCP onboarding',
  'keyring-timeout': 'keyringAuth: timed out after ',
  'keyring-cancelled': 'keyringAuth: context cancelled,',
  'keyring-user-info-failed': 'keyringAuth: failed to fetch user info:',
  'keyring-validation-network-failed': 'keyringAuth: token validation failed due to network error',
  'keyring-email-claim-missing': 'keyringAuth: no email claim stored for WIF credential',
  'keyring-remove-failed': 'keyringAuth: failed to remove token:',
  'chained-auth-success': 'ChainedAuth: authenticated via ',
  'interactive-auth-completion': 'ChainedAuth: interactive auth completed via ',
  'token-store-init-failed': 'failed to initialize token storage:',
  'token-store-fallback': 'Using file-based token storage because ',
  'keyring-timeout-marker-stat-failed': 'failed to stat keyring timeout marker ',
  'onboarding-state-load-failed': 'failed to load onboarding status:',
  'settings-write-failed': 'failed to write validated settings:',
  'settings-default-fallback': 'failed to load cli settings, using defaults:',
  'user-config-load-failed': 'failed to load user config:',
  'user-config-path-failed': 'failed to resolve UserConfigPath:',
  'private-project-resolution-failed': 'failed to resolve project:',
  'private-project-config-write-failed': 'write project config:',
  'conversation-directory-read-failed': 'Failed to read conversations directory',
  'conversation-summary-reconcile': 'summary store: starting background reconciliation',
  'backend-request-failed': 'Failed to make code assist backend request',
  'telemetry-setting-default-disabled': 'Failed to read telemetry setting from server, defaulting to disabled:',
  'telemetry-shutdown-failed': 'Failed to shutdown telemetry client:',
  'quota-summary-fetch-failed': 'Failed to retrieve user quota summary:',
  'language-server-shutdown': 'Language server shutting down',
  'migration-drain': 'Waiting for migrations to complete to prevent partial migration state',
};
const fixedWords = new Set(('abort access account agent alias allow app apply auth authenticate authenticated authentication bootstrap browser ' +
  'after before cache cancelled cannot chain check cli client code config configuration configured connect conversation could create credential credentials data default denied ' +
  'directory disabled dns empty enable error executable expired failed fallback fatal fetch file forbidden found global home http initialize invalid ' +
  'io ipc keychain keyring language launched list load loaded local lock lookup machine marker metadata migration missing model models ' +
  'network no not oauth open operator params parse path permission port preference preferences private project provider proxy quota read refused refresh ' +
  'remove request required resolve response retry runtime sandbox save scope security server session setting settings signal socket source ' +
  'start state status stderr storage stored summary system telemetry temp timeout token tool trust unavailable unknown unsupported update user ' +
  'validated validation warning without workspace write').split(' '));
const errnoClasses = new Map([
  [1, 'EPERM'], [2, 'ENOENT'], [5, 'EIO'], [13, 'EACCES'], [22, 'EINVAL'],
  [35, 'EAGAIN'], [54, 'ECONNRESET'], [60, 'ETIMEDOUT'], [61, 'ECONNREFUSED'],
]);

function safeVocabulary(message) {
  const stripped = message.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`[^`]*`/g, ' ')
    .replace(/(?:\b[A-Za-z][A-Za-z0-9+.-]*:\/\/|[\/~])\S+/g, ' ')
    .replace(/\S+@\S+|\b[\w.-]+=[^\s,;]+|[?&][^\s]+/g, ' ')
    .replace(/\b[A-Fa-f0-9]{16,}\b|\b[A-Za-z0-9_-]{25,}\b/g, ' ');
  return (stripped.toLowerCase().match(/[a-z]+/g) ?? []).filter((word) => fixedWords.has(word)).slice(0, 18);
}

function safeErrno(message) {
  const numeric = /\berrno\s*(?:[:=(]\s*)?(\d{1,3})\b/i.exec(message)?.[1];
  const symbolic = /\b(EPERM|ENOENT|EIO|EACCES|EINVAL|EAGAIN|ECONNRESET|ETIMEDOUT|ECONNREFUSED)\b/.exec(message)?.[1];
  if (symbolic) return symbolic;
  if (numeric) return errnoClasses.get(Number(numeric)) ?? 'other-errno';
  if (/operation not permitted/i.test(message)) return 'EPERM';
  if (/permission denied/i.test(message)) return 'EACCES';
  if (/no such file or directory/i.test(message)) return 'ENOENT';
  return null;
}

function processStatus(message) {
  const code = /(?:^|[:\s])exit status (\d{1,3})[.]?\s*$/i.exec(message)?.[1];
  if (code !== undefined && Number(code) <= 255) return { exitCode: Number(code) };
  const signal = /(?:^|[:\s])signal: (killed|terminated|interrupt|hangup|segmentation fault|abort trap)[.]?\s*$/i.exec(message)?.[1];
  return signal ? { signal: signal.toLowerCase() } : null;
}

function newProjection(bytes, nativeProjection) {
  const curated = Object.entries(templates).filter(([, phrase]) => bytes.includes(Buffer.from(phrase)));
  const sources = new Map();
  const binaryHasSource = (source) => {
    if (!sources.has(source)) {
      sources.set(source, ['/', '\\', '\0', ' '].some((boundary) => bytes.includes(Buffer.from(boundary + source))));
    }
    return sources.get(source);
  };
  return (output) => {
    const records = [];
    let count = 0;
    let unresolved = 0;
    for (const line of output.split(/\r?\n/)) {
      if (!line) continue;
      ++count;
      if (records.length >= lineLimit) continue;
      const prefix = /^([IWEF])\d{4}\s+\d{2}:\d{2}:\d{2}\.\d+\s+\d+\s+([A-Za-z0-9_]+[.]go):([1-9]\d{0,5})\]\s*/.exec(line);
      const source = prefix && binaryHasSource(prefix[2]) ? prefix[2] : null;
      const level = prefix ? { I: 'info', W: 'warning', E: 'error', F: 'fatal' }[prefix[1]] : 'unstructured';
      const body = prefix ? line.slice(prefix[0].length) : line;
      const labels = curated.filter(([, phrase]) => body.includes(phrase)).map(([name]) => name);
      const words = safeVocabulary(body);
      const errno = safeErrno(body);
      const native = nativeProjection(body);
      const process = processStatus(body);
      const classified = Boolean(labels.length || words.length || errno || native.operation || native.status || process);
      if (!classified) ++unresolved;
      records.push({ ordinal: count, level, source, sourceLine: source ? Number(prefix[3]) : null, labels, words, errno,
        ...(native.operation || native.status ? { native } : {}), ...(process && { process }) });
    }
    return { nonemptyLines: count, unresolvedRetainedLines: unresolved, truncated: count > records.length, records };
  };
}

function replaceOne(source, before, after) {
  if (source.split(before).length !== 2) throw new Error('trace source anchor changed');
  return source.replace(before, () => after);
}

async function loadTrace(directory) {
  const bytes = fs.readFileSync(baseline);
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== baselineHash) throw new Error('trace baseline changed');
  const entries = bytes.toString('utf8').split('\nconst args = process.argv.slice(2);\n');
  if (entries.length !== 2) throw new Error('trace baseline entry point changed');
  const askModel = '../../../tools/ask-model.mjs';
  const previous = './auth-trusted-workspace-control.mjs';
  let source = replaceOne(entries[0], "from '" + askModel + "';", 'from ' + JSON.stringify(new URL(askModel, baseline).href) + ';');
  source = replaceOne(source, "new URL('" + previous + "', import.meta.url)",
    'new URL(' + JSON.stringify(new URL(previous, baseline).href) + ')');
  source = replaceOne(source, 'async function observeModels(pair, helpers, directory) {',
    'async function observeModels(pair, helpers, directory, projectPinned) {');
  source = replaceOne(source, '  const stamp = await pair.verifyBinary(exe, checks.pin);',
    '  const stamp = await pair.verifyBinary(exe, checks.pin);\n  const project = projectPinned(exe, checks.pin, nativeProjection);');
  source = replaceOne(source, 'sinks = captureSinks(args, result);', 'sinks = captureSinks(args, result, project);');
  source = replaceOne(source, 'function captureSinks(args, result) {', 'function captureSinks(args, result, project) {');
  source = replaceOne(source, 'stdout: appProjection(result.stdout), stderr: appProjection(result.stderr),',
    'stdout: project(result.stdout), stderr: project(result.stderr),');
  source = replaceOne(source, "ownedLog: safeLog ? appProjection(fs.readFileSync(logFile, 'utf8')) : null,",
    "ownedLog: safeLog ? project(fs.readFileSync(logFile, 'utf8')) : null,");
  const file = path.join(directory, 'template-trace-helper.mjs');
  fs.writeFileSync(file, source + '\nexport { loadPair, observeModels, nativeProjection, selfTest };\n', { mode: 0o600, flag: 'wx' });
  return import(pathToFileURL(file).href);
}

function projectPinned(file, expectedHash, nativeProjection) {
  const bytes = fs.readFileSync(file);
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== expectedHash) throw new Error('template binary changed');
  return newProjection(bytes, nativeProjection);
}

function selfTest({ nativeProjection }) {
  const binary = Buffer.from('/public/auth.go\0/public/errorreport.go\0keyringAuth: failed to load stored token:\0');
  const project = newProjection(binary, nativeProjection);
  const text = [
    'E1124 09:44:32.123456 36155 auth.go:283] keyringAuth: failed to load stored token: "/private/secret/path" errno=13',
    'W1124 09:44:33.123456 36155 errorreport.go:282] SecItemCopyMatching: OSStatus error -25308 service=oauth-secret',
    'I1124 09:44:34.123456 36155 account_name.go:999] https://example.invalid/private?query=token secret@company.test',
    'E1124 09:44:35.123456 36155 auth.go:284] no auth provider configured token=secret args=["--service","nonpublic-encrypted-fixture"]',
    'E1124 09:44:36.123456 36155 auth.go:285] unrelated-only-symbols',
  ].join('\n');
  const r = project(text);
  assert.equal(r.nonemptyLines, 5);
  assert.equal(r.records[0].level, 'error');
  assert.equal(r.records[0].source, 'auth.go');
  assert.equal(r.records[0].sourceLine, 283);
  assert.deepEqual(r.records[0].labels, ['keyring-load-failed']);
  assert.equal(r.records[0].errno, 'EACCES');
  assert.deepEqual(r.records[1].native, { operation: 'keychain-item-match', status: 'interaction-not-allowed', osStatus: -25308 });
  assert.equal(r.records[2].source, null);
  assert.deepEqual(r.records[3].labels, []);
  assert.equal(r.unresolvedRetainedLines, 2);
  assert.deepEqual(processStatus('failed native lookup: exit status 166'), { exitCode: 166 });
  assert.deepEqual(processStatus('failed native lookup: signal: killed'), { signal: 'killed' });
  assert.equal(processStatus('failed native lookup: exit status 654321'), null);
  assert.equal(processStatus('failed native lookup: signal: unrecognized-secret'), null);
  assert.doesNotMatch(JSON.stringify(r), /secret|account_name|private|36155|09:44|example|company|query|oauth|nonpublic-encrypted-fixture|--service/);
  const capped = project(Array(lineLimit + 1).fill('opaque').join('\n'));
  assert.equal(capped.records.length, lineLimit);
  assert.equal(capped.nonemptyLines, lineLimit + 1);
  assert.equal(capped.truncated, true);
  console.log('fake-only pinned-template projection, source coordinates and secret redaction passed');
}

const args = process.argv.slice(2);
if (!args.length) {
  console.log(JSON.stringify({ mode: 'disabled', childLaunches: 0 }));
} else if (args.length === 1 && ['--self-test', '--observe-template-trace'].includes(args[0])) {
  const directory = fs.mkdtempSync('/private/tmp/acs-agy-auth-template-trace-');
  try {
    const trace = await loadTrace(directory);
    const pair = await trace.loadPair(directory);
    const helpers = await pair.loadHelpers(directory);
    if (args[0] === '--self-test') {
      selfTest(trace);
      await trace.selfTest(pair, helpers, directory);
    } else await trace.observeModels(pair, helpers, directory, projectPinned);
  } catch {
    process.stderr.write('Template auth trace failed a local safety check.\n');
    process.exitCode = 1;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
} else {
  process.stderr.write('usage: auth-template-trace.mjs --self-test | --observe-template-trace\n');
  process.exitCode = 64;
}
