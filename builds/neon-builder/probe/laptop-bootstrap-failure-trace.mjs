import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readAnswer } from '../../../tools/ask-model.mjs';

const original = new URL('./laptop-bootstrap-control.mjs', import.meta.url);
const template = new URL('./auth-template-trace.mjs', import.meta.url);
const decision = new URL('./auth-decision-trace.mjs', import.meta.url);
const digests = [
  'efc50181899f65bc0cd4bde5e6dcf96d8609ceb15813a8c31ce6f4e25ce3199a',
  'c66d5842607b36a500fc8dc99e71c6aac040116f7f8375c6aaa1fd3061510b80',
  '0b0c18553525b87ea16db8fdeb807e157facb8976a614a43cc0daa243df9e38a',
];
const builderFile = new URL('../../../tools/agy-builder.mjs', import.meta.url);
const newPublicHosts = ['antigravity.google', 'www.gstatic.com', 'fonts.gstatic.com'];

function replace(source, before, after) {
  if (source.split(before).length !== 2) throw new Error('failure trace source anchor changed');
  return source.replace(before, () => after);
}

function lockedSource(url, hash, entry) {
  const bytes = fs.readFileSync(url);
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== hash) throw new Error('failure trace baseline changed');
  const parts = bytes.toString('utf8').split(entry);
  if (parts.length !== 2) throw new Error('failure trace entry point changed');
  return parts[0];
}

async function moduleCopy(directory, name, source, exports) {
  const file = path.join(directory, name);
  fs.writeFileSync(file, source + '\nexport { ' + exports + ' };\n', { mode: 0o600, flag: 'wx' });
  return import(pathToFileURL(file).href);
}

async function loadTrace(directory) {
  const argsEntry = '\nconst args = process.argv.slice(2);\n';
  const templateSource = lockedSource(template, digests[1], argsEntry);
  const { newProjection } = await moduleCopy(directory, 'laptop-trace-templates.mjs', templateSource, 'newProjection');
  const askModel = '../../../tools/ask-model.mjs';
  const decisionSource = replace(lockedSource(decision, digests[2], argsEntry), "from '" + askModel + "';",
    'from ' + JSON.stringify(new URL(askModel, decision).href) + ';');
  const { nativeProjection } = await moduleCopy(directory, 'laptop-trace-errors.mjs', decisionSource, 'nativeProjection');

  let source = lockedSource(original, digests[0], '\nconst [mode, familyFlag, family, ...extra] = process.argv.slice(2);\n');
  for (const relative of ['../../../lib/models.js', askModel]) {
    source = replace(source, "from '" + relative + "';", 'from ' + JSON.stringify(new URL(relative, original).href) + ';');
  }
  source = replace(source, "new URL('./connect-diagnostic.mjs', import.meta.url)",
    'new URL(' + JSON.stringify(new URL('./connect-diagnostic.mjs', original).href) + ')');
  source = replace(source, 'async function run(helper, api, directory, family) {',
    'async function run(helper, api, directory, family, traceBinary) {');
  source = replace(source, '  const calls = recorder(https.request);\n  const seen = observation(api);', [
    '  const trace = traceBinary(bin);',
    '  const calls = recorder(https.request);',
    '  const seen = observation({ ...api, authorityShape: (value) => trace.authority(api.authorityShape, value) });',
    '  let printReply = null;',
    '  let ownedLog = null;',
  ].join('\n'));
  source = replace(source, "        const log = fs.readFileSync(logFile, 'utf8');",
    "        const log = fs.readFileSync(logFile, 'utf8');\n        ownedLog = trace.log(log);");
  source = replace(source, '      readResult() {\n        resultCallbackReached = true;',
    '      readResult(requested, reply) {\n        resultCallbackReached = true;\n        printReply = trace.reply(requested, reply);');
  source = replace(source, '  const evidence = { phase, refusedPublication, resultCallbackReached,',
    '  const evidence = { phase, printReply, ownedLog, refusedPublication, resultCallbackReached,');
  const control = await moduleCopy(directory, 'laptop-trace-control.mjs', source, 'loadControl, run, selfTest');
  return { control, newProjection, nativeProjection };
}

function containsPublicUrl(bytes, host) {
  for (const scheme of ['https://', 'http://']) {
    const needle = Buffer.from(scheme + host);
    for (let at = bytes.indexOf(needle); at >= 0; at = bytes.indexOf(needle, at + needle.length)) {
      const next = bytes[at + needle.length];
      if (next === undefined || next === 0 || '/:?#"\' )'.includes(String.fromCharCode(next))) return true;
    }
  }
  return false;
}

function parserCategory(reply, parsed) {
  const error = parsed.error ?? '';
  if (reply.signal) return 'process-signal';
  if (reply.error) return 'spawn-error';
  if (reply.code !== 0) return 'process-failed';
  if (typeof parsed.answer === 'string') return 'answer-returned';
  if (/^asked for /.test(error)) return 'model-mismatch';
  if (error === 'agy builder did not report a successful result') return 'unsuccessful-result';
  if (error.startsWith('agy returned an empty answer')) return 'empty-answer';
  return 'missing-result';
}

function makeTrace(bytes, { newProjection, nativeProjection }) {
  const project = newProjection(bytes, nativeProjection);
  const known = new Set(newPublicHosts.filter((host) => containsPublicUrl(bytes, host)));
  return {
    authority(classify, value) {
      const host = newPublicHosts.find((name) => known.has(name) && value === name + ':443');
      return host ? { authorityClass: 'named-google-public-static', googleHost: host, portIs443: true } : classify(value);
    },
    log(output) {
      const result = project(output);
      return { nonemptyLines: result.nonemptyLines, truncated: result.truncated,
        faults: result.records.filter(({ level }) => ['error', 'warning', 'fatal'].includes(level)) };
    },
    reply(id, reply) {
      const parsed = readAnswer('agy', id, reply, null, { agyBuild: true });
      let terminal;
      for (const line of String(reply.stdout ?? '').split('\n')) {
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (event?.event === 'result' && event.result && typeof event.result === 'object') terminal = event.result;
      }
      const status = terminal?.status;
      const signals = new Set(['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGKILL', 'SIGABRT', 'SIGSEGV', 'SIGTRAP']);
      return {
        code: Number.isInteger(reply.code) && reply.code >= 0 && reply.code <= 255 ? reply.code : null,
        signal: signals.has(reply.signal) ? reply.signal : reply.signal ? 'other' : null,
        parserExit: Number.isInteger(parsed.exit) ? parsed.exit : null,
        errorClass: parserCategory(reply, parsed),
        terminalStatus: ['SUCCESS', 'ERROR', 'FAILED', 'DEADLINE_EXCEEDED', 'CANCELLED', 'ABORTED', 'MAX_TURNS'].includes(status)
          ? status : typeof status === 'string' ? 'other' : null,
        stderr: project(String(reply.stderr ?? '')).records.slice(0, 12),
        resultError: [terminal?.error, terminal?.response].flatMap((value) =>
          typeof value === 'string' ? project(value).records.slice(0, 12) : []),
      };
    },
  };
}

function tracePinned(bin, deps) {
  const pin = /^const AGY_DIGEST = '([a-f0-9]{64})';$/m.exec(fs.readFileSync(builderFile, 'utf8'))?.[1];
  const bytes = fs.readFileSync(fs.realpathSync.native(bin));
  if (!pin || crypto.createHash('sha256').update(bytes).digest('hex') !== pin) throw new Error('failure trace binary changed');
  return makeTrace(bytes, deps);
}

function selfTest(deps) {
  const bytes = Buffer.from('/public/failure.go\0https://antigravity.google.com/\0https://fonts.gstatic.com"\0https://www.gstatic.com/assets');
  const trace = makeTrace(bytes, deps);
  const unknown = () => ({ authorityClass: 'non-google' });
  assert.deepEqual(trace.authority(unknown, 'antigravity.google:443'), unknown());
  assert.deepEqual(trace.authority(unknown, 'fonts.gstatic.com:443'), {
    authorityClass: 'named-google-public-static', googleHost: 'fonts.gstatic.com', portIs443: true,
  });
  assert.deepEqual(trace.authority(unknown, 'www.gstatic.com:444'), unknown());
  const privateLine = 'E1124 12:03:45.123456 1234 failure.go:319] failed to read auth agent from "/private/hidden" token=private-fixture';
  const reply = trace.reply('fixture-id', { code: 1, signal: null, stderr: privateLine,
    stdout: JSON.stringify({ event: 'result', result: { status: 'unexpected-secret', response: 'failed auth https://secret.invalid/?key=private' } }) });
  assert.equal(reply.errorClass, 'process-failed');
  assert.equal(reply.terminalStatus, 'other');
  assert.equal(reply.code, 1);
  assert.equal(reply.stderr[0].source, 'failure.go');
  assert.equal(reply.stderr[0].sourceLine, 319);
  assert.equal(trace.log(privateLine).faults[0].level, 'error');
  assert.equal(trace.reply('fixture-id', { code: null, signal: 'SIGTERM' }).errorClass, 'process-signal');
  assert.equal(trace.reply('fixture-id', { code: 0, stdout: '{"event":"result","result":{"status":"ERROR"}}' }).errorClass,
    'unsuccessful-result');
  assert.doesNotMatch(JSON.stringify(reply), /hidden|private-fixture|secret|unexpected|key=|token=/);
}

const [mode, flag, family, ...rest] = process.argv.slice(2);
if (!mode) console.log(JSON.stringify({ mode: 'disabled', childLaunches: 0 }));
else if (mode === '--self-test' && !flag || mode === '--trace-laptop-bootstrap' && flag === '--family' && family && !rest.length) {
  const directory = fs.mkdtempSync('/private/tmp/acs-agy-laptop-failure-trace-');
  try {
    const deps = await loadTrace(directory);
    const api = await deps.control.loadControl(directory);
    const helper = await api.temporaryHelper(directory);
    if (mode === '--self-test') {
      selfTest(deps);
      await deps.control.selfTest(helper, api, directory);
      console.log('fake-only failed print categories, owned log coordinates and exact static authority redaction passed');
    } else await deps.control.run(helper, api, directory, family, (bin) => tracePinned(bin, deps));
  } catch {
    process.stderr.write('Laptop bootstrap failure trace failed a local safety check.\n');
    process.exitCode = 1;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
} else {
  process.stderr.write('usage: laptop-bootstrap-failure-trace.mjs --self-test | --trace-laptop-bootstrap --family <family>\n');
  process.exitCode = 64;
}
