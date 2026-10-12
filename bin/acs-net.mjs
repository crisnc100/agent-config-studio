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
 *   acs-net.mjs run <port>      decodes the run file given on stdin and prints
 *                               "<pid> <nonce> token|legacy" (legacy: written by
 *                               a studio from before the stop token); exits 1
 *                               when it is not valid JSON of that shape
 *   acs-net.mjs stop <port>     asks the studio to stop itself with the run
 *                               file's stop token (run file on stdin). Exits 0
 *                               once the port is closed; 2 when /api/health does
 *                               not name that run file's pid and nonce (nothing
 *                               is sent); 3 when the studio refuses the token;
 *                               4 when it accepted but is still listening
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

/** The run file the studio writes at start (server.js), on stdin, decoded as JSON; null unless it has a pid and nonce. */
async function runFile() {
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  try {
    const r = JSON.parse(text);
    if (Number.isInteger(r?.pid) && r.pid > 0 && typeof r.nonce === 'string' && /^[0-9a-f]{32}$/.test(r.nonce)) return r;
  } catch {}
  return null;
}

/**
 * The studio's own stop: the token only the run file holds, sent to the
 * studio whose /api/health names that run file's pid and nonce. Nothing is
 * signalled from here; a studio that refuses, or a port that stays open,
 * is a failure.
 */
const hasToken = (r) => typeof r?.stopToken === 'string' && /^[0-9a-f]{64}$/.test(r.stopToken);

async function stopByToken() {
  const r = await runFile();
  if (!hasToken(r) || (await health()) !== `${r.pid} ${r.nonce}`) return 2;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/stop`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: r.stopToken }), signal: AbortSignal.timeout(3000),
    });
    if (!res.ok || (await res.json())?.stopping !== true) return 3;
  } catch { return 3; }
  for (let i = 0; i < 40; i++) {
    if (!(await accepts(250))) return 0;
    await new Promise((res) => setTimeout(res, 250));
  }
  return 4;
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
} else if (cmd === 'run') {
  const r = await runFile();
  if (r === null) process.exit(1);
  console.log(`${r.pid} ${r.nonce} ${hasToken(r) ? 'token' : 'legacy'}`);
} else if (cmd === 'stop') {
  process.exit(await stopByToken());
} else if (cmd === 'busy') {
  process.exit((await accepts()) ? 0 : 1);
} else if (cmd === 'wait') {
  for (let i = 0; i < 40; i++) {
    if (await accepts(250)) process.exit(0);
    await new Promise((r) => setTimeout(r, 250));
  }
  process.exit(1);
} else {
  console.error('usage: acs-net.mjs health|busy|wait|run|stop <port>');
  process.exit(2);
}
