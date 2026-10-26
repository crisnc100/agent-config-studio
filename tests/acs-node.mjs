/**
 * Which node `acs` runs (builds/server-freeze criterion 1), against temp HOMEs
 * and fake node binaries: tiny sh scripts that answer `-p process.versions.node`
 * with a version, and hand any other invocation to the real node after logging
 * it, so the log says which binary ran what.
 *
 *   - node on PATH with an even major (20 or newer) is used as it is;
 *   - an odd major (a short-lived release), a node below 20, or no node on
 *     PATH at all gives way to the newest LTS that nvm, fnm (both homes),
 *     Volta or Homebrew (HOMEBREW_PREFIX, or the brew on PATH) installed —
 *     each asked its version, never trusted by folder name — and the start
 *     says so in one line;
 *   - none found: PATH's odd node with a one-line warning at start; a node
 *     below 20, or none, refused as before;
 *   - ACS_NODE wins when set, and is refused clearly when it is missing, not
 *     executable, unreadable or older than 20;
 *   - every node invocation — acs-net, subcommands, server.js — is the chosen one,
 *     and every command but the start stays as quiet as it was.
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

const sb = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acs-node-')));
const scratchHome = path.join(sb, 'home-helpers');
fs.mkdirSync(scratchHome);
const which = (c) => spawnSync('/bin/sh', ['-c', `command -v ${c}`], { env: { PATH: process.env.PATH, HOME: scratchHome }, encoding: 'utf8' }).stdout.trim();
const LOG = path.join(sb, 'node-calls.log');
// What the launcher needs besides node; node itself is always a fake here.
const tools = path.join(sb, 'tools');
fs.mkdirSync(tools);
for (const t of ['dirname', 'readlink', 'git', 'ps', 'sed']) fs.symlinkSync(which(t), path.join(tools, t));

/** A fake node at `file` that reports `version` and runs everything else on the real node, logging it. */
function fakeNode(file, version) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [
    '#!/bin/sh',
    `if [ "$1" = -p ] && [ "$2" = process.versions.node ]; then echo ${version}; exit 0; fi`,
    `printf '%s %s\\n' ${version} "$*" >> '${LOG}'`,
    `exec '${process.execPath}' "$@"`,
    '',
  ].join('\n'), { mode: 0o755 });
  return file;
}
/** The versions that ran something other than the version query since the last call. */
const ran = () => {
  const lines = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean) : [];
  fs.rmSync(LOG, { force: true });
  return lines;
};
const versionsIn = (lines) => [...new Set(lines.map((l) => l.split(' ')[0]))];

let n = 0;
/** A temp HOME with these installs, and a PATH whose node reports `pathVersion`. */
function machine({ pathVersion = '23.11.1', installs = [] } = {}) {
  const home = path.join(sb, `home-${++n}`);
  fs.mkdirSync(home);
  const bin = path.join(sb, `path-${n}`);
  if (pathVersion) fakeNode(path.join(bin, 'node'), pathVersion);
  for (const [rel, version] of installs) fakeNode(path.join(home, rel), version);
  return { home, env: { HOME: home, PATH: `${pathVersion ? `${bin}:` : ''}${tools}`, ACS_NO_UPDATE: '1', ACS_NO_OPEN: '1', TMPDIR: os.tmpdir() } };
}
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const port = await freePort();
const run = (args, env, { shell = '/bin/sh', cwd = sb } = {}) => {
  const r = spawnSync(shell, [ACS, ...args], { cwd, env: { ACS_PORT: String(port), ...env }, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};
/** `acs stop` with nothing running: it exercises acs-net several times and says "not running." */
const stopWith = (env, opts) => {
  ran();
  const r = run(['stop'], env, opts);
  return { ...r, versions: versionsIn(ran()) };
};
const nvm = (v) => `.nvm/versions/node/v${v}/bin/node`;

console.log('\nacs: node on PATH');
{
  const m = machine({ pathVersion: '22.23.3', installs: [[nvm('24.1.0'), '24.1.0']] });
  const r = stopWith(m.env);
  ok('1 an even major on PATH (22) runs every node call, even with a newer LTS installed', r.code === 0 && /not running/.test(r.out) && r.versions.join() === '22.23.3', `${r.versions} ${r.out}`);
  ok('1 …and `acs stop` prints nothing about node', !/Node \d|short-lived/.test(r.out), r.out);
}

console.log('\nacs: an odd major on PATH gives way to the newest LTS installed');
{
  const m = machine({
    installs: [
      [nvm('18.20.4'), '18.20.4'], [nvm('20.19.0'), '20.19.0'], [nvm('21.7.3'), '21.7.3'],
      [nvm('22.9.0'), '22.9.0'], [nvm('22.10.0'), '22.10.0'], [nvm('25.0.0'), '25.0.0'],
      [nvm('24.0.0'), '19.9.0'],   // the folder says 24; the binary says 19
    ],
  });
  const r = stopWith(m.env);
  ok('1 nvm: the newest even major ≥20 by number (22.10.0 over 22.9.0), skipping 18, odd 21 and 25', r.code === 0 && r.versions.join() === '22.10.0', `${r.versions} ${r.out}`);
  ok('1 …a folder name is not trusted: v24.0.0 whose binary is 19.9.0 is skipped', !r.versions.includes('19.9.0'));
  ok('1 …and the default node 23 ran nothing', !r.versions.includes('23.11.1'));
}
{
  const m = machine({ installs: [[nvm('22.23.3'), '22.23.3'], ['.local/share/fnm/node-versions/v24.1.0/installation/bin/node', '24.1.0']] });
  const r = stopWith(m.env);
  ok('1 fnm (~/.local/share/fnm) counts, and the newest across managers wins (24.1.0 over nvm 22)', r.code === 0 && r.versions.join() === '24.1.0', `${r.versions} ${r.out}`);
}
{
  const m = machine({ installs: [['Library/Application Support/fnm/node-versions/v22.5.0/installation/bin/node', '22.5.0']] });
  const r = stopWith(m.env);
  ok('1 fnm\'s macOS home (~/Library/Application Support/fnm, a path with a space) counts', r.code === 0 && r.versions.join() === '22.5.0', `${r.versions} ${r.out}`);
}
{
  const m = machine({ installs: [['.volta/tools/image/node/22.11.0/bin/node', '22.11.0']] });
  const r = stopWith(m.env);
  ok('1 Volta (~/.volta/tools/image/node) counts', r.code === 0 && r.versions.join() === '22.11.0', `${r.versions} ${r.out}`);
}
{
  const m = machine();
  const brew = path.join(sb, 'brew');
  fakeNode(path.join(brew, 'opt', 'node@22', 'bin', 'node'), '22.12.0');
  fakeNode(path.join(brew, 'opt', 'node@24', 'bin', 'node'), '24.2.0');
  fakeNode(path.join(brew, 'opt', 'node@23', 'bin', 'node'), '23.6.0');
  const r = stopWith({ ...m.env, HOMEBREW_PREFIX: brew });
  ok('1 Homebrew\'s opt/node@N under HOMEBREW_PREFIX counts: node@24 over node@22, odd node@23 skipped', r.code === 0 && r.versions.join() === '24.2.0', `${r.versions} ${r.out}`);
  const onPath = path.join(sb, 'brew-on-path');
  fs.mkdirSync(path.join(onPath, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(onPath, 'bin', 'brew'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fakeNode(path.join(onPath, 'opt', 'node@22', 'bin', 'node'), '22.12.0');
  const b = stopWith({ ...m.env, PATH: `${m.env.PATH}:${path.join(onPath, 'bin')}` });
  ok('1 …and with no HOMEBREW_PREFIX, under the prefix of the brew on PATH', b.code === 0 && b.versions.join() === '22.12.0', `${b.versions} ${b.out}`);
  // A relative PATH entry: dash's `command -v brew` answers relative to the cwd.
  for (const [shell, rel, cwd] of [['dash', 'bin', onPath], ['dash', '.', path.join(onPath, 'bin')], ['sh', 'bin', onPath]]) {
    const r2 = stopWith({ ...m.env, PATH: `${rel}:${m.env.PATH}` }, { shell: which(shell), cwd });
    ok(`1 …and through a relative PATH entry ("${rel}", ${shell}), resolved against the cwd`, r2.code === 0 && r2.versions.join() === '22.12.0', `${r2.versions} ${r2.out}`);
  }
}
{
  const m = machine();
  const r = stopWith(m.env);
  ok('1 no LTS found: PATH\'s odd node runs every call', r.code === 0 && /not running/.test(r.out) && r.versions.join() === '23.11.1', `${r.versions} ${r.out}`);
  ok('1 …and `acs stop` stays quiet about it (the warning is the start\'s)', !/short-lived/.test(r.out), r.out);
}
for (const [what, pathVersion, refused] of [['no node on PATH at all', null, /node is not on PATH/], ['node 18 on PATH', '18.19.0', /Node\.js 18\.19\.0 is too old — Node 20 or newer is required/]]) {
  const r = stopWith(machine({ pathVersion, installs: [[nvm('22.23.3'), '22.23.3']] }).env);
  ok(`1 ${what}, an LTS installed: the LTS runs every call`, r.code === 0 && /not running/.test(r.out) && r.versions.join() === '22.23.3', `${r.versions} ${r.out}`);
  const none = stopWith(machine({ pathVersion }).env);
  ok(`1 …and with none installed, refused as before`, none.code === 1 && refused.test(none.out) && none.versions.length === 0, none.out);
}
{
  const m = machine({ pathVersion: '19.9.0', installs: [[nvm('22.23.3'), '22.23.3']] });
  const r = stopWith(m.env);
  ok('1 an odd major below 20 (19) with an LTS installed: the LTS runs', r.code === 0 && r.versions.join() === '22.23.3', `${r.versions} ${r.out}`);
  const none = stopWith(machine({ pathVersion: '19.9.0' }).env);
  ok('1 …and with none, it is refused as too old', none.code === 1 && /Node\.js 19\.9\.0 is too old — Node 20 or newer is required/.test(none.out) && none.versions.length === 0, none.out);
}
{
  const m = machine({ installs: [[nvm('22.23.3'), '22.23.3']] });
  ran();
  const r = run(['roots', 'ls'], m.env);
  const versions = versionsIn(ran());
  ok('1 a subcommand (acs roots ls) runs on the chosen node', r.code === 0 && versions.join() === '22.23.3', `${versions} ${r.out}`);
  ok('1 …and its output is what it was: no node notice', !/Node \d|short-lived/.test(r.out), r.out);
}

console.log('\nacs: ACS_NODE');
{
  const m = machine({ pathVersion: '22.23.3', installs: [[nvm('24.1.0'), '24.1.0']] });
  const twenty = fakeNode(path.join(sb, 'acs-node', 'node20'), '20.19.0');
  const r = stopWith({ ...m.env, ACS_NODE: twenty });
  ok('1 ACS_NODE (a path) wins over PATH and every install', r.code === 0 && r.versions.join() === '20.19.0', `${r.versions} ${r.out}`);
  const odd = fakeNode(path.join(sb, 'acs-node', 'node23'), '23.11.1');
  const o = stopWith({ ...machine({ installs: [[nvm('22.23.3'), '22.23.3']] }).env, ACS_NODE: odd });
  ok('1 an odd ACS_NODE is the user\'s choice: used, no LTS search', o.code === 0 && o.versions.join() === '23.11.1', `${o.versions} ${o.out}`);
  const named = path.join(sb, 'named');
  fakeNode(path.join(named, 'node-lts'), '22.4.0');
  const b = stopWith({ ...m.env, PATH: `${named}:${m.env.PATH}`, ACS_NODE: 'node-lts' });
  ok('1 ACS_NODE as a command name on PATH', b.code === 0 && b.versions.join() === '22.4.0', `${b.versions} ${b.out}`);
}
{
  const m = machine({ pathVersion: '22.23.3' });
  const missing = stopWith({ ...m.env, ACS_NODE: path.join(sb, 'nowhere', 'node') });
  ok('1 ACS_NODE that does not exist: refused, naming it, nothing run', missing.code === 1 && /ACS_NODE is set to ".*nowhere\/node", which is not an executable file/.test(missing.out) && missing.versions.length === 0, missing.out);
  const plain = path.join(sb, 'not-executable');
  fs.writeFileSync(plain, '#!/bin/sh\necho 22.0.0\n', { mode: 0o644 });
  const nx = stopWith({ ...m.env, ACS_NODE: plain });
  ok('1 ACS_NODE that is not executable: refused the same way', nx.code === 1 && /not an executable file/.test(nx.out), nx.out);
  const unknown = stopWith({ ...m.env, ACS_NODE: 'no-such-node-anywhere' });
  ok('1 ACS_NODE naming no command: refused the same way', unknown.code === 1 && /not an executable file/.test(unknown.out), unknown.out);
  const old = fakeNode(path.join(sb, 'acs-node', 'node18'), '18.19.0');
  const o = stopWith({ ...m.env, ACS_NODE: old });
  ok('1 ACS_NODE older than 20: refused as too old, naming ACS_NODE', o.code === 1 && /Node\.js 18\.19\.0 is too old — Node 20 or newer is required/.test(o.out) && o.out.includes(`ACS_NODE: ${old}`) && o.versions.length === 0, o.out);
  const junk = path.join(sb, 'junk');
  fs.writeFileSync(junk, '#!/bin/sh\necho hello\n', { mode: 0o755 });
  const j = stopWith({ ...m.env, ACS_NODE: junk });
  ok('1 ACS_NODE that is not node: the version cannot be read, and it says so', j.code === 1 && /could not read the Node\.js version \(ACS_NODE \(.*junk\) -p printed "hello"\)/.test(j.out), j.out);
}

console.log('\nacs: the start says which node, and the studio runs on it');
const health = async (p) => { try { return (await (await fetch(`http://127.0.0.1:${p}/api/health`, { signal: AbortSignal.timeout(2000) })).json()).app === 'agent-config-studio'; } catch { return false; } };
async function start(env) {
  let out = '';
  const child = spawn('/bin/sh', [ACS], { cwd: '/', env: { ACS_PORT: String(port), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  let exited = null;
  child.on('exit', (c) => { exited = c; });
  for (let i = 0; i < 150 && exited === null && !(await health(port)); i++) await sleep(100);
  return { child, out: () => out, exited: () => exited };
}
const stopAsync = (env) => new Promise((resolve) => {
  const c = spawn('/bin/sh', [ACS, 'stop'], { cwd: sb, env: { ACS_PORT: String(port), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  c.stdout.on('data', (d) => { out += d; });
  c.stderr.on('data', (d) => { out += d; });
  c.on('exit', (code) => resolve({ code, out }));
});
for (const [what, pathVersion, installs, line, version] of [
  ['default node 23, an LTS installed', '23.11.1', [[nvm('22.23.3'), '22.23.3']], 'acs: using Node 22.23.3 (LTS); your default node 23.11.1 is a short-lived release', '22.23.3'],
  ['default node 23, no LTS installed', '23.11.1', [], 'acs: your default node 23.11.1 is a short-lived release and no LTS node (an even major, 20 or newer) was found — running on it anyway. Set ACS_NODE to an LTS node to choose one.', '23.11.1'],
  ['no node on PATH, an LTS installed', null, [[nvm('22.23.3'), '22.23.3']], 'acs: using Node 22.23.3 (LTS); there is no node on your PATH', '22.23.3'],
  ['node 18 on PATH, an LTS installed', '18.19.0', [[nvm('22.23.3'), '22.23.3']], 'acs: using Node 22.23.3 (LTS); your default node 18.19.0 is too old', '22.23.3'],
]) {
  const m = machine({ pathVersion, installs });
  ran();
  const s = await start(m.env);
  const up = await health(port);
  const lines = ran();
  const notes = s.out().split('\n').filter((l) => /^acs: (using Node|your default node)/.test(l));
  ok(`1 ${what}: the studio starts`, up && s.exited() === null, s.out());
  ok('1 …and the start says so in exactly one line', notes.length === 1 && notes[0] === line, s.out());
  ok(`1 …server.js runs on ${version}`, lines.some((l) => l === `${version} ${path.join(ROOT, 'server.js')}`), lines.join(' | '));
  ok('1 …and so did every node call of the start', versionsIn(lines).join() === version, lines.join(' | '));
  const st = await stopAsync(m.env);
  await new Promise((res) => (s.exited() !== null ? res() : s.child.once('exit', res)));
  const stopVersions = versionsIn(ran());
  ok('1 …acs stop stops it, on the same node', st.code === 0 && /stopped/.test(st.out) && !(await health(port)) && stopVersions.join() === version, `${stopVersions} ${st.out}`);
}

console.log('\nacs: the source');
{
  const code = fs.readFileSync(ACS, 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  const bare = code.split('\n').filter((l) => /(^|[\s;|&(])(exec\s+)?node\s+"\$DIR\//.test(l));
  const chosen = [...code.matchAll(/"\$NODE" "\$DIR\/(bin\/[\w-]+\.mjs|server\.js)"/g)].map((m) => m[1]);
  ok('1 no node invocation in bin/acs bypasses the chosen binary', bare.length === 0, bare.join(' | '));
  ok('1 …acs-net, server.js and every subcommand go through "$NODE"',
     ['bin/acs-net.mjs', 'server.js', 'bin/usage.mjs', 'bin/roots.mjs', 'bin/install-worktree.mjs', 'bin/model-id.mjs', 'bin/acs-link.mjs'].every((f) => chosen.includes(f)), chosen.join(' '));
}

fs.rmSync(sb, { recursive: true, force: true });
assertRealHomesUnchanged(realBefore, ok);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
