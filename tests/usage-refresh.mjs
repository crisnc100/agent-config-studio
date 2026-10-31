/**
 * POST /api/usage/refresh coalesces (builds/model-roles R11): concurrent
 * callers share one child, and a child that fails or times out answers
 * `fresh: false` with the reason, never a successful-looking reading.
 * In-process with HOME redirected before any import, then through a real
 * server on the same kind of temp HOME. No credential exists to read.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshotRealHomes, assertRealHomesUnchanged } from './real-home.mjs';
import { tempDir, track } from './fixtures/cleanup.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const realBefore = snapshotRealHomes();
const home = fs.realpathSync(tempDir('acs-refresh-'));
process.env.HOME = home;
delete process.env.CODEX_HOME;
const { refreshSnapshot, refreshSpawns } = await import('../lib/usage/refresh.js');

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
console.log('\nusage refresh: one run, honest results');

{
  const before = refreshSpawns();
  const a = refreshSnapshot();
  const b = refreshSnapshot();
  ok('R11 two concurrent calls share one run', a === b);
  const [ra, rb] = await Promise.all([a, b]);
  ok('…and one spawn', refreshSpawns() - before === 1, `${refreshSpawns() - before} spawns`);
  ok('…both get the same answer, with when it was taken', ra === rb && typeof ra.at === 'number' && Array.isArray(ra.seats));
  ok('a child that exits 0 is fresh', ra.fresh === true && !('error' in ra), JSON.stringify(ra).slice(0, 200));
  const c = await refreshSnapshot();
  ok('once settled, the next call starts a new run', refreshSpawns() - before === 2 && c !== ra);
}
{
  const t = await refreshSnapshot({ timeoutMs: 1 });
  ok('R11 a child that times out → fresh: false with the reason', t.fresh === false && /timed out after/.test(t.error), JSON.stringify(t).slice(0, 200));
  ok('…still carrying the stored reading, labelled', Array.isArray(t.seats) && typeof t.at === 'number');
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
{
  const srvHome = fs.realpathSync(tempDir('acs-refresh-srv-'));
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT, env: { HOME: srvHome, PORT: String(port), PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, TMPDIR: os.tmpdir() }, stdio: 'ignore',
  }); track(child);
  const base = `http://localhost:${port}`;
  try {
    for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 100)); }
    const post = () => fetch(`${base}/api/usage/refresh`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then((r) => r.json());
    const [x, y] = await Promise.all([post(), post()]);
    ok('R11 through the server: two concurrent requests get one run (the same reading, the same `at`)', x.at === y.at && x.fresh === true && Array.isArray(x.seats), JSON.stringify([x.at, y.at, x.fresh]));
    const z = await post();
    ok('…and a later one runs again', z.at > x.at);
  } finally {
    child.kill('SIGKILL');
    fs.rmSync(srvHome, { recursive: true, force: true });
  }
}

assertRealHomesUnchanged(realBefore, ok);
fs.rmSync(home, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
