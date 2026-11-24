import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const trace = new URL('./laptop-bootstrap-failure-trace.mjs', import.meta.url);
const bootstrap = new URL('./laptop-bootstrap-control.mjs', import.meta.url);
const connect = new URL('./connect-diagnostic.mjs', import.meta.url);
const digests = [
  '6cc10dd2fa905533065a0d816489d18f343b308bc410776dc9c88f94ccaaa4ce',
  'efc50181899f65bc0cd4bde5e6dcf96d8609ceb15813a8c31ce6f4e25ce3199a',
  '4ae51fe64a5e0eb2c74decd2925232d99ed554e7afcc97a449daebc796580071',
];
const quota = '/v1internal:retrieveUserQuotaSummary';
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

function source(url, expected) {
  const bytes = fs.readFileSync(url);
  if (sha(bytes) !== expected) throw new Error('quota diagnostic baseline changed');
  return bytes.toString('utf8');
}

function replace(text, before, after) {
  if (text.split(before).length !== 2) throw new Error('quota diagnostic source anchor changed');
  return text.replace(before, () => after);
}

function connectVariant() {
  let text = source(connect, digests[2]);
  text = replace(text, "'/v1internal:retrieveUserQuota', '/v1internal:listExperiments'",
    "'/v1internal:retrieveUserQuota', '" + quota + "', '/v1internal:listExperiments'");
  const before = "'/v1internal:retrieveUserQuota': 'POST',";
  const after = before + "\n    '" + quota + "': 'POST',";
  return replace(text, '  const operations = [', '  const operations = [\n    ' + JSON.stringify([before, after]) + ',');
}

function bootstrapVariant(connectPath, connectHash) {
  let text = source(bootstrap, digests[1]);
  const changes = [
    ["const baselineHash = '" + digests[2] + "';", "const baselineHash = '" + connectHash + "';"],
    ['new URL(relative, baseline).href', 'new URL(relative, ' + JSON.stringify(connect.href) + ').href'],
    ['new URL(builder, baseline).href', 'new URL(builder, ' + JSON.stringify(connect.href) + ').href'],
    ["  [cloud, 'POST', '/v1internal:retrieveUserQuota', 'quota'],",
      "  [cloud, 'POST', '/v1internal:retrieveUserQuota', 'quota'],\n  [cloud, 'POST', '" + quota + "', 'quota-summary'],"],
    ["'fetchAdminControls', 'retrieveUserQuotaSummary', 'fetchUserInfo'", "'fetchAdminControls', 'fetchUserInfo'"],
    ['function qualifies({', [
      'function afterQuota200(calls, denied) {',
      '  return denied.generationDenied && (calls.dispatches["quota-summary"]?.statuses[200] ?? 0) > 0;',
      '}',
      'const failedEligibility = (output) => /eligibility check failed:/i.test(output);',
      'function qualifies({',
    ].join('\n')],
    ["  let phase = 'preflight';", "  let phase = 'preflight';\n  let generationDeniedAfterQuota200 = false;\n  let eligibilityFailed = false;"],
    ["        const log = fs.readFileSync(logFile, 'utf8');",
      "        const log = fs.readFileSync(logFile, 'utf8');\n        eligibilityFailed ||= failedEligibility(log);"],
    ['          observeConnect: seen.observeConnect, observeDeniedRpc: seen.observeDeniedRpc, requestUpstream: calls.requestUpstream,',
      ['          observeConnect: seen.observeConnect,',
        '          observeDeniedRpc(event) {',
        '            generationDeniedAfterQuota200 ||= afterQuota200(calls.summary(), event);',
        '            seen.observeDeniedRpc(event);',
        '          },',
        '          requestUpstream: calls.requestUpstream,'].join('\n')],
    ['  const evidence = { phase, refusedPublication, resultCallbackReached,',
      '  const evidence = { phase, refusedPublication, resultCallbackReached, generationDeniedAfterQuota200, eligibilityFailed,'],
    ['  const passed = qualifies(evidence);',
      '  const passed = qualifies(evidence) && generationDeniedAfterQuota200 &&\n' +
        '    !evidence.denied.some(({ label, queryPresent }) => label === "quota-summary" && queryPresent);'],
    ['  const broker = await helper.agyGoogleBroker(directory, {\n    observeConnect: seen.observeConnect, observeDeniedRpc: seen.observeDeniedRpc, requestUpstream: calls.requestUpstream,',
      ['  const ordering = [];',
        '  const broker = await helper.agyGoogleBroker(directory, {',
        '    observeConnect: seen.observeConnect,',
        '    observeDeniedRpc(event) {',
        '      if (event.generationDenied) ordering.push(afterQuota200(calls.summary(), event));',
        '      seen.observeDeniedRpc(event);',
        '    },',
        '    requestUpstream: calls.requestUpstream,'].join('\n')],
    ["    console.log('fake-only exact bodyless GETs, dual generation blocks, dispatch counts and auth proof passed');",
      [
        "    const quotaPath = '" + quota + "';",
        "    assert.equal(await send(cloud, 'POST', quotaPath + '?fixture=private'), 403);",
        "    assert.equal(await send(cloud, 'GET', quotaPath), 403);",
        "    assert.equal(await send(cloud, 'POST', '/v1internal:fetchAdminControls'), 403);",
        "    assert.equal(await send(cloud, 'POST', '/v1internal:fetchUserInfo'), 403);",
        '    assert.equal(requests, 2);',
        '    assert.deepEqual(ordering, [false, false, false]);',
        "    assert.equal(await send(cloud, 'POST', quotaPath), 200);",
        "    assert.equal(await send(cloud, 'POST', generation[0]), 403);",
        '    assert.deepEqual(ordering, [false, false, false, true]);',
        '    assert.equal(requests, 3);',
        "    assert.deepEqual(calls.summary().dispatches['quota-summary'], { count: 1, statuses: { 200: 1 } });",
        '    assert.equal(calls.summary().forwardedInference, 0);',
        "    assert.equal(afterQuota200({ dispatches: { 'quota-summary': { statuses: { 403: 1 } } } }, { generationDenied: true }), false);",
        "    assert.ok(seen.summary().denied.some((event) => event.label === 'quota-summary' && event.queryPresent));",
        "    assert.doesNotMatch(JSON.stringify(seen.summary()), /fixture|private/);",
        "    assert.equal(failedEligibility('Eligibility check failed: withheld'), true);",
        "    assert.equal(failedEligibility('eligibility check failed: withheld'), true);",
        "    console.log('fake-only exact quota POST, denial ordering, query redaction and zero generation passed');",
      ].join('\n')],
  ];
  for (const [before, after] of changes) text = replace(text, before, after);
  return { text, connectPath };
}

function traceVariant(variant) {
  let text = source(trace, digests[0]);
  for (const [name, file] of [
    ['./laptop-bootstrap-control.mjs', bootstrap],
    ['./auth-template-trace.mjs', new URL('./auth-template-trace.mjs', trace)],
    ['./auth-decision-trace.mjs', new URL('./auth-decision-trace.mjs', trace)],
    ['../../../tools/agy-builder.mjs', new URL('../../../tools/agy-builder.mjs', trace)],
  ]) text = replace(text, "new URL('" + name + "', import.meta.url)", 'new URL(' + JSON.stringify(file.href) + ')');
  const ask = '../../../tools/ask-model.mjs';
  text = replace(text, "import { readAnswer } from '" + ask + "';",
    'import { readAnswer } from ' + JSON.stringify(new URL(ask, trace).href) + ';');
  const bootLine = text.split('\n').find((line) => line.startsWith('  let source = lockedSource(original, digests[0], '));
  if (!bootLine) throw new Error('quota trace bootstrap seam changed');
  text = replace(text, bootLine, '  let source = ' + JSON.stringify(variant.text) + ';');
  text = replace(text, "JSON.stringify(new URL('./connect-diagnostic.mjs', original).href)",
    'JSON.stringify(' + JSON.stringify(variant.connectPath) + ')');
  text = replace(text, 'printReply = trace.reply(requested, reply);',
    'printReply = trace.reply(requested, reply);\\n' +
      '        eligibilityFailed ||= failedEligibility(String(reply.stdout ?? "") + String(reply.stderr ?? ""));');
  return text;
}

const [mode, familyFlag, family, ...extra] = process.argv.slice(2);
if (!mode) {
  console.log(JSON.stringify({ mode: 'disabled', childLaunches: 0 }));
} else if ((mode === '--self-test' && !familyFlag) ||
    (mode === '--observe-quota-bootstrap' && familyFlag === '--family' && family && !extra.length)) {
  const directory = fs.mkdtempSync('/private/tmp/acs-agy-laptop-quota-control-');
  const previous = process.argv;
  try {
    const connectSource = connectVariant();
    const connectFile = path.join(directory, 'quota-connect-source.mjs');
    fs.writeFileSync(connectFile, connectSource, { mode: 0o600, flag: 'wx' });
    const variant = bootstrapVariant(pathToFileURL(connectFile).href, sha(connectSource));
    const file = path.join(directory, 'quota-trace.mjs');
    fs.writeFileSync(file, traceVariant(variant), { mode: 0o600, flag: 'wx' });
    process.argv = mode === '--self-test' ? [previous[0], file, '--self-test'] :
      [previous[0], file, '--trace-laptop-bootstrap', '--family', family];
    await import(pathToFileURL(file).href);
  } catch {
    process.stderr.write('Quota bootstrap control failed a local safety check.\n');
    process.exitCode = 1;
  } finally {
    process.argv = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  }
} else {
  process.stderr.write('usage: laptop-quota-bootstrap-control.mjs --self-test | --observe-quota-bootstrap --family <family>\n');
  process.exitCode = 64;
}
