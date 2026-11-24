import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AGY_ENV, agyAfterCall, agyTokenLeft, readAnswer } from '../../../tools/ask-model.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const home = fs.realpathSync.native(os.homedir());
const family = 'neon';
const id = execFileSync('model-id', [family], { encoding: 'utf8' }).trim();
const nonce = crypto.randomBytes(8).toString('hex');
const relative = `builds/neon-builder/probe/native-edit-${nonce}.txt`;
const file = path.join(root, relative);
const expected = `neon-native-builder-ok-${nonce}\n`;
const scratch = fs.mkdtempSync('/private/tmp/acs-neon-native-edit-');
const log = path.join(scratch, 'agy.log');
const evidence = path.join(root, 'builds/neon-builder/probe/native-session-edit.result.json');
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
if (agyTokenLeft(home)) throw new Error('Native test refused an existing plaintext token');
fs.writeFileSync(file, 'before\n', { flag: 'wx', mode: 0o600 });
const prompt = [
  'You are the builder implementer for this one operator-approved native Antigravity test, not the orchestrator.',
  'The operator explicitly authorizes this provisional Neon builder test before adding Neon to the builder role.',
  `Your working directory is ${root}.`,
  `Edit ONLY ${relative}. Replace its contents with the exact line ${expected.trimEnd()} followed by one LF.`,
  'Use the native file editing tools. Do not run shell or Git commands, invoke another model, review, push, merge, or open a PR.',
  'Do not inspect or change unrelated files. Stop after the edit and give a short completion reply.',
].join('\n');
console.log(`Native Neon test: ${relative}; requested ${id} at high effort (served model unverified).`);
const out = [];
const err = [];
let child;
let result;
try {
  child = spawn('agy', ['--mode', 'accept-edits', '--model', id, '--effort', 'high',
    '--output-format', 'stream-json', '--print-timeout', '180s', '--log-file', log, '-p', prompt], {
    cwd: root, env: { ...process.env, ...AGY_ENV }, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stop = () => { try { if (child.pid) process.kill(-child.pid, 'SIGTERM'); } catch {} };
  const timer = setTimeout(stop, 190000);
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const signal of signals) process.on(signal, stop);
  child.stdout.on('data', (bytes) => out.push(bytes));
  child.stderr.on('data', (bytes) => err.push(bytes));
  const status = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  }).finally(() => {
    clearTimeout(timer);
    for (const signal of signals) process.off(signal, stop);
    stop();
  });
  const parsed = readAnswer('agy', id, { ...status, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() },
    null, { family, agyBuild: true });
  const bytes = fs.readFileSync(file);
  const postflight = !agyTokenLeft(home) && fs.existsSync(log) && !agyAfterCall(log, home);
  result = { requested: id, effort: 'high', nativePermissions: true, servedModelVerified: false,
    ...status, file: relative, beforeSha256: hash('before\n'), expectedSha256: hash(expected), actualSha256: hash(bytes),
    exactEdit: bytes.equals(Buffer.from(expected)), cleanPostflight: postflight,
    successfulAnswer: typeof parsed.answer === 'string' && !!parsed.answer.trim() && parsed.exit === undefined,
    actions: (parsed.actions ?? []).map(({ tool, state, refusal }) => ({ tool, state, ...(refusal && { refusal }) })),
  };
  result.passed = status.code === 0 && !status.signal && result.exactEdit && postflight && result.successfulAnswer;
  fs.writeFileSync(evidence, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.passed ? 0 : 1;
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
