import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { agyBuildLayout, agyBuildWall, prepareAgyLaunch } from '../../../tools/agy-builder.mjs';
import { agyAfterCall, agyTokenLeft } from '../../../tools/ask-model.mjs';

const home = fs.realpathSync.native(os.homedir());
const bin = path.join(home, '.local/bin/agy');
const directory = fs.mkdtempSync('/private/tmp/acs-agy-metadata-');
let launch;
try {
  const layout = agyBuildLayout(directory);
  if (agyTokenLeft(home) || agyTokenLeft(layout.privateHome)) throw new Error('plaintext token preflight refused');
  launch = await prepareAgyLaunch(layout, bin, home);
  const { params, env, broker } = launch;
  const logFile = path.join(layout.runtime, 'agy.log');
  const args = agyBuildWall(params, [params.bin, '--log-file', logFile, '--output-format', 'json', 'models']);
  const result = await new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/sandbox-exec', args, {
      cwd: layout.source, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 25000,
    });
    child.once('error', reject);
    child.once('exit', () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  let reply;
  try { reply = JSON.parse(result.stdout); } catch {}
  const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
  const evidence = {
    code: result.code, signal: result.signal, status: reply?.status, turns: reply?.num_turns,
    models: reply?.command?.data?.models?.length,
    keychainLoaded: /keyringAuth: loaded token/i.test(log),
    keychainAuthenticated: /authenticated via keyring/i.test(log),
    tokenExpired: /expired=true/i.test(log),
    cleanPostflight: !agyTokenLeft(home) && !agyAfterCall(logFile, layout.privateHome),
    blockedNativeSettingsUpdate: /failed to write validated settings[^\n]*operation not permitted/i.test(log),
    brokerEvents: broker.events,
  };
  process.stdout.write(JSON.stringify(evidence, null, 2) + '\n');
  if (evidence.code !== 0 || evidence.turns !== 0 || evidence.status !== 'SUCCESS' || !evidence.models ||
      !evidence.keychainLoaded || !evidence.keychainAuthenticated || !evidence.cleanPostflight) process.exitCode = 1;
} finally {
  launch?.broker.close();
  fs.rmSync(directory, { recursive: true, force: true });
}
