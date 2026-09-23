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

const { buildRegistry } = await import('../lib/registry.js');
const history = await import('../lib/history.js');
const { contextMap, outlineOf } = await import('../lib/context-map.js');

const strip = (r) => JSON.stringify(r.groups);
const registryBefore = strip(buildRegistry());
await history.ensureRepo();
const snap1 = await history.snapshotAll('before the context map');

const m = contextMap();
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
ok('C9 .cursor/rules/*.mdc is found', scope('.cursor/rules/style.mdc')?.kind === 'cursor-rule');
ok('C9 a worktree under .worktrees/ is found (and joins the repository)',
   paths.includes(tilde(path.join(fx.inner, 'CLAUDE.md'))) && alpha.checkouts.some((c) => c.label === 'inner'));
ok('C9 node_modules is never walked', !m.groups.some((g) => g.scopes.some((s) => s.variants.some((v) => v.paths.some((p) => p.display.includes('node_modules'))))));

const web = scope('apps/web/CLAUDE.md');
ok('C9 a drifted worktree copy gets a drift badge', web?.drift === true && web.variants.some((v) => v.drift && !v.trunk), JSON.stringify(web));
ok('C9 …the unchanged scopes do not', root.drift === false);
ok('C9 totals count the collapsed copies and the drift', m.totals.drifted === 1 && m.totals.collapsedCopies >= 3, JSON.stringify(m.totals));

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
}
server.close();

// Trunk is the checkout whose .worktrees.conf names it, not necessarily git's
// main checkout (on this machine airflo-trunk is itself a worktree).
{
  fs.writeFileSync(path.join(fx.wt, '.worktrees.conf'), `# test\nTRUNK="${fx.wt}"\nROOT="${path.dirname(fx.wt)}"\n`);
  const t = contextMap().groups.find((g) => g.label === 'alpha');
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
ok('C9 …and the worktree copy the view collapsed is still mirrored as its own file',
   mirrored(path.join(fx.wt, 'CLAUDE.md')) && mirrored(path.join(fx.alpha, 'CLAUDE.md')));

assertRealHomesUnchanged(realBefore, ok);
unlockMemoryHome(fakeHome);
fs.rmSync(fakeHome, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
