/**
 * builds/acs-reshape PR 1, acceptance: the sidebar's eight-section shape, the
 * old hashes landing somewhere sensible, Context opening on the main files,
 * Tools' three sections, Setup holding the folders and the settings files —
 * and no file the old Files page listed left without a page that opens it.
 *
 * Runs index.html and the real public/ scripts in a node VM against stubbed
 * routes (tests/fixtures/shell-page.mjs). No server, no HOME.
 */
import fs from 'node:fs';
import path from 'node:path';
import { bootPage, routesFor, registry, MEMORY, PATHS, ROOT, settle } from './fixtures/shell-page.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const pages = [];
const boot = async (o) => { const p = await bootPage(o); pages.push(p); await settle(20); return p; };
const H = '/h';
const one = (id, label, p, extra = {}) => ({ id, label, harness: 'claude', display: `~${p.slice(H.length)}`, scope: 'global', dir: path.dirname(p),
  primary: p, deletable: true, files: [{ name: path.basename(p), path: p, display: `~${p.slice(H.length)}` }], ...extra });

console.log('\nreshape: the sidebar');
{
  const p = await boot();
  const labels = (sel) => p.$(sel).querySelectorAll('.nav-item').map((b) => p.text(b.querySelector('.nav-label')));
  ok('the sidebar is exactly Home, Context, Tools, Models, Usage, Memory, Packs, in that order', JSON.stringify(labels('nav')) === JSON.stringify(['Home', 'Context', 'Tools', 'Models', 'Usage', 'Memory', 'Packs']), labels('nav').join(', '));
  const foot = labels('nav-foot');
  ok('the footer is Setup, Trash, then the theme switch', foot.length === 3 && foot[0] === 'Setup' && foot[1] === 'Trash' && /theme$/i.test(foot[2]), foot.join(', '));
}

console.log('\nreshape: old hashes redirect (R7)');
const MOVED = [['#files', 'search', '#search'], ['#scope', 'context', '#context'], ['#audit', 'home', ''], ['#folders', 'setup', '#setup&step=folders'],
  ['#worktrees', 'worktrees', '#worktrees'], ['#skills', 'tools', '#tools/skills'], ['#mcp', 'tools', '#tools/mcp']];
for (const [old, view, now] of MOVED) {
  const cold = await boot({ hash: old });
  const warm = await boot();
  warm.navigate(old);
  await settle(20);
  ok(`${old} lands on ${view} (${now || 'Home, no hash'}), cold and at runtime`, [cold, warm].every((p) => p.eval('S.view') === view && p.location.hash === now && p.errors.length === 0),
    [cold, warm].map((p) => `${p.eval('S.view')} ${p.location.hash} ${p.errors.join(' ')}`).join(' / '));
}
{
  const p = await boot({ hash: '#mcp' });
  ok('…and Tools opens on the section the old page was', p.$('content').querySelector('.tools-tabs .tab.active')?.dataset.section === 'mcp');
  const q = await boot({ hash: '#skills/new' });
  ok('the New skill wizard keeps its own #skills/new, with Tools marked', q.eval('S.view') === 'skill-new' && q.$('btn-tools').getAttribute('aria-current') === 'location');
}

console.log('\nreshape: Context opens on the main instruction files (R2)');
{
  const reg = registry();
  reg.groups.find((g) => g.id === 'memory').entries.unshift(one('md:claude', 'Global · Claude', `${H}/.claude/CLAUDE.md`, { harness: 'claude' }));
  const routes = routesFor({ 'GET /api/registry': () => reg,
    'GET /api/scope': (_b, u) => ({ chain: [
      { path: `${H}/.claude/CLAUDE.md`, display: '~/.claude/CLAUDE.md', scope: 'global', note: 'Every Claude Code session', size: 2048 },
      { path: PATHS.claudeMd, display: '~/Documents/Projects/app/CLAUDE.md', scope: 'directory', note: u.searchParams.get('dir'), size: 512 }] }) });
  routes.files.set(`${H}/.claude/CLAUDE.md`, '# Working agreement\n\nbody\n\n## Lanes\n\nmore\n');
  const p = await boot({ routes, hash: '#context' });
  const c = p.$('content');
  const heads = c.querySelectorAll('h3').map((h) => p.text(h));
  ok('the page reads main files first, then Projects', JSON.stringify(heads) === JSON.stringify(['Your main instruction files', 'Projects']), heads.join(' | '));
  const cards = c.querySelectorAll('.cx-main');
  ok('one card per global instruction file the registry lists (Claude and Grok here), before any project', cards.length === 2
    && cards.every((k) => c.children[0].children.indexOf(k) < c.children[0].children.indexOf(c.querySelector('.cx-projects-h'))));
  const claude = cards.find((k) => /Global · Claude/.test(p.text(k)));
  ok('each shows its size and the outline of its headings', /7 lines · \d+ B/.test(p.text(claude.querySelector('.cx-size')))
    && JSON.stringify(claude.querySelectorAll('.cx-head').map((h) => p.text(h).trim())) === JSON.stringify(['Working agreement7 lines', '  Lanes3 lines'].map((x) => x.trim())),
    claude.querySelectorAll('.cx-head').map((h) => p.text(h)).join(' | '));
  claude.querySelector('button').click();
  await settle(10);
  ok('Open on a main file opens it in the editor, Context still marked', p.eval('S.file?.path') === `${H}/.claude/CLAUDE.md` && p.$('btn-context').getAttribute('aria-current') === 'location');
  p.$('btn-context').click();
  await settle(20);
  const chain = p.$('content').querySelectorAll('.cx-chain .scope-item');
  ok('choosing a project shows what an agent loads there, in order, main file first', chain.length === 2 && /Main file/.test(p.text(chain[0])) && /This project/.test(p.text(chain[1]))
    && p.requests.some((r) => r.path === '/api/scope' && r.search === `?dir=${encodeURIComponent('~/Documents/Projects/app')}`), chain.map((x) => p.text(x)).join(' | '));
  ok('…then every instruction file in that project', !!p.$('content').querySelector('.cx-variant') && p.errors.length === 0, p.errors.join(' | '));
  const proj = p.$('content').querySelector('.cx-project');
  proj.value = '*';
  proj.onchange();
  await settle(10);
  ok('"All projects" lists every project\'s files at once, with no load order (it needs one folder)', p.$('content').querySelectorAll('.cx-variant').length === 1
    && !p.$('content').querySelector('.cx-chain') && !p.$('content').querySelector('.cx-dir'));
}

console.log('\nreshape: Tools has three sections (R3)');
{
  const reg = registry();
  reg.groups.push({ id: 'agents', title: 'Subagents', createKind: 'agent', entries: [one('ag:rev', 'reviewer', `${H}/.claude/agents/reviewer.md`)] });
  reg.groups.push({ id: 'commands', title: 'Slash commands', createKind: 'command', entries: [one('cmd:ship', 'ship', `${H}/.claude/commands/ship.md`)] });
  const p = await boot({ routes: routesFor({ 'GET /api/registry': () => reg }), hash: '#tools' });
  const tabs = p.$('content').querySelectorAll('.tools-tabs .tab').map((b) => p.text(b));
  ok('the sections are Skills, Agents and commands, MCP servers', JSON.stringify(tabs) === JSON.stringify(['Skills', 'Agents and commands', 'MCP servers']), tabs.join(', '));
  ok('Skills is first, with New skill', p.location.hash === '#tools/skills' && !!p.$('content').querySelector('.sk-new'));
  p.$('content').querySelectorAll('.tools-tabs .tab')[1].click();
  await settle(10);
  const text = p.text(p.$('content'));
  ok('Agents and commands lists subagents and slash commands', p.location.hash === '#tools/agents' && /reviewer/.test(text) && /ship/.test(text)
    && !!p.$('content').querySelector('[data-path="/h/.claude/agents/reviewer.md"]'), text.slice(0, 300));
  p.$('content').querySelectorAll('.tools-tabs .tab')[2].click();
  await settle(10);
  ok('MCP servers is the MCP view', p.location.hash === '#tools/mcp' && !!p.$('content').querySelector(`[data-path="${PATHS.mcp}"]`));
  p.$('btn-home').click();
  await settle(5);
  p.$('btn-tools').click();
  await settle(10);
  ok('the sidebar\'s Tools reopens the last section', p.location.hash === '#tools/mcp');
}

console.log('\nreshape: Setup holds the folders and the settings files (R1, R5)');
{
  const p = await boot({ hash: '#setup' });
  const steps = p.$('content').querySelectorAll('.setup-step-btn').map((b) => p.text(b));
  ok('Setup\'s steps: CLIs, Accounts, Project folders, Settings and hooks, Done', JSON.stringify(steps) === JSON.stringify(['1. CLIs', '2. Accounts', '3. Project folders', '4. Settings and hooks', '5. Done']), steps.join(', '));
  p.navigate('#setup&step=settings');
  await settle(10);
  const paths = p.$('content').querySelectorAll('[data-path]').map((b) => b.dataset.path);
  ok('Settings and hooks lists the settings files and the hook scripts', [PATHS.codexConfig, PATHS.codexRules, PATHS.hook].every((x) => paths.includes(x)), paths.join(' '));
  ok('Setup sits in the footer and is marked', !!p.$('btn-setup').closest('.nav-foot') && p.$('btn-setup').getAttribute('aria-current') === 'page');
}

console.log('\nreshape: nothing the Files page listed is unreachable (R1)');
{
  // Static: every registry group the server builds has a page that owns it.
  const regSrc = fs.readFileSync(path.join(ROOT, 'lib', 'registry.js'), 'utf8');
  const groupIds = [...new Set([...regSrc.matchAll(/^\s*(?:groups\.push\(\{\s*)?id: '([a-z-]+)', title:/gm), ...regSrc.matchAll(/\['(agents|commands)', '(?:Subagents|Slash commands)'/g)].map((m) => m[1]))];
  const p0 = await boot();
  const home = p0.eval('GROUP_HOME');
  ok('lib/registry.js builds the groups this test expects', ['memory', 'claude-skills', 'codex-skills', 'mcp', 'auto-memory', 'agents', 'commands', 'plugin-skills', 'hooks', 'settings', 'worktrees', 'retired']
    .every((g) => groupIds.includes(g)), groupIds.join(', '));
  const missing = groupIds.filter((g) => !home[g] || !p0.eval(`!!viewById(${JSON.stringify(home[g])})`));
  ok('every registry group has a page (GROUP_HOME) that lists it', missing.length === 0, missing.join(', '));

  // Live: a registry holding every group, and each file found as an Open on its page.
  const reg = registry();
  const add = (id, title, entries, createKind = null) => reg.groups.push({ id, title, createKind, entries });
  add('claude-skills', 'Claude skills', [one('cs:a', 'a', `${H}/.claude/skills/a/SKILL.md`)], 'claude-skill');
  add('codex-skills', 'Codex skills', [one('xs:b', 'b', `${H}/.codex/skills/b/SKILL.md`, { harness: 'codex' })], 'codex-skill');
  add('plugin-skills', 'Plugin skills', [one('ps:c', 'p: c', `${H}/.claude/plugins/p/skills/c/SKILL.md`)]);
  add('retired', 'Retired skills', [one('rs:d', 'd', `${H}/.claude/skills_retired/d/SKILL.md`)]);
  add('agents', 'Subagents', [one('ag:e', 'e', `${H}/.claude/agents/e.md`)], 'agent');
  add('commands', 'Slash commands', [one('cm:f', 'f', `${H}/.claude/commands/f.md`)], 'command');
  const memIx = `${H}/.claude/projects/-app/memory/MEMORY.md`;
  reg.groups.find((g) => g.id === 'auto-memory').entries[0].files.push({ name: 'MEMORY.md', path: memIx, display: '~/.claude/projects/-app/memory/MEMORY.md' });
  const skillRow = (id, dir, source) => ({ id, name: path.basename(dir), displayName: path.basename(dir), source, dir, description: '', files: [{}], totalBytes: 1, broken: false, aliasCount: 0, aliasSources: [] });
  const projects = reg.groups.find((g) => g.id === 'memory').entries.filter((e) => e.scope === 'project');
  const context = { totals: { files: projects.length, entries: projects.length, drifted: 0 }, roots: {}, unreadable: [],
    groups: projects.map((e, i) => ({ root: 'projects', rootLabel: 'Projects', label: e.label, display: `~/proj${i}`, checkouts: [{}], scopes: [
      { scope: path.basename(e.primary), kind: 'claude', drift: false, trunkId: null, variants: [
        { id: `v${i}`, trunk: true, lines: 1, copies: 1, readOnly: false, open: { path: e.primary, display: e.display }, paths: [{ display: e.display, trunk: true }], outline: [] }] }] })) };
  const memory = { ...MEMORY, groups: [{ ...MEMORY.groups[0], indexes: [{ slug: '-app', lines: 3, oversized: false, openPath: memIx, display: '~/.claude/projects/-app/memory/MEMORY.md' }] }] };
  const routes = routesFor({ 'GET /api/registry': () => reg, 'GET /api/context': () => context, 'GET /api/memory': () => memory,
    'GET /api/skills': () => ({ usage: { caveat: { text: '' } }, skills: [skillRow('s1', `${H}/.claude/skills/a`, 'global-claude'), skillRow('s2', `${H}/.codex/skills/b`, 'global-codex'), skillRow('s3', `${H}/.claude/skills/alpha`, 'global-claude')] }) });
  const p = await boot({ routes });
  const seen = new Map();
  const collect = (where) => { for (const b of p.$('content').querySelectorAll('[data-path]')) if (b.dataset.path && !seen.has(b.dataset.path)) seen.set(b.dataset.path, where); };
  for (const h of ['#context', '#tools/skills', '#tools/agents', '#tools/mcp', '#setup&step=settings', '#worktrees']) { p.navigate(h); await settle(20); collect(h); }
  p.navigate('#context'); await settle(20);
  for (const g of context.groups) { p.eval(`CX.project = ${JSON.stringify(g.display)}; paintContext()`); collect('#context'); }
  p.navigate('#memory'); await settle(20);
  p.eval(`MV.tab = 'projects'; paintMemory()`); collect('#memory');
  const all = reg.groups.flatMap((g) => g.entries.flatMap((e) => (g.id === 'auto-memory' ? e.files.map((f) => f.path) : [e.primary])));
  const orphans = all.filter((x) => !seen.has(x));
  ok(`every one of the ${all.length} registry files is an Open on a page (Context, Tools, Memory, Setup or Worktrees)`, orphans.length === 0, orphans.join(' '));
  ok('…the hooks and settings files on Setup', [PATHS.hook, PATHS.codexConfig, PATHS.codexRules].every((x) => seen.get(x) === '#setup&step=settings'));
  ok('…subagents and commands on Tools', seen.get(`${H}/.claude/agents/e.md`) === '#tools/agents' && seen.get(`${H}/.claude/commands/f.md`) === '#tools/agents');
  ok('…plugin and retired skills on Tools\' Skills', seen.get(`${H}/.claude/plugins/p/skills/c/SKILL.md`) === '#tools/skills' && seen.get(`${H}/.claude/skills_retired/d/SKILL.md`) === '#tools/skills');
  ok('…auto-memory, its MEMORY.md index included, on Memory', seen.get(memIx) === '#memory' && seen.get(PATHS.memory) === '#memory');
  ok('…worktree rules files on Worktrees', seen.get(PATHS.wtDefaults) === '#worktrees');
  ok('no page errors on the way', p.errors.length === 0, p.errors.join(' | '));
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const search = server.slice(server.indexOf("'GET /api/search'"), server.indexOf("'GET /api/search'") + 1200);
  ok('⌘K Search still reads every registry file: /api/search walks every group\'s every entry\'s every file', /buildRegistry\(\)/.test(search)
    && /for \(const g of groups\)/.test(search) && /for \(const e of g\.entries\)/.test(search) && /for \(const f of e\.files\)/.test(search));
}

for (const p of pages) { p.done(); for (const s of p.sources) s.close(); }
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
