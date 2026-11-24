import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { agyBuildEnv, agyBuildWall, agyGoogleBroker } from './transport.mjs';
import { agyAfterCall, agyTokenLeft } from '../../../tools/ask-model.mjs';

const home = fs.realpathSync.native(os.homedir());
const bin = fs.realpathSync.native(path.join(home, '.local/bin/agy'));
const root = fs.mkdtempSync(path.join(fs.realpathSync.native(path.dirname(new URL(import.meta.url).pathname)), '.metadata-'));
const runtime = path.join(root, 'runtime');
const source = path.join(root, 'source');
const certificateDir = path.join(root, 'ca');
const logFile = path.join(runtime, 'agy.log');
const mode = process.argv[2] ?? 'localhost-listener';
if (!['localhost-listener', 'bind-only', 'require-peer-localhost'].includes(mode)) throw new Error('invalid listener control');
const listenerRule = '(allow network-bind network-inbound (local tcp "localhost:*"))';
const listenerControls = {
  'bind-only': '(allow network-bind (local tcp "localhost:*"))',
  'require-peer-localhost': '(allow network-bind (local tcp "localhost:*")) (allow network-inbound (require-all (local tcp "localhost:*") (remote tcp "localhost:*")))',
};
let broker;
try {
  for (const dir of [runtime, source, certificateDir]) fs.mkdirSync(dir, { mode: 0o700 });
  if (agyTokenLeft(home)) throw new Error('plaintext token preflight refused');
  const version = spawnSync(bin, ['--version'], {
    cwd: source, env: { HOME: home, PATH: '/usr/bin:/bin', AGY_CLI_DISABLE_AUTO_UPDATE: 'true' },
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000,
  });
  if (version.status !== 0 || version.stdout.trim() !== '1.5.14') throw new Error('unexpected agy version');

  broker = await agyGoogleBroker(certificateDir);
  const params = { source, runtime, certificate: broker.certificate, bin, home, port: broker.port };
  const command = [bin, '--log-file', logFile, '--output-format', 'json', 'models'];
  const result = await new Promise((resolve, reject) => {
    const args = agyBuildWall(params, command);
    if (mode !== 'localhost-listener') {
      const profile = args.indexOf('-p') + 1;
      if (!args[profile].includes(listenerRule)) throw new Error('listener control does not match the probe profile');
      args[profile] = args[profile].replace(listenerRule, listenerControls[mode]);
    }
    const child = spawn('/usr/bin/sandbox-exec', args, {
      cwd: source, env: agyBuildEnv({ home, runtime, broker }), stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000,
    });
    const chunks = [];
    child.stdout.on('data', (buffer) => chunks.push(buffer));
    const errorChunks = [];
    child.stderr.on('data', (buffer) => errorChunks.push(buffer));
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, output: Buffer.concat(chunks).toString(), error: Buffer.concat(errorChunks).toString() }));
  });
  let reply;
  let log = '';
  try { reply = JSON.parse(result.output); } catch {}
  try { log = fs.readFileSync(logFile, 'utf8'); } catch {}
  const evidence = {
    mode, version: version.stdout.trim(),
    listenerDenied: /listen tcp[^\n]*operation not permitted/i.test(`${log}\n${result.error}`), code: result.code, signal: result.signal, command: reply?.command?.name,
    turns: reply?.num_turns, status: reply?.status, modelCount: reply?.command?.data?.models?.length,
    keyringLoaded: /keyringAuth: loaded token/i.test(log),
    keyringAuthenticated: /authenticated via keyring/i.test(log),
    tokenExpired: /expired=true/i.test(log),
    tokenRefreshed: /token refreshed/i.test(log),
    keyringSaveFailed: /failed keyring SaveToken/i.test(log),
    cleanPostflight: !agyAfterCall(logFile, home),
    noPlaintext: !agyTokenLeft(home), brokerEvents: broker.events,
  };
  process.stdout.write(JSON.stringify(evidence, null, 2) + '\n');
  if (result.code !== 0 || evidence.turns !== 0 || evidence.status !== 'SUCCESS' || !evidence.modelCount ||
    !evidence.keyringLoaded || !evidence.keyringAuthenticated || !evidence.cleanPostflight ||
    !evidence.brokerEvents.some((event) => event.path === '/v1internal:fetchAvailableModels' && event.status === 200)) {
    process.exitCode = 1;
  }
} finally {
  broker?.close();
  fs.rmSync(root, { recursive: true, force: true });
}
