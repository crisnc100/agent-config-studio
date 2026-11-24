import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const baselineFile = new URL('./auth-factor-ladder.mjs', import.meta.url);
const baselineDigest = '12b7e7344f6f9e25048a8f487007dd31d94d19b0656dd9d54b56375e240d8538';
const builderUrl = new URL('../../../tools/agy-builder.mjs', baselineFile).href;
const askModelUrl = new URL('../../../tools/ask-model.mjs', baselineFile).href;

function replaceOne(source, before, after) {
  if (source.split(before).length !== 2) throw new Error('paired control anchor changed');
  return source.replace(before, () => after);
}

function replaceBetween(source, start, end, replacement) {
  const begin = source.indexOf(start);
  const finish = source.indexOf(end, begin + start.length);
  if (begin < 0 || finish < 0 || source.split(start).length !== 2 || source.split(end).length !== 2) {
    throw new Error('paired control span changed');
  }
  return source.slice(0, begin) + replacement + source.slice(finish);
}

function modifiedLadder() {
  const bytes = fs.readFileSync(baselineFile);
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== baselineDigest) throw new Error('ladder baseline changed');
  let source = bytes.toString('utf8');
  source = replaceOne(source, "from '../../../tools/ask-model.mjs';", 'from ' + JSON.stringify(askModelUrl) + ';');
  for (const name of ['auth-bootstrap-controls.mjs', 'auth-normal-home-control.mjs']) {
    const relative = './' + name;
    source = replaceOne(source, "new URL('" + relative + "', import.meta.url)",
      'new URL(' + JSON.stringify(new URL(relative, baselineFile).href) + ')');
  }

  const paired = [
    'const arms = [',
    "  { name: 'private-read-only-wall', proxy: true, privateHome: true, strict: false },",
    "  { name: 'private-builder-wall', proxy: true, privateHome: true, strict: true },",
    '];',
    "const seedNames = ['installation_id', 'jetski_state.pbtxt', 'default_project_id.txt', 'onboarding.json', 'settings.json'];",
    '',
    'function samePrivateInputs(a, b) {',
    '  return Boolean(a.aliasMatches && b.aliasMatches && a.login === b.login &&',
    '    a.seeds.length === seedNames.length && b.seeds.length === seedNames.length &&',
    '    a.seeds.every((seed, index) => seed === b.seeds[index]));',
    '}',
    '',
    'function preparePairedInputs({ builder, bootstrap }, directory, home) {',
    '  const prepared = arms.map((arm) => {',
    '    const input = path.join(directory, arm.name);',
    '    fs.mkdirSync(input, { mode: 0o700 });',
    '    const layout = builder.agyBuildLayout(input);',
    "    if (agyTokenLeft(home) || agyTokenLeft(layout.privateHome)) throw new Error('private plaintext preflight refused');",
    '    builder.seedAgyState(home, layout.privateHome);',
    "    fs.mkdirSync(path.join(layout.privateHome, 'Library'), { mode: 0o700 });",
    "    fs.symlinkSync(path.join(home, 'Library', 'Keychains'), path.join(layout.privateHome, 'Library', 'Keychains'));",
    '    return { ...arm, input, layout, privateBefore: bootstrap.privateInputs(layout, home) };',
    '  });',
    '  if (!samePrivateInputs(prepared[0].privateBefore, prepared[1].privateBefore)) {',
    "    throw new Error('fresh private HOME inputs do not match');",
    '  }',
    '  return prepared;',
    '}',
    '',
    'function modelsArgs({ builder, normal }, arm, params, runtime, broker, command) {',
    '  if (!arm.strict) return normal.walled(params, command);',
    '  return builder.agyBuildWall({ source: params.ROOT, runtime, certificate: broker.certificate,',
    '    bin: params.AGY, home: params.HOME, port: broker.port }, command);',
    '}',
  ].join('\n');
  source = replaceBetween(source, 'const arms = [', '\n\nfunction replaceOne', paired);

  const preflight = [
    '  const { input, layout, privateBefore } = arm;',
    '  if (agyWallProblem() || checks.agyWorkspaceFiles(root).length || checks.agyConfigProblem(actualHome) ||',
    '      agyTokenLeft(actualHome) || agyTokenLeft(layout.privateHome) ||',
    '      fs.realpathSync.native(bin) !== bin || fileStamp(bin) !== binaryStamp ||',
    '      !samePrivateInputs(privateBefore, bootstrap.privateInputs(layout, actualHome))) {',
    "    throw new Error('paired wall preflight refused');",
    '  }',
    '',
  ].join('\n');
  source = replaceBetween(source, '  const input = path.join(directory, arm.name);\n  fs.mkdirSync(input, { mode: 0o700 });',
    '\n  let broker;', preflight);
  source = replaceOne(source,
    '    const result = await normal.launch(normal.walled(params, normal.modelsCommand(bin, root, logFile)), root, env);',
    '    const command = normal.modelsCommand(bin, root, logFile);\n' +
    '    const result = await normal.launch(modelsArgs(helpers, arm, params, layout.runtime, broker, command), root, env);');
  source = replaceOne(source, '      plaintextAbsent, cleanPostflight, aliasMatchesAfter, seedsMatchAfter, ...auth,',
    '      plaintextAbsent, cleanPostflight, aliasMatchesAfter, seedsMatchAfter, ...auth,\n' +
    '      seedsChangedAfter: Object.fromEntries(seedNames.map((name, index) =>\n' +
    '        [name, privateBefore.seeds[index] !== privateAfter.seeds[index]])),');
  source = replaceOne(source, '  const observed = [];\n  let preflightFailedAt = null;\n  for (const arm of arms) {',
    '  if (agyWallProblem() || helpers.checks.agyWorkspaceFiles(root).length || helpers.checks.agyConfigProblem(actualHome)) {\n' +
    "    throw new Error('paired layout customization preflight refused');\n" +
    '  }\n' +
    '  const prepared = preparePairedInputs(helpers, directory, actualHome);\n' +
    '  const observed = [];\n  let preflightFailedAt = null;\n  for (const arm of prepared) {');
  source = replaceOne(source, "{ mode: 'metadata-factor-ladder', originalPinVerified: true,",
    "{ mode: 'paired-private-walls', originalPinVerified: true, freshPrivateInputsMatched: true,");

  const fakeAssertions = [
    '  normal.selfTest(checks);',
    '  const production = await import(' + JSON.stringify(builderUrl) + ');',
    '  const params = { ROOT: "/fixture/root", CALL_TMP: "/fixture/tmp", LOG: "/fixture/tmp/log", AGY: "/fixture/installed/agy",',
    '    HOME: "/fixture/operator", TMP: "/fixture/temp", USER_TMP: "/fixture/user-tmp" };',
    '  const runtime = "/fixture/private/runtime";',
    '  const broker = { certificate: "/fixture/ca", port: 42402 };',
    '  const command = normal.modelsCommand(params.AGY, params.ROOT, params.LOG);',
    '  assert.deepEqual(modelsArgs(helpers, arms[0], params, runtime, broker, command), normal.walled(params, command));',
    '  const strict = modelsArgs(helpers, arms[1], params, runtime, broker, command);',
    '  assert.deepEqual(strict, production.agyBuildWall({ source: params.ROOT, runtime, certificate: broker.certificate,',
    '    bin: params.AGY, home: params.HOME, port: broker.port }, command));',
    '  assert.deepEqual(strict.slice(-command.length), command);',
    '  const inputs = { aliasMatches: true, login: "/fixture/login-db", seeds: ["a", "b", "c", "d", "e"] };',
    '  assert.equal(samePrivateInputs(inputs, { ...inputs }), true);',
    '  assert.equal(samePrivateInputs(inputs, { ...inputs, seeds: ["a", "b", "c", "d", "f"] }), false);',
    '  assert.equal(samePrivateInputs(inputs, { ...inputs, aliasMatches: false }), false);',
    '  console.log("fake-only paired argv, stock/production profiles and seed identity controls passed");',
  ].join('\n');
  return replaceOne(source, '  normal.selfTest(checks);', fakeAssertions);
}

const args = process.argv.slice(2);
if (!args.length) {
  console.log(JSON.stringify({ mode: 'disabled', childLaunches: 0 }));
} else if (args.length === 1 && ['--self-test', '--observe-wall-pair'].includes(args[0])) {
  const root = fs.mkdtempSync('/private/tmp/acs-agy-wall-pair-control-');
  const originalArgv = process.argv;
  try {
    const variant = path.join(root, 'wall-pair-variant.mjs');
    fs.writeFileSync(variant, modifiedLadder(), { mode: 0o600, flag: 'wx' });
    const option = args[0] === '--self-test' ? '--self-test' : '--observe-auth-factors';
    process.argv = [originalArgv[0], variant, option];
    await import(pathToFileURL(variant).href);
  } catch {
    process.stderr.write('Auth wall pair failed a local safety check.\n');
    process.exitCode = 1;
  } finally {
    process.argv = originalArgv;
    fs.rmSync(root, { recursive: true, force: true });
  }
} else {
  process.stderr.write('usage: auth-wall-pair-control.mjs --self-test | --observe-wall-pair\n');
  process.exitCode = 64;
}
