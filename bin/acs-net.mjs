#!/usr/bin/env node
/**
 * The launcher's port checks, in node rather than curl and lsof: node is the
 * one thing `acs` already needs, and a missing curl or lsof must never read as
 * "port free" (that would start a second server).
 *
 *   acs-net.mjs health <port>   prints "<pid> <nonce>" and exits 0 when the
 *                               studio answers there; exits 1 otherwise
 *   acs-net.mjs busy <port>     exits 0 when anything accepts a connection
 *   acs-net.mjs wait <port>     waits up to 10 s for the port to accept one
 *
 * The server listens on 127.0.0.1 only, so that is the address checked.
 */
import net from 'node:net';

const [cmd, portArg] = process.argv.slice(2);
const port = Number(portArg);
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error(`acs: not a port: ${portArg}`);
  process.exit(2);
}

function accepts(timeoutMs = 1000) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(timeoutMs, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

async function health() {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) });
    const j = await r.json();
    if (j?.app === 'agent-config-studio' && Number.isInteger(j.pid) && j.pid > 0) {
      return `${j.pid} ${typeof j.nonce === 'string' && /^[0-9a-f]{32}$/.test(j.nonce) ? j.nonce : '-'}`;
    }
  } catch {}
  return null;
}

if (cmd === 'health') {
  const pid = await health();
  if (pid === null) process.exit(1);
  console.log(pid);
} else if (cmd === 'busy') {
  process.exit((await accepts()) ? 0 : 1);
} else if (cmd === 'wait') {
  for (let i = 0; i < 40; i++) {
    if (await accepts(250)) process.exit(0);
    await new Promise((r) => setTimeout(r, 250));
  }
  process.exit(1);
} else {
  console.error('usage: acs-net.mjs health|busy|wait <port>');
  process.exit(2);
}
