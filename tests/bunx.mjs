/**
 * bunx distribution, with Node present (builds/npm-package A7, N10): bunx
 * fetches the packed tarball into its own cache and runs bin/acs, which is
 * POSIX sh and starts the studio with node. That is all this proves — not
 * that the studio runs on Bun's runtime. Temp HOME, temp bun cache, offline.
 *
 *   node tests/bunx.mjs <tarball>
 *
 * Bun is found as `bun` on PATH or at ~/.bun/bin/bun; without it the suite
 * says so and exits 0, unless ACS_REQUIRE_BUN=1 (CI), where that fails.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { snapshotRealHomes, assertRealHomesUnchanged } from './real-home.mjs';

const realBefore = snapshotRealHomes();
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tarball = process.argv[2] && path.resolve(process.argv[2]);
const onPath = spawnSync('/bin/sh', ['-c', 'command -v bun'], { encoding: 'utf8' }).stdout.trim();
const bun = onPath || [path.join(os.homedir(), '.bun', 'bin', 'bun')].find((b) => fs.existsSync(b));
console.log('\nbunx: the packed tarball');
if (!bun) {
  ok('bun is installed', !process.env.ACS_REQUIRE_BUN, 'no bun on PATH or at ~/.bun/bin/bun');
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
ok('a tarball was given', !!tarball && fs.existsSync(tarball), String(tarball));

const sb = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acs-bunx-')));
const home = path.join(sb, 'home');
const tmp = path.join(sb, 'tmp');
fs.mkdirSync(home); fs.mkdirSync(tmp);
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const port = await freePort();
const env = {
  HOME: home, TMPDIR: tmp, SHELL: '/bin/sh', PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
  BUN_INSTALL_CACHE_DIR: path.join(sb, 'bun-cache'), ACS_PORT: String(port), ACS_NO_OPEN: '1',
};
const spec = `agent-config-studio@file:${tarball}`;
const version = spawnSync(bun, ['--version'], { encoding: 'utf8' }).stdout.trim();
console.log(`  bun ${version}, node ${process.versions.node}`);

const health = async () => { try { return (await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()); } catch { return null; } };
let out = '';
const child = spawn(bun, ['x', spec], { cwd: sb, env, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', (d) => { out += d; });
child.stderr.on('data', (d) => { out += d; });
let exited = null;
child.on('exit', (c) => { exited = c; });
let h = null;
for (let i = 0; i < 600 && exited === null && !(h = await health()); i++) await sleep(100);
ok(`bunx ${spec.replace(tarball, '<tarball>')} starts the studio`, h?.app === 'agent-config-studio', out.slice(-600));
const args = h ? spawnSync('ps', ['-o', 'args=', '-p', String(h.pid)], { encoding: 'utf8' }).stdout.trim() : '';
ok('…from bunx\'s own cache, served by node (Bun only fetched the package)', /[\\/]bunx-[^/]*[\\/]node_modules[\\/]agent-config-studio[\\/]server\.js$/.test(args) && /\bnode\b/.test(args.split(' ')[0]), args);
let index = null;
try { index = await (await fetch(`http://127.0.0.1:${port}/`)).text(); } catch {}
ok('…and serves the UI', /<title>/.test(index || ''), (index || '').slice(0, 200));
const stop = spawnSync(bun, ['x', spec, 'stop'], { cwd: sb, env, encoding: 'utf8' });
for (let i = 0; i < 100 && exited === null; i++) await sleep(100);
ok('bunx agent-config-studio stop stops it', stop.status === 0 && /stopped/.test(stop.stdout) && !(await health()), `${stop.stdout}${stop.stderr}`);
if (exited === null) child.kill('SIGKILL');

fs.rmSync(sb, { recursive: true, force: true });
assertRealHomesUnchanged(realBefore, ok);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
