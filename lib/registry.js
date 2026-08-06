import fs from 'node:fs';
import path from 'node:path';
import {
  HOME, CLAUDE_HOME, CODEX_HOME, PROJECTS,
  isDenied, kindOf, tilde,
} from './paths.js';

const enc = (p) => Buffer.from(p).toString('base64url');

function exists(p) { try { fs.statSync(p); return true; } catch { return false; } }

/** stat through symlinks — several skills and memory files are symlinked. */
function typeOf(abs) {
  try {
    const s = fs.statSync(abs);
    return s.isDirectory() ? 'dir' : s.isFile() ? 'file' : 'other';
  } catch { return 'broken'; }
}

function listDirs(dir) {
  try {
    return fs.readdirSync(dir)
      .filter((n) => !n.startsWith('.') && typeOf(path.join(dir, n)) === 'dir')
      .sort();
  } catch { return []; }
}
function listFiles(dir) {
  try {
    return fs.readdirSync(dir)
      .filter((n) => !n.startsWith('.')
        && typeOf(path.join(dir, n)) === 'file'
        && !isDenied(path.join(dir, n)))
      .sort();
  } catch { return []; }
}

/** If `abs` is a symlink, where it really points (else null). */
function linkTarget(abs) {
  try {
    if (!fs.lstatSync(abs).isSymbolicLink()) return null;
    return fs.realpathSync(abs);
  } catch { return null; }
}

function fileEntry(abs) {
  let size = 0, mtime = 0;
  try { const s = fs.statSync(abs); size = s.size; mtime = s.mtimeMs; } catch {}
  // Report the real path so it matches what the API resolves to on load.
  let real = abs;
  try { real = fs.realpathSync(abs); } catch {}
  return {
    name: path.basename(abs), path: real, display: tilde(real),
    kind: kindOf(abs), size, mtime,
    ...(real !== abs ? { linkedFrom: tilde(abs) } : {}),
  };
}

/** Pull `name` and `description` out of a SKILL.md YAML frontmatter block. */
export function readFrontmatter(abs) {
  try {
    const raw = fs.readFileSync(abs, 'utf8');
    if (!raw.startsWith('---')) return null;
    const end = raw.indexOf('\n---', 3);
    if (end === -1) return null;
    const block = raw.slice(3, end);
    const out = {};
    let key = null;
    for (const line of block.split('\n')) {
      const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (m) { key = m[1]; out[key] = m[2].trim(); }
      else if (key && line.trim()) out[key] += ' ' + line.trim();
    }
    return out;
  } catch { return null; }
}

function skillEntry(dir, harness) {
  const name = path.basename(dir);
  const files = listFiles(dir).map((f) => fileEntry(path.join(dir, f)));
  // A skill may keep references in subfolders (references/, scripts/).
  for (const sub of listDirs(dir)) {
    for (const f of listFiles(path.join(dir, sub))) {
      files.push(fileEntry(path.join(dir, sub, f)));
    }
  }
  const primary = files.find((f) => f.name === 'SKILL.md') || files[0];
  const fm = primary ? readFrontmatter(primary.path) : null;
  const target = linkTarget(dir);
  return {
    id: enc(dir),
    label: name,
    kindLabel: 'skill',
    dir,
    display: tilde(target || dir),
    harness,
    files,
    primary: primary?.path ?? null,
    description: fm?.description ?? '',
    extraFiles: files.length - 1,
    ...(target ? { linkedFrom: tilde(dir) } : {}),
  };
}

function singleFileEntry(abs, { label, harness, kindLabel, note } = {}) {
  const f = fileEntry(abs);
  return {
    id: enc(abs),
    label: label ?? f.name,
    kindLabel: kindLabel ?? f.kind,
    dir: path.dirname(abs),
    display: f.display,
    harness: harness ?? 'both',
    files: [f],
    primary: abs,
    description: note ?? '',
    extraFiles: 0,
  };
}

/** Version dirs sorted so the newest lands last (numeric-aware). */
function sortVersions(names) {
  return [...names].sort((a, b) => {
    const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] || 0) - (pb[i] || 0);
      if (d) return d;
    }
    return a.localeCompare(b);
  });
}

/**
 * Skill dirs belonging to plugins that are actually enabled in settings.json.
 * The plugin cache holds hundreds of skills from marketplaces that are merely
 * installed; only the enabled ones are ever loaded, so only those are shown.
 */
function enabledPluginSkills() {
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(path.join(CLAUDE_HOME, 'settings.json'), 'utf8'));
  } catch { return []; }

  const out = [];
  for (const [key, on] of Object.entries(settings.enabledPlugins || {})) {
    if (!on) continue;
    const [plugin, marketplace] = key.split('@');
    if (!plugin || !marketplace) continue;

    const base = path.join(CLAUDE_HOME, 'plugins', 'cache', marketplace, plugin);
    const versions = sortVersions(listDirs(base));
    const version = versions[versions.length - 1];
    if (!version) continue;

    // Layout varies: <version>/skills or <version>/.claude/skills
    for (const rel of ['skills', path.join('.claude', 'skills')]) {
      const dir = path.join(base, version, rel);
      for (const name of listDirs(dir)) {
        out.push({ dir: path.join(dir, name), plugin, version });
      }
    }
  }
  return out;
}

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', 'venv', '.venv',
  '__pycache__', 'worktrees', 'target', 'coverage', 'out', 'tmp',
  'Pods', 'DerivedData', '.cache', 'vendor',
]);

/**
 * Find every repo-level memory file under `root`. Depth is not capped — a
 * fixed limit silently hid two thirds of them. Exclusions keep the walk cheap
 * (~10ms here) and realpath tracking prevents symlink cycles.
 */
function discoverProjectMemory(root, names = ['CLAUDE.md', 'AGENTS.md']) {
  const found = [];
  const seen = new Set();
  const walk = (dir) => {
    let real;
    try { real = fs.realpathSync(dir); } catch { return; }
    if (seen.has(real)) return;
    seen.add(real);

    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const abs = path.join(dir, e.name);
      const t = typeOf(abs);
      if (t === 'dir') {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        walk(abs);
      } else if (t === 'file' && (names ? names.includes(e.name) : e.name.endsWith('.md'))) {
        found.push(abs);
      }
    }
  };
  walk(root);
  return found.sort();
}

/**
 * Auto-memory written by the harness itself, one bucket per project scope.
 * Grouped by scope rather than listed flat — there are hundreds of files.
 */
function autoMemoryEntries() {
  const projectsDir = path.join(CLAUDE_HOME, 'projects');
  const out = [];
  for (const slug of listDirs(projectsDir)) {
    const memDir = path.join(projectsDir, slug, 'memory');
    if (typeOf(memDir) !== 'dir') continue;
    const files = discoverProjectMemory(memDir, null)
      .map((f) => fileEntry(f));
    if (!files.length) continue;
    out.push({
      id: enc(memDir),
      label: slug.replace(/^-Users-[^-]+-/, '').replace(/^-+/, ''),
      kindLabel: 'auto-memory',
      dir: memDir,
      display: tilde(memDir),
      harness: 'claude',
      files,
      primary: files[0].path,
      description: `${files.length} memories the harness wrote for this project scope.`,
      extraFiles: files.length - 1,
    });
  }
  return out.sort((a, b) => b.files.length - a.files.length);
}

export function buildRegistry() {
  const groups = [];

  // ---- Memory: the precedence chain, ordered widest -> narrowest -------------
  const memory = [];
  const globalClaude = path.join(CLAUDE_HOME, 'CLAUDE.md');
  const globalCodex = path.join(CODEX_HOME, 'AGENTS.md');
  const workspaceClaude = path.join(PROJECTS, 'CLAUDE.md');

  if (exists(globalClaude)) {
    memory.push(singleFileEntry(globalClaude, {
      label: 'Global · Claude', harness: 'claude', kindLabel: 'memory',
      note: 'Applies to every Claude Code session on this Mac.',
    }));
  }
  if (exists(globalCodex)) {
    memory.push(singleFileEntry(globalCodex, {
      label: 'Global · Codex', harness: 'codex', kindLabel: 'memory',
      note: 'Applies to every Codex session on this Mac.',
    }));
  }
  if (exists(workspaceClaude)) {
    memory.push(singleFileEntry(workspaceClaude, {
      label: 'Projects workspace', harness: 'claude', kindLabel: 'memory',
      note: 'Applies to everything under ~/Documents/Projects.',
    }));
  }
  const repoMemory = discoverProjectMemory(PROJECTS).filter((p) => p !== workspaceClaude);
  // Real files before symlinks, so a link attaches to its target's entry and
  // never the other way around.
  const ordered = [...repoMemory].sort((a, b) => (linkTarget(a) ? 1 : 0) - (linkTarget(b) ? 1 : 0));
  const byReal = new Map();
  for (const abs of ordered) {
    const real = linkTarget(abs) || abs;
    const rel = path.relative(PROJECTS, path.dirname(abs));

    // A symlinked AGENTS.md -> CLAUDE.md is one file serving both harnesses.
    // Record it as an alias on the real entry rather than as a duplicate.
    const owner = byReal.get(real);
    if (owner) {
      owner.harness = 'both';
      owner.aliases = [...(owner.aliases || []), tilde(abs)];
      owner.description =
        `Repo-scoped memory for ${rel}. Also loaded as ${path.basename(abs)} (symlink) — one file, both harnesses.`;
      continue;
    }

    const entry = singleFileEntry(abs, {
      // Last two path segments — enough to disambiguate nested repos without
      // overflowing the sidebar. The full path is always shown in the header.
      label: rel.split(path.sep).slice(-2).join('/') || rel,
      harness: path.basename(abs) === 'AGENTS.md' ? 'codex' : 'claude',
      kindLabel: 'memory',
      note: `Repo-scoped memory for ${rel}.`,
    });
    byReal.set(real, entry);
    memory.push(entry);
  }
  groups.push({
    id: 'memory', title: 'Memory', icon: 'brain',
    subtitle: 'Instruction files, ordered from widest scope to narrowest',
    entries: memory,
  });

  // ---- Skills ---------------------------------------------------------------
  const claudeSkillsDir = path.join(CLAUDE_HOME, 'skills');
  const codexSkillsDir = path.join(CODEX_HOME, 'skills');
  const claudeSkills = listDirs(claudeSkillsDir).map((n) => skillEntry(path.join(claudeSkillsDir, n), 'claude'));
  const codexSkills = listDirs(codexSkillsDir).map((n) => skillEntry(path.join(codexSkillsDir, n), 'codex'));

  // Mark cross-harness pairs so they can be opened side by side. Divergence is
  // expected and fine — this is for comparison, not for enforcing sameness.
  const codexByName = new Map(codexSkills.map((s) => [s.label, s]));
  const claudeByName = new Map(claudeSkills.map((s) => [s.label, s]));
  for (const s of claudeSkills) if (codexByName.has(s.label)) s.pairedWith = codexByName.get(s.label).id;
  for (const s of codexSkills) if (claudeByName.has(s.label)) s.pairedWith = claudeByName.get(s.label).id;

  groups.push({
    id: 'claude-skills', title: 'Claude skills', icon: 'skill',
    subtitle: `${claudeSkills.length} in ~/.claude/skills`, entries: claudeSkills,
  });
  groups.push({
    id: 'codex-skills', title: 'Codex skills', icon: 'skill',
    subtitle: `${codexSkills.length} in ~/.codex/skills`, entries: codexSkills,
  });

  // ---- MCP servers ----------------------------------------------------------
  // Only project-scoped .mcp.json is editable here. Global MCP lives in
  // ~/.claude.json alongside oauth tokens and API-key responses, so it is
  // surfaced read-only through /api/mcp instead of being opened for editing.
  const mcpFiles = discoverProjectMemory(PROJECTS, ['.mcp.json']);
  if (mcpFiles.length) {
    groups.push({
      id: 'mcp', title: 'MCP servers', icon: 'mcp',
      subtitle: 'Project-scoped .mcp.json — global servers are read-only under MCP',
      entries: mcpFiles.map((abs) => {
        const rel = path.relative(PROJECTS, path.dirname(abs));
        return singleFileEntry(abs, {
          label: rel.split(path.sep).slice(-2).join('/') || rel,
          harness: 'both', kindLabel: 'mcp',
          note: `MCP servers available inside ${rel}.`,
        });
      }),
    });
  }

  // ---- Auto-memory ----------------------------------------------------------
  const autoMem = autoMemoryEntries();
  if (autoMem.length) {
    const count = autoMem.reduce((n, e) => n + e.files.length, 0);
    groups.push({
      id: 'auto-memory', title: 'Auto-memory', icon: 'memory',
      subtitle: `${count} harness-written memories across ${autoMem.length} project scopes`,
      entries: autoMem, collapsed: true, ephemeral: true,
    });
  }

  // ---- Subagents & slash commands -------------------------------------------
  // Neither directory exists yet; both appear the moment one is created.
  for (const [dirName, title, sub] of [
    ['agents', 'Subagents', 'Custom agent definitions in ~/.claude/agents'],
    ['commands', 'Slash commands', 'Custom commands in ~/.claude/commands'],
  ]) {
    const dir = path.join(CLAUDE_HOME, dirName);
    const entries = listFiles(dir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => singleFileEntry(path.join(dir, f), {
        label: f.replace(/\.md$/, ''), harness: 'claude', kindLabel: dirName.slice(0, -1),
      }));
    if (entries.length) groups.push({ id: dirName, title, icon: 'agent', subtitle: sub, entries });
  }

  // ---- Plugin skills (enabled plugins only) ----------------------------------
  const pluginSkills = enabledPluginSkills().map(({ dir, plugin, version }) => {
    const e = skillEntry(dir, 'claude');
    e.label = `${plugin}: ${e.label}`;
    e.pluginVersion = version;
    return e;
  });
  if (pluginSkills.length) {
    groups.push({
      id: 'plugin-skills', title: 'Plugin skills', icon: 'plugin',
      subtitle: 'From enabled plugins — edits are lost when the plugin updates',
      entries: pluginSkills, collapsed: true,
    });
  }

  // ---- Hooks ----------------------------------------------------------------
  const hooksDir = path.join(CLAUDE_HOME, 'hooks');
  const hooks = listFiles(hooksDir).map((f) =>
    singleFileEntry(path.join(hooksDir, f), { harness: 'claude', kindLabel: 'hook' }));
  if (hooks.length) {
    groups.push({
      id: 'hooks', title: 'Hooks', icon: 'hook',
      subtitle: 'Shell scripts the harness executes', entries: hooks,
    });
  }

  // ---- Settings & config ----------------------------------------------------
  const settings = [];
  const claudeConfigFiles = [
    ['settings.json', 'Settings'],
    ['settings.local.json', 'Settings (local)'],
    ['advisor-config.json', 'Advisor config'],
    ['investigate-config.json', 'Investigate config'],
    ['review-config.json', 'Review config'],
  ];
  for (const [file, label] of claudeConfigFiles) {
    const abs = path.join(CLAUDE_HOME, file);
    if (exists(abs)) settings.push(singleFileEntry(abs, { label, harness: 'claude', kindLabel: 'config' }));
  }
  const codexConfig = path.join(CODEX_HOME, 'config.toml');
  if (exists(codexConfig)) {
    settings.push(singleFileEntry(codexConfig, { label: 'Codex config', harness: 'codex', kindLabel: 'config' }));
  }
  const rulesDir = path.join(CODEX_HOME, 'rules');
  for (const f of listFiles(rulesDir)) {
    settings.push(singleFileEntry(path.join(rulesDir, f), { label: `rules/${f}`, harness: 'codex', kindLabel: 'config' }));
  }
  groups.push({
    id: 'settings', title: 'Settings & config', icon: 'gear',
    subtitle: 'Machine-readable — validated before every save', entries: settings,
  });

  // ---- Retired skills (kept visible, rarely touched) -------------------------
  const retiredDir = path.join(CLAUDE_HOME, 'skills_retired');
  const retired = listDirs(retiredDir).map((n) => skillEntry(path.join(retiredDir, n), 'claude'));
  if (retired.length) {
    groups.push({
      id: 'retired', title: 'Retired skills', icon: 'archive',
      subtitle: 'Not loaded by the harness', entries: retired, collapsed: true,
    });
  }

  return { groups, home: HOME, generatedAt: Date.now() };
}

/**
 * The memory files that actually apply when an agent runs in `dir`, in the
 * order the harness layers them (widest scope first).
 */
export function scopeChain(dir) {
  const chain = [];
  const push = (abs, scope, note) => {
    if (exists(abs)) chain.push({ ...fileEntry(abs), scope, note });
  };
  push(path.join(CLAUDE_HOME, 'CLAUDE.md'), 'global', 'Every Claude Code session');
  push(path.join(CODEX_HOME, 'AGENTS.md'), 'global', 'Every Codex session');

  const parts = path.resolve(dir).split(path.sep);
  const walked = [];
  for (let i = 1; i <= parts.length; i++) {
    const cur = parts.slice(0, i).join(path.sep) || path.sep;
    if (!cur.startsWith(HOME)) continue;
    walked.push(cur);
  }
  for (const d of walked) {
    push(path.join(d, 'CLAUDE.md'), 'directory', tilde(d));
    push(path.join(d, 'AGENTS.md'), 'directory', tilde(d));
  }
  // Dedupe while preserving order.
  const seen = new Set();
  return chain.filter((c) => (seen.has(c.path) ? false : (seen.add(c.path), true)));
}
