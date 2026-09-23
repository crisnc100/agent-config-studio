/**
 * The Context view (criterion 9 of builds/memory-review/plan.md): copies
 * collapse with every path still listed, `.cursor/rules/*.mdc` and
 * `.worktrees/` are found, drift is flagged and diffs, outlines are present —
 * and the registry, which history treats as its inventory, is unchanged.
 *
 * HOME is redirected to a temp directory before anything from lib/ loads.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { snapshotRealHomes, assertRealHomesUnchanged } from './real-home.mjs';
import { seedMemoryHome, unlockMemoryHome } from './fixtures/memory-home.mjs';

const realHome = os.homedir();
const realBefore = snapshotRealHomes();
const fakeHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acs-context-')));
process.env.HOME = fakeHome;
process.env.ACS_SUITE = 'offline';
delete process.env.CODEX_HOME;

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

console.log('\ncontext map');
ok('HOME is redirected away from the real one', os.homedir() === fakeHome && fakeHome !== realHome);
const fx = seedMemoryHome(fakeHome);
const tilde = (p) => '~' + p.slice(fakeHome.length);

// Garman-Homes: client work, read-only. A main checkout, one identical
// worktree copy, one drifted, and three links that must never be served.
const G = path.join(fakeHome, 'Documents', 'Garman-Homes');
const gMain = path.join(G, '05-Development', 'client-app');
const gWt1 = path.join(G, '05-Development', 'client-app-wt', 'feature-one');
const gWt2 = path.join(G, '05-Development', 'client-app-wt', 'feature-two');
const gPut = (f, body) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); };
fs.mkdirSync(path.join(gMain, '.git', 'objects'), { recursive: true });
for (const [wt, name] of [[gWt1, 'feature-one'], [gWt2, 'feature-two']]) {
  gPut(path.join(gMain, '.git', 'worktrees', name, 'commondir'), '../..\n');
  gPut(path.join(wt, '.git'), `gitdir: ${path.join(gMain, '.git', 'worktrees', name)}\n`);
}
const gClaude = '# Client app\n\n## Deploy\n\nnever on Fridays\n';
gPut(path.join(gMain, 'CLAUDE.md'), gClaude);
gPut(path.join(gWt1, 'CLAUDE.md'), gClaude);
gPut(path.join(gWt2, 'CLAUDE.md'), gClaude + '\n## Drift\n\nonly here\n');
gPut(path.join(gMain, 'notes.txt'), 'GARMAN-NOTES-MARKER\n');
gPut(path.join(fakeHome, '.ssh', 'id_garman'), 'GARMAN-OUT-OF-ROOTS-MARKER\n');
fs.mkdirSync(path.join(gMain, 'apps'), { recursive: true });
fs.symlinkSync(path.join(fx.alphaSlug, 'session-2', 'subagents', 'agent-x.jsonl'), path.join(gMain, 'apps', 'AGENTS.md'));
fs.mkdirSync(path.join(gMain, 'docs'), { recursive: true });
fs.symlinkSync(path.join(gMain, 'notes.txt'), path.join(gMain, 'docs', 'AGENTS.md'));
fs.mkdirSync(path.join(gMain, 'ext'), { recursive: true });
fs.symlinkSync(path.join(fakeHome, '.ssh', 'id_garman'), path.join(gMain, 'ext', 'CLAUDE.md'));

const { buildRegistry } = await import('../lib/registry.js');
const history = await import('../lib/history.js');
const { contextMap, outlineOf } = await import('../lib/context-map.js');

const strip = (r) => JSON.stringify(r.groups);
const registryBefore = strip(buildRegistry());
await history.ensureRepo();
const snap1 = await history.snapshotAll('before the context map');

const m = await contextMap();
const alpha = m.groups.find((g) => g.label === 'alpha');
ok('C9 one group for the repository, across its main checkout and both worktrees',
   alpha && alpha.checkouts.length === 3 && alpha.checkouts[0].trunk === true, JSON.stringify(alpha?.checkouts));
const scope = (s) => alpha.scopes.find((x) => x.scope === s);

const root = scope('CLAUDE.md');
ok('C9 identical copies collapse into one variant', root?.variants.length === 1, JSON.stringify(root?.variants.map((v) => v.copies)));
const paths = root.variants[0].paths.map((p) => p.display);
const want = [path.join(fx.alpha, 'CLAUDE.md'), path.join(fx.alpha, 'AGENTS.md'), path.join(fx.wt, 'CLAUDE.md'), path.join(fx.inner, 'CLAUDE.md')].map(tilde);
ok('C9 …but every physical path stays listed (worktree copies and the AGENTS.md link)',
   want.every((p) => paths.includes(p)) && paths.length === 4, JSON.stringify(paths));
ok('C9 …the AGENTS.md symlink is marked as a link, not a second file',
   root.variants[0].paths.some((p) => p.alias === 'AGENTS.md → CLAUDE.md'));
ok('C9 …and the editor opens the trunk copy first', root.variants[0].open.display === tilde(path.join(fx.alpha, 'CLAUDE.md')));
ok('C9 files at different scopes are never merged, even with identical bytes',
   scope('docs/CLAUDE.md')?.variants.length === 1 && scope('docs/CLAUDE.md').variants[0].copies === 1);
const docsLink = scope('docs/AGENTS.md');
ok('C9 B9 a link at a different scope (docs/AGENTS.md → ../CLAUDE.md) stays its own entry',
   docsLink?.variants.length === 1 && docsLink.variants[0].linksTo === tilde(path.join(fx.alpha, 'CLAUDE.md'))
   && !paths.includes(tilde(path.join(fx.alpha, 'docs', 'AGENTS.md'))), JSON.stringify(docsLink));
ok('C9 .cursor/rules/*.mdc is found', scope('.cursor/rules/style.mdc')?.kind === 'cursor-rule');
ok('C9 a worktree under .worktrees/ is found (and joins the repository)',
   paths.includes(tilde(path.join(fx.inner, 'CLAUDE.md'))) && alpha.checkouts.some((c) => c.label === 'inner'));
ok('C9 node_modules is never walked', !m.groups.some((g) => g.scopes.some((s) => s.variants.some((v) => v.paths.some((p) => p.display.includes('node_modules'))))));

const web = scope('apps/web/CLAUDE.md');
ok('C9 a drifted worktree copy gets a drift badge', web?.drift === true && web.variants.some((v) => v.drift && !v.trunk), JSON.stringify(web));
ok('C9 …the unchanged scopes do not', root.drift === false);
// Totals now span both roots: the Projects fixture's one drift, plus Garman's.
ok('C9 totals count the collapsed copies and the drift', m.roots.projects.drifted === 1 && m.totals.drifted === 2
   && m.totals.collapsedCopies >= 4, JSON.stringify(m.totals));

const v = root.variants[0];
ok('C9 outlines are present, with a line count per section',
   JSON.stringify(v.outline.map((o) => [o.level, o.text, o.lines])) === JSON.stringify([[1, 'Alpha', 10], [2, 'Build', 4], [2, 'Style', 4]]),
   JSON.stringify(v.outline));
ok('C9 frontmatter and fenced code are not headings',
   JSON.stringify(outlineOf('---\ntitle: x\n---\n# Real\n```\n# not a heading\n```\n').map((o) => o.text)) === '["Real"]');

// The diff opens: both texts, by id, through the HTTP surface.
const { createApp } = await import('../server.js');
const { server } = createApp();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const B = `http://localhost:${server.address().port}`;
const get = (p, headers) => fetch(B + p, { headers }).then(async (r) => [r.status, await r.json()]);
{
  const [s, body] = await get('/api/context');
  ok('GET /api/context is 200', s === 200 && body.groups.length === m.groups.length);
  const w = body.groups.find((g) => g.label === 'alpha').scopes.find((x) => x.scope === 'apps/web/CLAUDE.md');
  const drifted = w.variants.find((x) => x.drift);
  const [s1, a] = await get(`/api/context/file?id=${w.trunkId}`);
  const [s2, b] = await get(`/api/context/file?id=${drifted.id}`);
  ok('C9 the drift diff opens: trunk and worktree texts by id',
     s1 === 200 && s2 === 200 && a.content.includes('npm run dev\n') && b.content.includes('only here'), `${s1} ${s2}`);
  const [s3] = await get(`/api/context/file?path=${encodeURIComponent(path.join(fx.alpha, 'CLAUDE.md'))}`);
  const [s4] = await get(`/api/context/file?id=${Buffer.from(path.join(fx.alpha, 'CLAUDE.md')).toString('base64url')}`);
  ok('the context routes take no path and no base64 path', s3 === 400 && s4 === 400, `${s3} ${s4}`);
  const [s5] = await get('/api/context', { origin: 'http://evil.example', 'sec-fetch-site': 'cross-site' });
  ok('the context GET refuses a cross-site request', s5 === 403, String(s5));

  const gGroup = body.groups.find((g) => g.root === 'garman-homes');
  const gV = gGroup.scopes[0].variants.find((v) => v.trunk);
  const [s6, gf] = await get(`/api/context/file?id=${gV.id}`);
  ok('G2 a Garman file is served read-only by id: content and outline', s6 === 200 && gf.readOnly === true && gf.content === gClaude
     && gf.outline.map((o) => o.text).join() === 'Client app,Deploy', `${s6} ${JSON.stringify(gf).slice(0, 120)}`);
  const text = JSON.stringify(body);
  ok('G3 no refused link\'s bytes reach any response', !['toolu_sub', 'GARMAN-NOTES-MARKER', 'GARMAN-OUT-OF-ROOTS-MARKER'].some((mk) => text.includes(mk)));
  const gPath = path.join(gMain, 'CLAUDE.md');
  const [s7] = await get(`/api/file?path=${encodeURIComponent(gPath)}`);
  const put = await fetch(`${B}/api/file`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: gPath, content: 'x' }) });
  ok('G2 GET /api/file and PUT /api/file still 403 on a Garman-Homes path', s7 === 403 && put.status === 403 && fs.readFileSync(gPath, 'utf8') === gClaude,
     `${s7} ${put.status}`);
}
server.close();

// Garman-Homes: listed, collapsed, drift-flagged — and read-only.
const garman = m.groups.find((g) => g.root === 'garman-homes' && g.label === 'client-app');
{
  ok('G1 Garman-Homes projects are listed, grouped per repo and labelled by root',
     garman && garman.rootLabel === 'Garman Homes' && garman.readOnly === true && garman.checkouts.length === 3, JSON.stringify(garman?.checkouts));
  const gs = garman.scopes.find((x) => x.scope === 'CLAUDE.md');
  const trunkV = gs.variants.find((v) => v.trunk);
  ok('G1 …identical copies collapse, every path still listed', trunkV.copies === 2
     && trunkV.paths.map((p) => p.display).sort().join() === [tilde(path.join(gMain, 'CLAUDE.md')), tilde(path.join(gWt1, 'CLAUDE.md'))].sort().join());
  ok('G1 …and the drifted worktree copy is flagged', gs.drift === true && gs.variants.some((v) => v.drift && v.paths[0].display === tilde(path.join(gWt2, 'CLAUDE.md'))));
  ok('G1 …with per-root counts', m.roots['garman-homes'].files === 3 && m.roots['garman-homes'].entries === 1 && m.roots['garman-homes'].drifted === 1
     && m.roots.projects.readOnly === false && m.roots['garman-homes'].readOnly === true, JSON.stringify(m.roots));
  ok('G2 a Garman variant carries no path for the editor, and is marked read-only',
     garman.scopes.every((x) => x.variants.every((v) => v.readOnly === true && !('path' in v.open))));
  ok('G2 Projects variants still open in the editor', root.variants[0].readOnly === false && root.variants[0].open.path === path.join(fx.alpha, 'CLAUDE.md'));
  const refused = JSON.stringify(m.unreadable);
  ok('G3 an AGENTS.md link to a transcript, a link to a non-context file, and a link out of both roots are refused',
     ['apps/AGENTS.md', 'docs/AGENTS.md', 'ext/CLAUDE.md'].every((x) => refused.includes(`client-app/${x}`)), refused);
}

// Trunk is the checkout whose .worktrees.conf names it, not necessarily git's
// main checkout (on this machine airflo-trunk is itself a worktree).
{
  fs.writeFileSync(path.join(fx.wt, '.worktrees.conf'), `# test\nTRUNK="${fx.wt}"\nROOT="${path.dirname(fx.wt)}"\n`);
  const t = (await contextMap()).groups.find((g) => g.label === 'alpha');
  const w = t.scopes.find((x) => x.scope === 'apps/web/CLAUDE.md');
  ok('C9 the checkout named by .worktrees.conf is trunk: it opens first and drift is measured against it',
     t.checkouts[0].display === tilde(fx.wt) && w.variants.find((x) => x.trunk).open.display === tilde(path.join(fx.wt, 'apps', 'web', 'CLAUDE.md'))
     && w.variants.some((x) => x.drift && x.open.display === tilde(path.join(fx.web, 'CLAUDE.md'))), JSON.stringify(t.checkouts));
  fs.rmSync(path.join(fx.wt, '.worktrees.conf'));
}

// The registry and sidebar are unchanged, and history keeps every copy.
ok('C9 the registry is unchanged by the context map', strip(buildRegistry()) === registryBefore);
const snap2 = await history.snapshotAll('after the context map');
ok('C9 history inventory: a snapshot after the context map removes nothing', snap2.removed === 0 && snap1.removed === 0, JSON.stringify([snap1, snap2]));
const mirrored = (abs) => fs.existsSync(path.join(fakeHome, '.agent-config-studio', 'history', 'home', path.relative(fakeHome, abs)));
ok('G2 the history inventory is unchanged: nothing from Garman-Homes is mirrored or listed',
   !fs.existsSync(path.join(fakeHome, '.agent-config-studio', 'history', 'home', 'Documents', 'Garman-Homes'))
   && !registryBefore.includes('Garman-Homes'));
ok('C9 …and the worktree copy the view collapsed is still mirrored as its own file',
   mirrored(path.join(fx.wt, 'CLAUDE.md')) && mirrored(path.join(fx.alpha, 'CLAUDE.md')));

// G4: the real-home tripwire sha-covers Garman context files, like Projects.
{
  const { compareRealHomes } = await import('./real-home.mjs');
  const g = path.join(realHome, 'Documents', 'Garman-Homes');
  const f = path.join(g, 'client', 'CLAUDE.md');
  const before = { [`context:${g}`]: JSON.stringify([f]), [f]: 'sha-one' };
  ok('G4 an edited Garman context file fails the tripwire', compareRealHomes(before, { ...before, [f]: 'sha-two' }).content.length > 0);
  ok('G4 …and so does a new one', compareRealHomes(before, { ...before, [`context:${g}`]: JSON.stringify([f, `${f}.x`]), [`${f}.x`]: 'sha' }).content.length > 0);
  ok('G4 the real snapshot lists a context key for Garman-Homes', Object.keys(realBefore).includes(`context:${g}`));
}

assertRealHomesUnchanged(realBefore, ok);
unlockMemoryHome(fakeHome);
fs.rmSync(fakeHome, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
