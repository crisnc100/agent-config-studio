/**
 * The scripted offline walkthrough (builds/setup-screen criterion 8, the
 * program's definition of done for this build).
 *
 * A real server (tests/fixtures/setup-server.mjs: server.js as `acs` starts
 * it, with the fixture usage collector) on an empty temp HOME, fake claude,
 * codex and grok on PATH, a fake `security` that records any call, and a temp
 * projects tree. The real front end, booted in the test VM, drives it the way
 * a person would:
 *
 *   setup opens → the CLIs are detected → (Next, Back, Next) → a seat is
 *   added from a suggestion → it signs in through the fake `codex login`,
 *   polled by setup → Refresh shows its numbers → a scan finds the tree →
 *   that folder is added as edit, through the confirm → Finish → Home shows
 *   the folder count, each CLI and the seat; the folder's context is served.
 *   Steps change only through the real Next / Back / Finish buttons.
 *
 * Nothing reaches a Keychain or the network: no `security` call is recorded,
 * the real config trees are unchanged, and nothing lands outside the sandbox.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshotRealHomes, assertRealHomesUnchanged } from './real-home.mjs';
import { bootPage, settle } from './fixtures/shell-page.mjs';
import { fakeCli, recorder, isolatedPath, calls } from './fixtures/setup-home.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const realBefore = snapshotRealHomes();
const gitStatus = () => execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: ROOT, encoding: 'utf8' });
const statusBefore = gitStatus();
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acs-walkthrough-')));
const home = path.join(sandbox, 'home');
const bin = path.join(sandbox, 'bin');
const tmp = path.join(sandbox, 'tmp');
for (const d of [home, tmp]) fs.mkdirSync(d);
for (const c of ['claude', 'codex', 'grok']) fakeCli(bin, c, { version: `${c} 3.0.0 (fake)` });
recorder(bin, 'security');
const PATH = isolatedPath(bin);
// The projects tree a stranger might have: ~/code/work holding two repos.
const work = path.join(home, 'code', 'work');
for (const repo of ['app', 'lib']) {
  fs.mkdirSync(path.join(work, repo, '.git'), { recursive: true });
  fs.writeFileSync(path.join(work, repo, 'CLAUDE.md'), `# ${repo}\n\nwalkthrough ${repo} rules\n`);
}

console.log('\nsetup walkthrough');
ok('HOME is an empty temp folder, not the real one', home !== os.homedir() && fs.readdirSync(home).join() === 'code');

const port = await new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});
const base = `http://localhost:${port}`;
let log = '', exited = null;
const child = spawn(process.execPath, ['--no-warnings', path.join(ROOT, 'tests', 'fixtures', 'setup-server.mjs'), String(port)], {
  cwd: ROOT, env: { HOME: home, PATH, TMPDIR: tmp, ACS_SUITE: 'offline' }, stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', (b) => { log += b; });
child.stderr.on('data', (b) => { log += b; });
child.on('exit', (code, signal) => { exited = { code, signal }; });
let up = false;
for (let i = 0; i < 200 && !exited && !up; i++) {
  try { up = (await fetch(`${base}/api/health`)).ok; } catch {}
  if (!up) await sleep(100);
}
ok('the server boots on the empty HOME', up, log.slice(-500));

// The real front end against this real server: every request the page makes
// is forwarded, so the page shows exactly what the routes say.
const proxy = async (method, p, body, u) => {
  const r = await fetch(`${base}${p}${u?.search || ''}`, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
  if (!r.ok) throw { status: r.status, body: data };
  return data;
};
const page = await bootPage({ routes: proxy });
const text = () => page.text(page.$('content'));
const btn = (label) => page.$('content').querySelectorAll('button').find((b) => b.textContent === label);
const until = async (cond, ms = 8000) => { const t = Date.now(); while (!cond() && Date.now() - t < ms) await settle(50); return cond(); };

ok('1 setup opens on first run', await until(() => page.eval('S.view') === 'setup'), page.eval('S.view'));
ok('2 the three CLIs are detected, with the versions they printed',
   await until(() => ['claude', 'codex', 'grok'].every((c) => text().includes(`${c} 3.0.0 (fake)`))), text().slice(0, 400));

// Steps change through the real Next / Back buttons, as a person clicks them.
const step = () => page.eval('SETUP.step');
btn('Next').click();
ok('Next moves from CLIs to Accounts', await until(() => step() === 'accounts'));
btn('Back').click();
ok('Back returns to CLIs', await until(() => step() === 'clis' && /Recheck/.test(text())));
btn('Next').click();
await until(() => step() === 'accounts');
ok('4 S2 accounts are suggested from the installed CLIs alone', await until(() => !!page.$('content').querySelector('[data-suggestion="codex"] button')), text().slice(0, 300));
page.$('content').querySelector('[data-suggestion="codex"] button').click();
ok('4 a seat is added from the suggestion', await until(() => !!page.$('content').querySelector('[data-seat]')));
const seats = JSON.parse(fs.readFileSync(path.join(home, '.agent-config-studio', 'seats.json'), 'utf8')).seats;
ok('S3 seats.json holds exactly the detected home', seats.length === 1 && seats[0].vendor === 'codex' && seats[0].home === path.join(home, '.codex'), JSON.stringify(seats));
// The Codex sign-in, from setup, against the fake `codex login`: it prints the
// URL, then writes auth.json; setup's own poller sees the seat signed in.
await until(() => !!btn('Sign in with ChatGPT'));
btn('Sign in with ChatGPT').click();
ok('4 the sign-in starts from setup and shows its link', await until(() => /Open the sign-in page/.test(text())), text().slice(0, 300));
ok('4 …and reaches signed in through the UI', await until(() => /is signed in/.test(page.text(page.$('notice-slot'))), 10_000), page.text(page.$('notice-slot')));
ok('4 …the credential landed in the seat\'s own home', fs.statSync(path.join(home, '.codex', 'auth.json')).size > 0);
await until(() => !!btn('Refresh'));
btn('Refresh').click();
ok('4 Refresh shows the seat\'s numbers', await until(() => /Weekly \(fixture\): 75% left/.test(text())), text().slice(0, 500));

btn('Next').click();
ok('Next moves to Project folders', await until(() => step() === 'folders'));
await until(() => !!btn('Scan for projects'));
btn('Scan for projects').click();
ok('6 the scan finds the projects tree', await until(() => !!page.$('content').querySelector('[data-folder="~/code/work"]')), text().slice(0, 400));
ok('6 …with its counts', /2 repos · 2 with CLAUDE\.md \/ AGENTS\.md/.test(page.text(page.$('content').querySelector('[data-folder="~/code/work"]'))));
const asked = [];
page.confirm = (m) => { asked.push(m); return true; };
const row = page.$('content').querySelector('[data-folder="~/code/work"]');
const sel = row.querySelector('select');
sel.value = 'edit'; sel.onchange();
await until(() => asked.length === 1);
ok('6 edit asks a confirm naming the folder', /~\/code\/work/.test(asked[0] || ''), asked[0]);
btn('Add selected').click();
ok('5 the folder is added as edit', await until(() => {
  try { return JSON.parse(fs.readFileSync(path.join(home, '.agent-config-studio', 'roots.json'), 'utf8')).roots.some((r) => r.path === work && r.access === 'edit'); } catch { return false; }
}));

btn('Next').click();
ok('Next moves to Done', await until(() => step() === 'done'));
await until(() => !!btn('Finish'));
ok('S16 Done names this checkout\'s bin/acs (acs is not on this PATH)', text().includes(path.join(ROOT, 'bin', 'acs')));
btn('Finish').click();
ok('1 Finish lands on Home', await until(() => page.eval('S.view') === 'home'));
ok('1 …having written setup.json completed: done', JSON.parse(fs.readFileSync(path.join(home, '.agent-config-studio', 'setup.json'), 'utf8')).completed === 'done');
ok('S15 Home shows the folder count', await until(() => /Project folders: 1 \(edit\) · 0 \(read\)/.test(text())), text().slice(0, 300));
ok('S15 Home shows each CLI\'s state', await until(() => ['claude', 'codex', 'grok'].every((c) => text().includes(`${c} 3.0.0 (fake) · sign-in:`))), text());
ok('QA3 nothing on Home calls an installed CLI missing (Needs attention agrees with the CLIs card)',
   await until(() => /installed, no model catalog yet/.test(text())) && !/(Claude|Codex|Grok)[^:]*: not installed/.test(text()), text().slice(0, 600));
ok('S15 Home shows the added seat', await until(() => page.text(page.$('content').querySelector('.home-accounts')).includes('Codex (primary)')));
const ctx = await proxy('GET', '/api/context');
ok('8 the folder\'s context is served (Context lists both repos\' CLAUDE.md)', ['~/code/work/app/CLAUDE.md', '~/code/work/lib/CLAUDE.md'].every((d) => JSON.stringify(ctx).includes(d)), JSON.stringify(ctx).slice(0, 300));
ok('8 the next load lands on Home, not setup', (await proxy('GET', '/api/setup/status')).state === 'done');
ok('no page errors', page.errors.length === 0, page.errors.join(' | '));
page.done();
const again = await bootPage({ routes: proxy });
await settle(300);
ok('1 a fresh load after Finish lands on Home, through the server', again.eval('S.view') === 'home' && !again.requests.some((r) => r.path === '/api/setup/clis' && r.search === '?recheck=1'), again.eval('S.view'));
again.done();

console.log('\nisolation');
ok('S8 no `security` (Keychain) call was made', !/security/.test(calls(bin)), calls(bin));
const cliCalls = calls(bin).split('\n').filter(Boolean);
ok('S8 the fake CLIs were asked --version, and codex once to log in — nothing that reaches a service',
   cliCalls.every((l) => / --version$/.test(l) || l === 'codex login') && cliCalls.filter((l) => l === 'codex login').length === 1, calls(bin));
child.kill('SIGINT');
await new Promise((r) => (exited ? r() : child.once('exit', r)));
ok('nothing written to the server\'s TMPDIR', fs.readdirSync(tmp).length === 0, fs.readdirSync(tmp).join(', '));
ok('the checkout is unchanged', gitStatus() === statusBefore);
assertRealHomesUnchanged(realBefore, ok);
fs.rmSync(sandbox, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
