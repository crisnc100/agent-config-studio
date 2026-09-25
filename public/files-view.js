/* Agent Config Studio — the Files page: every registry file, by tool, then by type */

/**
 * Pure, and loaded before app.js, so tests run it in a VM as the browser does.
 * The registry groups files by type; this regroups them by the tool that reads
 * them. `scope: 'project'` comes from the server, so no path is guessed here.
 */
const FILE_TOOLS = [
  ['claude', 'Claude Code'],
  ['codex', 'Codex'],
  ['grok', 'Grok'],
  ['project', 'Projects'],
  ['shared', 'Shared'],
];

const FILE_TYPE_NAMES = {
  settings: 'Settings', hooks: 'Hooks', agents: 'Agents', commands: 'Commands',
  'claude-skills': 'Skills', 'codex-skills': 'Skills', 'plugin-skills': 'Plugin skills',
  'auto-memory': 'Auto-memory', mcp: 'MCP', worktrees: 'Worktrees', retired: 'Retired skills',
};
/** Instruction files are named for what the tool calls them. */
const MEMORY_NAMES = { claude: 'CLAUDE.md', codex: 'AGENTS.md', grok: 'AGENTS.md', project: 'CLAUDE.md & AGENTS.md', shared: 'Instruction files' };

/** Where an EMPTY group that can create belongs — there is no entry to ask. */
const GROUP_TOOL = { 'claude-skills': 'claude', 'codex-skills': 'codex', hooks: 'claude', agents: 'claude', commands: 'claude' };

function fileTool(entry) {
  if (entry.scope === 'project') return 'project';
  return ['claude', 'codex', 'grok'].includes(entry.harness) ? entry.harness : 'shared';
}

function fileType(group, entry, tool) {
  if (group.id === 'memory') return { key: 'memory', label: MEMORY_NAMES[tool] };
  if (group.id === 'settings' && /^rules\//.test(entry.label)) return { key: 'rules', label: 'Rules' };
  return { key: group.id, label: FILE_TYPE_NAMES[group.id] || group.title };
}

/**
 * [{ id, label, count, types: [{ key, label, group, entries, create }] }] in
 * tool order, empty tools left out. A registry group's "+" appears once, on
 * the first type built from it, so each create action stays single.
 */
function filesModel(registry) {
  const tools = new Map(FILE_TOOLS.map(([id, label]) => [id, { id, label, count: 0, types: new Map() }]));
  const created = new Set();
  for (const g of registry?.groups || []) {
    // A group that can create is shown even empty, or its first file could never be made.
    if (!g.entries.length && g.createKind) {
      const tool = tools.get(GROUP_TOOL[g.id] || 'shared');
      const t = fileType(g, { label: '' }, tool.id);
      const key = `${tool.id}:${t.key}`;
      if (!tool.types.has(key)) tool.types.set(key, { key, label: t.label, group: g, entries: [], create: !created.has(g.id) });
      created.add(g.id);
      continue;
    }
    for (const e of g.entries) {
      const tool = tools.get(fileTool(e));
      const t = fileType(g, e, tool.id);
      const key = `${tool.id}:${t.key}`;
      if (!tool.types.has(key)) {
        const create = !!g.createKind && !created.has(g.id);
        if (create) created.add(g.id);
        tool.types.set(key, { key, label: t.label, group: g, entries: [], create });
      }
      tool.types.get(key).entries.push(e);
      tool.count++;
    }
  }
  return [...tools.values()].filter((t) => t.types.size)
    .map((t) => ({ ...t, types: [...t.types.values()].map((x) => ({ ...x, labels: shownLabels(x.entries) })) }));
}

/**
 * The label each entry shows in its type: its own, unless another entry in
 * the same type has the same one. Then a label that is the tail of its
 * folder's path takes the next parent segment (apps/web → alpha/apps/web)
 * until they differ; any other label gets its folder's name after it.
 */
function shownLabels(entries) {
  const out = {};
  const counts = new Map();
  for (const e of entries) counts.set(e.label, (counts.get(e.label) || 0) + 1);
  for (const e of entries) {
    if (counts.get(e.label) < 2) { out[e.id] = e.label; continue; }
    const where = (e.where || e.display.replace(/\/[^/]*$/, '')).replace(/^~\//, '').split('/').filter(Boolean);
    const own = e.label.split('/');
    const tail = where.slice(-own.length).join('/') === e.label;
    out[e.id] = tail ? where.slice(-(own.length + 1)).join('/') : `${e.label} · ${where[where.length - 1] || ''}`;
  }
  // A second pass for anything the first still left identical.
  const seen = new Map();
  for (const e of entries) seen.set(out[e.id], (seen.get(out[e.id]) || 0) + 1);
  for (const e of entries) {
    if (seen.get(out[e.id]) < 2) continue;
    const where = (e.where || e.display.replace(/\/[^/]*$/, '')).replace(/^~\//, '').split('/').filter(Boolean);
    out[e.id] = where.slice(-3).join('/');
  }
  return out;
}

/** Recently opened, newest first, one row per path, at most `max`. */
function pushRecent(list, item, max = 8) {
  return [item, ...(Array.isArray(list) ? list : []).filter((x) => x && x.path !== item.path)].slice(0, max);
}
