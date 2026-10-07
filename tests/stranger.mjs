/**
 * A stranger follows the README, offline (builds/ready-for-strangers item 5,
 * B5, B6, B10). Every command line in the README's Get started section is run,
 * in order, by the production launcher: bin/acs → server.js, with no fixture
 * seam. The test fails on any line it does not know how to run.
 *
 * Two candidates, both THIS working tree (tracked and new files, minus .git):
 *
 *   A. a copy, in a path with a space. `git clone` becomes that copy, and the
 *      copy's README and bin/acs are byte-identical to the worktree's. Setup
 *      is driven through the real UI (the VM page, proxied to the server).
 *      Home and the views then show what the temp HOME holds: the CLIs, a
 *      seat, the folder, skills, MCP, models, context and worktrees.
 *   B. a real `git clone` of a local bare repo holding that tree, so the
 *      launcher's update runs. A commit lands on origin, then `acs` through
 *      the PATH link fast-forwards and re-executes itself through that link.
 *
 * Offline throughout. A fake `security` and fake CLIs record every call; the
 * PATH holds no real CLI; HOME is a temp folder. The test asserts that no
 * Keychain read, no usage refresh, no Check now, and no CLI call beyond
 * `--version` happened.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshotRealHomes, assertRealHomesUnchanged } from './real-home.mjs';
import { bootPage, settle } from './fixtures/shell-page.mjs';
import { fakeCli, recorder, isolatedPath, calls } from './fixtures/setup-home.mjs';
import { getStartedCommands } from './fixtures/readme.mjs';

const ROOT = fs.realpathSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const realBefore = snapshotRealHomes();
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: { ...process.env, ...GIT_ENV }, encoding: 'utf8' }).trim();

const COMMANDS = getStartedCommands();
const CLONE_RE = /^git clone (https:\/\/\S+?)(?:\s+(\S+))?$/;
ok('B10 Get started opens with a git clone', CLONE_RE.test(COMMANDS[0] || ''), COMMANDS[0]);

/** The candidate: tracked and new files, as the working tree has them. */
const CANDIDATE = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' })
  .split('\0').filter((f) => f && fs.existsSync(path.join(ROOT, f)));
function copyCandidate(dest) {
  for (const rel of CANDIDATE) {
    const from = path.join(ROOT, rel);
    const to = path.join(dest, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    const st = fs.lstatSync(from);
    if (st.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(from), to);
    else { fs.copyFileSync(from, to); fs.chmodSync(to, st.mode & 0o777); }
  }
}

const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const healthy = async (port) => { try { return (await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()).app === 'agent-config-studio'; } catch { return false; } };

/** A stranger's machine: temp HOME with something in each surface, fake CLIs, no real one on PATH. */
async function machine(tag) {
  const sb = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `acs-stranger-${tag}-`)));
  const home = path.join(sb, 'home');
  const bin = path.join(sb, 'bin');
  const tmp = path.join(sb, 'tmp');
  const elsewhere = path.join(sb, 'elsewhere');
  for (const d of [home, tmp, elsewhere, path.join(home, '.local', 'bin')]) fs.mkdirSync(d, { recursive: true });
  // Each fake sits where production discovery looks FIRST (lib/harness.js
  // CLI_CANDIDATES): claude's and grok's fixed home locations come before
  // /usr/local/bin and /opt/homebrew/bin, codex's PATH before those. A real
  // CLI installed there can then never be picked; the resolved paths are
  // asserted below all the same.
  const cliDirs = { claude: path.join(home, '.local', 'bin'), grok: path.join(home, '.grok', 'bin'), codex: bin };
  for (const [c, d] of Object.entries(cliDirs)) fakeCli(d, c, { version: `${c} 4.0.0 (fake)` });
  recorder(bin, 'security');
  const w = (rel, body) => { const f = path.join(home, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); return f; };
  w('.claude/skills/hello-stranger/SKILL.md', '---\nname: hello-stranger\ndescription: Says hello. Use when greeting.\n---\n\nSay hello.\n');
  w('.claude.json', JSON.stringify({ mcpServers: { 'stranger-mcp': { command: 'stranger-mcp-server' } } }));
  w('code/work/app/CLAUDE.md', '# app\n\nstranger app rules\n');
  fs.mkdirSync(path.join(home, 'code', 'work', 'app', '.git'), { recursive: true });
  w('.config/worktree/repos/app.conf', `CMD=\nTRUNK="${path.join(home, 'code', 'work', 'app')}"\n`);
  const port = await freePort();
  const env = {
    HOME: home, PATH: `${path.join(home, '.local', 'bin')}:${isolatedPath(bin)}`, SHELL: '/bin/sh', TMPDIR: tmp,
    ACS_PORT: String(port), ACS_NO_OPEN: '1', ...GIT_ENV,
  };
  const allCalls = () => [...new Set(Object.values(cliDirs))].map((d) => calls(d)).join('');
  return { sb, root: sb, home, bin, tmp, elsewhere, port, env, allCalls };
}

/** Runs the README's Get started lines in order. `hooks` are the person's actions between them. */
async function followReadme(m, { materialize, startEnv = {}, afterStart, onLine = {} }) {
  let cwd = m.sb;
  let launcher = null;
  const results = [];
  for (const line of COMMANDS) {
    let r = null;
    const clone = line.match(CLONE_RE);
    if (clone) {
      const name = clone[2] || path.basename(clone[1]).replace(/\.git$/, '');
      await materialize(path.join(cwd, name), clone[1]);
      r = { code: 0, out: '' };
    } else if (/^cd \S+$/.test(line)) {
      cwd = path.join(cwd, line.slice(3));
      r = { code: fs.statSync(cwd).isDirectory() ? 0 : 1, out: '' };
    } else if (line === './bin/acs' && !launcher) {
      let out = '';
      const child = spawn('/bin/sh', ['-c', line], { cwd, env: { ...m.env, ...startEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { out += d; });
      launcher = { child, out: () => out, exited: null };
      child.on('exit', (c) => { launcher.exited = c; });
      let up = false;
      for (let i = 0; i < 200 && launcher.exited === null && !up; i++) { up = await healthy(m.port); if (!up) await sleep(100); }
      r = { code: up ? 0 : 1, out: out };
      ok(`${m.tag} \`${line}\` starts the studio`, up, out.slice(-500));
      if (up && afterStart) await afterStart({ cwd, launcher });
    } else if (/^(\.\/bin\/)?acs( [a-z-]+)?$/.test(line)) {
      // Bare `acs` lines run from an unrelated folder, the way a new terminal would.
      const where = line.startsWith('./') ? cwd : m.elsewhere;
      if (onLine[line]) await onLine[line]({ cwd });
      if (line === 'acs') {
        // Running already: it says so and exits. Not running: it starts and stays.
        const wasUp = await healthy(m.port);
        let out = '';
        let exited = null;
        const child = spawn('/bin/sh', ['-c', line], { cwd: where, env: m.env, stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', (d) => { out += d; });
        child.on('exit', (c) => { exited = c; });
        for (let i = 0; i < 200 && exited === null && (wasUp || !(await healthy(m.port))); i++) await sleep(100);
        if (exited === null) {
          launcher = { child, out: () => out, exited: null };
          child.on('exit', (c) => { launcher.exited = c; });
        }
        r = { code: exited ?? 0, out, up: await healthy(m.port) };
      } else {
        const s = spawnSync('/bin/sh', ['-c', line], { cwd: where, env: m.env, encoding: 'utf8' });
        r = { code: s.status, out: `${s.stdout}${s.stderr}` };
      }
    } else {
      ok(`${m.tag} the stranger test knows how to run every Get started line`, false, `unknown README line: ${line}`);
      continue;
    }
    results.push({ line, cwd, ...r });
  }
  return { results, cwd, launcher: () => launcher };
}

const byLine = (results, line) => results.find((r) => r.line === line);

/** bin/model-id arrives as a symlink to model-id.mjs, and `acs install-model-id` works from it on this Node. */
function modelIdChecks(m, checkout, tag) {
  const link = path.join(checkout, 'bin', 'model-id');
  ok(`${tag} bin/model-id arrives as a symlink to model-id.mjs`, fs.lstatSync(link).isSymbolicLink() && fs.readlinkSync(link) === 'model-id.mjs', fs.lstatSync(link).isSymbolicLink() ? fs.readlinkSync(link) : 'a file');
  const inst = spawnSync('/bin/sh', ['-c', 'acs install-model-id'], { cwd: m.elsewhere, env: m.env, encoding: 'utf8' });
  ok(`${tag} \`acs install-model-id\` runs on Node ${process.versions.node}`, inst.status === 0 && fs.existsSync(path.join(m.home, '.local', 'bin', 'model-id')), `${inst.stdout}${inst.stderr}`);
  const r = spawnSync('/bin/sh', ['-c', 'model-id opus'], { cwd: m.elsewhere, env: m.env, encoding: 'utf8' });
  ok(`${tag} …and the installed model-id resolves`, r.status === 0 && /^claude-/.test(r.stdout), `${r.stdout}${r.stderr}`);
}
const waitExit = (l) => new Promise((res) => (!l || l.exited !== null ? res() : l.child.once('exit', res)));

/* ── A: a copy of the candidate, setup through the UI ─────────────────── */
console.log('\nstranger A: a copy of this working tree');
{
  const m = await machine('copy');
  m.tag = 'A';
  const parent = path.join(m.sb, 'my apps');
  fs.mkdirSync(parent);
  m.sb = parent;   // the clone lands in a path with a space
  let checkout = null;
  const flow = await followReadme(m, {
    startEnv: { ACS_NO_UPDATE: '1' },
    materialize: async (dest) => {
      checkout = dest;
      copyCandidate(dest);
      ok('B6 the copy\'s README is the worktree\'s, byte for byte', sha(path.join(dest, 'README.md')) === sha(path.join(ROOT, 'README.md')));
      ok('B6 the copy\'s bin/acs is the worktree\'s, byte for byte', sha(path.join(dest, 'bin', 'acs')) === sha(path.join(ROOT, 'bin', 'acs')));
      ok('B6 …and the copy carries no .git', !fs.existsSync(path.join(dest, '.git')));
    },
    afterStart: async () => {
      const base = `http://localhost:${m.port}`;
      const proxy = async (method, p, body, u) => {
        const r = await fetch(`${base}${p}${u?.search || ''}`, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
        const data = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
        if (!r.ok) throw { status: r.status, body: data };
        return data;
      };
      const page = await bootPage({ routes: proxy });
      const text = () => page.text(page.$('content'));
      const btn = (label) => page.$('content').querySelectorAll('button').find((b) => b.textContent === label);
      const until = async (cond, ms = 10_000) => { const t = Date.now(); while (!cond() && Date.now() - t < ms) await settle(50); return cond(); };
      const step = () => page.eval('SETUP.step');

      // Isolation, proven: every CLI the server resolved is one of the fakes.
      const det = await proxy('GET', '/api/setup/clis');
      const resolved = Object.fromEntries(det.clis.map((c) => [c.id, c.binary]));
      const inside = (b) => typeof b === 'string' && (b.startsWith('~/') || b.startsWith(m.root + path.sep));
      ok('B5 every CLI the server resolved is a fake inside the sandbox (no real claude, codex or grok)',
         ['claude', 'codex', 'grok'].every((c) => inside(resolved[c])), JSON.stringify(resolved));
      ok('A the setup screen opens on first run', await until(() => page.eval('S.view') === 'setup'), page.eval('S.view'));
      ok('A it finds the three CLIs, with the versions they printed', await until(() => ['claude', 'codex', 'grok'].every((c) => text().includes(`${c} 4.0.0 (fake)`))), text().slice(0, 400));
      btn('Next').click();
      await until(() => step() === 'accounts');
      ok('A Accounts suggests a seat from the installed CLIs', await until(() => !!page.$('content').querySelector('[data-suggestion="codex"] button')), text().slice(0, 300));
      page.$('content').querySelector('[data-suggestion="codex"] button').click();
      ok('A …and adds it', await until(() => !!page.$('content').querySelector('[data-seat]')));
      btn('Next').click();
      await until(() => step() === 'folders' && !!btn('Scan for projects'));
      btn('Scan for projects').click();
      ok('A the scan finds ~/code/work', await until(() => !!page.$('content').querySelector('[data-folder="~/code/work"]')), text().slice(0, 400));
      page.confirm = () => true;
      const sel = page.$('content').querySelector('[data-folder="~/code/work"] select');
      sel.value = 'edit'; sel.onchange();
      await settle(50);
      btn('Add selected').click();
      ok('A the folder is added as edit', await until(() => {
        try { return JSON.parse(fs.readFileSync(path.join(m.home, '.agent-config-studio', 'roots.json'), 'utf8')).roots.some((r) => r.access === 'edit' && r.path === path.join(m.home, 'code', 'work')); } catch { return false; }
      }));
      btn('Next').click();
      await until(() => step() === 'done' && !!btn('Finish'));
      const pathRow = page.$('content').querySelector('.setup-path .setup-cmd code')?.textContent;
      ok('A Done shows how to put acs on PATH, with this checkout\'s bin/acs, quoted for its space',
         pathRow === `'${path.join(checkout, 'bin', 'acs')}' install`, pathRow);
      btn('Finish').click();
      ok('A Finish lands on Home', await until(() => page.eval('S.view') === 'home'));
      ok('5 Home shows each CLI', await until(() => ['claude', 'codex', 'grok'].every((c) => text().includes(`${c} 4.0.0 (fake) · sign-in:`))), text().slice(0, 600));
      ok('5 Home shows the seat', await until(() => page.text(page.$('content').querySelector('.home-accounts') || page.$('content')).includes('Codex (primary)')), text().slice(0, 600));
      ok('5 Home shows the folder', await until(() => /Project folders: 1 \(edit\) · 0 \(read\)/.test(text())), text().slice(0, 300));

      for (const [view, open, want] of [
        ['Skills', 'openSkills()', 'hello-stranger'],
        ['MCP', 'openMcp()', 'stranger-mcp'],
        ['Models', 'openModels()', 'claude-opus-5-5'],
        ['Context', 'openContext()', '~/code/work/app'],
        ['Worktrees', 'openWorktrees()', 'app'],
      ]) {
        page.eval(open);
        ok(`B5 ${view} renders from the temp HOME (shows ${want})`, await until(() => text().includes(want)), text().slice(0, 300));
      }
      ok('A no page errors', page.errors.length === 0, page.errors.join(' | '));
      page.done();
    },
    onLine: {},
  });
  const { results } = flow;
  const local = path.join(m.home, '.local', 'bin', 'acs');
  const install = byLine(results, './bin/acs install');
  ok('5 `./bin/acs install` links acs onto the PATH', install?.code === 0 && fs.readlinkSync(local) === path.join(checkout, 'bin', 'acs'), install?.out);
  const again = byLine(results, 'acs');
  ok('5 `acs` from another folder, through the link, finds the running studio', again?.code === 0 && /already running/.test(again.out), again?.out);
  const stop = byLine(results, 'acs stop');
  await waitExit(flow.launcher());
  ok('5 `acs stop` stops it, and the launcher started from the README exits', stop?.code === 0 && /stopped/.test(stop.out) && !(await healthy(m.port)) && flow.launcher().exited !== null, stop?.out);
  const help = byLine(results, 'acs help');
  ok('5 `acs help` through the link names the copied checkout', help?.code === 0 && help.out.includes(`checkout:    ${checkout}`), help?.out.slice(-200));
  modelIdChecks(m, checkout, 'A');
  const un = spawnSync('/bin/sh', ['-c', 'acs uninstall'], { cwd: m.elsewhere, env: m.env, encoding: 'utf8' });
  ok('5 `acs uninstall` (the README\'s way off PATH) removes the link', un.status === 0 && !fs.existsSync(local), `${un.stdout}${un.stderr}`);

  console.log('\nstranger A: isolation');
  ok('B5 no `security` (Keychain) call', !/security/.test(calls(m.bin)), calls(m.bin));
  const cli = m.allCalls().split('\n').filter(Boolean);
  ok('B5 the fake CLIs were only asked --version (no sign-in, no usage, no Check now, no Assist)', cli.length > 0 && cli.every((l) => / --version$/.test(l)), cli.filter((l) => !/ --version$/.test(l)).join(' | '));
  ok('B5 no usage refresh ran (no stored reading)', !fs.existsSync(path.join(m.home, '.agent-config-studio', 'usage-snapshot.json')));
  fs.rmSync(path.dirname(m.sb), { recursive: true, force: true });
}

/* ── B: a real clone, so the launcher updates and re-execs through the link ── */
console.log('\nstranger B: a git clone of a local origin');
{
  const m = await machine('clone');
  m.tag = 'B';
  const work = path.join(m.sb, 'origin-work');
  const bare = path.join(m.sb, 'origin.git');
  copyCandidate(work);
  git(work, 'init', '-q', '-b', 'main');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'candidate');
  git(m.sb, 'clone', '-q', '--bare', work, bare);
  let checkout = null;
  const flow = await followReadme(m, {
    materialize: async (dest, url) => {
      checkout = dest;
      // The README's URL, swapped for the local origin: the one substitution.
      const r = spawnSync('git', ['clone', '-q', bare, dest], { env: { ...process.env, ...GIT_ENV }, encoding: 'utf8' });
      ok(`B6 \`git clone\` (${url} → a local bare repo of this tree)`, r.status === 0, r.stderr);
      ok('B6 the clone\'s bin/acs is the worktree\'s', sha(path.join(dest, 'bin', 'acs')) === sha(path.join(ROOT, 'bin', 'acs')));
    },
    afterStart: async ({ cwd, launcher }) => {
      // A merge lands on origin; this launcher stops so the next `acs` is a fresh start.
      fs.writeFileSync(path.join(work, 'NEWS.txt'), 'merged after the clone\n');
      git(work, 'add', 'NEWS.txt');
      git(work, 'commit', '-q', '-m', 'news from origin');
      git(work, 'push', '-q', bare, 'main');
      spawnSync('/bin/sh', ['-c', './bin/acs stop'], { cwd, env: m.env });
      await waitExit(launcher);
    },
  });
  const { results } = flow;
  const first = byLine(results, './bin/acs');
  ok('B6 the first start fetched origin and had nothing to move', first?.code === 0 && !/updated to/.test(first.out) && !/could not reach origin/.test(first.out), first?.out);
  const again = byLine(results, 'acs');
  const l = flow.launcher();
  ok('B6 `acs` through the PATH link fast-forwards to origin\'s new commit', again && /updated to \w+ news from origin/.test(l.out()), l?.out());
  ok('B6 …re-executes through the link and starts the updated checkout', again?.up === true && fs.existsSync(path.join(checkout, 'NEWS.txt')) && /starting Agent Config Studio/.test(l.out()), l?.out());
  const stop = byLine(results, 'acs stop');
  await waitExit(l);
  ok('B6 `acs stop` stops it', stop?.code === 0 && !(await healthy(m.port)), stop?.out);
  const help = byLine(results, 'acs help');
  ok('B6 `acs help` names the clone', help?.out.includes(`checkout:    ${checkout}`), help?.out.slice(-200));
  modelIdChecks(m, checkout, 'B');
  spawnSync('/bin/sh', ['-c', 'acs uninstall'], { cwd: m.elsewhere, env: m.env });
  ok('B6 uninstalled', !fs.existsSync(path.join(m.home, '.local', 'bin', 'acs')));
  ok('B5 no `security` call here either', !/security/.test(calls(m.bin)), calls(m.bin));
  fs.rmSync(m.sb, { recursive: true, force: true });
}

assertRealHomesUnchanged(realBefore, ok);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
