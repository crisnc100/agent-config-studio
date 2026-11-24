import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const baselineFile = new URL('./auth-bootstrap-controls.mjs', import.meta.url);
const baselineDigest = 'be6624573630fad70dbdbb17cbef3d75465ba40508a96ad520fa0e32c415946e';
const productionHelper = new URL('../../../tools/agy-builder.mjs', baselineFile).href;
const askModel = new URL('../../../tools/ask-model.mjs', baselineFile).href;
const metadataRule = '(allow file-read-metadata (literal (string-append (param "HOME") "/Library/Keychains")))';
const profileAnchor = "    '(allow file-read-metadata (apply path-ancestors ";

function replaceOne(source, before, after) {
  if (source.split(before).length !== 2) throw new Error('baseline or profile anchor changed');
  return source.replace(before, () => after);
}

function modifiedBaseline() {
  const bytes = fs.readFileSync(baselineFile);
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== baselineDigest) throw new Error('baseline script changed');
  const helperReplacements = [
    profileAnchor,
    '    ' + JSON.stringify(metadataRule) + ',\n' + profileAnchor,
  ];
  const selfTest = [
    'async function selfTest(helper, directory) {',
    '  const baseline = await import(' + JSON.stringify(productionHelper) + ');',
    '  const params = { source: "/fixture/source", runtime: "/fixture/runtime", certificate: "/fixture/ca",',
    '    bin: "/fixture/agy", home: "/fixture/home", port: 42402 };',
    '  const command = ["/usr/bin/security", "default-keychain", "-d", "user"];',
    '  const expected = baseline.agyBuildWall(params, command);',
    '  const profile = expected.indexOf("-p") + 1;',
    '  const lines = expected[profile].split("\\n");',
    '  const before = lines.findIndex((line) => line.startsWith("(allow file-read-metadata (apply path-ancestors "));',
    '  assert.ok(before >= 0);',
    '  lines.splice(before, 0, ' + JSON.stringify(metadataRule) + ');',
    '  expected[profile] = lines.join("\\n");',
    '  assert.deepEqual(helper.agyBuildWall(params, command), expected);',
  ].join('\n');
  const replacements = [
    ["from '../../../tools/ask-model.mjs';", 'from ' + JSON.stringify(askModel) + ';'],
    ["new URL('../../../tools/agy-builder.mjs', import.meta.url)", 'new URL(' + JSON.stringify(productionHelper) + ')'],
    ["  const file = path.join(directory, 'auth-bootstrap-helper.mjs');",
      '  replacements.push(' + JSON.stringify(helperReplacements) + ');\n' +
        "  const file = path.join(directory, 'auth-bootstrap-helper.mjs');"],
    ['async function selfTest(helper, directory) {', selfTest],
    ["{ mode: 'metadata-only', modelsCliLaunches: 1, privateInputsPinned,",
      "{ mode: 'metadata-only', profileVariant: 'keychain-directory-metadata', modelsCliLaunches: 1, privateInputsPinned,"],
  ];
  return replacements.reduce((source, [before, after]) => replaceOne(source, before, after), bytes.toString('utf8'));
}

const args = process.argv.slice(2);
if (!args.length) {
  console.log(JSON.stringify({ mode: 'disabled', childLaunches: 0 }));
} else if (args.length === 1 && ['--self-test', '--observe-keychain-directory-metadata'].includes(args[0])) {
  const root = fs.mkdtempSync('/private/tmp/acs-agy-keychain-directory-control-');
  const originalArgv = process.argv;
  try {
    const variant = path.join(root, 'bootstrap-variant.mjs');
    fs.writeFileSync(variant, modifiedBaseline(), { mode: 0o600, flag: 'wx' });
    const option = args[0] === '--self-test' ? '--self-test' : '--observe-bootstrap';
    process.argv = [originalArgv[0], variant, option];
    await import(pathToFileURL(variant).href);
  } catch {
    process.stderr.write('Keychain directory metadata control failed a local safety check.\n');
    process.exitCode = 1;
  } finally {
    process.argv = originalArgv;
    fs.rmSync(root, { recursive: true, force: true });
  }
} else {
  process.stderr.write('usage: auth-keychain-directory-control.mjs --self-test | --observe-keychain-directory-metadata\n');
  process.exitCode = 64;
}
