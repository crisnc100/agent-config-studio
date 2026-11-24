import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { agyBuildWall } from './transport.mjs';
const nonLoopback = Object.values(os.networkInterfaces()).flat().find((item) => item.family === 'IPv4' && !item.internal);
if (!nonLoopback) throw new Error('no independent non-loopback adapter');
const work = fs.mkdtempSync(path.join(fs.realpathSync.native(path.dirname(new URL(import.meta.url).pathname)), '.wildcard-'));
const node = fs.realpathSync.native(process.execPath);
try {
  const code = `const net = require('node:net'); const server = net.createServer((s) => s.end('wildcard response')).listen(0, '0.0.0.0', () => console.log(server.address().port));`;
  const args = agyBuildWall({ source: work, runtime: work, certificate: work, bin: node, home: work, port: 29923 }, [node, '-e', code], { testExecutable: node });
  const child = spawn('/usr/bin/sandbox-exec', args, { cwd: work, env: { HOME: work, PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const port = await new Promise((resolve, reject) => {
      child.stdout.once('data', (data) => resolve(Number(data.toString().trim())));
      child.once('exit', (exit) => reject(new Error('child exited ' + exit)));
      child.stderr.on('data', (data) => process.stderr.write(data));
    });
    for (const [label, host] of [['loopback', '127.0.0.1'], ['non-loopback', nonLoopback.address]]) {
      const observed = await new Promise((resolve) => {
        const socket = net.connect({ host, port });
        socket.once('data', (bytes) => { resolve(bytes.toString()); socket.destroy(); });
        socket.once('error', (error) => resolve(error.code));
        socket.setTimeout(1500, () => { socket.destroy(); resolve('timeout'); });
      });
      console.log(label, observed);
      if (label === 'non-loopback' && observed === 'wildcard response') process.exitCode = 1;
    }
  } finally {
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('close', resolve));
  }
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
