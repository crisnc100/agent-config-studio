/**
 * The front end booted in tests/fixtures/fake-dom.mjs against stubbed routes.
 * Nothing here touches a filesystem beyond reading public/: every route answer
 * is fixture data, so no HOME is involved at all.
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { makePage, settle } from './fake-dom.mjs';

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const PUB = path.join(ROOT, 'public');
export const HTML = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
/** The scripts index.html loads, in its order, minus the vendored markdown parser. */
export const SCRIPTS = [...HTML.matchAll(/<script src="\/([^"]+)"/g)].map((m) => m[1]).filter((s) => !s.startsWith('vendor/'));

const H = '/h';
const file = (p, extra = {}) => ({ name: p.split('/').pop(), path: `${H}/${p}`, display: `~/${p}`, ...extra });
export const PATHS = {
  skill: `${H}/.claude/skills/alpha/SKILL.md`,
  skillRef: `${H}/.claude/skills/alpha/ref.md`,
  hook: `${H}/.claude/hooks/pre tool.sh`,
  mcp: `${H}/Documents/Projects/app/.mcp.json`,
  claudeMd: `${H}/Documents/Projects/app/CLAUDE.md`,
  memory: `${H}/.claude/projects/-app/memory/fact.md`,
  synthetic: `${H}/.claude/projects/-gone/memory/orphan.md`,
  grokAgents: `${H}/.grok/AGENTS.md`,
  codexConfig: `${H}/.codex/config.toml`,
  codexRules: `${H}/.codex/rules/default.rules`,
  wtDefaults: `${H}/.config/worktree/defaults.conf`,
};

export function registry(over = {}) {
  return {
    groups: [
      { id: 'skills', title: 'Skills', createKind: 'claude-skill', canAddFiles: true, entries: [
        { id: 'skill:alpha', scope: 'global', label: 'alpha', harness: 'claude', kindLabel: 'skill', display: '~/.claude/skills/alpha',
          dir: `${H}/.claude/skills/alpha`, primary: PATHS.skill, deletable: true,
          files: [file('.claude/skills/alpha/SKILL.md'), file('.claude/skills/alpha/ref.md')] },
      ] },
      { id: 'memory', title: 'Memory', createKind: null, entries: [
        { id: 'md:grok', label: 'Global · Grok', harness: 'grok', kindLabel: 'memory', display: '~/.grok/AGENTS.md', scope: 'global',
          dir: `${H}/.grok`, primary: PATHS.grokAgents, deletable: true, files: [file('.grok/AGENTS.md')] },
        { id: 'md:app', label: 'app', harness: 'both', kindLabel: 'memory', display: '~/Documents/Projects/app/CLAUDE.md', scope: 'project',
          dir: `${H}/Documents/Projects/app`, primary: PATHS.claudeMd, deletable: true, files: [file('Documents/Projects/app/CLAUDE.md')] },
      ] },
      { id: 'auto-memory', title: 'Auto-memory', collapsed: true, createKind: null, entries: [
        { id: 'am:fact', label: 'fact', harness: 'claude', kindLabel: 'auto-memory', display: '~/.claude/projects/-app/memory/fact.md', scope: 'global',
          dir: `${H}/.claude/projects/-app/memory`, primary: PATHS.memory, deletable: true, files: [file('.claude/projects/-app/memory/fact.md')] },
      ] },
      { id: 'hooks', title: 'Hooks', collapsed: true, createKind: 'claude-hook', entries: [
        { id: 'hook:pre', scope: 'global', label: 'pre tool', harness: 'claude', kindLabel: 'hook', display: '~/.claude/hooks/pre tool.sh',
          dir: `${H}/.claude/hooks`, primary: PATHS.hook, deletable: true, files: [file('.claude/hooks/pre tool.sh')] },
      ] },
      { id: 'settings', title: 'Settings & config', createKind: null, entries: [
        { id: 'cfg:codex', label: 'Codex config', harness: 'codex', kindLabel: 'config', display: '~/.codex/config.toml', scope: 'global',
          dir: `${H}/.codex`, primary: PATHS.codexConfig, deletable: false, files: [file('.codex/config.toml')] },
        { id: 'cfg:rules', label: 'rules/default.rules', harness: 'codex', kindLabel: 'config', display: '~/.codex/rules/default.rules', scope: 'global',
          dir: `${H}/.codex/rules`, primary: PATHS.codexRules, deletable: true, files: [file('.codex/rules/default.rules')] },
      ] },
      { id: 'mcp', title: 'MCP', createKind: null, entries: [
        { id: 'mcp:app', scope: 'project', label: 'app', harness: 'claude', kindLabel: 'mcp', display: '~/Documents/Projects/app/.mcp.json',
          dir: `${H}/Documents/Projects/app`, primary: PATHS.mcp, deletable: false, files: [file('Documents/Projects/app/.mcp.json')] },
      ] },
      { id: 'worktrees', title: 'Worktrees', createKind: 'worktree-project', entries: [
        { id: 'wt:defaults', label: 'Defaults template', harness: 'shell', kindLabel: 'worktree', display: '~/.config/worktree/defaults.conf', scope: 'global',
          dir: `${H}/.config/worktree`, primary: PATHS.wtDefaults, deletable: false, files: [file('.config/worktree/defaults.conf')] },
        { id: 'wt:conf', scope: 'project', label: 'app', harness: 'both', kindLabel: 'config', display: '~/Documents/Projects/app-trunk/.worktrees.conf',
          dir: `${H}/Documents/Projects/app-trunk`, primary: `${H}/Documents/Projects/app-trunk/.worktrees.conf`, deletable: false,
          files: [file('Documents/Projects/app-trunk/.worktrees.conf')] },
      ] },
    ],
    history: { path: '~/.agent-config-studio/history', commits: 12, lastAt: Date.now() - 3_600_000, lastSubject: 'save CLAUDE.md' },
    assistActions: [],
    harnesses: [{ id: 'claude', label: 'Claude Code', models: [{ id: 'm-default', label: 'Default' }], defaultModel: 'm-default', retired: {}, streams: true }],
    defaultHarness: 'claude',
    registryError: null,
    modelAlerts: 2,
    ...over,
  };
}

export const MEMORY = {
  rows: [
    { id: 'r1', name: 'fact', type: 'project', group: 'g1', rel: 'fact.md', inQueue: true, activity: '2026-01-01', modified: '2026-01-01',
      openPath: PATHS.memory, display: '~/.claude/projects/-app/memory/fact.md' },
    { id: 'r2', name: 'orphan', type: 'project', group: 'g1', rel: 'orphan.md', inQueue: true, activity: '2026-01-02', modified: '2026-01-02',
      openPath: PATHS.synthetic, display: '~/.claude/projects/-gone/memory/orphan.md' },
  ],
  groups: [{ id: 'g1', label: 'app', state: 'resolved', rowCount: 2, display: '~/Documents/Projects/app', slugs: [], indexes: [] }],
  slugCount: 2, states: { resolved: 1 }, hiddenProbeFiles: 0,
  other: { codex: { count: null, note: 'not present' }, grok: { count: null, note: 'not present' } },
  scan: { transcripts: 1, scanned: 1, reused: 0, ms: 1 },
  caveat: { text: 'Last written is the newest successful write found in transcripts.' },
  keepDays: 90,
  findings: { emptySlugs: [], dangling: [], unindexed: [], oversized: [], orphans: [], duplicates: [] },
};

export const CONTEXT = {
  totals: { files: 1, entries: 1, collapsedCopies: 0, drifted: 0 },
  roots: { projects: { label: 'Projects', files: 1, entries: 1, drifted: 0 } },
  unreadable: [],
  groups: [{ root: 'projects', rootLabel: 'Projects', label: 'app', display: '~/Documents/Projects/app', checkouts: [{}], scopes: [
    { scope: '.', kind: 'claude', drift: false, trunkId: null, variants: [
      { id: 'v1', trunk: true, lines: 3, copies: 1, readOnly: false, open: { path: PATHS.claudeMd, display: '~/Documents/Projects/app/CLAUDE.md' },
        paths: [{ display: '~/Documents/Projects/app/CLAUDE.md', trunk: true }], outline: [] },
    ] },
  ] }],
};

/**
 * Default route answers. `over` replaces any of them by "METHOD /path"; a
 * function there gets (body, url) and may throw { status } for an HTTP error.
 */
export function routesFor(over = {}) {
  const files = new Map(Object.values(PATHS).map((p) => [p, `# ${p.split('/').pop()}\n\nbody\n`]));
  const reg = { current: registry() };
  const table = {
    'GET /api/registry': () => reg.current,
    'GET /api/file': (_b, u) => {
      const p = u.searchParams.get('path');
      if (!files.has(p)) throw { status: 404, body: { error: 'not found' } };
      const content = files.get(p);
      return { path: p, display: `~${p.slice(H.length)}`, kind: p.endsWith('.md') ? 'markdown' : 'text', content, mtime: 1, size: content.length, lines: 3 };
    },
    'PUT /api/file': (b) => { files.set(b.path, b.content); return { saved: true, mtime: 2, sha: 'abcdef1234' }; },
    'GET /api/memory': () => MEMORY,
    'GET /api/memory/ops': () => ({ ops: [] }),
    'GET /api/context': () => CONTEXT,
    'GET /api/mcp': () => ({ note: '', global: [], codex: [] }),
    'GET /api/skills': () => ({ skills: [], usage: { caveat: { text: '' } } }),
    'GET /api/models': () => ({ rows: [], catalogs: [], pending: 2, checkedAt: Date.now() }),
    'GET /api/worktree': (_b, u) => (u.searchParams.get('status') === '0'
      ? { registered: [], candidates: [{ path: `${H}/Documents/Projects/new`, display: '~/Documents/Projects/new' }] }
      : { registered: [], candidates: [], projects: [] }),
    'GET /api/worktree/bases': () => ({ bases: ['origin/main'], suggested: 'origin/main' }),
    'GET /api/usage': () => ({ seats: [] }),
    'GET /api/harnesses': () => ({ harnesses: reg.current.harnesses, defaultHarness: 'claude', registryError: null }),
    'GET /api/trash': () => ({ items: [] }),
    'GET /api/scope/dirs': () => ({ dirs: [{ path: `${H}/Documents/Projects`, display: '~/Documents/Projects' }] }),
    'GET /api/scope': () => ({ chain: [] }),
    'GET /api/search': (_b, u) => ({ hits: [{
      entryId: 'hook:pre', path: PATHS.hook, entryLabel: 'pre tool', file: 'pre tool.sh', harness: 'claude', group: 'Hooks',
      display: '~/.claude/hooks/pre tool.sh', matches: [{ line: 1, text: u.searchParams.get('q') }], total: 1 }] }),
    'POST /api/create': (b) => ({ path: PATHS.skill, display: `new ${b.kind}` }),
    'POST /api/create-file': () => ({ path: PATHS.skillRef, display: 'ref.md' }),
    'POST /api/delete': () => ({ display: 'alpha', files: 2 }),
    ...over,
  };
  const fn = async (method, p, body, url) => {
    const h = table[`${method} ${p}`];
    if (!h) throw { status: 404, body: { error: `no stub for ${method} ${p}` } };
    return typeof h === 'function' ? h(body, url) : h;
  };
  fn.files = files;
  fn.reg = reg;
  fn.table = table;
  return fn;
}

/** Boot the page: parse index.html, run its scripts, wait for boot to finish. */
process.setMaxListeners(0);

export async function bootPage({ routes = routesFor(), hash = '', storage, width, carry } = {}) {
  const page = makePage({ html: HTML, routes, hash, storage, width });
  if (carry) for (const [k, v] of carry) page.store.set(k, v);
  const unhandled = (e) => page.errors.push(`unhandled: ${e?.stack || e}`);
  process.on('unhandledRejection', unhandled);
  page.done = () => process.off('unhandledRejection', unhandled);
  for (const s of SCRIPTS) page.run(path.join(PUB, s));
  await settle(5);
  return page;
}

export { settle };
