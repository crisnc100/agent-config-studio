/**
 * The audit through the real server (builds/skills-audit A3, A5): a
 * `node server.js` with HOME redirected to a temp dir and one read root
 * beside it. Strict same-origin on every route before anything is read or
 * written; propose → accept; the class refusals as HTTP statuses; dismiss
 * persisting; Home's summary; and no absolute path in any response.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshotRealHomes, assertRealHomesUnchanged } from './real-home.mjs';

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
  });
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

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acs-audit-srv-')));
const ext = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acs-audit-ext-')));
const put = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); return f; };
const skill = (dir) => put(path.join(dir, 'SKILL.md'), '---\nname: x\n---\n```bash\ncodex exec -m gpt-6-sol "go"\n```\n');
const S = path.join(home, '.claude', 'skills');
const alpha = skill(path.join(S, 'alpha'));
skill(path.join(S, 'synced', 'u1', 'beta'));
skill(path.join(home, '.claude', 'plugins', 'cache', 'mkt', 'plug', '1.0.0', 'skills', 'p1'));
put(path.join(home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'plug@mkt': true } }));
put(path.join(home, '.claude', 'CLAUDE.md'), '# Global\nBuild with claude-opus-5-5.\n');
put(path.join(ext, 'CLAUDE.md'), 'Builds use claude-opus-5-5.\n');
put(path.join(home, 'Projects', 'app', 'CLAUDE.md'), 'Use claude-opus-5-5.\n');
put(path.join(home, '.agent-config-studio', 'roots.json'), JSON.stringify({ version: 1, roots: [
  { id: 'projects', label: 'Projects', access: 'edit', path: path.join(home, 'Projects') },
  { id: 'client', label: 'Client', access: 'read', path: ext },
] }));
const dismissedFile = path.join(home, '.agent-config-studio', 'audit-dismissed.json');
const bytes = (f) => { try { return fs.readFileSync(f); } catch { return null; } };
const historyCommits = () => {
  const r = spawnSync('git', ['-C', path.join(home, '.agent-config-studio', 'history'), 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' });
  return r.status === 0 ? Number(r.stdout.trim()) : 0;
};
const leaks = (text) => text.includes(home) || text.includes(ext) || text.includes(fs.realpathSync(os.tmpdir()));

const srv = await startServer(home);
const get = (route, headers) => call(srv.base, 'GET', route, undefined, headers);
const post = (route, body = {}, headers) => call(srv.base, 'POST', route, body, headers);
const seen = [];
const track = (r) => { seen.push(r.text); return r; };

try {
  console.log('\naudit routes: A5 — strict same-origin, refused before any read, write or scan');
  {
    const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    const routes = ['GET /api/audit', 'GET /api/audit/summary', 'POST /api/audit/propose', 'POST /api/audit/accept', 'POST /api/audit/reject', 'POST /api/audit/dismiss', 'POST /api/audit/undismiss'];
    for (const r of routes) {
      const at = src.indexOf(`'${r}': async (req`);
      ok(`${r}: its first statement is requireStrict(req)`, at > 0 && /^\s*requireStrict\(req\);/.test(src.slice(src.indexOf('{', at + r.length + 3) + 1)));
    }
    for (let i = 0; i < 100 && !fs.existsSync(path.join(home, '.agent-config-studio', 'history', '.git', 'refs', 'heads', 'main')); i++) await sleep(100);
    await sleep(200);
    const bads = [
      ['a foreign origin', { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }],
      ['another localhost port', { origin: 'http://localhost:5173', 'sec-fetch-site': 'same-site' }],
      ['no Origin with Sec-Fetch-Site: same-site', { 'sec-fetch-site': 'same-site' }],
    ];
    // Refused before any scan: the summary still says not audited afterwards.
    for (const [what, headers] of bads) {
      const r = await get('/api/audit', headers);
      ok(`${what}: GET /api/audit → 403`, r.status === 403, `${r.status} ${r.text.slice(0, 100)}`);
    }
    ok('…and no scan ran', (await get('/api/audit/summary')).body.state === 'not-audited');
    const run = track(await get('/api/audit')).body;
    const a = run.files.find((f) => f.display === '~/.claude/skills/alpha/SKILL.md');
    const live = track(await post('/api/audit/propose', { fileRef: a.ref, findingIds: a.findings.map((f) => f.id) })).body;
    const before = { alpha: bytes(alpha), mtime: fs.statSync(alpha).mtimeMs, commits: historyCommits() };
    ok('(history has its startup commit to count from)', before.commits >= 1, String(before.commits));
    const calls = [
      ['GET', '/api/audit/summary', undefined],
      ['POST', '/api/audit/propose', { fileRef: a.ref, findingIds: a.findings.map((f) => f.id) }],
      ['POST', '/api/audit/propose', '{not json'],
      ['POST', '/api/audit/accept', { id: live.id }],
      ['POST', '/api/audit/reject', { id: live.id }],
      ['POST', '/api/audit/dismiss', { id: a.findings[0].id }],
      ['POST', '/api/audit/undismiss', { id: a.findings[0].id }],
    ];
    for (const [what, headers] of bads) {
      for (const [method, route, body] of calls) {
        const r = await call(srv.base, method, route, body, headers);
        ok(`${what}: ${method} ${route}${typeof body === 'string' ? ' (a body that would not parse)' : ''} → 403`, r.status === 403, `${r.status} ${r.text.slice(0, 120)}`);
      }
    }
    ok('…nothing was written: the file, its mtime, history and the dismissed list are untouched',
      bytes(alpha).equals(before.alpha) && fs.statSync(alpha).mtimeMs === before.mtime && historyCommits() === before.commits && !fs.existsSync(dismissedFile));
    const rej = await post('/api/audit/reject', { id: live.id }, { 'sec-fetch-site': 'same-origin' });
    ok('…and the refused accept and reject did not spend the proposal', rej.status === 200 && rej.body.rejected === true, rej.text);
    ok('this page (Sec-Fetch-Site: same-origin) is let through', (await get('/api/audit', { 'sec-fetch-site': 'same-origin' })).status === 200);
  }

  console.log('\naudit routes: A3 — propose, accept, the class policy, dismiss');
  {
    const run = track(await get('/api/audit?refresh=1')).body;
    ok('the result carries counts by class', run.counts.byClass.plugin.files === 1 && run.counts.byClass.readonly.files === 1 && run.counts.byClass.synced.files === 1, JSON.stringify(run.counts.byClass));
    ok('a read root outside HOME shows as Client/…', run.files.some((f) => f.display === 'Client/CLAUDE.md'));
    const by = (d) => run.files.find((f) => f.display === d);
    const a = by('~/.claude/skills/alpha/SKILL.md');
    const p = track(await post('/api/audit/propose', { fileRef: a.ref, findingIds: a.findings.map((f) => f.id) }));
    ok('propose → 200 with the full before and after', p.status === 200 && p.body.proposed.includes('$(model-id sol || echo MODEL-ID-UNRESOLVED-sol)') && p.body.current === fs.readFileSync(alpha, 'utf8'), p.text.slice(0, 200));
    const acc = track(await post('/api/audit/accept', { id: p.body.id }));
    ok('accept → 200, the reviewed bytes written, recorded in history', acc.status === 200 && fs.readFileSync(alpha, 'utf8') === p.body.proposed && acc.body.sha, acc.text);
    ok('a spent id → 410', (await post('/api/audit/accept', { id: p.body.id })).status === 410);
    ok('an accept leaves Home\'s count stale', (await get('/api/audit/summary')).body.stale === true);
    for (const [what, d, status, reason] of [
      ['plugin', '~/.claude/plugins/cache/mkt/plug/1.0.0/skills/p1/SKILL.md', 403, 'plugin'],
      ['readonly', 'Client/CLAUDE.md', 403, 'readonly'],
      ['synced without ackSync', '~/.claude/skills/synced/u1/beta/SKILL.md', 409, 'synced'],
    ]) {
      const f = by(d);
      const r = track(await post('/api/audit/propose', { fileRef: f.ref, findingIds: [f.findings[0].id] }));
      ok(`${what} → ${status} at propose (${reason})`, r.status === status && r.body.reason === reason, r.text);
    }
    const syn = by('~/.claude/skills/synced/u1/beta/SKILL.md');
    const sp = track(await post('/api/audit/propose', { fileRef: syn.ref, findingIds: [syn.findings[0].id], ackSync: true }));
    ok('synced with ackSync: true → a proposal', sp.status === 200 && sp.body.cls === 'synced', sp.text);
    for (const [what, body] of [['an unknown ref', { fileRef: 'f'.repeat(16), findingIds: ['a'.repeat(16)] }], ['a path as the ref', { fileRef: alpha, findingIds: ['a'.repeat(16)] }], ['no finding ids', { fileRef: a.ref, findingIds: [] }]]) {
      const r = track(await post('/api/audit/propose', body));
      ok(`${what} → 4xx, never a read of a path`, r.status >= 400 && r.status < 500, `${r.status} ${r.text}`);
    }
    const g = by('~/.claude/CLAUDE.md');
    const d = track(await post('/api/audit/dismiss', { id: g.findings[0].id }));
    ok('dismiss → 200 and persisted', d.status === 200 && Object.hasOwn(JSON.parse(fs.readFileSync(dismissedFile, 'utf8')).dismissed, g.findings[0].id));
    const again = track(await get('/api/audit')).body;
    ok('…a dismissed finding comes back marked, and is not counted', again.files.find((f) => f.display === '~/.claude/CLAUDE.md').findings[0].dismissed === true && again.counts.byClass.user.findings === run.counts.byClass.user.findings - 1 - a.findings.length);
    const und = await post('/api/audit/undismiss', { id: g.findings[0].id });
    ok('undismiss → 200', und.status === 200 && !Object.hasOwn(JSON.parse(fs.readFileSync(dismissedFile, 'utf8')).dismissed, g.findings[0].id));
    const sum = track(await get('/api/audit/summary')).body;
    ok('the summary is counts only', ['state', 'findings', 'fixable', 'scannedAt', 'stale'].every((k) => k in sum) && !('files' in sum), JSON.stringify(sum));
  }

  console.log('\naudit routes: R15 — no absolute path in any response');
  ok(`${seen.length} responses checked`, seen.length > 8 && !seen.some(leaks), seen.find(leaks)?.slice(0, 200));
} finally {
  srv.child.kill('SIGKILL');
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(ext, { recursive: true, force: true });
  assertRealHomesUnchanged(realBefore, ok);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
