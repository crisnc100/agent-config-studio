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
 * the same type has the same one. Then the colliding entries grow parent
 * context together (a label that is its folder's tail takes the next parent:
 * lib/production → dealer-portal/lib/production → airflo-trunk/…) until every
 * pair in different folders differs. Entries still alike share a folder, so
 * the filename tells them apart instead.
 */
function shownLabels(entries) {
  const out = {};
  const parts = (p) => p.replace(/^~\//, '').split('/').filter(Boolean);
  const info = entries.map((e) => {
    const full = parts(e.display || '');
    const dir = e.where ? parts(e.where) : full.slice(0, -1);
    const own = e.label.split('/');
    return { e, dir, key: dir.join('/'), file: full[full.length - 1] || '', own, tail: dir.slice(-own.length).join('/') === e.label };
  });
  const at = (x, k) => (k === 0 ? x.e.label
    : x.tail ? x.dir.slice(-(x.own.length + k)).join('/') : `${x.e.label} · ${x.dir.slice(-k).join('/')}`);
  const groups = new Map();
  for (const x of info) groups.set(x.e.label, [...(groups.get(x.e.label) || []), x]);
  for (const group of groups.values()) {
    if (group.length === 1) { out[group[0].e.id] = group[0].e.label; continue; }
    const apart = (labels) => group.every((x, i) => group.every((y, j) => i === j || x.key === y.key || labels[i] !== labels[j]));
    const max = Math.max(...group.map((x) => x.dir.length));
    let k = 0;
    let labels = group.map((x) => at(x, 0));
    while (!apart(labels) && k < max) { k++; labels = group.map((x) => at(x, k)); }
    const seen = new Map();
    for (const l of labels) seen.set(l, (seen.get(l) || 0) + 1);
    group.forEach((x, i) => { out[x.e.id] = seen.get(labels[i]) > 1 ? `${labels[i]} · ${x.file}` : labels[i]; });
  }
  return out;
}

/** Recently opened, newest first, one row per path, at most `max`. */
function pushRecent(list, item, max = 8) {
  return [item, ...(Array.isArray(list) ? list : []).filter((x) => x && x.path !== item.path)].slice(0, max);
}
