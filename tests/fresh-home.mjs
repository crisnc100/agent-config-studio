/**
 * Does ACS work on a machine that has none of Cris's setup? A real server,
 * booted with a brand-new empty HOME (no ~/.claude, ~/.codex, ~/.grok,
 * ~/Documents, ~/.agent-config-studio), a free port, and a PATH that finds no
 * claude, codex or grok. Then every GET route the server registers is called.
 *
 * The routes are read out of server.js's source, not listed here, so a route
 * added later is covered without touching this file. Each is called bare, and
 * once more per query parameter its handler reads, with that parameter empty.
 * The bar is "no 5xx, no crash": a 400 or 404 carrying a plain JSON error is
 * how a route says there is nothing here, and that passes.
 *
 * Nothing may land outside the temp HOME: the real config trees are compared
 * by tests/real-home.mjs, the checkout by `git status`, and the server's
 * TMPDIR is a sibling of the HOME that must still be empty at the end.
 *
 * With zero project folders (builds/configurable-roots, criterion 5): no
 * route mentions a folder this machine does not have, the banner says how to
 * add one, and the page's Folders view renders its empty state — the real
 * front end, booted in the test VM against this real server.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshotRealHomes, assertRealHomesUnchanged } from './real-home.mjs';
import { bootPage, settle } from './fixtures/shell-page.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const realBefore = snapshotRealHomes();
const gitStatus = () => execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: ROOT, encoding: 'utf8' });
const statusBefore = gitStatus();

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acs-fresh-home-')));
const home = path.join(sandbox, 'home');
const tmp = path.join(sandbox, 'tmp');
const bin = path.join(sandbox, 'bin');
for (const d of [home, tmp, bin]) fs.mkdirSync(d);

// node from its own link, and only the system dirs that hold no agent CLI.
// /usr/local/bin is left out whole: it is where npm and installers drop them.
fs.symlinkSync(process.execPath, path.join(bin, 'node'));
const CLIS = ['claude', 'codex', 'grok'];
const sysDirs = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'].filter((d) => !CLIS.some((c) => fs.existsSync(path.join(d, c))));
const PATH = [bin, ...sysDirs].join(':');

const free = () => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});
const port = await free();
const base = `http://localhost:${port}`;

console.log('\nfresh HOME');
ok('HOME is redirected', home !== os.homedir());
ok('no agent CLI on the server\'s PATH',
  !PATH.split(':').some((d) => CLIS.some((c) => fs.existsSync(path.join(d, c)))), PATH);

let stderr = '';
let stdout = '';
let exited = null;
const child = spawn(process.execPath, ['--no-warnings', path.join(ROOT, 'server.js')], {
  cwd: ROOT,
  env: { HOME: home, PORT: String(port), PATH, TMPDIR: tmp },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stderr.on('data', (b) => { stderr += b; });
child.stdout.on('data', (b) => { stdout += b; });
child.on('exit', (code, signal) => { exited = { code, signal }; });

let healthy = null;
for (let i = 0; i < 150 && !exited; i++) {
  try {
    const r = await fetch(`${base}/api/health`);
    if (r.ok) { healthy = await r.json(); break; }
  } catch {}
  await new Promise((r) => setTimeout(r, 100));
}
ok('the server boots and /api/health answers', healthy?.app === 'agent-config-studio',
  exited ? `exited ${JSON.stringify(exited)}: ${stderr.trim().slice(-600)}` : 'no answer in 15s');
ok('the server took the temp HOME as its home', fs.existsSync(path.join(home, '.agent-config-studio')),
  fs.readdirSync(home).join(', ') || 'temp HOME is still empty');

const get = async (p, opts = {}) => {
  try {
    const r = await fetch(`${base}${p}`, { signal: AbortSignal.timeout(30_000), ...opts });
    return { status: r.status, type: r.headers.get('content-type') || '', res: r };
  } catch (e) { return { status: 0, error: e.cause?.code || e.name || String(e) }; }
};

// The table's keys, each with the handler source up to the next key, so the
// query parameters it reads can be found; then the GETs matched ahead of the
// dispatcher, which stream or write their own headers.
const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const keys = [...src.matchAll(/^\s*'([A-Z]+) (\/api\/[^']*)':/gm)];
const routes = keys.map((m, i) => ({
  method: m[1], path: m[2],
  params: [...new Set([...src.slice(m.index, keys[i + 1]?.index ?? src.length)
    .matchAll(/searchParams\.get\('([^']+)'\)/g)].map((p) => p[1]))],
})).filter((r) => r.method === 'GET');
const direct = [...src.matchAll(/req\.method === 'GET' && url\.pathname === '(\/api\/[^']+)'/g)].map((m) => m[1]);
ok('routes were found in server.js', routes.length > 10 && direct.length > 0, `${routes.length} table, ${direct.length} direct`);

if (healthy) {
  console.log('\nGET routes');
  const phantom = [];
  // This checkout and the main one it is a worktree of (what `git` reports as primary).
  let primary = null;
  try { primary = path.dirname(execFileSync('git', ['-C', ROOT, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim()); } catch {}
  const CHECKOUTS = [ROOT, primary].filter(Boolean).sort((a, b) => b.length - a.length);
  // No route may hand back a path inside ACS's own checkout: it is the
  // server's cwd, never a project folder (builds/setup-screen S16). The only
  // exceptions are named here, by route, with the reason.
  const CHECKOUT_OK = {
    '/api/setup/clis': "the Done step's next-step commands name this checkout's bin/acs, because acs is not on this PATH (S16)",
  };
  const inCheckout = [];
  const json = async (p) => {
    const r = await get(p);
    if (r.status === 0) return ok(`GET ${p}`, false, `no response (${r.error})`);
    let body = null;
    try { body = await r.res.json(); } catch {}
    ok(`GET ${p}`, r.status < 500 && body !== null,
      `${r.status} ${body?.error ?? (body === null ? `not JSON (${r.type})` : '')}`);
    let text = JSON.stringify(body);
    const route = p.split('?')[0];
    const hit = CHECKOUTS.find((c) => text.includes(c));
    if (hit && !CHECKOUT_OK[route]) inCheckout.push(`${p}: ${text.slice(Math.max(0, text.indexOf(hit) - 40), text.indexOf(hit) + hit.length + 40)}`);
    // An excepted route's checkout path may itself sit under ~/Documents/Projects;
    // it is judged above, not as a phantom folder.
    if (CHECKOUT_OK[route]) text = CHECKOUTS.reduce((t, c) => t.split(c).join('<checkout>'), text);
    if (/Documents\/Projects|garman/i.test(text)) phantom.push(`${p}: ${text.match(/.{0,60}(Documents\/Projects|garman).{0,60}/i)[0]}`);
  };
  for (const r of routes) {
    await json(r.path);
    for (const p of r.params) await json(`${r.path}?${p}=`);
  }
  for (const p of direct) {
    if (p === '/api/events') {
      // An event stream never ends: the headers are the answer.
      const ac = new AbortController();
      const r = await get(p, { signal: ac.signal });
      ok(`GET ${p} opens an event stream`, r.status === 200 && r.type.startsWith('text/event-stream'),
        r.status ? `${r.status} ${r.type}` : `no response (${r.error})`);
      ac.abort();
    } else {
      await json(p);
    }
  }

  ok('no route mentions ~/Documents/Projects or Garman on a machine with no project folders', phantom.length === 0, phantom.join(' | '));
  ok('no route returns a path inside ACS\'s own checkout (exceptions named by route)', inCheckout.length === 0, inCheckout.join(' | '));
  const bases = await get('/api/worktree/bases');
  ok('F3 /api/worktree/bases with no repo is a 400 "repo required", not the checkout\'s branches',
     bases.status === 400 && /repo required/.test((await bases.res.json()).error));

  console.log('\nzero project folders');
  // The banner prints from listen's callback; give it a moment past health.
  for (let i = 0; i < 20 && !/watching/.test(stdout); i++) await new Promise((r) => setTimeout(r, 50));
  ok('the startup banner says there are no folders and how to add one',
     /no project folders yet — run: acs roots add <path>/.test(stdout) && !/Documents\/Projects/.test(stdout), stdout);
  const studio = path.join(home, '.agent-config-studio');
  ok('the first start wrote an empty roots.json and no setup marker (setup still to run)',
     JSON.parse(fs.readFileSync(path.join(studio, 'roots.json'), 'utf8')).roots.length === 0 && !fs.existsSync(path.join(studio, 'setup.json')));
  // The real front end against this real server: every request the page
  // makes is forwarded, so the view renders exactly what the routes say.
  const proxy = async (method, p, body, u) => {
    const r = await fetch(`${base}${p}${u?.search || ''}`, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
    const data = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
    if (!r.ok) throw { status: r.status, body: data };
    return data;
  };
  const view = await bootPage({ routes: proxy, hash: '#folders' });
  await settle(40);
  const folders = view.text(view.$('content'));
  ok('the Folders view renders its empty state with the add command',
     view.eval('S.view') === 'folders' && /No project folders yet/.test(folders) && /acs roots add <path>/.test(folders), folders.slice(0, 300));
  ok('…with no page errors', view.errors.length === 0, view.errors.join(' | '));
  view.done();

  console.log('\nthe page');
  const page = await get('/');
  const html = page.status === 200 ? await page.res.text() : '';
  ok('GET / serves the page', page.status === 200 && page.type.startsWith('text/html'), `${page.status} ${page.type}`);
  const assets = [...html.matchAll(/(?:src|href)="(\/[^/"][^"]*)"/g)].map((m) => m[1]);
  ok('the page references its assets', assets.length > 0);
  for (const a of assets) {
    const r = await get(a);
    if (r.status) await r.res.arrayBuffer();
    ok(`GET ${a}`, r.status === 200, r.status ? String(r.status) : r.error);
  }
}

console.log('\nafterwards');
await new Promise((r) => setTimeout(r, 300));
ok('the server is still running', !exited, exited && `exited ${JSON.stringify(exited)}: ${stderr.trim().slice(-600)}`);
child.kill('SIGINT');
await new Promise((r) => (exited ? r() : child.once('exit', r)));
ok('nothing written to the server\'s TMPDIR', fs.readdirSync(tmp).length === 0, fs.readdirSync(tmp).join(', '));
ok('the checkout is unchanged', gitStatus() === statusBefore);
assertRealHomesUnchanged(realBefore, ok);

fs.rmSync(sandbox, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
