import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { agyBuildEnv, agyBuildWall, agyGoogleBroker } from './transport.mjs';
import { agyAfterCall, agyTokenLeft } from '../../../tools/ask-model.mjs';

const home = fs.realpathSync.native(os.homedir());
const bin = fs.realpathSync.native(path.join(home, '.local/bin/agy'));
const directory = fs.mkdtempSync(path.join(path.dirname(new URL(import.meta.url).pathname), '.listener-'));
const runtime = path.join(directory, 'runtime');
const source = path.join(directory, 'source');
const ca = path.join(directory, 'ca');
const logFile = path.join(runtime, 'agy.log');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const seen = new Map();
const external = Object.values(os.networkInterfaces()).flat().filter((v) => v && !v.internal && v.family === 'IPv4');
let broker;
let child;
let finished = false;

function descendants(pid) {
  const result = spawnSync('/bin/ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8', timeout: 2000 });
  const rows = result.stdout.trim().split('\n').map((s) => s.trim().split(/\s+/).map(Number));
  const ids = new Set([pid]);
  let changed;
  do {
    changed = false;
    for (const [id, parent] of rows) if (ids.has(parent) && !ids.has(id)) { ids.add(id); changed = true; }
  } while (changed);
  return ids;
}

function listeners(ids) {
  const result = spawnSync('/usr/sbin/lsof', ['-nP', '-a', '-p', [...ids].join(','), '-iTCP', '-sTCP:LISTEN', '-Fpcn'], { encoding: 'utf8', timeout: 3000 });
  const rows = [];
  let pid, command;
  for (const line of result.stdout.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    if (line.startsWith('c')) command = line.slice(1);
    if (line.startsWith('n') && ids.has(pid)) {
      const endpoint = line.slice(1);
      const port = Number(/:(\d+)$/.exec(endpoint)?.[1]);
      if (port) rows.push({ pid, command, endpoint, port });
    }
  }
  return rows;
}

async function connect(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (connected, code) => { socket.destroy(); resolve({ connected, ...(code && { code }) }); };
    socket.setTimeout(400, () => done(false, 'TIMEOUT'));
    socket.once('error', (error) => done(false, error.code));
    socket.once('connect', () => done(true));
  });
}

try {
  for (const d of [runtime, source, ca]) fs.mkdirSync(d, { mode: 0o700 });
  if (agyTokenLeft(home)) throw new Error('plaintext token preflight refused');
  const version = spawnSync(bin, ['--version'], { cwd: source, env: { HOME: home, PATH: '/usr/bin:/bin', AGY_CLI_DISABLE_AUTO_UPDATE: 'true' }, encoding: 'utf8', timeout: 5000 });
  if (version.status !== 0 || version.stdout.trim() !== '1.5.14') throw new Error('unexpected agy version');
  // Holding metadata responses keeps the real startup listener alive long enough to observe it.
  broker = await agyGoogleBroker(ca, { requestUpstream: (options, callback) => https.request(options, (response) => setTimeout(() => callback(response), 1800)) });
  const params = { source, runtime, certificate: broker.certificate, bin, home, port: broker.port };
  child = spawn('/usr/bin/sandbox-exec', agyBuildWall(params, [bin, '--log-file', logFile, '--output-format', 'json', 'models']), {
    cwd: source, env: agyBuildEnv({ home, runtime, broker }), stdio: ['ignore', 'pipe', 'pipe'], timeout: 25000,
  });
  const chunks = [];
  child.stdout.on('data', (buffer) => chunks.push(buffer));
  child.stderr.resume();
  const completion = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => { finished = true; resolve({ code, signal }); });
  });
  let observations = 0;
  while (!finished) {
    const ids = descendants(child.pid);
    for (const row of listeners(ids)) {
      const key = `${row.pid}:${row.endpoint}`;
      if (seen.has(key)) continue;
      const scope = /^(127\.|\[?::1\]?:)/.test(row.endpoint) ? 'loopback' : row.endpoint.startsWith('*:') ? 'wildcard' : 'non-loopback';
      const probes = [];
      for (const candidate of external) probes.push({ via: 'non-loopback IPv4', ...await connect(candidate.address, row.port) });
      seen.set(key, { process: row.command, scope, port: row.port, probes });
    }
    observations++;
    if (!finished) await delay(100);
  }
  const result = await completion;
  let reply;
  try { reply = JSON.parse(Buffer.concat(chunks).toString()); } catch {}
  const records = [...seen.values()];
  const evidence = { ...result, version: version.stdout.trim(), turns: reply?.num_turns, status: reply?.status,
    observations, listeners: records, externalInterfaces: external.length, cleanPostflight: !agyAfterCall(logFile, home), noPlaintext: !agyTokenLeft(home) };
  process.stdout.write(JSON.stringify(evidence, null, 2) + '\n');
  if (result.code !== 0 || reply?.num_turns !== 0 || !records.length || !external.length || !evidence.cleanPostflight || !evidence.noPlaintext) process.exitCode = 1;
} finally {
  child?.kill();
  broker?.close();
  fs.rmSync(directory, { recursive: true, force: true });
}
