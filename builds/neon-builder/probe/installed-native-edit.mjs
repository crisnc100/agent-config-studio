import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { agyTokenLeft } from '../../../tools/ask-model.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const home = os.homedir();
const id = execFileSync('model-id', ['neon'], { encoding: 'utf8' }).trim();
const scratch = fs.mkdtempSync('/private/tmp/acs-neon-installed-proof-');
const nonce = crypto.randomBytes(8).toString('hex');
const relative = `builds/neon-builder/probe/installed-native-edit-${nonce}.txt`;
const file = path.join(root, relative);
const expected = `neon-installed-builder-ok-${nonce}\n`;
const hash = (data) => crypto.createHash('sha256').update(data).digest('hex');
try {
  if (agyTokenLeft(home)) throw new Error('Native test refused an existing plaintext token');
  const installHome = path.join(scratch, 'install-home');
  fs.mkdirSync(installHome, { mode: 0o700 });
  execFileSync(process.execPath, [path.join(root, 'bin/model-id.mjs'), '--install'], {
    cwd: root, env: { HOME: installHome, PATH: process.env.PATH, LANG: 'en_US.UTF-8' }, stdio: 'pipe',
  });
  const launcher = path.join(installHome, '.local/bin/ask-model');
  const installed = fs.realpathSync.native(launcher);
  if (!installed.startsWith(installHome + path.sep)) throw new Error('Installed launcher escaped the fixture');
  const resolver = path.join(installHome, '.agent-config-studio/resolver/bin');
  const helpersAbsent = ['agy-builder.mjs', 'agy-builder-source.mjs'].every((name) => !fs.existsSync(path.join(resolver, name)));
  fs.writeFileSync(file, 'before\n', { flag: 'wx', mode: 0o600 });
  const promptFile = path.join(scratch, 'prompt.txt');
  fs.writeFileSync(promptFile, [
    'The operator explicitly authorizes this provisional native Neon builder test.',
    `Edit ONLY ${relative}; replace its contents with the exact line ${expected.trimEnd()} followed by one LF.`,
    'Use native file tools. Do not run shell or Git commands, delegate, review, push, merge, open a PR or inspect unrelated files.',
    'Stop after the edit and reply briefly.',
  ].join('\n'), { mode: 0o600 });
  console.log(`Installed ask-model --build proof: ${relative}; ${id} high, served model unverified.`);
  const out = [];
  const err = [];
  const child = spawn(launcher, ['--family', 'neon', '--build', '--cwd', root, '--effort', 'high',
    '--prompt-file', promptFile, '--json'], { cwd: root, env: process.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const stop = () => { try { process.kill(-child.pid, 'SIGTERM'); } catch {} };
  const timer = setTimeout(stop, 190000);
  child.stdout.on('data', (bytes) => out.push(bytes));
  child.stderr.on('data', (bytes) => err.push(bytes));
  const status = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  }).finally(() => clearTimeout(timer));
  let response;
  try { response = JSON.parse(Buffer.concat(out).toString()); } catch {}
  const bytes = fs.readFileSync(file);
  const result = { ...status, requested: id, effort: 'high', installedLauncher: true, helpersAbsent,
    nativeCompleted: response?.mode === 'build' && response?.build?.execution === 'native' && response?.build?.completed === true,
    noPublicationClaim: !!response?.build && !Object.hasOwn(response.build, 'published'),
    noBrokerClaim: !!response && !Object.hasOwn(response, 'brokerEvents'),
    unverified: response?.served?.verified === false && response?.served?.requested === id,
    cleanPostflight: !agyTokenLeft(home) && response?.error === null,
    successfulAnswer: typeof response?.answer === 'string' && !!response.answer.trim(), file: relative,
    expectedSha256: hash(expected), actualSha256: hash(bytes), exactEdit: bytes.equals(Buffer.from(expected)),
    labelPresent: Buffer.concat(err).toString().includes(`${id} was requested (unverified)`),
  };
  result.passed = status.code === 0 && !status.signal && ['helpersAbsent', 'nativeCompleted', 'noPublicationClaim', 'noBrokerClaim',
    'unverified', 'cleanPostflight', 'successfulAnswer', 'exactEdit', 'labelPresent'].every((key) => result[key] === true);
  fs.writeFileSync(path.join(root, 'builds/neon-builder/probe/installed-native-edit.result.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.passed ? 0 : 1;
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
