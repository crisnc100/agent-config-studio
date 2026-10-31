/**
 * The Packs card's routes (builds/skill-packs P3, C13's server half): a real
 * `node server.js` in a temp HOME with stub CLIs (tests/fixtures/
 * packs-sandbox.mjs). Strict same-origin on every route, a plan writes
 * nothing, bad input is a 400, apply refuses a stale preview, the status job
 * reports progress and completes while the studio keeps answering, and an
 * install and uninstall through the routes leave HOME as it was. No model
 * CLI is run; the codex stub answers only the trust check's hooks/list.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { snapshotRealHomes, assertRealHomesUnchanged } from './real-home.mjs';
import { ROOT, changed, sandbox, tests, track, tree } from './fixtures/packs-sandbox.mjs';

const realBefore = snapshotRealHomes();
const { ok, done } = tests();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const boxes = [], servers = [];

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

async function startServer(sb, extra = {}) {
  const port = await freePort();
  const child = track(spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT, env: { ...sb.env, PORT: String(port), ...extra }, stdio: ['ignore', 'pipe', 'pipe'],
  }));
  servers.push(child);
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const base = `http://localhost:${port}`;
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null) break;
    try { if ((await fetch(`${base}/api/health`)).ok) return { child, base, log: () => log }; } catch {}
    await sleep(100);
  }
  child.kill('SIGKILL');
  throw new Error(`server did not start: ${log.slice(-800)}`);
}

async function call(base, method, route, body, headers = {}) {
  const r = await fetch(`${base}${route}`, {
    method, headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, body: json, text };
}

/** Poll a status job until it finishes (or 60 s pass). */
async function finishJob(get, job) {
  for (let i = 0; i < 600 && job.running; i++) { await sleep(100); job = (await get(`/api/packs/status?job=${job.id}`)).body.job; }
  return job;
}

// The studio's own files: its history repo, run file and the backups every
// write leaves (kept by design), plus the pack record a full uninstall
// leaves empty. Everything else in HOME must come back byte for byte.
const OWN = ['.agent-config-studio/history', '.agent-config-studio/run', '.agent-config-studio/backups', '.agent-config-studio/packs'];
const own = (sb) => (p) => OWN.some((d) => p === path.join(sb.home, d) || p.startsWith(path.join(sb.home, d) + path.sep));

const sb = sandbox('srv', { clis: ['claude', 'codex'] });
boxes.push(sb);
try {
  // The trust check's hooks/list answers after 1.5 s: slow enough to watch progress and poll health meanwhile.
  const srv = await startServer(sb, { STUB_HOOKS_DELAY_MS: '1500' });
  const get = (route, headers) => call(srv.base, 'GET', route, undefined, headers);
  const post = (route, body, headers) => call(srv.base, 'POST', route, body, headers);
  const appServerCalls = () => sb.callsOf('codex').filter((a) => a[0] === 'app-server').length;
  const settledHome = tree(sb.home, own(sb));

  console.log('\npacks routes: strict same-origin on every route, before anything is read, run or written');
  {
    const bads = [
      ['a foreign origin', { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }],
      ['a different localhost port', { origin: 'http://localhost:5173', 'sec-fetch-site': 'same-site' }],
      ['no Origin with Sec-Fetch-Site: same-site', { 'sec-fetch-site': 'same-site' }],
    ];
    const routes = [
      ['GET', '/api/packs', undefined],
      ['GET', '/api/packs/status', undefined],
      ['GET', '/api/packs/status?job=0123456789abcdef', undefined],
      ['POST', '/api/packs/plan', { action: 'install', pack: 'handoff' }],
      ['POST', '/api/packs/apply', { action: 'install', pack: 'handoff', signature: '0'.repeat(64) }],
    ];
    for (const [what, headers] of bads) {
      for (const [method, route, body] of routes) {
        const r = await call(srv.base, method, route, body, headers);
        ok(`${what}: ${method} ${route} → 403`, r.status === 403, `${r.status} ${r.text.slice(0, 120)}`);
      }
    }
    ok('…and no trust check was started', appServerCalls() === 0, String(appServerCalls()));
    ok('…and HOME is unchanged', changed(settledHome, tree(sb.home, own(sb))).length === 0, changed(settledHome, tree(sb.home, own(sb))).join(' '));
    const same = await get('/api/packs', { 'sec-fetch-site': 'same-origin' });
    ok('this page (Sec-Fetch-Site: same-origin) is let through', same.status === 200, same.text.slice(0, 200));
  }

  console.log('\nGET /api/packs: the catalog, explanations, requirements, harnesses and installed state');
  {
    const r = await get('/api/packs');
    const ids = (r.body?.packs || []).map((p) => p.id);
    ok('every pack, in the catalog order', ids.join() === 'review-gate,build,advisor,second-opinion,handoff,worktree', ids.join());
    ok('each with a summary and a full explain', r.body.packs.every((p) => p.summary && p.explain.what && p.explain.does && p.explain.undo && p.explain.changes.length));
    ok('each part with its own explain and changes', r.body.packs.every((p) => p.parts.every((x) => x.explain.what && x.explain.changes.length)));
    const rg = r.body.packs.find((p) => p.id === 'review-gate');
    ok('requirements are listed, met here', rg.requirements.length >= 4 && rg.requirements.every((x) => x.ok), JSON.stringify(rg.requirements));
    const build = r.body.packs.find((p) => p.id === 'build');
    ok('build lists review-gate as a requirement not met yet', build.requirements.some((x) => x.dep === 'review-gate' && !x.ok), JSON.stringify(build.requirements));
    const h = Object.fromEntries(r.body.harnesses.map((x) => [x.id, x]));
    ok('claude and codex are detected; grok is not, with why', h.claude.present && h.codex.present && !h.grok.present && /no grok CLI on PATH and no ~\/\.grok/.test(h.grok.why), JSON.stringify(r.body.harnesses));
    ok('nothing is installed yet, and no earlier install is reported', r.body.packs.every((p) => p.installed === null) && r.body.legacy.length === 0);
    ok('the status and preview words are the CLI\'s', r.body.words.status.edited === 'edited by you' && r.body.words.what.create === 'new file');
    ok('no absolute path in HOME is handed back', !r.text.includes(sb.home), r.text.slice(r.text.indexOf(sb.home) - 60, r.text.indexOf(sb.home) + 60));
  }

  console.log('\nbad input is a 400 (and writes nothing)');
  {
    const before = tree(sb.home, own(sb));
    const cases = [
      ['no action', { pack: 'handoff' }, /action must be/],
      ['an unknown action', { action: 'reinstall', pack: 'handoff' }, /action must be/],
      ['an unknown pack', { action: 'install', pack: 'nope' }, /unknown pack "nope"/],
      ['no pack', { action: 'install' }, /pack must be/],
      ['an unknown part', { action: 'install', pack: 'review-gate', parts: ['code-review', 'turbo'] }, /unknown part "turbo"/],
      ['parts not a list', { action: 'install', pack: 'review-gate', parts: 'code-review' }, /parts must be a list/],
      ['an unknown harness', { action: 'install', pack: 'handoff', harnesses: ['cursor'] }, /unknown harness "cursor"/],
      ['an empty harness list', { action: 'install', pack: 'handoff', harnesses: [] }, /at least one harness/],
      ['an unknown role', { action: 'install', pack: 'review-gate', setRoles: { overlord: ['opus'] } }, /unknown role "overlord"/],
      ['an unknown family', { action: 'install', pack: 'review-gate', setRoles: { reviewer: ['gpt-9000'] } }, /unknown family "gpt-9000"/],
      ['a role with no families', { action: 'install', pack: 'review-gate', setRoles: { reviewer: [] } }, /at least one family/],
      ['withDeps not a boolean', { action: 'install', pack: 'build', withDeps: 'yes' }, /withDeps must be true or false/],
      ['a field the action does not take (force)', { action: 'uninstall', pack: 'handoff', force: true }, /unknown field "force"/],
      ['parts on an update', { action: 'update', pack: 'handoff', parts: ['handoff'] }, /unknown field "parts" for update/],
      ['a signature on a plan', { action: 'install', pack: 'handoff', signature: 'a'.repeat(64) }, /unknown field "signature"/],
      ['an array body', ['install'], /must be a JSON object/],
    ];
    for (const [what, body, re] of cases) {
      const r = await post('/api/packs/plan', body);
      ok(`plan: ${what} → 400 naming it`, r.status === 400 && re.test(r.body?.error), `${r.status} ${r.text.slice(0, 160)}`);
    }
    const j = await post('/api/packs/plan', '{"action": "install",');
    ok('plan: invalid JSON → 400', j.status === 400, `${j.status} ${j.text}`);
    const nosig = await post('/api/packs/apply', { action: 'install', pack: 'handoff' });
    ok('apply: no signature → 400 (preview first)', nosig.status === 400 && /signature/.test(nosig.body?.error), `${nosig.status} ${nosig.text}`);
    const badsig = await post('/api/packs/apply', { action: 'install', pack: 'handoff', signature: 'not-a-hash' });
    ok('apply: a malformed signature → 400', badsig.status === 400, `${badsig.status} ${badsig.text}`);
    const unk = await post('/api/packs/apply', { action: 'install', pack: 'nope', signature: 'a'.repeat(64) });
    ok('apply: an unknown pack → 400', unk.status === 400 && /unknown pack/.test(unk.body?.error), `${unk.status} ${unk.text}`);
    const trust = await get('/api/packs/status?trust=yes');
    ok('status: trust other than 0 or 1 → 400', trust.status === 400, `${trust.status} ${trust.text}`);
    const nojob = await get('/api/packs/status?job=feedfacefeedface');
    ok('status: an unknown job → 404', nojob.status === 404, `${nojob.status} ${nojob.text}`);
    ok('…and not one file in HOME changed', changed(before, tree(sb.home, own(sb))).length === 0, changed(before, tree(sb.home, own(sb))).join(' '));
  }

  console.log('\nPOST /api/packs/plan: the preview, and nothing written');
  {
    const before = tree(sb.home, own(sb));
    const r = await post('/api/packs/plan', { action: 'install', pack: 'review-gate', parts: ['code-review', 'instructions', 'agent-guard'] });
    const paths = (r.body?.preview || []).map((x) => x.path).filter(Boolean);
    ok('200 with every path the install will change', r.status === 200 && ['~/.claude/skills/code-review/SKILL.md', '~/.codex/skills/code-review/SKILL.md', '~/.claude/CLAUDE.md', '~/.codex/AGENTS.md', '~/.claude/settings.json', '~/.codex/hooks.json'].every((p) => paths.includes(p)), `${r.status} ${paths.join(' ')}`);
    ok('…each row with the CLI\'s mark and words', r.body.preview.find((x) => x.path === '~/.claude/skills/code-review/SKILL.md')?.symbol === '+' && r.body.preview.find((x) => x.path === '~/.claude/skills/code-review/SKILL.md')?.what === 'new file');
    ok('…the units, harnesses, a signature and no refusals', r.body.units.map((u) => u.key).join() === 'review-gate/code-review,review-gate/instructions,review-gate/agent-guard'
      && r.body.units[0].harnesses.join() === 'claude,codex' && /^[0-9a-f]{64}$/.test(r.body.signature) && r.body.refusals.length === 0 && r.body.changes, JSON.stringify(r.body.units));
    ok('…the same signature for the same request', (await post('/api/packs/plan', { action: 'install', pack: 'review-gate', parts: ['code-review', 'instructions', 'agent-guard'] })).body.signature === r.body.signature);
    const one = await post('/api/packs/plan', { action: 'install', pack: 'review-gate', parts: ['code-review'], harnesses: ['claude'] });
    ok('harnesses narrow it: claude only', one.status === 200 && one.body.preview.some((x) => x.path === '~/.claude/skills/code-review/SKILL.md') && !one.body.preview.some((x) => /\.codex/.test(x.path || '')), JSON.stringify(one.body.preview.map((x) => x.path)));
    const dep = await post('/api/packs/plan', { action: 'install', pack: 'build' });
    ok('build without review-gate is refused, saying why', dep.status === 200 && dep.body.refusals.some((s) => /needs the review-gate pack/.test(s)) && dep.body.requirements.some((x) => x.dep === 'review-gate' && !x.ok), JSON.stringify(dep.body.refusals));
    const deps = await post('/api/packs/plan', { action: 'install', pack: 'build', withDeps: true });
    ok('withDeps (the offer, accepted) adds review-gate\'s skill and clears the refusal', deps.body.refusals.length === 0 && deps.body.units.some((u) => u.key === 'review-gate/code-review' && u.dependency) && deps.body.notes.some((n) => /adds the review-gate pack's code-review skill/.test(n)), JSON.stringify(deps.body.units));
    const notInstalled = await post('/api/packs/plan', { action: 'uninstall', pack: 'handoff' });
    ok('uninstalling what is not installed is a refusal in the preview', notInstalled.status === 200 && notInstalled.body.refusals.some((s) => /handoff is not installed/.test(s)));
    ok('…and no plan wrote a file', changed(before, tree(sb.home, own(sb))).length === 0, changed(before, tree(sb.home, own(sb))).join(' '));
    ok('…or started the trust check', appServerCalls() === 0);
  }

  console.log('\nPOST /api/packs/apply refuses a stale preview');
  {
    const plan = (await post('/api/packs/plan', { action: 'install', pack: 'handoff' })).body;
    const mine = path.join(sb.home, '.claude/skills/handoff/SKILL.md');
    fs.mkdirSync(path.dirname(mine), { recursive: true });
    fs.writeFileSync(mine, 'my own handoff\n');
    const r = await post('/api/packs/apply', { action: 'install', pack: 'handoff', signature: plan.signature });
    ok('a file that appeared since the preview: 409, preview again', r.status === 409 && /different from the preview/.test(r.body?.error), `${r.status} ${r.text}`);
    ok('…and my file is untouched and nothing was recorded', sb.read(mine) === 'my own handoff\n' && !fs.existsSync(path.join(sb.home, '.agent-config-studio/packs/state.json')));
    const other = (await post('/api/packs/plan', { action: 'install', pack: 'advisor' })).body;
    const swapped = await post('/api/packs/apply', { action: 'install', pack: 'handoff', signature: other.signature });
    ok('another preview\'s signature: 409', swapped.status === 409, `${swapped.status} ${swapped.text}`);
    const refused = await post('/api/packs/apply', { action: 'install', pack: 'build', signature: (await post('/api/packs/plan', { action: 'install', pack: 'build' })).body.signature });
    ok('a preview with a refusal cannot be applied: 409 with the reason', refused.status === 409 && /needs the review-gate pack/.test(refused.body?.error), `${refused.status} ${refused.text}`);
    fs.rmSync(path.dirname(mine), { recursive: true });
  }

  console.log('\ninstall, status and uninstall through the routes: HOME as it was');
  {
    // Files of my own that the install edits: each must come back byte for byte.
    fs.writeFileSync(path.join(sb.home, '.claude/CLAUDE.md'), '# my rules\n\nbe kind\n');
    fs.writeFileSync(path.join(sb.env.CODEX_HOME, 'AGENTS.md'), '# codex rules\n');
    fs.writeFileSync(path.join(sb.home, '.claude/settings.json'), '{\n  "theme": "dark"\n}\n');
    const before = tree(sb.home, own(sb));
    const applyPlan = async (body) => {
      const p = (await post('/api/packs/plan', body)).body;
      return { plan: p, r: await post('/api/packs/apply', { ...body, signature: p.signature }) };
    };
    const rg = { action: 'install', pack: 'review-gate', parts: ['code-review', 'instructions', 'agent-guard'] };
    const t0 = Date.now();
    const { plan, r } = await applyPlan(rg);
    ok('review-gate (skill, instructions, agent guard) installs', r.status === 200 && fs.existsSync(path.join(sb.home, '.claude/skills/code-review/SKILL.md')) && fs.existsSync(path.join(sb.env.CODEX_HOME, 'skills/code-review/SKILL.md')), `${r.status} ${r.text.slice(0, 400)}`);
    ok('…the result names the backup folder, what was kept, the notes and the installers\' output', /^~\/\.agent-config-studio\/backups\//.test(r.body?.backupDir) && Array.isArray(r.body.kept) && Array.isArray(r.body.notes) && r.body.log.some((l) => /agent guard installed/i.test(l)), JSON.stringify(r.body));
    const written = changed(before, tree(sb.home, own(sb))).filter((p) => fs.statSync(p, { throwIfNoEntry: false })?.isFile());
    const previewed = new Set(plan.preview.map((x) => x.path).filter(Boolean).map((p) => p.replace(/^~/, sb.home)));
    ok('every file it wrote was in the preview it applied', written.length > 0 && written.every((p) => previewed.has(p)), written.filter((p) => !previewed.has(p)).join(' '));
    ok('…and it took at least the trust check\'s 1.5 s, in the worker', Date.now() - t0 >= 1500);
    const hd = await applyPlan({ action: 'install', pack: 'handoff' });
    ok('handoff installs', hd.r.status === 200 && fs.existsSync(path.join(sb.home, '.claude/skills/handoff/SKILL.md')), hd.r.text.slice(0, 300));

    const cat = (await get('/api/packs')).body;
    ok('GET /api/packs now shows both installed, with their parts and harnesses', cat.packs.find((p) => p.id === 'review-gate').installed?.parts['agent-guard']?.harnesses.join() === 'claude,codex' && !!cat.packs.find((p) => p.id === 'handoff').installed);

    // The status job: progress while the trust check runs, and the studio answers meanwhile.
    const start = await get('/api/packs/status');
    ok('GET /api/packs/status starts a job and answers at once', start.status === 200 && start.body.job.running && /^[0-9a-f]{16}$/.test(start.body.job.id) && start.body.job.progress.length >= 1, start.text);
    const joined = await get('/api/packs/status');
    ok('…a second request while it runs joins the same job', joined.body.job.id === start.body.job.id);
    let sawGuard = false, healthMs = Infinity;
    for (let i = 0; i < 50; i++) {
      const j = (await get(`/api/packs/status?job=${start.body.job.id}`)).body.job;
      if (j.progress.some((p) => /checking the agent guard/.test(p.message))) sawGuard = true;
      if (sawGuard && j.running) {
        const t = Date.now();
        await get('/api/health');
        healthMs = Date.now() - t;
        break;
      }
      await sleep(50);
    }
    ok('the trust check\'s progress line arrives while the job runs', sawGuard);
    ok('…and the studio answers /api/health meanwhile (no frozen server)', healthMs < 1000, `${healthMs} ms`);
    const fin = await finishJob(get, start.body.job);
    ok('the job completes', !fin.running && !fin.error && !!fin.result && fin.elapsedMs >= 1500, JSON.stringify({ running: fin.running, error: fin.error, ms: fin.elapsedMs }));
    const parts = Object.fromEntries(fin.result.packs.find((p) => p.id === 'review-gate').parts.map((x) => [x.id, x]));
    ok('…with each part\'s status: installed', ['code-review', 'instructions', 'agent-guard'].every((id) => parts[id].statuses.join() === 'installed'), JSON.stringify(parts));
    ok('…and the guard per harness: claude active, the Codex home active', parts['agent-guard'].harness?.claude === 'active' && parts['agent-guard'].harness?.['codex ~/.codex'] === 'active', JSON.stringify(parts['agent-guard'].harness));
    ok('…and handoff installed, the rest not installed', fin.result.packs.find((p) => p.id === 'handoff').parts[0].statuses.join() === 'installed' && fin.result.packs.find((p) => p.id === 'advisor').parts[0].statuses.join() === 'not installed');
    const calls = appServerCalls();
    const quick = await finishJob(get, (await get('/api/packs/status?trust=0')).body.job);
    ok('?trust=0 skips the trust check: no app-server, and the guard says it was not checked', !quick.error && appServerCalls() === calls
      && quick.result.packs.find((p) => p.id === 'review-gate').parts.find((x) => x.id === 'agent-guard').details.some((d) => /trust not checked/.test(d)), JSON.stringify(quick.error));

    // Edited by you, through the status job and the update preview.
    const skill = path.join(sb.home, '.claude/skills/handoff/SKILL.md');
    const shipped = sb.read(skill);
    fs.appendFileSync(skill, '\nmy note\n');
    const edited = await finishJob(get, (await get('/api/packs/status?trust=0')).body.job);
    ok('status: my edit shows as edited by you', edited.result.packs.find((p) => p.id === 'handoff').parts[0].statuses.includes('edited by you'));
    const up = (await post('/api/packs/plan', { action: 'update', pack: 'handoff' })).body;
    ok('the update preview keeps my edit and says so', up.kept.some((k) => k.path === '~/.claude/skills/handoff/SKILL.md' && /you edited it/.test(k.why)) && !up.changes, JSON.stringify(up.kept));
    const rep = (await post('/api/packs/plan', { action: 'update', pack: 'handoff', replace: true })).body;
    ok('…and replace offers the pack\'s copy, backing my edit up first', rep.preview.some((x) => x.path === '~/.claude/skills/handoff/SKILL.md' && x.action === 'replace-edited'), JSON.stringify(rep.preview));
    fs.writeFileSync(skill, shipped);

    const u1 = await applyPlan({ action: 'uninstall', pack: 'handoff' });
    ok('handoff uninstalls', u1.r.status === 200 && !fs.existsSync(skill), u1.r.text.slice(0, 300));
    const u2 = await applyPlan({ action: 'uninstall', pack: 'review-gate' });
    ok('review-gate uninstalls', u2.r.status === 200 && !fs.existsSync(path.join(sb.home, '.agent-config-studio/review-gate')), u2.r.text.slice(0, 400));
    const diff = changed(before, tree(sb.home, own(sb)));
    ok('…and HOME is exactly as it was before the installs', diff.length === 0, diff.join(' '));
    const last = await finishJob(get, (await get('/api/packs/status')).body.job);
    ok('a status started after the uninstall shows nothing installed', last.result.packs.every((p) => p.parts.every((x) => x.statuses.join() === 'not installed')));
  }

  console.log('\na Claude-only machine: harness detection and the role fix-up through the routes');
  {
    const c1 = sandbox('srv-claude', { clis: ['claude'] });
    boxes.push(c1);
    const s1 = await startServer(c1);
    const before = tree(c1.home, own(c1));
    const cat = (await call(s1.base, 'GET', '/api/packs')).body;
    const codex = cat.harnesses.find((h) => h.id === 'codex');
    ok('codex is not detected, with why', !codex.present && /no codex CLI on PATH and no ~\/\.codex/.test(codex.why), JSON.stringify(codex));
    const p = (await call(s1.base, 'POST', '/api/packs/plan', { action: 'install', pack: 'review-gate' })).body;
    const prob = p.roles.find((r) => r.role === 'reviewer');
    ok('the preview names the unusable reviewer role and offers installed families', prob && !prob.set && prob.suggestion.length > 0 && p.warnings.some((w) => /reviewer role/.test(w)), JSON.stringify(p.roles));
    ok('…and installs for claude only', p.units[0].harnesses.join() === 'claude' && !p.preview.some((x) => /\.codex/.test(x.path || '')), JSON.stringify(p.units));
    const fixed = (await call(s1.base, 'POST', '/api/packs/plan', { action: 'install', pack: 'review-gate', setRoles: { reviewer: prob.suggestion } })).body;
    ok('setRoles (the offer, accepted) puts the role change in the preview and drops the warning', fixed.roles.find((r) => r.role === 'reviewer')?.set?.join() === prob.suggestion.join()
      && fixed.preview.some((x) => x.path === '~/.agent-config-studio/roles.json' && /reviewer role →/.test(x.note)) && !fixed.warnings.some((w) => /reviewer role/.test(w)), JSON.stringify(fixed.preview));
    ok('…and an install for codex here is refused in the preview, not a 400', (await call(s1.base, 'POST', '/api/packs/plan', { action: 'install', pack: 'handoff', harnesses: ['codex'] })).body.refusals.some((s) => /codex is not installed here/.test(s)));
    ok('…and still nothing was written', changed(before, tree(c1.home, own(c1))).length === 0, changed(before, tree(c1.home, own(c1))).join(' '));
    const body = { action: 'install', pack: 'review-gate', setRoles: { reviewer: prob.suggestion } };
    const done1 = await call(s1.base, 'POST', '/api/packs/apply', { ...body, signature: fixed.signature });
    const rolesDoc = JSON.parse(c1.read(path.join(c1.home, '.agent-config-studio/roles.json')) || '{}');
    ok('applying it (in the worker) installs and sets the role through ACS\'s roles write path', done1.status === 200 && rolesDoc.roles?.reviewer?.use?.join() === prob.suggestion.join()
      && fs.existsSync(path.join(c1.home, '.claude/skills/code-review/SKILL.md')) && done1.body.log.some((l) => /reviewer role set to/.test(l)), `${done1.status} ${done1.text.slice(0, 400)}`);
    const hist = c1.run('git', ['-C', path.join(c1.home, '.agent-config-studio/history'), 'log', '--oneline']);
    ok('…recorded in ACS\'s history', hist.code === 0 && /roles: reviewer edited/.test(hist.stdout), hist.out);
  }
} finally {
  for (const c of servers) c.kill('SIGKILL');
  await sleep(200);
  for (const b of boxes) b.cleanup();
}
assertRealHomesUnchanged(realBefore, ok);
done();
