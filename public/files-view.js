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
  return [...tools.values()].filter((t) => t.count).map((t) => ({ ...t, types: [...t.types.values()] }));
}

/** Recently opened, newest first, one row per path, at most `max`. */
function pushRecent(list, item, max = 8) {
  return [item, ...(Array.isArray(list) ? list : []).filter((x) => x && x.path !== item.path)].slice(0, max);
}
