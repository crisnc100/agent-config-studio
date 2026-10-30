/**
 * The npm package (builds/npm-package A2–A5, N3–N9): the tarball `npm pack`
 * makes, installed the ways a stranger gets it — a global prefix, npx's cache,
 * a project's dependencies — with a temp HOME, a temp npm cache and no
 * network. Offline throughout: fake CLIs, no real one is ever reachable.
 *
 *   node tests/package.mjs [tarball]   (packs this tree when none is given)
 *
 *   - A2 the tarball holds the runtime files, README, LICENSE and
 *     package.json, and nothing else;
 *   - A3/N6 `acs` starts from the install: the UI, every asset index.html
 *     names, the setup command table, the usage collector, both installers;
 *   - A4/N4/N5 no self-update git call from an npm install (a recording git
 *     wrapper proves it), the update hint, `acs install|uninstall|update`
 *     refused, a package inside someone's repo never fetches that repo, a
 *     real worktree (its .git a file) still updates, missing git is named;
 *   - A5/N8 with the package read-only, unprivileged: start, setup, both
 *     installers and an Assist prompt-file write all succeed, and not one
 *     byte, mode or entry of the package changes;
 *   - N7 npx runs the tarball, `npx … stop` stops it, and a studio started
 *     from one install is stopped from another;
 *   - N9 copies the installers made that differ from the package are named.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshotRealHomes, assertRealHomesUnchanged } from './real-home.mjs';
import { fakeCli } from './fixtures/setup-home.mjs';
import { containedCli } from './fixtures/contained-cli.mjs';

const ROOT = fs.realpathSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const realBefore = snapshotRealHomes();
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const which = (c) => spawnSync('/bin/sh', ['-c', `command -v ${c}`], { encoding: 'utf8' }).stdout.trim();
const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: { ...process.env, ...GIT_ENV }, encoding: 'utf8' }).trim();

ok('A5 the suite runs unprivileged (root would ignore the read-only bits)', process.getuid() !== 0, `uid ${process.getuid()}`);

const sb = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acs-package-')));
const nodeDir = path.dirname(process.execPath);
const SYS = '/usr/bin:/bin:/usr/sbin:/sbin';
const home = path.join(sb, 'home');
const cache = path.join(sb, 'npm-cache');
fs.mkdirSync(home);
const npmEnv = {
  HOME: home, PATH: `${nodeDir}:${SYS}`, SHELL: '/bin/sh', TMPDIR: os.tmpdir(), npm_config_cache: cache,
  npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false', npm_config_offline: 'true',
};
// By path: Node 20.0's spawnSync looks a bare name up on its own PATH, not env's.
const NPM = fs.existsSync(path.join(nodeDir, 'npm')) ? path.join(nodeDir, 'npm') : 'npm';
const npm = (cwd, ...args) => spawnSync(NPM, args, { cwd, env: npmEnv, encoding: 'utf8' });

// Fakes where discovery looks first (lib/harness.js CLI_CANDIDATES), so no
// real claude, codex or grok can answer; grok is the containment fake, which
// speaks the stream protocol Assist checks.
const bin = path.join(sb, 'bin');
fakeCli(path.join(home, '.local', 'bin'), 'claude');
fakeCli(bin, 'codex');
const grok = path.join(home, '.grok', 'bin', 'grok');
containedCli(grok, 'grok');
fs.writeFileSync(path.join(path.dirname(grok), 'mode.json'), JSON.stringify({ kind: 'ok', inspect: { mcpServers: [], plugins: [] }, reply: 'packaged reply' }));
// Every git call the launcher or the studio makes, with the folder it was aimed at.
const gitLog = path.join(sb, 'git.log');
fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${gitLog}'\nexec '${which('git')}' "$@"\n`, { mode: 0o755 });
const gitCalls = () => { try { return fs.readFileSync(gitLog, 'utf8').split('\n').filter(Boolean); } catch { return []; } };
const env = (extra = {}) => ({ ...npmEnv, PATH: `${bin}:${nodeDir}:${SYS}`, ACS_NO_OPEN: '1', ...GIT_ENV, ...extra });

/* ── A2: what the tarball holds ──────────────────────────────────────── */
console.log('\npackage: the tarball');
let tarball = process.argv[2] ? path.resolve(process.argv[2]) : null;
if (!tarball) {
  const p = npm(ROOT, 'pack', '--pack-destination', sb);
  tarball = path.join(sb, (p.stdout || '').trim().split('\n').pop());
  ok('npm pack makes a tarball of this tree', p.status === 0 && fs.existsSync(tarball), `${p.stdout}${p.stderr}`);
}
const listed = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' }).split('\n').filter(Boolean).map((f) => f.replace(/^package\//, ''));
const RUNTIME = /^(server\.js|models\.default\.json|README\.md|LICENSE|package\.json|(lib|public|bin|tools|packs)\/.+)$/;
ok(`A2 ${listed.length} files, every one a runtime file, README, LICENSE or package.json`, listed.length > 40 && listed.every((f) => RUNTIME.test(f)), listed.filter((f) => !RUNTIME.test(f)).join(' | '));
ok('A2 no tests, builds, CI, handoffs, reviews or runbook', !listed.some((f) => /^(tests|builds|\.github|\.handoffs|reviews)\/|^RUNBOOK|^verify\.sh/.test(f)));
ok('A2 C15 the packs ship, and none of their tests do', listed.some((f) => f === 'packs/review-gate/pack.json') && !listed.some((f) => /^packs\/[^/]+\/tests\//.test(f)), listed.filter((f) => /^packs\/[^/]+\/tests\//.test(f)).join(' | '));
const NEEDED = ['bin/acs', 'bin/model-id.mjs', 'bin/install-worktree.mjs', 'lib/commands.md', 'tools/worktree/wt.zsh', 'tools/worktree/defaults.conf', 'public/index.html', 'public/vendor/marked.min.js', 'LICENSE', 'README.md'];
ok('A2 N2 N6 …and every file the runtime reads, the command table and tools/ included', NEEDED.every((f) => listed.includes(f)), NEEDED.filter((f) => !listed.includes(f)).join(' | '));

/* ── a global prefix ─────────────────────────────────────────────────── */
console.log('\npackage: npm install -g into a temp prefix');
const prefix = path.join(sb, 'prefix');
const inst = npm(sb, 'install', '-g', '--prefix', prefix, tarball);
const PKG = path.join(prefix, 'lib', 'node_modules', 'agent-config-studio');
const ACS = path.join(prefix, 'bin', 'acs');
ok('A3 npm install -g puts acs in the prefix\'s bin', inst.status === 0 && fs.lstatSync(ACS).isSymbolicLink(), `${inst.stdout}${inst.stderr}`);
const sh = (cmd, extra = {}, cwd = sb) => {
  const r = spawnSync('/bin/sh', ['-c', cmd], { cwd, env: env(extra), encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};
const q = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
const help = sh(`${q(ACS)} help`);
ok('N5 acs help names the npm package as how it was installed', help.code === 0 && /^installed:\s+npm package/m.test(help.out) && help.out.includes(`checkout:    ${PKG}`), help.out.slice(-300));

for (const [cmd, want] of [['install', /not needed: npm put acs on your PATH/], ['uninstall', /npm uninstall -g agent-config-studio/], ['update', /this is the npm package — update it with: npm install -g agent-config-studio/]]) {
  const r = sh(`${q(ACS)} ${cmd}`);
  ok(`A4 N5 acs ${cmd} from the npm package refuses, saying what to do instead`, r.code === 1 && want.test(r.out), r.out);
}
ok('A4 …and no link was made on PATH', !fs.existsSync(path.join(home, '.local', 'bin', 'acs')));

{
  // N4: npm brings no git. Everything the launcher needs but git.
  const tools = path.join(sb, 'no-git');
  fs.mkdirSync(tools);
  fs.symlinkSync(process.execPath, path.join(tools, 'node'));
  for (const t of ['dirname', 'readlink', 'ps', 'sed', 'grep', 'cmp']) fs.symlinkSync(which(t), path.join(tools, t));
  const r = spawnSync('/bin/sh', [ACS], { cwd: sb, env: { ...env(), PATH: tools, ACS_PORT: String(await freePort()) }, encoding: 'utf8' });
  ok('N4 no git on PATH: acs refuses to start, naming git and why', r.status === 1 && /git is required and is not on PATH/.test(r.stderr) && /history/.test(r.stderr) && !/starting/.test(r.stdout), `${r.stdout}${r.stderr}`);
}

function freePort() {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}
const health = async (port) => { try { return (await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()).app === 'agent-config-studio'; } catch { return false; } };
const live = [];
/** `cmd` under sh, as a terminal would run it; resolves once /api/health answers (or it exits). */
async function start(cmd, port, { cwd = sb, extra = {} } = {}) {
  let out = '';
  const child = spawn('/bin/sh', ['-c', cmd], { cwd, env: env({ ACS_PORT: String(port), ...extra }), stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const s = { child, out: () => out, exited: null, port };
  child.on('exit', (c) => { s.exited = c; });
  live.push(s);
  for (let i = 0; i < 300 && s.exited === null && !(await health(port)); i++) await sleep(100);
  s.up = await health(port);
  return s;
}
/** Until the launcher exits — at most 15 s, then it is killed, so a failed stop cannot hang the suite. */
const waitExit = (s) => new Promise((res) => {
  if (s.exited !== null) return res();
  const t = setTimeout(() => { s.child.kill('SIGKILL'); res(); }, 15_000);
  s.child.once('exit', () => { clearTimeout(t); res(); });
});
const api = async (port, p, body) => {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  return { status: r.status, text: await r.text() };
};

/** Every entry under `dir`: path, kind, mode and content hash (a link by its target). */
function tree(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of fs.readdirSync(d).sort()) {
      const abs = path.join(d, name);
      const st = fs.lstatSync(abs);
      const rel = path.relative(dir, abs);
      if (st.isSymbolicLink()) out.push(`${rel} l ${fs.readlinkSync(abs)}`);
      else if (st.isDirectory()) { out.push(`${rel} d ${(st.mode & 0o7777).toString(8)}`); walk(abs); }
      else out.push(`${rel} f ${(st.mode & 0o7777).toString(8)} ${crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex')}`);
    }
  };
  walk(dir);
  return out;
}
function chmodTree(dir, writable) {
  const set = (p, st) => fs.chmodSync(p, writable ? (st.mode | 0o200) & 0o7777 : (st.mode & ~0o222) & 0o7777);
  const walk = (d) => {
    if (writable) set(d, fs.statSync(d));
    for (const name of fs.readdirSync(d)) {
      const abs = path.join(d, name);
      const st = fs.lstatSync(abs);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(abs); else set(abs, st);
    }
    if (!writable) set(d, fs.statSync(d));
  };
  walk(dir);
}

/* ── A3 A4 A5 N6 N8: the read-only global install, run for real ───────── */
console.log('\npackage: a read-only install, started and used');
const pkgBefore = tree(PKG);
chmodTree(PKG, false);
let writeProbe = 'writable';
try { fs.writeFileSync(path.join(PKG, 'probe'), 'x'); fs.rmSync(path.join(PKG, 'probe')); } catch (e) { writeProbe = e.code; }
ok('A5 the package dir is read-only to this user', writeProbe === 'EACCES', writeProbe);
// The system temp dir's prompt folder exists and is not writable, so a
// prompt file has to take the fallback path (lib/harness.js promptDir).
const tmp = path.join(sb, 'tmp');
fs.mkdirSync(path.join(tmp, 'acs-harness-prompts'), { recursive: true });
fs.chmodSync(path.join(tmp, 'acs-harness-prompts'), 0o500);
fs.rmSync(gitLog, { force: true });
{
  const port = await freePort();
  const s = await start(q(ACS), port, { cwd: PKG, extra: { TMPDIR: tmp } });
  ok('A3 acs from the npm install starts, standing in the read-only package dir', s.up, s.out().slice(-600));
  ok('A4 it prints the npm update hint', /npm package — update: npm install -g agent-config-studio \(or npx agent-config-studio@latest\)/.test(s.out()), s.out().slice(0, 400));
  ok('A4 …and no self-update: nothing fetched, pulled or merged', !/updated to|not updating|could not reach origin/.test(s.out()) && !gitCalls().some((l) => /\b(fetch|pull|merge)\b/.test(l)), gitCalls().join(' | '));
  ok('A4 N5 the only git calls aimed at the package dir are the read-only checkout probe', gitCalls().filter((l) => l.includes(PKG)).every((l) => /^-C \S+ (rev-parse --show-toplevel|-c core\.fsmonitor=false ls-files --error-unmatch -- bin\/acs)$/.test(l)), gitCalls().filter((l) => l.includes(PKG)).join(' | '));
  ok('N4 history git did run (the user\'s history repo, not the package)', fs.existsSync(path.join(home, '.agent-config-studio', 'history', '.git')));

  const index = await api(port, '/');
  ok('N6 / serves the UI', index.status === 200 && /<title>/.test(index.text) && /app\.js/.test(index.text), index.text.slice(0, 200));
  const assets = [...index.text.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map((m) => m[1]);
  const got = await Promise.all(assets.map(async (a) => [a, (await api(port, a)).status]));
  ok(`N6 every asset index.html names answers 200 (${assets.length})`, assets.length >= 7 && got.every(([, c]) => c === 200), JSON.stringify(got));

  const clis = JSON.parse((await api(port, '/api/setup/clis')).text);
  ok('N6 /api/setup/clis answers with the CLIs', Array.isArray(clis.clis) && clis.clis.length === 3, JSON.stringify(clis).slice(0, 300));
  ok('N6 N2 …and the command table is there: the next steps and the PATH row', clis.next?.length === 2 && clis.next.every((n) => n.command) && clis.path?.command, JSON.stringify({ next: clis.next, path: clis.path }));
  ok('N7 the setup screen offers npm\'s global install, not `acs install`, under npm', clis.path?.key === 'next.npm' && clis.path.command === 'npm install -g agent-config-studio', JSON.stringify(clis.path));
  const wrong = await api(port, '/api/stop', { token: '00'.repeat(32) });
  const none = await api(port, '/api/stop', {});
  ok('N7 /api/stop refuses a wrong or missing token, and the studio keeps running', wrong.status === 403 && none.status === 403 && await health(port), `${wrong.status} ${none.status}`);
  const cross = await fetch(`http://127.0.0.1:${port}/api/stop`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }, body: JSON.stringify({ token: JSON.parse(fs.readFileSync(path.join(home, '.agent-config-studio', 'run', `${port}.json`), 'utf8')).stopToken }) });
  ok('N7 …and a cross-site request, even with the right token', cross.status === 403 && await health(port), String(cross.status));
  const done = await api(port, '/api/setup/complete', { completed: 'done' });
  ok('A5 setup completes, writing the user\'s studio dir', done.status === 200 && fs.existsSync(path.join(home, '.agent-config-studio', 'setup.json')), done.text);

  const chat = await fetch(`http://127.0.0.1:${port}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'hi', harness: 'grok' }) });
  const lines = (await chat.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const turn = fs.readFileSync(path.join(path.dirname(grok), 'calls.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((c) => c.argv.includes('--prompt-file'));
  const promptFile = turn?.argv[turn.argv.indexOf('--prompt-file') + 1] || '';
  ok('A5 N8 an Assist turn runs from the read-only install', lines.some((l) => l.t === 'done' && l.ok === true), JSON.stringify(lines).slice(0, 300));
  ok('A5 N8 …its prompt file fell back to ~/.agent-config-studio/tmp, not the cwd (the package)', promptFile.startsWith(path.join(home, '.agent-config-studio', 'tmp') + path.sep), promptFile);

  const usage = sh(`${q(ACS)} usage --json`, { TMPDIR: tmp }, PKG);
  let parsed = null;
  try { parsed = JSON.parse(usage.out); } catch {}
  ok('N6 the usage collector runs from the install (a reading, not a stored snapshot)', usage.code === 0 ? Array.isArray(parsed?.seats) && typeof parsed.takenAt === 'number' : usage.out.trim().length > 0, usage.out.slice(0, 300));

  const mid = sh(`${q(ACS)} install-model-id`, {}, PKG);
  ok('N3 acs install-model-id installs from the packed install', mid.code === 0 && fs.existsSync(path.join(home, '.local', 'bin', 'model-id')), mid.out);
  const resolved = sh(`${q(path.join(home, '.local', 'bin', 'model-id'))} opus`, {}, sb);
  ok('N3 …and the installed resolver executes', resolved.code === 0 && /^claude-/.test(resolved.out), resolved.out);
  const wt = sh(`${q(ACS)} install-worktree`, { ZDOTDIR: home }, PKG);
  ok('N6 acs install-worktree installs from the packed install', wt.code === 0 && fs.readFileSync(path.join(home, '.config', 'worktree', 'wt.zsh')).equals(fs.readFileSync(path.join(PKG, 'tools', 'worktree', 'wt.zsh'))) && /wt\.zsh/.test(fs.readFileSync(path.join(home, '.zshrc'), 'utf8')), wt.out);

  const stop = sh(`${q(ACS)} stop`, { ACS_PORT: String(port) }, PKG);
  await waitExit(s);
  ok('A3 acs stop stops it', stop.code === 0 && /stopped/.test(stop.out) && !(await health(port)), stop.out);
}

console.log('\npackage: after an npm update (N9)');
{
  const studio = path.join(home, '.agent-config-studio');
  const record = path.join(studio, 'worktree-source');
  ok('N9 install-worktree recorded what it installed from', ['wt.zsh', 'defaults.conf'].every((f) => fs.readFileSync(path.join(record, f)).equals(fs.readFileSync(path.join(PKG, 'tools', 'worktree', f)))));
  /** One start and stop: whether it came up (health answered), and what it printed. */
  const startOut = async () => {
    const port = await freePort();
    const s = await start(q(ACS), port, { cwd: PKG });
    sh(`${q(ACS)} stop`, { ACS_PORT: String(port) });
    await waitExit(s);
    return { up: s.up, out: s.out() };
  };
  // The package moved on from what was installed: older copies, older record.
  fs.appendFileSync(path.join(studio, 'resolver', 'lib', 'models.js'), '// an older copy\n');
  fs.appendFileSync(path.join(record, 'defaults.conf'), '# an older package\n');
  const first = await startOut();
  ok('N9 the first start names the stale model-id resolver', first.up && /installed model-id resolver is older than this package — run: acs install-model-id/.test(first.out), first.out.slice(0, 600));
  ok('N9 …and a change to defaults.conf alone names the worktree tools', first.up && /the worktree tools changed in this package — run: acs install-worktree/.test(first.out), first.out.slice(0, 600));
  sh(`${q(ACS)} install-model-id`);
  sh(`${q(ACS)} install-worktree`, { ZDOTDIR: home });
  const clean = await startOut();
  ok('N9 reinstalled: it starts, with no reminder', clean.up && !/older than this package|changed in this package/.test(clean.out), clean.out.slice(0, 600));
  // A user's own defaults.conf is kept by the installer and is not a reminder.
  fs.appendFileSync(path.join(home, '.config', 'worktree', 'defaults.conf'), '# mine\n');
  const mine = await startOut();
  ok('N9 a customised defaults.conf, the package unchanged: it starts, with no reminder', mine.up && !/changed in this package/.test(mine.out), mine.out.slice(0, 600));
  fs.appendFileSync(path.join(record, 'wt.zsh'), '# an older package\n');
  const wtz = await startOut();
  ok('N9 a change to wt.zsh names the worktree tools too', wtz.up && /the worktree tools changed in this package/.test(wtz.out), wtz.out.slice(0, 600));
  // An install from before the record: its wt.zsh is what is compared.
  fs.rmSync(record, { recursive: true });
  fs.appendFileSync(path.join(home, '.config', 'worktree', 'wt.zsh'), '# an older copy\n');
  const old = await startOut();
  ok('N9 no record (an older install): a stale wt.zsh is still named', old.up && /installed worktree tools are older than this package/.test(old.out), old.out.slice(0, 600));
  sh(`${q(ACS)} install-worktree --replace-defaults`, { ZDOTDIR: home });
}

chmodTree(PKG, true);
const pkgAfter = tree(PKG);
const changed = [...pkgAfter.filter((l) => !pkgBefore.includes(l)), ...pkgBefore.filter((l) => !pkgAfter.includes(l))];
ok(`A5 N8 the package is byte-for-byte, mode-for-mode what npm installed (${pkgBefore.length} entries)`, changed.length === 0, changed.slice(0, 10).join(' | '));

/* ── N5: a package inside someone's repo ──────────────────────────────── */
console.log('\npackage: installed inside another repo');
{
  const proj = path.join(sb, 'their-project');
  const origin = path.join(sb, 'their-origin.git');
  fs.mkdirSync(proj);
  git(proj, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(proj, 'app.txt'), 'theirs\n');
  git(proj, 'add', '.');
  git(proj, 'commit', '-q', '-m', 'theirs');
  git(sb, 'clone', '-q', '--bare', proj, origin);
  git(proj, 'remote', 'add', 'origin', origin);
  git(proj, 'fetch', '-q', 'origin');
  git(proj, 'remote', 'set-head', 'origin', 'main');
  git(proj, 'branch', '-q', '--set-upstream-to', 'origin/main');
  fs.rmSync(path.join(proj, '.git', 'FETCH_HEAD'), { force: true });
  // origin moves on, so a fetch and fast-forward would show.
  const other = path.join(sb, 'their-other');
  git(sb, 'clone', '-q', origin, other);
  fs.writeFileSync(path.join(other, 'app.txt'), 'theirs v2\n');
  git(other, 'commit', '-q', '-am', 'v2');
  git(other, 'push', '-q', 'origin', 'main');
  const head = git(proj, 'rev-parse', 'HEAD');
  const local = npm(proj, 'install', tarball);
  const pAcs = path.join(proj, 'node_modules', '.bin', 'acs');
  ok('N5 npm install into the project gives node_modules/.bin/acs', local.status === 0 && fs.existsSync(pAcs), `${local.stdout}${local.stderr}`);
  fs.rmSync(gitLog, { force: true });
  const up = sh(`${q(pAcs)} update`, {}, proj);
  ok('N5 acs update there refuses (the npm package), and does not touch their repo', up.code === 1 && /npm package/.test(up.out), up.out);
  const port = await freePort();
  const s = await start(q(pAcs), port, { cwd: proj });
  ok('N5 acs starts from inside their repo', s.up, s.out().slice(-400));
  sh(`${q(pAcs)} stop`, { ACS_PORT: String(port) }, proj);
  await waitExit(s);
  ok('N5 their repo was never fetched or fast-forwarded', git(proj, 'rev-parse', 'HEAD') === head && !fs.existsSync(path.join(proj, '.git', 'FETCH_HEAD'))
     && !gitCalls().some((l) => /\b(fetch|pull|merge)\b/.test(l)), gitCalls().join(' | '));
  ok('N5 …and help calls it the npm package, not a checkout', /^installed:\s+npm package/m.test(sh(`${q(pAcs)} help`, {}, proj).out));
}

/* ── N7: npx, and stopping across installs ────────────────────────────── */
console.log('\npackage: npx');
{
  const npx = `npx --yes ${q(`file:${tarball}`)}`;
  const port = await freePort();
  const s = await start(npx, port, { cwd: sb });
  ok('N7 npx <tarball> starts the studio', s.up, s.out().slice(-400));
  const served = JSON.parse(fs.readFileSync(path.join(home, '.agent-config-studio', 'run', `${port}.json`), 'utf8')).server;
  ok('N7 …from npx\'s own cache', /[\\/]_npx[\\/]/.test(served), served);
  const clis = JSON.parse((await api(port, '/api/setup/clis')).text);
  ok('N7 under npx the next steps say npx agent-config-studio …', clis.next?.every((n) => n.command.startsWith('npx agent-config-studio ')), JSON.stringify(clis.next));
  const stop = sh(`${npx} stop`, { ACS_PORT: String(port) });
  await waitExit(s);
  ok('N7 `npx agent-config-studio stop` stops it', stop.code === 0 && /stopped/.test(stop.out) && !(await health(port)), stop.out);

  // Started by one install, stopped by another (another version or cache).
  const port2 = await freePort();
  const g = await start(q(ACS), port2);
  const cross = sh(`${npx} stop`, { ACS_PORT: String(port2) });
  await waitExit(g);
  ok('N7 a studio the global install started is stopped by npx\'s acs', g.up && cross.code === 0 && /stopped/.test(cross.out) && !(await health(port2)), cross.out);

  // The install that started it is gone (npx's cache cleaned, an old version
  // removed): its studio is still stopped, from what it recorded at start.
  for (const [what, dir] of [['deleted before acs stop', 'gone-prefix'], ['whose path holds a " (JSON-escaped in the run file) and a space', 'odd"pre fix']]) {
    // Installed under a plain name, then moved (its bin link is relative). A
    // backslash is not tried: Node's ESM loader refuses any module path with one.
    const other = path.join(sb, dir);
    const r = npm(sb, 'install', '-g', '--prefix', path.join(sb, 'plain-prefix'), tarball);
    fs.renameSync(path.join(sb, 'plain-prefix'), other);
    const port3 = await freePort();
    const o = await start(q(path.join(other, 'bin', 'acs')), port3);
    if (what.startsWith('deleted')) fs.rmSync(other, { recursive: true, force: true });
    const st = sh(`${q(ACS)} stop`, { ACS_PORT: String(port3) });
    await waitExit(o);
    ok(`N7 a studio started by another install ${what}: acs stop stops it`, r.status === 0 && o.up && st.code === 0 && /stopped/.test(st.out) && !(await health(port3)), `${r.stderr || ''} ${st.out} ${o.out().slice(-200)}`);
  }

  // Impostors: a health answer and a run file that agree name a pid that is
  // not a studio. The liar runs in its own process and the launcher runs
  // asynchronously, so every answer arrives and each refusal is the identity
  // check's, named by its reason — never a timeout.
  const pkgShaped = path.join(sb, 'impostor', 'node_modules', 'agent-config-studio', 'server.js');
  fs.mkdirSync(path.dirname(pkgShaped), { recursive: true });
  fs.writeFileSync(pkgShaped, 'setTimeout(() => {}, 60000);\n');
  const worker = path.join(sb, 'unrelated', 'worker.js');
  fs.mkdirSync(path.dirname(worker), { recursive: true });
  fs.writeFileSync(worker, 'setTimeout(() => {}, 60000);\n');
  const liarJs = path.join(sb, 'liar.cjs');
  fs.writeFileSync(liarJs, `
const http = require('http');
const [port, pid, nonce, stopStatus] = process.argv.slice(2);
http.createServer((req, res) => {
  if (req.url === '/api/stop') {
    req.resume();
    res.writeHead(Number(stopStatus), { 'content-type': 'application/json' });
    return res.end(JSON.stringify(stopStatus === '200' ? { stopping: true } : { error: 'no' }));
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ app: 'agent-config-studio', pid: Number(pid), nonce }));
}).listen(Number(port), '127.0.0.1', () => process.stdout.write('up\\n'));
`);
  const shAsync = (cmd, extra) => new Promise((res) => {
    const c = spawn('/bin/sh', ['-c', cmd], { cwd: sb, env: env(extra), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { out += d; });
    c.on('exit', (code) => res({ code, out }));
  });
  const PKG_SERVER = path.join(PKG, 'server.js');
  const nonce = 'cd'.repeat(16);
  for (const [what, argv, token, healthNonce, stopStatus, reason] of [
    ['token run file: `node worker.js <this install>/server.js`', [worker, PKG_SERVER], true, nonce, 403, /refused the stop token in its run file — not touching it/],
    ['token run file: a health answer whose nonce is not the run file\'s', [worker, PKG_SERVER], true, 'ab'.repeat(16), 200, /not the one its run file names — not touching it/],
    ['token run file: a program at a package-shaped path that accepts and keeps listening', [pkgShaped], true, nonce, 200, /accepted but is still listening/],
    ['legacy run file: `node worker.js <this install>/server.js`', [worker, PKG_SERVER], false, nonce, 403, /not this checkout's .* start — not touching it/],
    ['legacy run file: a program at a package-shaped path', [pkgShaped], false, nonce, 403, /not this checkout's .* start — not touching it/],
    ['legacy run file: an unrelated script given the package path', [worker, pkgShaped], false, nonce, 403, /not this checkout's .* start — not touching it/],
  ]) {
    const port4 = await freePort();
    const victim = spawn(process.execPath, argv, { stdio: 'ignore' });
    const liar = spawn(process.execPath, [liarJs, String(port4), String(victim.pid), healthNonce, String(stopStatus)], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise((res) => { liar.stdout.once('data', res); liar.once('exit', res); });
    const runFile = path.join(home, '.agent-config-studio', 'run', `${port4}.json`);
    fs.mkdirSync(path.dirname(runFile), { recursive: true });
    fs.writeFileSync(runFile, JSON.stringify({ pid: victim.pid, nonce, server: argv.at(-1), ...(token ? { stopToken: 'ef'.repeat(32) } : {}) }), { mode: 0o600 });
    const t0 = Date.now();
    const st = await shAsync(`${q(ACS)} stop`, { ACS_PORT: String(port4) });
    await sleep(300);
    let alive = true;
    try { process.kill(victim.pid, 0); } catch { alive = false; }
    ok(`N7 ${what}: refused for that reason, nothing signalled`, st.code === 1 && reason.test(st.out) && alive, `${st.code} ${Date.now() - t0}ms ${st.out} alive=${alive}`);
    victim.kill('SIGKILL');
    liar.kill('SIGKILL');
    fs.rmSync(runFile, { force: true });
  }

  // The control: a legacy run file naming a process whose command line is
  // exactly `node <this install>/server.js` is signalled — so the refusals
  // above are the command-line check, not a pid fallback that never fires.
  {
    const port5 = await freePort();
    const ctrlHome = path.join(sb, 'ctrl-home');
    fs.mkdirSync(ctrlHome, { recursive: true });
    const real = spawn(process.execPath, [PKG_SERVER], { cwd: sb, env: { ...env(), HOME: ctrlHome, PORT: String(await freePort()) }, stdio: 'ignore' });
    await sleep(1500);
    const liar = spawn(process.execPath, [liarJs, String(port5), String(real.pid), nonce, '403'], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise((res) => { liar.stdout.once('data', res); liar.once('exit', res); });
    const runFile = path.join(home, '.agent-config-studio', 'run', `${port5}.json`);
    fs.writeFileSync(runFile, JSON.stringify({ pid: real.pid, nonce, server: PKG_SERVER }), { mode: 0o600 });
    const st = await shAsync(`${q(ACS)} stop`, { ACS_PORT: String(port5) });
    const gone = await new Promise((res) => { if (real.exitCode !== null || real.signalCode) return res(true); const t = setTimeout(() => res(false), 5000); real.once('exit', () => { clearTimeout(t); res(true); }); });
    ok('N7 control: a legacy run file and exactly `node <this install>/server.js`: signalled', st.code === 0 && /stopped/.test(st.out) && gone, `${st.code} ${st.out} gone=${gone}`);
    real.kill('SIGKILL');
    liar.kill('SIGKILL');
    fs.rmSync(runFile, { force: true });
  }
}

/* ── N5: a real ACS worktree, whose .git is a file; a foreign repo with a bin/acs ── */
console.log('\npackage: a git worktree of ACS still updates; a foreign repo does not');
{
  /** A repo holding `files` (relative path → source or bytes), on main, with a bare origin and a second clone. */
  const repo = (tag, files) => {
    const seed = path.join(sb, `${tag}-seed`);
    for (const [rel, body] of Object.entries(files)) {
      const to = path.join(seed, rel);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      if (Buffer.isBuffer(body) || typeof body === 'string') fs.writeFileSync(to, body);
      else { fs.copyFileSync(body.from, to); fs.chmodSync(to, fs.statSync(body.from).mode & 0o777); }
    }
    fs.writeFileSync(path.join(seed, 'app.txt'), 'v1\n');
    git(seed, 'init', '-q', '-b', 'main');
    git(seed, 'add', '.');
    git(seed, 'commit', '-q', '-m', 'v1');
    const origin = path.join(sb, `${tag}-origin.git`);
    git(sb, 'clone', '-q', '--bare', seed, origin);
    git(seed, 'remote', 'add', 'origin', origin);
    const clone = path.join(sb, `${tag}-clone`);
    git(sb, 'clone', '-q', origin, clone);
    const push = () => { fs.writeFileSync(path.join(seed, 'app.txt'), 'v2\n'); git(seed, 'commit', '-q', '-am', 'v2'); git(seed, 'push', '-q', 'origin', 'main'); };
    return { seed, clone, push };
  };

  // ACS-shaped: this tree's tracked files, as a clone has them.
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0')
    .filter((f) => f && fs.existsSync(path.join(ROOT, f)) && !fs.lstatSync(path.join(ROOT, f)).isSymbolicLink());
  const acsRepo = repo('acs', Object.fromEntries(tracked.map((f) => [f, { from: path.join(ROOT, f) }])));
  git(acsRepo.clone, 'checkout', '-q', '-b', 'elsewhere');
  const wtDir = path.join(sb, 'acs-wt');
  git(acsRepo.clone, 'worktree', 'add', '-q', wtDir, 'main');
  ok('N5 the ACS worktree\'s .git is a file', fs.statSync(path.join(wtDir, '.git')).isFile());
  ok('N5 help calls it a git checkout', /^installed:\s+git checkout/m.test(sh(`${q(path.join(wtDir, 'bin', 'acs'))} help`).out));
  acsRepo.push();
  const r = sh(`${q(path.join(wtDir, 'bin', 'acs'))} update`);
  ok('N5 acs update fast-forwards the ACS worktree', r.code === 0 && /updated to \w+ v2/.test(r.out) && fs.readFileSync(path.join(wtDir, 'app.txt'), 'utf8') === 'v2\n', r.out);

  // Foreign: its own bin/acs (a copy of ours), server.js and package.json at the top level — another tool's.
  const foreign = repo('foreign', {
    'bin/acs': { from: path.join(ROOT, 'bin', 'acs') },
    'server.js': '// another tool\n',
    'package.json': '{\n  "name": "some-other-tool",\n  "version": "1.0.0"\n}\n',
  });
  const head = git(foreign.clone, 'rev-parse', 'HEAD');
  foreign.push();
  fs.rmSync(gitLog, { force: true });
  const fh = sh(`${q(path.join(foreign.clone, 'bin', 'acs'))} help`);
  ok('N5 a foreign repo with its own bin/acs is not called a checkout', /^installed:\s+a copy without git/m.test(fh.out), fh.out.slice(-200));
  const fu = sh(`${q(path.join(foreign.clone, 'bin', 'acs'))} update`);
  ok('N5 …and acs update there never fetches or fast-forwards it', fu.code === 0 && git(foreign.clone, 'rev-parse', 'HEAD') === head
     && !fs.existsSync(path.join(foreign.clone, '.git', 'FETCH_HEAD')) && !gitCalls().some((l) => /\b(fetch|pull|merge)\b/.test(l)), `${fu.out} ${gitCalls().join(' | ')}`);
}

for (const s of live) if (s.exited === null) s.child.kill('SIGKILL');
try { chmodTree(PKG, true); } catch {}
fs.chmodSync(path.join(tmp, 'acs-harness-prompts'), 0o700);
fs.rmSync(sb, { recursive: true, force: true });
assertRealHomesUnchanged(realBefore, ok);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
