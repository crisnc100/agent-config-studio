/**
 * bin/acs from a stranger's shell (builds/ready-for-strangers criterion 2, B7,
 * B8, B9), against temp HOMEs and temp PATH dirs only:
 *
 *   - it finds its checkout through a symlink, a chain of two, a relative
 *     link and a path with spaces, under sh, dash and zsh;
 *   - `acs install` links into a PATH dir of the user's, is idempotent,
 *     refuses a file, a dangling link, a looping link, another checkout's
 *     link, and an earlier `acs` on PATH; never edits a shell profile, and
 *     prints the PATH line when no dir of the user's is on PATH;
 *   - `acs uninstall` is idempotent and removes only a link to this checkout;
 *   - help exits 0, an unknown command exits non-zero, an old or missing node
 *     is named;
 *   - with no curl and no lsof it still starts headless, refuses a port
 *     another process holds (a non-HTTP listener), survives a browser opener
 *     that fails, and stops.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshotRealHomes, assertRealHomesUnchanged } from './real-home.mjs';

const ROOT = fs.realpathSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const ACS = path.join(ROOT, 'bin', 'acs');
const realBefore = snapshotRealHomes();
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const which = (c) => spawnSync('/bin/sh', ['-c', `command -v ${c}`], { encoding: 'utf8' }).stdout.trim();

const sb = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acs-launcher-')));
const nodeDir = path.dirname(process.execPath);
const SYS = '/usr/bin:/bin';
const run = (shell, args, { cwd = sb, env = {}, input } = {}) => {
  const r = spawnSync(shell, args, { cwd, env: { PATH: `${nodeDir}:${SYS}`, HOME: path.join(sb, 'home'), ACS_NO_UPDATE: '1', SHELL: '/bin/sh', ...env }, encoding: 'utf8', input });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};
const checkoutOf = (out) => out.match(/^checkout:\s+(.*)$/m)?.[1];

console.log('\nacs: finds its checkout through links');
const spaced = path.join(sb, 'dir with spaces');
const chain = path.join(sb, 'chain');
fs.mkdirSync(spaced); fs.mkdirSync(chain);
fs.symlinkSync(ACS, path.join(spaced, 'acs one'));                          // absolute, in a spaced dir
fs.symlinkSync(path.join('..', 'dir with spaces', 'acs one'), path.join(chain, 'acs'));   // relative, second hop
const shells = ['sh', 'dash', 'zsh'].map((s) => [s, which(s)]);
for (const [name, bin] of shells) {
  ok(`2 B9 ${name} is installed for this test`, !!bin, `${name} not found — CI installs dash and zsh`);
  if (!bin) continue;
  for (const [what, link] of [['the checkout itself', ACS], ['one absolute link in a spaced path', path.join(spaced, 'acs one')], ['a chain of two, the second relative', path.join(chain, 'acs')]]) {
    const r = run(bin, [link, 'help'], { cwd: '/' });
    ok(`2 ${name}: via ${what}, from /, acs finds its checkout`, r.code === 0 && checkoutOf(r.out) === ROOT, r.out.slice(-200));
  }
}
fs.symlinkSync(path.join(sb, 'loop-b'), path.join(sb, 'loop-a'));
fs.symlinkSync(path.join(sb, 'loop-a'), path.join(sb, 'loop-b'));
const loop = run('/bin/sh', [path.join(sb, 'loop-a'), 'help']);
ok('2 a link cycle is refused, not followed forever', loop.code !== 0, loop.out);

console.log('\nacs: help, unknown commands, node');
const help = run('/bin/sh', [ACS, '--help']);
ok('B8 acs --help prints usage and exits 0', help.code === 0 && /usage: acs/.test(help.out));
ok('B8 acs -h and acs help do too', run('/bin/sh', [ACS, '-h']).code === 0 && run('/bin/sh', [ACS, 'help']).code === 0);
const bogus = run('/bin/sh', [ACS, 'frobnicate']);
ok('B8 an unknown subcommand exits non-zero, naming it', bogus.code === 2 && /unknown command: frobnicate/.test(bogus.out) && /usage: acs/.test(bogus.out), bogus.out);
const oldNode = path.join(sb, 'old-node');
fs.mkdirSync(oldNode);
fs.writeFileSync(path.join(oldNode, 'node'), '#!/bin/sh\necho 18.19.0\n', { mode: 0o755 });
const old = run('/bin/sh', [ACS, 'stop'], { env: { PATH: `${oldNode}:${SYS}` } });
ok('B9 Node 18 is refused with a clear message', old.code === 1 && /Node\.js 18\.19\.0 is too old — Node 20 or newer is required/.test(old.out), old.out);
const noNodePath = path.join(sb, 'no-node');
fs.mkdirSync(noNodePath);
for (const t of ['dirname', 'readlink']) fs.symlinkSync(which(t), path.join(noNodePath, t));
const none = run('/bin/sh', [ACS, 'stop'], { env: { PATH: noNodePath } });
ok('B9 no node at all is named', none.code === 1 && /node is not on PATH/.test(none.out), none.out);
ok('B9 help needs no node', run('/bin/sh', [ACS, 'help'], { env: { PATH: noNodePath } }).code === 0);

console.log('\nacs install / uninstall');
function fresh(tag) {
  const home = path.join(sb, `home-${tag}`);
  const local = path.join(home, '.local', 'bin');
  fs.mkdirSync(local, { recursive: true });
  for (const f of ['.zshrc', '.bashrc', '.profile']) fs.writeFileSync(path.join(home, f), `# ${f} as the user left it\n`);
  return { home, local, env: { HOME: home, PATH: `${local}:${nodeDir}:${SYS}` } };
}
const profiles = (home) => ['.zshrc', '.bashrc', '.profile'].every((f) => fs.readFileSync(path.join(home, f), 'utf8') === `# ${f} as the user left it\n`);
{
  const h = fresh('ok');
  const i1 = run('/bin/sh', [ACS, 'install'], { env: h.env });
  const link = path.join(h.local, 'acs');
  ok('2 install links ~/.local/bin/acs to this checkout\'s bin/acs', i1.code === 0 && fs.lstatSync(link).isSymbolicLink() && fs.readlinkSync(link) === ACS, i1.out);
  ok('B7 …and says to open a new terminal or hash -r', /new terminal/.test(i1.out) && /hash -r/.test(i1.out), i1.out);
  const i2 = run('/bin/sh', [ACS, 'install'], { env: h.env });
  ok('2 install again is a no-op that says so', i2.code === 0 && /already installed/.test(i2.out) && fs.readlinkSync(link) === ACS, i2.out);
  const bare = run('/bin/sh', ['-c', 'acs help'], { env: h.env, cwd: '/' });
  ok('B7 bare `acs` from an unrelated cwd is this checkout', bare.code === 0 && checkoutOf(bare.out) === ROOT, bare.out.slice(-200));
  ok('2 no shell profile was touched', profiles(h.home));
  const u1 = run('/bin/sh', [link, 'uninstall'], { env: h.env });
  ok('2 uninstall removes the link', u1.code === 0 && !fs.existsSync(link) && /removed ~\/\.local\/bin\/acs/.test(u1.out), u1.out);
  const u2 = run('/bin/sh', [ACS, 'uninstall'], { env: h.env });
  ok('2 uninstall again is a no-op that says so', u2.code === 0 && /not installed/.test(u2.out), u2.out);
  ok('2 …profiles still untouched', profiles(h.home));
}
{
  const h = fresh('relative');
  fs.symlinkSync(path.relative(h.local, ACS), path.join(h.local, 'acs'));
  const r = run('/bin/sh', [ACS, 'install'], { env: h.env });
  ok('B7 a relative link to this checkout counts as ours', r.code === 0 && /already installed/.test(r.out), r.out);
  const u = run('/bin/sh', [ACS, 'uninstall'], { env: h.env });
  ok('B7 …and uninstall removes it', u.code === 0 && !fs.existsSync(path.join(h.local, 'acs')), u.out);
}
for (const [what, plant] of [
  ['a file', (l) => fs.writeFileSync(l, '#!/bin/sh\necho mine\n', { mode: 0o755 })],
  ['a dangling link', (l) => fs.symlinkSync(path.join(sb, 'nowhere', 'acs'), l)],
  ['a looping link', (l) => fs.symlinkSync(l, l)],
  ['another checkout\'s link', (l) => { const other = path.join(sb, 'other-checkout', 'bin'); fs.mkdirSync(other, { recursive: true }); fs.writeFileSync(path.join(other, 'acs'), '#!/bin/sh\n', { mode: 0o755 }); fs.symlinkSync(path.join(other, 'acs'), l); }],
]) {
  const h = fresh(what.replace(/\W+/g, '-'));
  const link = path.join(h.local, 'acs');
  plant(link);
  const before = fs.lstatSync(link);
  const target = before.isSymbolicLink() ? fs.readlinkSync(link) : fs.readFileSync(link, 'utf8');
  const r = run('/bin/sh', [ACS, 'install'], { env: h.env });
  const after = fs.lstatSync(link);
  ok(`2 B7 install refuses to replace ${what}`, r.code === 1 && /refusing/.test(r.out) &&
     (after.isSymbolicLink() ? fs.readlinkSync(link) : fs.readFileSync(link, 'utf8')) === target, r.out);
  const u = run('/bin/sh', [ACS, 'uninstall'], { env: h.env });
  ok(`B7 uninstall leaves ${what} alone`, u.code === 0 && fs.lstatSync(link).ino === before.ino && /not installed/.test(u.out), u.out);
}
{
  const h = fresh('shadowed');
  const early = path.join(h.home, 'bin-early');
  fs.mkdirSync(early);
  fs.writeFileSync(path.join(early, 'acs'), '#!/bin/sh\necho an older acs\n', { mode: 0o755 });
  const env = { ...h.env, PATH: `${early}:${h.local}:${nodeDir}:${SYS}` };
  const r = run('/bin/sh', [ACS, 'install'], { env });
  ok('B7 an earlier acs on PATH that is not ours: refused, naming it', r.code === 1 && /bin-early\/acs/.test(r.out) && /comes first on PATH/.test(r.out) && !fs.existsSync(path.join(h.local, 'acs')), r.out);
}
{
  const h = fresh('offpath');
  const env = { HOME: h.home, PATH: `${nodeDir}:${SYS}` };
  fs.rmSync(path.join(h.home, '.local'), { recursive: true });
  const r = run('/bin/sh', [ACS, 'install'], { env });
  ok('2 no dir of the user\'s on PATH: links ~/.local/bin/acs anyway', r.code === 0 && fs.readlinkSync(path.join(h.home, '.local', 'bin', 'acs')) === ACS, r.out);
  ok('2 …and prints the line to add, naming the profile, without editing it', /export PATH="\$HOME\/\.local\/bin:\$PATH"/.test(r.out) && /acs does not edit it/.test(r.out) && profiles(h.home), r.out);
}

console.log('\nacs: no curl, no lsof — start, refuse, stop');
// A PATH holding only what the launcher may need: node, git, ps, and the two
// file tools it uses to resolve its own path. No curl, no lsof.
const tools = path.join(sb, 'tools');
fs.mkdirSync(tools);
fs.symlinkSync(process.execPath, path.join(tools, 'node'));
for (const t of ['dirname', 'readlink', 'git', 'ps']) fs.symlinkSync(which(t), path.join(tools, t));
ok('B8 the launcher\'s source invokes neither curl nor lsof', !/\b(curl|lsof)\b\s+-/.test(fs.readFileSync(ACS, 'utf8')));
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const health = async (port) => { try { return (await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()).app === 'agent-config-studio'; } catch { return false; } };
const home = path.join(sb, 'home-run');
fs.mkdirSync(home);
async function start(port, env) {
  let out = '';
  const child = spawn('/bin/sh', [ACS], { cwd: '/', env: { HOME: home, PATH: tools, ACS_PORT: String(port), ACS_NO_UPDATE: '1', TMPDIR: os.tmpdir(), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  let exited = null;
  child.on('exit', (c) => { exited = c; });
  for (let i = 0; i < 100 && exited === null && !(await health(port)); i++) await sleep(100);
  await sleep(300);
  return { child, out: () => out, exited: () => exited };
}
{
  const port = await freePort();
  const holder = net.createServer((s) => { s.on('error', () => {}); s.end('not http\n'); });
  await new Promise((r) => holder.listen(port, '127.0.0.1', r));
  const r = await start(port, { ACS_NO_OPEN: '1' });
  await new Promise((res) => (r.exited() !== null ? res() : r.child.once('exit', res)));
  ok('B8 a port held by a non-HTTP listener: refused, nothing started', r.exited() === 1 && /port \d+ is in use by another process/.test(r.out()), r.out());
  const stop = run('/bin/sh', [ACS, 'stop'], { env: { HOME: home, PATH: tools, ACS_PORT: String(port) } });
  ok('B8 acs stop leaves that listener alone', stop.code === 1 && /in use by something else/.test(stop.out), stop.out);
  holder.close();
}
{
  const port = await freePort();
  const r = await start(port, { ACS_NO_OPEN: '1' });
  ok('B8 headless (ACS_NO_OPEN=1): starts, with no curl or lsof on PATH', await health(port) && r.exited() === null, r.out());
  ok('B8 …and prints the URL instead of opening a browser', new RegExp(`open http://localhost:${port} in your browser`).test(r.out()), r.out());
  const again = run('/bin/sh', [ACS, '--no-open'], { env: { HOME: home, PATH: tools, ACS_PORT: String(port) } });
  ok('B8 a second acs sees it running and exits 0', again.code === 0 && /already running/.test(again.out), again.out);
  const stop = run('/bin/sh', [ACS, 'stop'], { env: { HOME: home, PATH: tools, ACS_PORT: String(port) } });
  await new Promise((res) => (r.exited() !== null ? res() : r.child.once('exit', res)));
  ok('B8 acs stop stops it, and the launcher exits', stop.code === 0 && /stopped/.test(stop.out) && !(await health(port)), stop.out);
  ok('B8 acs stop when nothing runs says so', /not running/.test(run('/bin/sh', [ACS, 'stop'], { env: { HOME: home, PATH: tools, ACS_PORT: String(port) } }).out));
}
// Stop by pid only for a pid that is really the studio: a listener that
// answers /api/health — saying it is ACS or not — with another process's pid
// gets no signal.
for (const [what, app] of [['claims to be ACS', 'agent-config-studio'], ['is some other app', 'other-app']]) {
  const port = await freePort();
  const victim = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  const liar = net.createServer((s) => {
    s.on('error', () => {});
    s.end(`HTTP/1.1 200 OK\r\ncontent-type: application/json\r\nconnection: close\r\n\r\n${JSON.stringify({ app, pid: victim.pid })}`);
  });
  await new Promise((r) => liar.listen(port, '127.0.0.1', r));
  const stop = run('/bin/sh', [ACS, 'stop'], { env: { HOME: home, PATH: tools, ACS_PORT: String(port) } });
  let alive = true;
  try { process.kill(victim.pid, 0); } catch { alive = false; }
  ok(`B8 a health answer that ${what}, naming an unrelated pid: acs stop refuses and signals nothing`,
     stop.code === 1 && /in use by something else/.test(stop.out) && alive, `${stop.code} ${stop.out} alive=${alive}`);
  victim.kill('SIGKILL');
  liar.close();
}
{
  const port = await freePort();
  const opener = path.join(sb, 'failing-opener');
  fs.mkdirSync(opener);
  for (const o of ['open', 'xdg-open']) fs.writeFileSync(path.join(opener, o), '#!/bin/sh\necho "no display" >&2\nexit 1\n', { mode: 0o755 });
  const r = await start(port, { PATH: `${opener}:${tools}` });
  ok('B8 a browser opener that fails: the launcher keeps running the server', await health(port) && r.exited() === null && /could not open a browser/.test(r.out()), r.out());
  run('/bin/sh', [ACS, 'stop'], { env: { HOME: home, PATH: tools, ACS_PORT: String(port) } });
  await new Promise((res) => (r.exited() !== null ? res() : r.child.once('exit', res)));
}

fs.rmSync(sb, { recursive: true, force: true });
assertRealHomesUnchanged(realBefore, ok);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
