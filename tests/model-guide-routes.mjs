/**
 * The model guide through the real server (builds/model-guide G3, G4, G5):
 * a `node server.js` with HOME redirected to a temp dir. Strict same-origin
 * on every route before anything is read or written, propose → accept for
 * all three targets, the refusals, and history. Nothing outside the temp
 * HOME is written.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshotRealHomes, assertRealHomesUnchanged } from './real-home.mjs';
import { tempDir, track } from './fixtures/cleanup.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const realBefore = snapshotRealHomes();
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

async function startServer(home) {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: { HOME: home, PORT: String(port), PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, TMPDIR: os.tmpdir() },
    stdio: ['ignore', 'pipe', 'pipe'],
  }); track(child);
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const base = `http://localhost:${port}`;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) break;
    try { if ((await fetch(`${base}/api/health`)).ok) return { child, base }; } catch {}
    await sleep(100);
  }
  child.kill('SIGKILL');
  throw new Error(`server did not start: ${log.slice(-600)}`);
}

async function call(base, method, route, body, headers = {}) {
  const r = await fetch(`${base}${route}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, body: json, text };
}

const home = fs.realpathSync(tempDir('acs-guide-srv-'));
const files = {
  claude: path.join(home, '.claude', 'CLAUDE.md'),
  codex: path.join(home, '.codex', 'AGENTS.md'),
  grok: path.join(home, '.grok', 'AGENTS.md'),
};
fs.mkdirSync(path.dirname(files.claude), { recursive: true });
fs.mkdirSync(path.dirname(files.codex), { recursive: true });
fs.mkdirSync(path.join(home, '.agents'), { recursive: true });
fs.writeFileSync(files.claude, '# My rules\n\nBe brief.\n');
fs.writeFileSync(path.join(home, '.agents', 'AGENTS.md'), 'codex notes\r\n');
fs.symlinkSync(path.join(home, '.agents', 'AGENTS.md'), files.codex);
const bytes = (f) => { try { return fs.readFileSync(f); } catch { return null; } };
const historyCommits = () => {
  const r = spawnSync('git', ['-C', path.join(home, '.agent-config-studio', 'history'), 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' });
  return r.status === 0 ? Number(r.stdout.trim()) : 0;
};

const srv = await startServer(home);
const get = (route, headers) => call(srv.base, 'GET', route, undefined, headers);
const post = (route, body = {}, headers) => call(srv.base, 'POST', route, body, headers);

try {
  console.log('\nmodel guide routes: G4 — strict same-origin, refused before any read or write');
  {
    const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    const routes = ['GET /api/model-guide', 'POST /api/model-guide/propose', 'POST /api/model-guide/accept', 'POST /api/model-guide/reject'];
    for (const r of routes) {
      const at = src.indexOf(`'${r}': async (req) => {`);
      ok(`${r}: its first statement is requireStrict(req)`, at > 0 && /^\s*requireStrict\(req\);/.test(src.slice(src.indexOf('{', at + r.length + 3) + 1)));
    }
    // The startup snapshot commits on its own schedule; measure after it.
    for (let i = 0; i < 100 && !fs.existsSync(path.join(home, '.agent-config-studio', 'history', '.git', 'refs', 'heads', 'main')); i++) await sleep(100);
    await sleep(200);
    const live = (await post('/api/model-guide/propose', { target: 'claude', action: 'install' })).body;
    const before = { claude: bytes(files.claude), codex: bytes(files.codex), mtime: fs.statSync(files.claude).mtimeMs, commits: historyCommits() };
    ok('(history has its startup commit to count from)', before.commits >= 1, String(before.commits));
    const bads = [
      ['a foreign origin', { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }],
      ['another localhost port', { origin: 'http://localhost:5173', 'sec-fetch-site': 'same-site' }],
      ['no Origin with Sec-Fetch-Site: same-site', { 'sec-fetch-site': 'same-site' }],
    ];
    const calls = [
      ['GET', '/api/model-guide', undefined],
      ['POST', '/api/model-guide/propose', { target: 'claude', action: 'install' }],
      ['POST', '/api/model-guide/propose', '{not json'],
      ['POST', '/api/model-guide/accept', { id: live.id }],
      ['POST', '/api/model-guide/reject', { id: live.id }],
    ];
    for (const [what, headers] of bads) {
      for (const [method, route, body] of calls) {
        const r = await call(srv.base, method, route, body, headers);
        ok(`${what}: ${method} ${route}${typeof body === 'string' ? ' (a body that would not parse)' : ''} → 403`, r.status === 403, `${r.status} ${r.text.slice(0, 120)}`);
      }
    }
    ok('…nothing was written: the files, their mtime and history are untouched',
      bytes(files.claude).equals(before.claude) && bytes(files.codex).equals(before.codex) && fs.statSync(files.claude).mtimeMs === before.mtime && historyCommits() === before.commits && !fs.existsSync(files.grok));
    const rej = await post('/api/model-guide/reject', { id: live.id }, { 'sec-fetch-site': 'same-origin' });
    ok('…and the refused accept and reject did not spend the proposal', rej.status === 200 && rej.body.rejected === true, rej.text);
    ok('this page (Sec-Fetch-Site: same-origin) is let through', (await get('/api/model-guide', { 'sec-fetch-site': 'same-origin' })).status === 200);
  }

  console.log('\nmodel guide routes: G3 — status, propose, accept');
  {
    const st = (await get('/api/model-guide')).body;
    const by = Object.fromEntries(st.targets.map((t) => [t.key, t]));
    ok('GET lists the three targets with display paths', st.targets.map((t) => t.key).join() === 'claude,codex,grok' && by.claude.path === '~/.claude/CLAUDE.md' && by.codex.path === '~/.codex/AGENTS.md');
    ok('…a missing harness home reads "not installed"', by.grok.status === 'not-installed' && by.grok.harnessInstalled === false && by.grok.installed === false);
    ok('…and a file without a block reads absent', by.claude.status === 'absent' && by.claude.exists === true && by.claude.installed === false);
    ok('…a symlinked target names where it goes', by.codex.linkedTo === '~/.agents/AGENTS.md');

    const ng = await post('/api/model-guide/propose', { target: 'grok', action: 'install' });
    ok('propose for a missing home → 409, and ~/.grok is not created', ng.status === 409 && !fs.existsSync(path.join(home, '.grok')), ng.text);
    for (const target of ['nope', '~/.claude/CLAUDE.md', files.claude, '', 7]) {
      const r = await post('/api/model-guide/propose', { target, action: 'install' });
      ok(`a target that is not one of the keys (${JSON.stringify(target)}) → 400`, r.status === 400, r.text);
    }
    const bad = await post('/api/model-guide/propose', { target: 'claude', action: 'overwrite' });
    ok('an unknown action → 400', bad.status === 400, bad.text);
    const sneaky = await post('/api/model-guide/propose', { target: 'claude', action: 'install', path: '/etc/hosts', file: path.join(home, 'x.md') });
    ok('a client-sent path is ignored: the proposal is for the key\'s own file', sneaky.status === 200 && sneaky.body.path === '~/.claude/CLAUDE.md' && sneaky.body.current === '# My rules\n\nBe brief.\n', sneaky.text);

    const p = sneaky.body;
    ok('propose returns current and proposed in full, the base and the status', p.proposed.startsWith('# My rules\n\nBe brief.\n\n<!-- acs:model-guide v1 sep=1 sha256:') && p.status === 'absent' && /^sha256:[0-9a-f]{64}$/.test(p.base) && p.newFile === false);
    const commitsBefore = historyCommits();
    const acc = await post('/api/model-guide/accept', { id: p.id });
    ok('accept writes exactly the reviewed bytes', acc.status === 200 && acc.body.saved && fs.readFileSync(files.claude, 'utf8') === p.proposed, acc.text);
    ok('G5 …one more commit in history', historyCommits() === commitsBefore + 1, `${commitsBefore} → ${historyCommits()}`);
    ok('G5 …and it is in history', acc.body.sha && (await get(`/api/history?path=${encodeURIComponent(files.claude)}`)).body.commits.some((c) => /model guide: install/.test(c.subject)));
    ok('a used id → 410', (await post('/api/model-guide/accept', { id: p.id })).status === 410);

    const pc = (await post('/api/model-guide/propose', { target: 'codex', action: 'install' })).body;
    ok('a CRLF file gets a CRLF block', /codex notes\r\n\r\n<!-- acs:model-guide v1 sep=1 sha256:[0-9a-f]{64} -->\r\n## Model guide\r\n/.test(pc.proposed));
    const ra = await post('/api/model-guide/accept', { id: pc.id });
    ok('a symlinked target: written in place, the link kept', ra.status === 200 && fs.lstatSync(files.codex).isSymbolicLink() && fs.readFileSync(path.join(home, '.agents', 'AGENTS.md'), 'utf8') === pc.proposed, ra.text);

    fs.mkdirSync(path.join(home, '.grok'));
    const st2 = (await get('/api/model-guide')).body.targets.find((t) => t.key === 'grok');
    ok('with its home there, a missing file reads absent and new', st2.status === 'absent' && st2.newFile === true && st2.exists === false);
    const pg = (await post('/api/model-guide/propose', { target: 'grok', action: 'install' })).body;
    ok('…its proposal is a new file holding only the block', pg.newFile === true && pg.current === '' && pg.base === 'absent' && pg.proposed.startsWith('<!-- acs:model-guide v1 sep=0'));
    ok('…and accept creates it', (await post('/api/model-guide/accept', { id: pg.id })).status === 200 && fs.readFileSync(files.grok, 'utf8') === pg.proposed);
    ok('all three are now current', (await get('/api/model-guide')).body.targets.every((t) => t.status === 'current'));

    const pr = (await post('/api/model-guide/propose', { target: 'claude', action: 'remove' })).body;
    fs.appendFileSync(files.claude, 'an edit made in an editor\n');
    const changed = bytes(files.claude);
    const stale = await post('/api/model-guide/accept', { id: pr.id });
    ok('a file changed since propose → 409, nothing written', stale.status === 409 && bytes(files.claude).equals(changed), stale.text);
    ok('…and that id is spent', (await post('/api/model-guide/accept', { id: pr.id })).status === 410);
    const again = (await post('/api/model-guide/propose', { target: 'claude', action: 'remove' })).body;
    ok('remove takes out the block and the blank line ACS added', (await post('/api/model-guide/accept', { id: again.id })).status === 200 && fs.readFileSync(files.claude, 'utf8') === '# My rules\n\nBe brief.\nan edit made in an editor\n', JSON.stringify(fs.readFileSync(files.claude, 'utf8')));
  }

  console.log('\nmodel guide routes: G4 — edited and malformed');
  {
    const text = fs.readFileSync(files.grok, 'utf8');
    fs.writeFileSync(files.grok, text.replace('reads a diff', 'reads EVERY diff'));
    ok('a hand-edited block reads edited', (await get('/api/model-guide')).body.targets.find((t) => t.key === 'grok').status === 'edited');
    const up = await post('/api/model-guide/propose', { target: 'grok', action: 'update' });
    ok('update on edited: allowed, with overwritesEdits: true', up.status === 200 && up.body.overwritesEdits === true && up.body.status === 'edited', up.text);
    const rm = await post('/api/model-guide/propose', { target: 'grok', action: 'remove' });
    ok('remove on edited: allowed, with overwritesEdits: true', rm.status === 200 && rm.body.overwritesEdits === true);
    const ins = await post('/api/model-guide/propose', { target: 'grok', action: 'install' });
    ok('install on edited → 409 with its status', ins.status === 409 && ins.body.guideStatus === 'edited', ins.text);

    fs.writeFileSync(files.grok, `notes\n${text}\n${text}`);
    const st = (await get('/api/model-guide')).body.targets.find((t) => t.key === 'grok');
    ok('two blocks read malformed, with the lines', st.status === 'malformed' && st.lines.length === 2, JSON.stringify(st));
    const before = bytes(files.grok);
    for (const action of ['install', 'update', 'remove']) {
      const r = await post('/api/model-guide/propose', { target: 'grok', action });
      ok(`malformed × ${action} → 409 naming the lines`, r.status === 409 && /lines \d+, \d+/.test(r.body.error) && r.body.lines.length === 2 && r.body.guideStatus === 'malformed', r.text);
    }
    ok('…and nothing was written', bytes(files.grok).equals(before));
  }

  console.log('\nmodel guide routes: R3 — invalid roles');
  {
    const rolesFile = path.join(home, '.agent-config-studio', 'roles.json');
    fs.writeFileSync(files.grok, 'plain\n');
    fs.writeFileSync(rolesFile, '{"version":1,"roles":{"reviewer":{"use":"nobody"}}}');
    const st = (await get('/api/model-guide')).body;
    ok('the status carries the roles error', /nobody/.test(st.rolesError) && st.targets.find((t) => t.key === 'codex').status === 'roles-invalid', JSON.stringify(st.targets.map((t) => t.status)));
    const ins = await post('/api/model-guide/propose', { target: 'grok', action: 'install' });
    ok('install is refused while roles are invalid', ins.status === 409 && /Models → Roles/.test(ins.body.error), ins.text);
    const up = await post('/api/model-guide/propose', { target: 'codex', action: 'update' });
    ok('update is refused while roles are invalid', up.status === 409, up.text);
    const rm = await post('/api/model-guide/propose', { target: 'codex', action: 'remove' });
    ok('remove is still allowed', rm.status === 200, rm.text);
    ok('…and gives back the original bytes', (await post('/api/model-guide/accept', { id: rm.body.id })).status === 200 && fs.readFileSync(path.join(home, '.agents', 'AGENTS.md'), 'utf8') === 'codex notes\r\n');
    fs.rmSync(rolesFile);
  }
} finally {
  srv.child.kill('SIGKILL');
  fs.rmSync(home, { recursive: true, force: true });
  assertRealHomesUnchanged(realBefore, ok);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
