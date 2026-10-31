/**
 * A frozen studio never stays frozen (builds/server-freeze criteria 2–5), in
 * temp HOMEs on free ports. Every process this suite starts gets a temp HOME.
 *
 * The freeze is the real one, not a stub: a preload (NODE_OPTIONS=--import,
 * so the command line stays exactly `node <checkout>/server.js`) answers
 * SIGUSR2 by opening a FIFO nobody writes, which parks one thread of the
 * pool. With UV_THREADPOOL_SIZE=1 that is the whole pool: no async fs call
 * completes while timers and HTTP still run — the 2026-10-24 symptom. With
 * the default four, three workers stay free, and process.exit still hangs
 * joining the parked one — the 2026-10-22 shape.
 *
 *   2  /api/health?deep=1 answers only once an async fs call completes; the
 *      plain probe's body is unchanged;
 *   3  `acs` replaces this install's frozen studio (SIGTERM, then SIGKILL when
 *      it ignores that) — launched from a node path with a space or a binary
 *      not named node too — leaves a healthy one and any unproven listener
 *      alone, `acs stop` SIGKILLs a proven studio that outlives its stop, and
 *      no signal goes to a pid whose start time changed since it was proven;
 *   4  the watchdog kills a studio whose probes stop completing, stub or real,
 *      and never one whose probe is merely late or slow;
 *   5  SIGTERM/SIGINT stop a healthy studio, SIGHUP (a closed terminal) does
 *      not stop it at all, and a stop never hangs — with a worker blocked for
 *      good, or the whole pool parked.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { snapshotRealHomes, assertRealHomesUnchanged } from './real-home.mjs';
import { tempDir, track } from './fixtures/cleanup.mjs';

const ROOT = fs.realpathSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const ACS = path.join(ROOT, 'bin', 'acs');
const SERVER = path.join(ROOT, 'server.js');
const realBefore = snapshotRealHomes();
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const sb = fs.realpathSync(tempDir('acs-liveness-'));
const scratchHome = path.join(sb, 'home-helpers');
fs.mkdirSync(scratchHome);
const which = (c) => spawnSync('/bin/sh', ['-c', `command -v ${c}`], { env: { PATH: process.env.PATH, HOME: scratchHome }, encoding: 'utf8' }).stdout.trim();
const tools = path.join(sb, 'tools');
fs.mkdirSync(tools);
fs.symlinkSync(process.execPath, path.join(tools, 'node'));
for (const t of ['dirname', 'readlink', 'git', 'ps', 'sed']) fs.symlinkSync(which(t), path.join(tools, t));
// The same, but ps says the pid started later once it has answered lstart
// truthfully REUSE_AFTER times (one by default): the kernel handed the
// proven pid to a new process with the same argv.
const reused = path.join(sb, 'tools-reused');
const REUSE_STATE = path.join(sb, 'lstart-asked');
const REUSE_AFTER = path.join(sb, 'lstart-true-answers');
fs.mkdirSync(reused);
for (const t of ['node', 'dirname', 'readlink', 'git', 'sed']) fs.symlinkSync(fs.readlinkSync(path.join(tools, t)), path.join(reused, t));
fs.writeFileSync(path.join(reused, 'ps'), [
  '#!/bin/sh',
  'case " $* " in',
  "  *' -o lstart= '*)",
  // Shell builtins only: this PATH has no cat.
  `    n=0; [ -e '${REUSE_STATE}' ] && read -r n < '${REUSE_STATE}'; n=$((n + 1)); echo "$n" > '${REUSE_STATE}'`,
  `    after=1; [ -e '${REUSE_AFTER}' ] && read -r after < '${REUSE_AFTER}'`,
  `    if [ "$n" -gt "$after" ]; then echo 'Mon Jan  1 00:00:00 2035'; exit 0; fi ;;`,
  'esac',
  `exec '${which('ps')}' "$@"`,
  '',
].join('\n'), { mode: 0o755 });
// Real node binaries under names the old argv check refused: a path with a
// space (fnm's macOS home) and a binary not named node.
const spacedNode = path.join(sb, 'Library', 'Application Support', 'fnm', 'node-versions', 'v0', 'installation', 'bin', 'node');
const otherName = path.join(sb, 'bin-renamed', 'nodejs-current');
for (const f of [spacedNode, otherName]) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.symlinkSync(process.execPath, f); }

const FIFO = path.join(sb, 'never-written');
spawnSync('mkfifo', [FIFO], { env: { PATH: process.env.PATH, HOME: scratchHome } });
const FREEZE = path.join(sb, 'freeze.mjs');
fs.writeFileSync(FREEZE, `import fs from 'node:fs';\nprocess.on('SIGUSR2', () => fs.open(${JSON.stringify(FIFO)}, 'r', () => {}));\n`);
// Signals the studio would stop on are caught and dropped, and its own
// handlers never install: only SIGKILL ends it.
const DEAF = path.join(sb, 'deaf.mjs');
fs.writeFileSync(DEAF, [
  'const on = process.on;',
  "for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP']) on.call(process, s, () => {});",
  'process.on = function (ev, fn) { return /^SIG(TERM|INT|HUP)$/.test(ev) ? this : on.call(this, ev, fn); };',
  '',
].join('\n'));
// startStudio in-process, with the watchdog's seam (FS_WATCHDOG) set per mode.
const WRAPPER = path.join(sb, 'wrapper.mjs');
fs.writeFileSync(WRAPPER, [
  "import fsp from 'node:fs/promises';",
  `import { FS_WATCHDOG, startStudio } from ${JSON.stringify(pathToFileURL(SERVER).href)};`,
  'const mode = process.env.LIVENESS_MODE;',
  "if (mode === 'stub') {",
  '  let hung = false;',
  "  process.on('SIGUSR2', () => { hung = true; });",
  "  FS_WATCHDOG.probe = () => (hung ? new Promise(() => {}) : fsp.stat('/'));",
  '}',
  "if (mode === 'stub' || mode === 'clock') Object.assign(FS_WATCHDOG, { everyMs: 200, timeoutMs: 500 });",
  '// One probe 80 ms late against a 30 ms deadline, then the real one.',
  "if (mode === 'late-once') {",
  '  let n = 0;',
  "  FS_WATCHDOG.probe = () => (n++ ? fsp.stat('/') : new Promise((r) => setTimeout(() => { process.stderr.write('late probe finished\\n'); r(); }, 80)));",
  '  Object.assign(FS_WATCHDOG, { everyMs: 100, timeoutMs: 30 });',
  '}',
  '// Every probe slower than the deadline (50 ms against 30), each one finite.',
  "if (mode === 'slow') Object.assign(FS_WATCHDOG, { probe: () => new Promise((r) => setTimeout(r, 50)), everyMs: 100, timeoutMs: 30 });",
  'await startStudio({ port: Number(process.env.PORT) });',
  '',
].join('\n'));

const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const busy = (port) => new Promise((resolve) => {
  const s = net.connect({ host: '127.0.0.1', port });
  const done = (v) => { s.destroy(); resolve(v); };
  s.setTimeout(1000, () => done(false));
  s.once('connect', () => done(true));
  s.once('error', () => done(false));
});
const get = async (port, p, ms = 2000) => {
  try {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { signal: AbortSignal.timeout(ms) });
    return { status: r.status, text: await r.text() };
  } catch { return null; }
};
const healthOf = async (port, q = '', ms = 2000) => { const r = await get(port, `/api/health${q}`, ms); try { return r && JSON.parse(r.text); } catch { return null; } };

let homes = 0;
const newHome = () => { const h = path.join(sb, `home-${++homes}`); fs.mkdirSync(h, { recursive: true }); return h; };
const live = [];
/**
 * A studio of this checkout, as `<node> <checkout>/server.js` (or the
 * wrapper), up and answering. `freeze` loads the FIFO preload; `pool` is
 * UV_THREADPOOL_SIZE (one, frozen, by default; null leaves node's four).
 */
async function studio({ port, home = newHome(), freeze = false, pool = freeze ? 1 : null, deaf = false, wrapper = null, node = process.execPath } = {}) {
  port ??= await freePort();
  const preload = [freeze && FREEZE, deaf && DEAF].filter(Boolean).map((f) => `--import ${f}`).join(' ');
  const env = { HOME: home, PORT: String(port), PATH: tools, TMPDIR: os.tmpdir(), ...(preload ? { NODE_OPTIONS: preload } : {}), ...(pool ? { UV_THREADPOOL_SIZE: String(pool) } : {}), ...(wrapper ? { LIVENESS_MODE: wrapper } : {}) };
  const child = spawn(node, [wrapper ? WRAPPER : SERVER], { cwd: '/', env, stdio: ['ignore', 'pipe', 'pipe'] }); track(child);
  const s = { child, port, home, out: '', err: '', exit: null, run: path.join(home, '.agent-config-studio', 'run', `${port}.json`) };
  child.stdout.on('data', (d) => { s.out += d; });
  child.stderr.on('data', (d) => { s.err += d; });
  s.exited = new Promise((res) => child.on('exit', (code, signal) => { s.exit = { code, signal }; res(s.exit); }));
  live.push(child);
  for (let i = 0; i < 150 && !s.exit && !(await healthOf(port)); i++) await sleep(100);
  s.pid = (await healthOf(port))?.pid;
  return s;
}
/** The exit within `ms`, or null while it still runs. */
const exitWithin = (s, ms) => Promise.race([s.exited, sleep(ms).then(() => null)]);
/** Park a pool thread (the preload's SIGUSR2), and give the open a moment to take it. */
async function freezeNow(s) {
  s.child.kill('SIGUSR2');
  await sleep(200);
}
const acsEnv = (port, home, PATH = tools) => ({ HOME: home, PATH, ACS_PORT: String(port), ACS_NO_UPDATE: '1', ACS_NO_OPEN: '1', TMPDIR: os.tmpdir() });
/** `acs <args>` run asynchronously, so every health answer the test's own studios give arrives. */
function acs(args, env) {
  const child = spawn('/bin/sh', [ACS, ...args], { cwd: sb, env, stdio: ['ignore', 'pipe', 'pipe'] }); track(child);
  const r = { child, out: '', code: null };
  child.stdout.on('data', (d) => { r.out += d; });
  child.stderr.on('data', (d) => { r.out += d; });
  r.done = new Promise((res) => child.on('exit', (code) => { r.code = code; res(r); }));
  live.push(child);
  return r;
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
/** An `acs` start that should exit: bounded, since one that wrongly starts a studio keeps running. */
const ended = (r, ms = 20000) => Promise.race([r.done, sleep(ms)]);
/** Run `acs` against a frozen studio and wait for a different pid to answer deep health. */
async function restart(s, env) {
  const a = acs([], env);
  let fresh = null;
  for (let i = 0; i < 300 && a.code === null; i++) {
    const h = await healthOf(s.port, '?deep=1', 1000);
    if (h && h.pid !== s.pid) { fresh = h; break; }
    await sleep(100);
  }
  return { a, fresh };
}
async function stopFresh(s, a) {
  const st = acs(['stop'], acsEnv(s.port, s.home));
  await st.done;
  await Promise.race([a.done, sleep(5000)]);
  return st.code === 0 && /stopped/.test(st.out) && a.code !== null && !(await busy(s.port));
}

try {
  console.log('\n2 deep health');
  {
    const s = await studio();
    const plain = await healthOf(s.port);
    ok('2 plain /api/health is unchanged: exactly app, pid, nonce', JSON.stringify(Object.keys(plain || {})) === '["app","pid","nonce"]' && plain.app === 'agent-config-studio' && plain.pid === s.child.pid && /^[0-9a-f]{32}$/.test(plain.nonce), JSON.stringify(plain));
    const t0 = Date.now();
    const deep = await healthOf(s.port, '?deep=1');
    ok('2 /api/health?deep=1 answers a healthy studio at once, with the same body', JSON.stringify(deep) === JSON.stringify(plain) && Date.now() - t0 < 1500, `${JSON.stringify(deep)} ${Date.now() - t0}ms`);
    s.child.kill('SIGTERM');
    await exitWithin(s, 5000);
  }
  {
    const s = await studio({ freeze: true });
    const before = await healthOf(s.port, '?deep=1');
    await freezeNow(s);
    const plain = await healthOf(s.port);
    const deep = await healthOf(s.port, '?deep=1', 3000);
    const page = await get(s.port, '/', 2000);
    ok('2 frozen (the pool parked): deep answered before the freeze', before?.pid === s.pid, JSON.stringify(before));
    ok('2 …plain /api/health still answers, same pid and nonce', plain?.pid === s.pid && plain?.nonce === before?.nonce, JSON.stringify(plain));
    ok('2 …deep does not answer within 3 s', deep === null, JSON.stringify(deep));
    ok('2 …and neither does a static page: the symptom deep catches', page === null, JSON.stringify(page));
    s.child.kill('SIGKILL');
    await s.exited;
  }

  console.log('\n3 acs replaces a frozen studio, and only its own');
  for (const deaf of [false, true]) {
    const s = await studio({ freeze: true, deaf });
    await freezeNow(s);
    const t0 = Date.now();
    const { a, fresh } = await restart(s, acsEnv(s.port, s.home));
    const what = deaf ? 'frozen and deaf to SIGTERM' : 'frozen';
    ok(`3 ${what}: acs says so in one line`, a.out.split('\n').filter((l) => l === 'acs: the running studio is frozen — restarting it').length === 1, a.out);
    ok(`3 …the frozen studio is gone${deaf ? ', by SIGKILL after the SIGTERM grace' : ''}`, s.exit !== null && !alive(s.pid) && (!deaf || (s.exit.signal === 'SIGKILL' && Date.now() - t0 >= 3000)), `${JSON.stringify(s.exit)} ${Date.now() - t0}ms`);
    if (!deaf) ok('3 …it took the SIGTERM and ended on it, its pool stuck, rather than hang in exit', s.exit?.signal === 'SIGTERM' && /stopped\./.test(s.out), `${JSON.stringify(s.exit)} ${s.err.slice(-300)}`);
    ok('3 …and a fresh studio answers deep health on the same port', fresh !== null && a.code === null, `${JSON.stringify(fresh)} ${a.out}`);
    ok('3 …which acs stop then stops, and the launcher exits', await stopFresh(s, a));
  }
  for (const [what, node] of [['a node path with a space (fnm\'s macOS home)', spacedNode], ['a node binary not named node', otherName]]) {
    const s = await studio({ freeze: true, node });
    await freezeNow(s);
    const { a, fresh } = await restart(s, acsEnv(s.port, s.home));
    ok(`3 frozen, launched from ${what}: proven and replaced`, /the running studio is frozen — restarting it/.test(a.out) && s.exit !== null && fresh !== null, `${JSON.stringify(s.exit)} ${a.out}`);
    await stopFresh(s, a);
    // A run file from before the stop token, the launch command kept: acs stop proves it by that command.
    const l = await studio({ node });
    const rf = JSON.parse(fs.readFileSync(l.run, 'utf8'));
    delete rf.stopToken;
    fs.writeFileSync(l.run, JSON.stringify(rf));
    const st = acs(['stop'], acsEnv(l.port, l.home));
    await st.done;
    ok(`3 …and acs stop proves and stops a legacy-run-file studio launched from ${what}`, st.code === 0 && /^stopped\.$/m.test(st.out) && (await exitWithin(l, 3000)) !== null, `${st.code} ${st.out}`);
  }
  {
    const s = await studio();
    const a = acs([], acsEnv(s.port, s.home));
    await ended(a);
    ok('3 a healthy studio is left running: "already running", same pid, no restart', a.code === 0 && /already running/.test(a.out) && !/frozen/.test(a.out) && (await healthOf(s.port))?.pid === s.pid, a.out);
    s.child.kill('SIGTERM');
    await exitWithin(s, 5000);
  }
  {
    // A listener that claims to be a studio, answers plain health, never deep,
    // and names a victim: an unrelated `node <someone-else>/server.js`.
    const otherDir = path.join(sb, 'someone-else');
    fs.mkdirSync(otherDir, { recursive: true });
    fs.writeFileSync(path.join(otherDir, 'server.js'), 'setTimeout(() => {}, 60000);\n');
    const liarJs = path.join(sb, 'frozen-liar.cjs');
    fs.writeFileSync(liarJs, [
      "const http = require('http');",
      'const [port, body] = process.argv.slice(2);',
      "http.createServer((req, res) => { if (req.url.includes('deep=1')) return; res.writeHead(200, { 'content-type': 'application/json' }); res.end(body); })",
      "  .listen(Number(port), '127.0.0.1', () => process.stdout.write('up\\n'));",
      '',
    ].join('\n'));
    const nonce = 'cd'.repeat(16);
    const otherServer = path.join(otherDir, 'server.js');
    for (const [what, runFile] of [
      ['no run file', null],
      ['a run file and nonce that match it', (pid) => ({ pid, nonce, server: otherServer, stopToken: 'ef'.repeat(32) })],
      ['a run file recording the victim\'s exact launch, another checkout\'s server.js', (pid) => ({ pid, nonce, server: otherServer, argv0: process.execPath, stopToken: 'ef'.repeat(32) })],
      ['a run file claiming this checkout\'s launch, which the victim\'s command line is not', (pid) => ({ pid, nonce, server: SERVER, argv0: process.execPath, stopToken: 'ef'.repeat(32) })],
    ]) {
      const port = await freePort();
      const home = newHome();
      const victim = spawn(process.execPath, [otherServer], { env: { HOME: home, PATH: tools }, stdio: 'ignore' }); track(victim);
      const liar = spawn(process.execPath, [liarJs, String(port), JSON.stringify({ app: 'agent-config-studio', pid: victim.pid, nonce })], { env: { HOME: home, PATH: tools }, stdio: ['ignore', 'pipe', 'inherit'] }); track(liar);
      live.push(victim, liar);
      await new Promise((r) => { liar.stdout.once('data', r); liar.once('exit', r); });
      if (runFile) {
        fs.mkdirSync(path.join(home, '.agent-config-studio', 'run'), { recursive: true });
        fs.writeFileSync(path.join(home, '.agent-config-studio', 'run', `${port}.json`), JSON.stringify(runFile(victim.pid)));
      }
      const a = acs([], acsEnv(port, home));
      await ended(a);
      ok(`3 a frozen listener that is not this install's proven start (${what}): left alone, as ever`, a.code === 0 && /already running/.test(a.out) && !/frozen|starting/.test(a.out) && alive(victim.pid) && liar.exitCode === null && await busy(port), `${a.code} ${a.out}`);
      victim.kill('SIGKILL');
      liar.kill('SIGKILL');
    }
  }
  {
    const s = await studio({ deaf: true });
    const t0 = Date.now();
    const st = acs(['stop'], acsEnv(s.port, s.home));
    await st.done;
    const gone = await exitWithin(s, 2000);
    ok('3 acs stop: a studio that accepts its token stop but keeps listening is SIGKILLed (proven pid)', st.code === 0 && /stopped \(it accepted the stop but kept listening, so it was killed\)/.test(st.out) && gone?.signal === 'SIGKILL' && !(await busy(s.port)), `${st.code} ${st.out} ${JSON.stringify(gone)} ${Date.now() - t0}ms`);
  }
  {
    const s = await studio({ deaf: true });
    // A run file from before the stop token: same pid and nonce, no token.
    const rf = JSON.parse(fs.readFileSync(s.run, 'utf8'));
    fs.writeFileSync(s.run, JSON.stringify({ pid: rf.pid, nonce: rf.nonce, server: rf.server }));
    const t0 = Date.now();
    const st = acs(['stop'], acsEnv(s.port, s.home));
    await st.done;
    const took = Date.now() - t0;
    const gone = await exitWithin(s, 2000);
    ok('3 acs stop, legacy run file: SIGTERM ignored, SIGKILL ~3 s later', st.code === 0 && /^stopped\.$/m.test(st.out) && gone?.signal === 'SIGKILL' && took >= 3000 && took < 8000 && !(await busy(s.port)), `${st.code} ${st.out} ${JSON.stringify(gone)} ${took}ms`);
  }
  {
    const s = await studio({ freeze: true });
    await freezeNow(s);
    const t0 = Date.now();
    const st = acs(['stop'], acsEnv(s.port, s.home));
    await st.done;
    ok('3 acs stop on a frozen studio: its token stop ends it (no exit hang)', st.code === 0 && /^stopped\.$/m.test(st.out) && (await exitWithin(s, 2000)) !== null && Date.now() - t0 < 6000, `${st.code} ${st.out} ${Date.now() - t0}ms`);
  }
  // The pid was proven, then its start time changed: the kernel reused it for
  // a process with the same command line. Nothing may be signalled.
  {
    const s = await studio();
    const rf = JSON.parse(fs.readFileSync(s.run, 'utf8'));
    delete rf.stopToken;
    fs.writeFileSync(s.run, JSON.stringify(rf));
    fs.rmSync(REUSE_STATE, { force: true });
    const st = acs(['stop'], acsEnv(s.port, s.home, reused));
    await st.done;
    ok('3 pid reused between proof and the first SIGTERM (legacy stop): no signal, and it says why', st.code === 1 && /no longer the process acs proved/.test(st.out) && fs.existsSync(REUSE_STATE) && (await exitWithin(s, 1500)) === null && (await healthOf(s.port))?.pid === s.pid, `${st.code} ${st.out}`);
    s.child.kill('SIGKILL');
  }
  {
    const s = await studio({ deaf: true });
    fs.rmSync(REUSE_STATE, { force: true });
    const st = acs(['stop'], acsEnv(s.port, s.home, reused));
    await st.done;
    ok('3 pid reused before the token stop\'s SIGKILL fallback: no SIGKILL', st.code === 1 && /accepted but is still listening/.test(st.out) && (await exitWithin(s, 1500)) === null && alive(s.child.pid), `${st.code} ${st.out}`);
    s.child.kill('SIGKILL');
  }
  {
    const s = await studio({ deaf: true });
    const rf = JSON.parse(fs.readFileSync(s.run, 'utf8'));
    delete rf.stopToken;
    fs.writeFileSync(s.run, JSON.stringify(rf));
    fs.rmSync(REUSE_STATE, { force: true });
    fs.writeFileSync(REUSE_AFTER, '2');
    const t0 = Date.now();
    const st = acs(['stop'], acsEnv(s.port, s.home, reused));
    await st.done;
    fs.rmSync(REUSE_AFTER, { force: true });
    ok('3 pid reused between the SIGTERM and its SIGKILL (legacy stop, SIGTERM ignored): no SIGKILL', Date.now() - t0 >= 3000 && (await exitWithin(s, 1500)) === null && alive(s.child.pid) && fs.readFileSync(REUSE_STATE, 'utf8').trim() === '3', `${st.code} ${st.out} ${JSON.stringify(s.exit)}`);
    s.child.kill('SIGKILL');
  }
  {
    const s = await studio({ freeze: true });
    await freezeNow(s);
    fs.rmSync(REUSE_STATE, { force: true });
    const a = acs([], acsEnv(s.port, s.home, reused));
    await ended(a);
    ok('3 pid reused before a frozen studio\'s SIGTERM: not signalled, nothing started', a.code === 1 && /no longer the process acs proved/.test(a.out) && !/starting Agent Config Studio/.test(a.out) && (await exitWithin(s, 1500)) === null && alive(s.child.pid), `${a.code} ${a.out} ${JSON.stringify(s.exit)}`);
    s.child.kill('SIGKILL');
  }

  console.log('\n4 the watchdog');
  {
    const s = await studio({ wrapper: 'stub' });
    ok('4 stub probe, short clock: the studio is up while its probe completes', !!s.pid && s.exit === null, s.err);
    await sleep(800);
    ok('4 …and stays up across several probes', s.exit === null && (await healthOf(s.port))?.pid === s.pid);
    s.child.kill('SIGUSR2');
    const t0 = Date.now();
    const gone = await exitWithin(s, 4000);
    ok('4 the probe never resolves: the studio kills itself with SIGKILL', gone?.signal === 'SIGKILL', `${JSON.stringify(gone)} ${Date.now() - t0}ms`);
    ok('4 …writing one line that names the reason', s.err.split('\n').filter((l) => /agent-config-studio: no async file operation completed in 1 s \(a probe, then a fresh one beside it\) — the thread pool is stuck — killing this studio \(pid \d+\) with SIGKILL/.test(l)).length === 1, s.err.slice(-300));
    ok('4 …and the port is free', !(await busy(s.port)));
  }
  {
    const s = await studio({ wrapper: 'late-once' });
    await sleep(1500);
    ok('4 one probe 80 ms late against a 30 ms deadline does not kill a healthy studio', s.exit === null && /late probe finished/.test(s.err) && (await healthOf(s.port, '?deep=1'))?.pid === s.pid, `${JSON.stringify(s.exit)} ${s.err.slice(-300)}`);
    s.child.kill('SIGKILL');
  }
  {
    const s = await studio({ wrapper: 'slow' });
    await sleep(1500);
    ok('4 every probe slower than the deadline (50 ms against 30), each finishing: never killed', s.exit === null && (await healthOf(s.port, '?deep=1'))?.pid === s.pid, `${JSON.stringify(s.exit)} ${s.err.slice(-300)}`);
    s.child.kill('SIGKILL');
  }
  {
    const s = await studio({ wrapper: 'clock', freeze: true });
    await sleep(800);
    ok('4 real probe, short clock: up and probing', s.exit === null && (await healthOf(s.port))?.pid === s.pid, s.err);
    await freezeNow(s);
    const gone = await exitWithin(s, 4000);
    ok('4 the pool parked for real: the default probe catches it and the studio SIGKILLs itself', gone?.signal === 'SIGKILL' && /no async file operation completed in 1 s/.test(s.err) && !(await busy(s.port)), `${JSON.stringify(gone)} ${s.err.slice(-300)}`);
  }
  {
    const s = await studio({ wrapper: 'clock' });
    await sleep(2000);
    ok('4 control: a healthy pool under the short clock is never killed', s.exit === null && (await healthOf(s.port))?.pid === s.pid, s.err);
    s.child.kill('SIGTERM');
    ok('4 …and SIGTERM stops it', (await exitWithin(s, 5000))?.signal === 'SIGTERM');
  }

  console.log('\n5 shutdown cannot hang');
  {
    const s = await studio();
    s.child.kill('SIGHUP');
    await sleep(1000);
    const deep = await healthOf(s.port, '?deep=1');
    ok('5 SIGHUP (the terminal that ran acs closed): the studio keeps running and answers deep health', s.exit === null && deep?.pid === s.pid, `${JSON.stringify(s.exit)} ${JSON.stringify(deep)} ${s.err.slice(-200)}`);
    s.child.kill('SIGTERM');
    const gone = await exitWithin(s, 5000);
    ok('5 …and SIGTERM still stops it: "stopped.", run file removed', gone?.signal === 'SIGTERM' && /stopped\./.test(s.out) && !fs.existsSync(s.run), JSON.stringify(gone));
  }
  {
    // Ctrl-C in the terminal that ran acs: SIGINT to the launcher's whole process group.
    const home = newHome();
    const port = await freePort();
    const l = spawn('/bin/sh', [ACS], { cwd: sb, env: acsEnv(port, home), stdio: ['ignore', 'pipe', 'pipe'], detached: true }); track(l, { group: true });
    let out = '';
    l.stdout.on('data', (d) => { out += d; });
    l.stderr.on('data', (d) => { out += d; });
    const exited = new Promise((res) => l.on('exit', (code, signal) => res({ code, signal })));
    live.push(l);
    for (let i = 0; i < 150 && !(await healthOf(port)); i++) await sleep(100);
    const up = (await healthOf(port))?.pid;
    process.kill(-l.pid, 'SIGINT');
    const gone = await Promise.race([exited, sleep(6000).then(() => null)]);
    const run = path.join(home, '.agent-config-studio', 'run', `${port}.json`);
    for (let i = 0; i < 30 && (await busy(port) || fs.existsSync(run) || !/stopped\./.test(out)); i++) await sleep(100);
    ok('5 Ctrl-C (SIGINT to the launcher\'s process group): the studio stops cleanly and acs exits 0', !!up && gone?.code === 0 && /stopped\./.test(out) && !fs.existsSync(run) && !(await busy(port)), `${JSON.stringify(gone)} ${out.slice(-300)}`);
  }
  for (const signal of ['SIGTERM', 'SIGINT']) {
    const s = await studio();
    const hadRun = fs.existsSync(s.run);
    s.child.kill(signal);
    const gone = await exitWithin(s, 5000);
    ok(`5 ${signal}: a healthy studio stops — "stopped.", its run file removed, ended by the ${signal} itself`, gone?.signal === signal && /stopped\./.test(s.out) && hadRun && !fs.existsSync(s.run) && !(await busy(s.port)), `${JSON.stringify(gone)} ${s.out.slice(-100)} ${s.err.slice(-200)}`);
  }
  {
    // The hazard is real on this node: one worker blocked for good, three free, and process.exit never returns.
    const probe = path.join(sb, 'exit-hangs.mjs');
    fs.writeFileSync(probe, "setTimeout(() => { process.kill(process.pid, 'SIGUSR2'); setTimeout(() => process.exit(0), 200); }, 100);\n");
    const c = spawn(process.execPath, [probe], { env: { HOME: newHome(), PATH: tools, NODE_OPTIONS: `--import ${FREEZE}` }, stdio: 'ignore' }); track(c);
    live.push(c);
    const exited = await Promise.race([new Promise((r) => c.once('exit', () => r(true))), sleep(3000).then(() => false)]);
    ok('5 control: on this node, one blocked worker of four makes process.exit hang (still alive 3 s on)', !exited);
    c.kill('SIGKILL');
  }
  for (const [what, pool] of [['one worker of four blocked for good', null], ['the whole pool (one thread) parked', 1]]) {
    const s = await studio({ freeze: true, pool });
    await freezeNow(s);
    ok(`5 ${what}: the studio still answers deep health`, pool === 1 || (await healthOf(s.port, '?deep=1'))?.pid === s.pid);
    const t0 = Date.now();
    s.child.kill('SIGTERM');
    const gone = await exitWithin(s, 4000);
    ok(`5 …SIGTERM: gone within 4 s, "stopped.", its run file removed`, gone !== null && /stopped\./.test(s.out) && !fs.existsSync(s.run) && !(await busy(s.port)), `${JSON.stringify(gone)} ${Date.now() - t0}ms ${s.out.slice(-80)}`);
  }
} finally {
  for (const c of live) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
}

await sleep(200);
fs.rmSync(sb, { recursive: true, force: true });
assertRealHomesUnchanged(realBefore, ok);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
