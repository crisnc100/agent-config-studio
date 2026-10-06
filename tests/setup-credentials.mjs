/**
 * Credential contents are never served through an alias (builds/setup-screen
 * criterion 2, grade P1). A real `node server.js` on temp HOMEs; each case
 * plants a marker in a credential file and then reaches it another way:
 *
 *   - a hard link: ~/.codex/auth.json and ~/.codex/AGENTS.md one inode
 *   - a symlink named auth.json that points at an innocently named file
 *   - a chain: AGENTS.md -> auth.json -> tokens-store
 *   - a project CLAUDE.md and a skill file hard-linked to a credential
 *
 * Every content route — the editor's read, search, Context, the skill
 * export, the history mirror — refuses or omits it, and the marker appears in
 * no response and no history commit.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshotRealHomes, assertRealHomesUnchanged } from './real-home.mjs';
import { startServer } from './fixtures/roots-home.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const realBefore = snapshotRealHomes();
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const temps = [];
const mkTemp = (tag) => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `acs-cred-${tag}-`))); temps.push(d); return d; };
const put = (f, body) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); };
const SECRET = 'SECRET-REFRESH-TOKEN-7f3a';
const leaked = (text) => String(text).includes(SECRET);
const historyText = (home) => {
  try { return execFileSync('git', ['-C', path.join(home, '.agent-config-studio', 'history'), 'log', '--all', '-p'], { encoding: 'utf8', maxBuffer: 64 << 20 }); } catch { return ''; }
};

console.log('\ncredentials through aliases');

async function scenario(tag, plant, probes) {
  const home = mkTemp(tag);
  put(path.join(home, '.claude', 'CLAUDE.md'), '# global\n');
  const work = path.join(home, 'code', 'work');
  put(path.join(work, 'app', 'README.md'), 'app\n');
  put(path.join(home, '.agent-config-studio', 'roots.json'), JSON.stringify({ version: 1, roots: [{ id: 'work', path: work, label: 'Work', access: 'edit' }] }));
  plant(home, work);
  const srv = await startServer(home, { root: ROOT });
  ok(`${tag}: the server boots`, srv.up, srv.log().slice(-300));
  for (const [what, route, check] of probes(home, work)) {
    const r = await srv.call(route);
    // A search echoes its query: judge what came back, not what was asked.
    const body = r.json && 'hits' in r.json ? JSON.stringify(r.json.hits) : r.text;
    ok(`${tag}: ${what}`, !leaked(body) && check(r), `${r.status} ${r.text.slice(0, 160)}`);
  }
  ok(`${tag}: the marker is in no history commit`, !leaked(historyText(home)));
  await srv.stop();
}

const file = (p) => `/api/file?path=${encodeURIComponent(p)}`;

await scenario('hardlink', (home) => {
  put(path.join(home, '.codex', 'auth.json'), `{"refresh":"${SECRET}"}`);
  fs.linkSync(path.join(home, '.codex', 'auth.json'), path.join(home, '.codex', 'AGENTS.md'));
}, (home) => [
  ['a hard link of auth.json named AGENTS.md is refused by the editor', file(path.join(home, '.codex', 'AGENTS.md')), (r) => r.status === 403 && /hard links/.test(r.json?.error)],
  ['…search does not return its lines', `/api/search?q=${SECRET}`, (r) => r.status === 200 && r.json.hits.length === 0],
  ['…and auth.json itself stays refused', file(path.join(home, '.codex', 'auth.json')), (r) => r.status === 403],
]);

await scenario('symlink', (home) => {
  put(path.join(home, '.codex', 'tokens-store'), `{"refresh":"${SECRET}"}`);
  fs.symlinkSync('tokens-store', path.join(home, '.codex', 'auth.json'));
}, (home) => [
  ['a symlink NAMED auth.json is refused, though its target has an innocent name', file(path.join(home, '.codex', 'auth.json')), (r) => r.status === 403 && /protected/.test(r.json?.error)],
  ['…by its ~ spelling too', file('~/.codex/auth.json'), (r) => r.status === 403],
]);

await scenario('chain', (home) => {
  put(path.join(home, '.codex', 'tokens-store'), `{"refresh":"${SECRET}"}`);
  fs.symlinkSync('tokens-store', path.join(home, '.codex', 'auth.json'));
  fs.symlinkSync('auth.json', path.join(home, '.codex', 'AGENTS.md'));
}, (home) => [
  ['a chain AGENTS.md -> auth.json -> tokens-store is refused', file(path.join(home, '.codex', 'AGENTS.md')), (r) => r.status === 403 && /protected/.test(r.json?.error)],
  ['…and search never reads through it', `/api/search?q=${SECRET}`, (r) => r.status === 200 && r.json.hits.length === 0],
]);

await scenario('project', (home, work) => {
  put(path.join(home, '.claude', '.credentials.json'), `{"claudeAiOauth":{"accessToken":"${SECRET}"}}`);
  fs.linkSync(path.join(home, '.claude', '.credentials.json'), path.join(work, 'app', 'CLAUDE.md'));
  put(path.join(work, 'app', '.claude', 'skills', 'leaky', 'SKILL.md'), '---\nname: leaky\ndescription: x\n---\n');
  fs.linkSync(path.join(home, '.claude', '.credentials.json'), path.join(work, 'app', '.claude', 'skills', 'leaky', 'notes.md'));
}, (home, work) => [
  ['a project CLAUDE.md hard-linked to .credentials.json is refused by the editor', file(path.join(work, 'app', 'CLAUDE.md')), (r) => r.status === 403],
  ['…Context serves no bytes of it', '/api/context', (r) => r.status === 200],
  ['…search does not return it', `/api/search?q=${SECRET}`, (r) => r.status === 200 && r.json.hits.length === 0],
  ['…and the skill holding a hard-linked file never ships it', '/api/skills', (r) => r.status === 200 && !r.json.skills.some((s) => s.name === 'leaky' && !s.broken && (s.files || []).some((f) => /notes/.test(f.rel || f.name || '')))],
]);

// Context files and the skill export by id: every id Context and Skills hand out.
{
  const home = mkTemp('ids');
  const work = path.join(home, 'code', 'work');
  put(path.join(home, '.claude', '.credentials.json'), `{"t":"${SECRET}"}`);
  put(path.join(work, 'app', 'README.md'), 'x\n');
  fs.linkSync(path.join(home, '.claude', '.credentials.json'), path.join(work, 'app', 'AGENTS.md'));
  put(path.join(work, 'app', '.claude', 'skills', 'leaky', 'SKILL.md'), '---\nname: leaky\ndescription: x\n---\n');
  fs.linkSync(path.join(home, '.claude', '.credentials.json'), path.join(work, 'app', '.claude', 'skills', 'leaky', 'ref.md'));
  put(path.join(home, '.agent-config-studio', 'roots.json'), JSON.stringify({ version: 1, roots: [{ id: 'work', path: work, label: 'Work', access: 'edit' }] }));
  const srv = await startServer(home, { root: ROOT });
  const ctx = await srv.call('/api/context');
  const ids = JSON.stringify(ctx.json).match(/"id":"[0-9a-f]{24}"/g)?.map((m) => m.slice(6, -1)) || [];
  let served = '';
  for (const id of ids) served += (await srv.call(`/api/context/file?id=${id}`)).text;
  ok('ids: no Context file id serves the hard-linked AGENTS.md', !leaked(served) && !leaked(ctx.text), `${ids.length} ids`);
  const sk = await srv.call('/api/skills');
  const leaky = sk.json?.skills?.find((s) => s.name === 'leaky');
  const exp = leaky ? await fetch(`${srv.base}/api/skills/export?ids=${leaky.id}`).then((r) => r.text()) : '';
  ok('ids: the skill export never carries the hard-linked file', !leaked(exp) && !leaked(sk.text), leaky ? JSON.stringify(leaky).slice(0, 200) : 'no row');
  ok('ids: …nor the history mirror', !leaked(historyText(home)));
  await srv.stop();
}

/* ── regrade 2: one read chokepoint, judged on the open descriptor ────── */

/** Run `code` in a child whose HOME is `home` (lib/paths.js binds HOME at import). */
const probe = (home, code) => {
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', `
    const P = await import(${JSON.stringify(path.join(ROOT, 'lib', 'paths.js'))});
    const M = await import(${JSON.stringify(path.join(ROOT, 'lib', 'mutate.js'))});
    const fs = await import('node:fs'); const path = await import('node:path');
    const H = ${JSON.stringify(home)};
    const r = await (async () => { ${code} })();
    process.stdout.write(JSON.stringify(r));`], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
  return JSON.parse(out);
};
const tryOpen = `(p) => { try { return { ok: true, text: P.openUserFile(p).buf.toString() }; } catch (e) { return { ok: false, status: e.status, error: e.message }; } }`;

{
  const home = mkTemp('swap');
  put(path.join(home, '.codex', 'auth.json'), `{"refresh":"${SECRET}"}`);
  const work = path.join(home, 'code', 'work');
  put(path.join(work, 'CLAUDE.md'), '# innocent\n');
  put(path.join(home, '.agent-config-studio', 'roots.json'), JSON.stringify({ version: 1, roots: [{ id: 'work', path: work, label: 'Work', access: 'edit' }] }));
  const r = probe(home, `
    const open = ${tryOpen};
    const f = path.join(H, 'code', 'work', 'CLAUDE.md');
    const checked = P.resolveSafe(f);                 // the check passes on the innocent file…
    fs.unlinkSync(f); fs.linkSync(path.join(H, '.codex', 'auth.json'), f);   // …then it is swapped
    return { swapped: open(checked) };`);
  ok('swap: a file swapped for a hard link to auth.json after the check is refused at the read', !r.swapped.ok && r.swapped.status === 403 && !leaked(JSON.stringify(r)), JSON.stringify(r.swapped));
}
{
  const home = mkTemp('identity');
  put(path.join(home, '.codex', 'auth.json'), `{"refresh":"${SECRET}"}`);
  put(path.join(home, 'elsewhere', 'creds'), 'x');
  const r = probe(home, `
    const open = ${tryOpen};
    fs.renameSync(path.join(H, '.codex', 'auth.json'), path.join(H, 'elsewhere', 'moved'));
    fs.symlinkSync(path.join(H, 'elsewhere', 'moved'), path.join(H, '.codex', 'auth.json'));
    return { viaTarget: open(path.join(H, 'elsewhere', 'moved')) };`);
  ok('identity: the credential reached by its innocent real name is refused by (dev, ino)', !r.viaTarget.ok && r.viaTarget.status === 403, JSON.stringify(r));
}

await scenario('frontmatter', (home) => {
  put(path.join(home, '.codex', 'auth.json'), `---\nname: x\ndescription: ${SECRET}\n---\n`);
  fs.mkdirSync(path.join(home, '.claude', 'skills', 'leak'), { recursive: true });
  fs.linkSync(path.join(home, '.codex', 'auth.json'), path.join(home, '.claude', 'skills', 'leak', 'SKILL.md'));
}, () => [
  ['the registry never publishes a hard-linked credential\'s frontmatter as a description', '/api/registry', (r) => r.status === 200],
]);

await scenario('whereused', (home) => {
  put(path.join(home, '.codex', 'auth.json'), `run: model-id opus ${SECRET}\n`);
  fs.rmSync(path.join(home, '.claude', 'CLAUDE.md'));
  fs.linkSync(path.join(home, '.codex', 'auth.json'), path.join(home, '.claude', 'CLAUDE.md'));
}, () => [
  ['Models "where used" never returns a line of a hard-linked credential', '/api/models/where?family=opus', (r) => r.status === 200],
]);

await scenario('case', (home) => {
  put(path.join(home, '.codex', 'tokens-store'), `{"refresh":"${SECRET}"}`);
  fs.symlinkSync('tokens-store', path.join(home, '.codex', 'auth.json'));
}, (home) => [
  ['AUTH.JSON (another case of a link named auth.json) is refused', file(path.join(home, '.codex', 'AUTH.JSON')), (r) => r.status === 403],
  ['…and so is Auth.Json by ~', file('~/.codex/Auth.Json'), (r) => r.status === 403],
]);

await scenario('dotdot', (home, work) => {
  put(path.join(home, 'secrets', 'inner', 'x'), 'x');
  put(path.join(home, 'secrets', 'AGENTS.md'), `${SECRET}\n`);
  put(path.join(work, 'AGENTS.md'), 'the lexical sibling\n');
  fs.symlinkSync(path.join(home, 'secrets', 'inner'), path.join(work, 'jump'));
}, (home, work) => [
  ['jump/../AGENTS.md resolves the way the kernel does (through the link, outside every root): refused, not the lexical sibling',
   file(`${work}/jump/../AGENTS.md`), (r) => r.status === 403 && !/lexical sibling/.test(r.text)],
]);

// A history version recorded for a path that is now — by identity — a credential.
{
  const home = mkTemp('version');
  put(path.join(home, '.claude', 'CLAUDE.md'), '# global\n');
  put(path.join(home, '.codex', 'AGENTS.md'), '# codex agents\n');
  put(path.join(home, '.codex', 'tokens-store'), `{"refresh":"${SECRET}"}`);
  const srv = await startServer(home, { root: ROOT });
  const agents = path.join(home, '.codex', 'AGENTS.md');
  // An old mirror that holds credential bytes under the innocent name (what an
  // earlier build could have recorded), committed straight into the history repo.
  const repo = path.join(home, '.agent-config-studio', 'history');
  const mirrored = path.join(repo, 'home', '.codex', 'AGENTS.md');
  fs.writeFileSync(mirrored, `{"refresh":"${SECRET}"}`);
  execFileSync('git', ['-C', repo, 'commit', '-qam', 'old mirror'], { encoding: 'utf8' });
  const sha = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  fs.rmSync(agents);
  fs.renameSync(path.join(home, '.codex', 'tokens-store'), path.join(home, '.codex', 'auth.json'));
  fs.symlinkSync('auth.json', agents);
  const v = await srv.call(`/api/history/version?path=${encodeURIComponent(agents)}&sha=${sha}`);
  ok('history: a version for a path that is now a credential is refused', v.status === 403 && !leaked(v.text), `${v.status} ${v.text.slice(0, 120)}`);
  const v2 = await srv.call(`/api/history/version?path=${encodeURIComponent(path.join(home, '.codex', 'AUTH.json'))}&sha=${sha}`);
  ok('history: …and one asked for under a denied name, any case', v2.status === 403 && !leaked(v2.text));
  await srv.stop();
}

// A tampered trash record cannot make a credential pass for a restore's own link.
{
  const home = mkTemp('trash');
  put(path.join(home, '.codex', 'auth.json'), `{"refresh":"${SECRET}"}`);
  const mem = path.join(home, '.claude', 'projects', '-x', 'memory');
  put(path.join(mem, 'keep.md'), 'k\n');
  const r = probe(home, `
    const crypto = await import('node:crypto');
    const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
    const trash = path.join(H, '.agent-config-studio', 'trash');
    const fact = path.join(${JSON.stringify(mem)}, 'fact.md');
    // 1. tampered: name climbs out of the trash to auth.json; fact.md is a link to it
    fs.mkdirSync(path.join(trash, 'evil', 'data'), { recursive: true });
    fs.writeFileSync(path.join(trash, 'evil', 'trash-meta.json'), JSON.stringify({ name: '../../../../.codex/auth.json', layout: 'data', originalPath: fact }));
    fs.linkSync(path.join(H, '.codex', 'auth.json'), fact);
    const credSha = sha(fs.readFileSync(path.join(H, '.codex', 'auth.json')));
    const tampered = M.isRestoreLink('evil', fact, credSha);
    const listed = (await M.listTrash()).some((t) => String(t.name).includes('auth.json'));
    fs.unlinkSync(fact);
    // 2. honest: a real interrupted restore, with and without the recorded bytes
    fs.mkdirSync(path.join(trash, 'good', 'data'), { recursive: true });
    fs.writeFileSync(path.join(trash, 'good', 'data', 'fact.md'), 'the fact');
    fs.writeFileSync(path.join(trash, 'good', 'trash-meta.json'), JSON.stringify({ name: 'fact.md', layout: 'data', originalPath: fact }));
    fs.linkSync(path.join(trash, 'good', 'data', 'fact.md'), fact);
    const right = M.isRestoreLink('good', fact, sha('the fact'));
    const wrong = M.isRestoreLink('good', fact, sha('something else'));
    return { tampered, listed, right, wrong, credStill: fs.existsSync(path.join(H, '.codex', 'auth.json')) };`);
  ok('trash: a record whose name climbs out of the trash never passes as a restore link', r.tampered === false && r.credStill, JSON.stringify(r));
  ok('trash: …and is not even listed as a trash entry', r.listed === false);
  ok('trash: an honest interrupted restore passes only with the recorded bytes', r.right === true && r.wrong === false, JSON.stringify(r));
}

/* ── regrade 3 ────────────────────────────────────────────────────────── */

// A FIFO in an edit folder: the read refuses it at once, and the server never blocks.
{
  let mkfifo = null;
  for (const c of ['/usr/bin/mkfifo', '/bin/mkfifo']) if (fs.existsSync(c)) mkfifo = c;
  if (!mkfifo) console.log('  skip FIFO: no mkfifo on this machine');
  else {
    const home = mkTemp('fifo');
    put(path.join(home, '.claude', 'CLAUDE.md'), '# global\n');
    const work = path.join(home, 'code', 'work');
    put(path.join(work, 'CLAUDE.md'), '# w\n');
    put(path.join(home, '.agent-config-studio', 'roots.json'), JSON.stringify({ version: 1, roots: [{ id: 'work', path: work, label: 'Work', access: 'edit' }] }));
    const fifo = path.join(work, 'pipe.md');
    execFileSync(mkfifo, [fifo]);
    const srv = await startServer(home, { root: ROOT });
    const t0 = Date.now();
    const r = await fetch(`${srv.base}${file(fifo)}`, { signal: AbortSignal.timeout(5000) }).then(async (x) => ({ status: x.status, text: await x.text() }), (e) => ({ status: 0, text: String(e) }));
    const took = Date.now() - t0;
    const h0 = Date.now();
    const health = await fetch(`${srv.base}/api/health`, { signal: AbortSignal.timeout(3000) }).then((x) => x.ok, () => false);
    ok('FIFO: GET /api/file on a named pipe with no writer answers 4xx within 1 s', r.status >= 400 && r.status < 500 && took < 1000, `${r.status} in ${took} ms: ${r.text.slice(0, 100)}`);
    ok('FIFO: …and /api/health stays responsive', health && Date.now() - h0 < 1000);
    await srv.stop();
  }
}

// A trash entry whose data/ is a link to a folder outside the trash.
{
  const home = mkTemp('trash-alias');
  const mem = path.join(home, '.claude', 'projects', '-x', 'memory');
  put(path.join(mem, 'keep.md'), 'k\n');
  put(path.join(home, 'outside', 'fact.md'), 'the fact');
  const r = probe(home, `
    const crypto = await import('node:crypto');
    const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
    const trash = path.join(H, '.agent-config-studio', 'trash');
    const fact = path.join(${JSON.stringify(mem)}, 'fact.md');
    const ext = path.join(H, 'outside', 'fact.md');
    fs.mkdirSync(path.join(trash, 'alias'), { recursive: true });
    fs.symlinkSync(path.join(H, 'outside'), path.join(trash, 'alias', 'data'));
    fs.writeFileSync(path.join(trash, 'alias', 'trash-meta.json'), JSON.stringify({ name: 'fact.md', layout: 'data', originalPath: fact }));
    fs.linkSync(ext, fact);
    const link = M.isRestoreLink('alias', fact, sha('the fact'));
    const listed = (await M.listTrash()).length;
    let restore; try { restore = await M.restoreTrash({ id: 'alias' }); } catch (e) { restore = { error: e.message, status: e.status }; }
    return { link, listed, restore, extStill: fs.existsSync(ext), content: fs.readFileSync(ext, 'utf8') };`);
  ok('trash: a data/ linked to an outside folder is no restore link', r.link === false, JSON.stringify(r));
  ok('trash: …is not listed, restore refuses it, and the outside payload survives', r.listed === 0 && r.restore.error && r.extStill && r.content === 'the fact', JSON.stringify(r));
}

assertRealHomesUnchanged(realBefore, ok);
for (const t of temps) fs.rmSync(t, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
