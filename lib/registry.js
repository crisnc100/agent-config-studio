import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  HOME, CLAUDE_HOME, CODEX_HOME, GROK_HOME, WORKTREE_HOME,
  currentRoots, isDenied, kindOf, readUserText, resolveSafe, resolutionTrail, tilde,
} from './paths.js';
import { decodeSlug, encodeSlug, isTempProbe } from './memory-index.js';
import { repoOf, mainCheckoutOf } from './gitmeta.js';
import { budget, spend, markWalk, WALK_LIMITS } from './walk-budget.js';

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
    return fs.realpathSync.native(abs);
  } catch { return null; }
}

function fileEntry(abs) {
  let size = 0, mtime = 0;
  try { const s = fs.statSync(abs); size = s.size; mtime = s.mtimeMs; } catch {}
  // Report the real path so it matches what the API resolves to on load —
  // unless the way there passes a denied name (a link through auth.json):
  // then the path as found is kept, so every read of it is refused for that
  // name instead of reaching the target under an innocent one.
  let real = abs;
  try { real = fs.realpathSync.native(abs); } catch {}
  try { if (resolutionTrail(abs).some(isDenied)) real = abs; } catch { real = abs; }
  return {
    name: path.basename(abs), path: real, display: tilde(real),
    kind: kindOf(abs), size, mtime,
    ...(real !== abs ? { linkedFrom: tilde(abs) } : {}),
  };
}

/** Pull `name` and `description` out of a SKILL.md YAML frontmatter block. */
export function readFrontmatter(abs) {
  try {
    const raw = readUserText(abs, { maxBytes: 1024 * 1024 });
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
    settings = JSON.parse(readUserText(path.join(CLAUDE_HOME, 'settings.json')));
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
 * (~10ms here) and realpath tracking prevents symlink cycles. `allowance`
 * (lib/walk-budget.js) bounds entries and time; when it runs out the walk
 * stops and the allowance says it was partial.
 */
function discoverProjectMemory(root, names = ['CLAUDE.md', 'AGENTS.md'], allowance = null) {
  const found = [];
  const seen = new Set();
  const walk = (dir) => {
    if (allowance?.partial) return;
    let real;
    try { real = fs.realpathSync.native(dir); } catch { return; }
    if (seen.has(real)) return;
    seen.add(real);

    // Streamed one entry at a time, the allowance spent per entry: a folder
    // of 200,000 files is never listed into memory first. (One readdir call
    // that blocks still blocks — a synchronous call cannot be interrupted.)
    let handle;
    try { handle = fs.opendirSync(dir); } catch { return; }
    const subdirs = [];
    try {
      for (let e; (e = handle.readSync()) !== null;) {
        if (!spend(allowance)) break;
        const abs = path.join(dir, e.name);
        const t = typeOf(abs);
        if (t === 'dir') {
          if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
          subdirs.push(abs);
        } else if (t === 'file' && (names ? names.includes(e.name) : e.name.endsWith('.md'))) {
          found.push(abs);
        }
      }
    } catch { /* unreadable mid-listing: what was read stands */ }
    finally { try { handle.closeSync(); } catch {} }
    for (const sd of subdirs.sort()) walk(sd);
  };
  walk(root);
  return found.sort();
}

/**
 * The name the Memory view gives a slug's project: its repository's main
 * checkout (so a worktree rolls up under its repo), else the folder, else the
 * slug with HOME dropped. `where` is the project's own folder, for the
 * tooltip and to tell same-named entries apart. Decoding walks the
 * filesystem, and the registry is rebuilt on every file event, so each slug
 * is decoded once per process.
 */
const slugNames = new Map();
function slugName(slug) {
  if (slugNames.has(slug)) return slugNames.get(slug);
  const home = encodeSlug(HOME) + '-';
  let out = { label: (slug.startsWith(home) ? slug.slice(home.length) : slug.replace(/^-Users-[^-]+-/, '')).replace(/^-+/, ''), where: null };
  if (!isTempProbe(slug)) {
    const dec = decodeSlug(slug);
    if (dec.state === 'found') {
      const repo = repoOf(dec.path);
      out = { label: path.basename(repo ? mainCheckoutOf(repo.commonDir) : dec.path), where: tilde(dec.path) };
    }
  }
  slugNames.set(slug, out);
  return out;
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
      ...slugName(slug),
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

/** The files the registry wants from a root, found in ONE bounded walk. */
const ROOT_FILES = ['CLAUDE.md', 'AGENTS.md', '.mcp.json', '.worktrees.conf'];
/**
 * The registry is built synchronously, so a root's walk may hold the event
 * loop for at most SYNC_SLICE_MS. A root that does not finish inside that
 * slice is "large": from then on it is walked off the main path — async,
 * yielding between directory batches, under the same entry and time caps —
 * one walk per root at a time, and builds use its last finished result
 * (none yet: what the slice found). A finished walk tells onWalkDone's
 * listeners, so the server can rebuild and re-aim its watchers. Small roots
 * keep the immediate synchronous walk they always had.
 */
const SYNC_SLICE_MS = 300;
const walks = new Map();   // root realpath -> { files, large, stale, running }
const walkListeners = new Set();

/** Be told when an off-path walk of a large root has finished. */
export function onWalkDone(fn) { walkListeners.add(fn); return () => walkListeners.delete(fn); }

/** Something changed on disk: large roots are walked again (off the main path) at the next build. */
export function staleLargeWalks() { for (const w of walks.values()) if (w.large) w.stale = true; }

/** The directories that hold a root's registry files, from its last walk — what a non-recursive watcher watches. */
export function walkedDirs(rootReal) {
  const w = walks.get(rootReal);
  return w ? [...new Set(w.files.map((f) => path.dirname(f)))] : [];
}

async function discoverAsync(root, names, allowance) {
  const found = [];
  const seen = new Set();
  const walk = async (dir) => {
    if (allowance.partial) return;
    let real;
    try { real = await fsp.realpath(dir); } catch { return; }
    if (seen.has(real)) return;
    seen.add(real);
    let handle;
    try { handle = await fsp.opendir(dir); } catch { return; }
    const subdirs = [];
    try {
      for await (const e of handle) {
        if (!spend(allowance)) break;
        const abs = path.join(dir, e.name);
        let st = null;
        try { st = await fsp.stat(abs); } catch {}
        if (st?.isDirectory()) {
          if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
          subdirs.push(abs);
        } else if (st?.isFile() && names.includes(e.name)) {
          found.push(abs);
        }
      }
    } catch { /* unreadable mid-listing: what was read stands */ }
    for (const sd of subdirs.sort()) await walk(sd);
  };
  await walk(root);
  return found.sort();
}

function walkOffPath(rootReal) {
  const w = walks.get(rootReal);
  if (!w || w.running) return;
  w.stale = false;
  const allowance = budget();
  w.running = discoverAsync(rootReal, ROOT_FILES, allowance).then((files) => {
    w.files = files;
    markWalk(rootReal, 'registry', allowance);
  }, () => {}).finally(() => {
    w.running = null;
    for (const fn of walkListeners) { try { fn(rootReal); } catch {} }
  });
}

function walkRoot(root) {
  const w = walks.get(root.real);
  if (w?.large) {
    if (w.stale) walkOffPath(root.real);
    return (names) => w.files.filter((p) => names.includes(path.basename(p)));
  }
  const allowance = budget({ ...WALK_LIMITS, timeMs: Math.min(WALK_LIMITS.timeMs, SYNC_SLICE_MS) });
  const all = discoverProjectMemory(root.real, ROOT_FILES, allowance);
  if (!allowance.partial) {
    walks.set(root.real, { files: all, large: false, stale: false, running: null });
    markWalk(root.real, 'registry', allowance);
  } else {
    // Too big for the main path: indexed off it, and partial until it is.
    walks.set(root.real, { files: all, large: true, stale: true, running: null });
    markWalk(root.real, 'registry', allowance);
    walkOffPath(root.real);
  }
  return (names) => all.filter((p) => names.includes(path.basename(p)));
}

/**
 * One edit root's instruction files: its workspace CLAUDE.md, then every
 * repo-level CLAUDE.md / AGENTS.md beneath it.
 */
function rootMemoryEntries(root, filesIn) {
  const out = [];
  const workspaceClaude = path.join(root.real, 'CLAUDE.md');
  if (exists(workspaceClaude)) {
    out.push(singleFileEntry(workspaceClaude, {
      label: `${root.label} workspace`, harness: 'claude', kindLabel: 'memory',
      note: `Applies to everything under ${tilde(root.path)}.`,
    }));
  }
  const repoMemory = filesIn(['CLAUDE.md', 'AGENTS.md']).filter((p) => p !== workspaceClaude);
  // Real files before symlinks, so a link attaches to its target's entry and
  // never the other way around.
  const ordered = [...repoMemory].sort((a, b) => (linkTarget(a) ? 1 : 0) - (linkTarget(b) ? 1 : 0));
  const byReal = new Map();
  for (const abs of ordered) {
    const real = linkTarget(abs) || abs;
    const rel = path.relative(root.real, path.dirname(abs));

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
    out.push(entry);
  }
  return out;
}

export function buildRegistry() {
  const groups = [];
  // Edit roots only: the registry is the editor's file list and history's
  // inventory, and a read root is neither edited nor mirrored. Re-read on
  // every build, so a folder that appears or comes back is picked up.
  const roots = currentRoots();
  const editRoots = roots.active.filter((r) => r.access === 'edit');
  const walks = new Map(editRoots.map((r) => [r.real, walkRoot(r)]));

  // ---- Memory: the precedence chain, ordered widest -> narrowest -------------
  const memory = [];
  const globalClaude = path.join(CLAUDE_HOME, 'CLAUDE.md');
  const globalCodex = path.join(CODEX_HOME, 'AGENTS.md');

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
  const globalGrok = path.join(GROK_HOME, 'AGENTS.md');
  if (exists(globalGrok)) {
    memory.push(singleFileEntry(globalGrok, {
      label: 'Global · Grok', harness: 'grok', kindLabel: 'memory',
      note: 'Applies to every Grok session. Grok does NOT read ~/.codex/AGENTS.md.',
    }));
  }
  for (const root of editRoots) memory.push(...rootMemoryEntries(root, walks.get(root.real)));
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
  const mcpFiles = editRoots.flatMap((root) => walks.get(root.real)(['.mcp.json']).map((abs) => ({ abs, root })));
  if (mcpFiles.length) {
    groups.push({
      id: 'mcp', title: 'MCP servers', icon: 'mcp',
      subtitle: 'Project-scoped .mcp.json — global servers are read-only under MCP',
      entries: mcpFiles.map(({ abs, root }) => {
        const rel = path.relative(root.real, path.dirname(abs));
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

  // ---- Worktrees: the rules agents follow when they branch ------------------
  const worktrees = [];
  const wtDefaults = path.join(WORKTREE_HOME, 'defaults.conf');
  if (exists(wtDefaults)) {
    worktrees.push(singleFileEntry(wtDefaults, {
      label: 'Defaults template', harness: 'shell', kindLabel: 'worktree',
      note: 'What `wtinit` seeds a new project with. Edit here to change the convention everywhere.',
    }));
  }
  // Each project's own .worktrees.conf, found at the trunk it governs.
  for (const root of editRoots) {
    for (const abs of walks.get(root.real)(['.worktrees.conf'])) {
      worktrees.push(singleFileEntry(abs, {
        label: path.basename(path.dirname(abs)), harness: 'shell', kindLabel: 'worktree',
        note: `Worktree rules for ${path.relative(root.real, path.dirname(abs))}.`,
      }));
    }
  }
  const wtRepos = path.join(WORKTREE_HOME, 'repos');
  for (const f of listFiles(wtRepos)) {
    worktrees.push(singleFileEntry(path.join(wtRepos, f), {
      label: `repos/${f}`, harness: 'shell', kindLabel: 'worktree',
      note: 'Out-of-repo override for a project whose trunk cannot carry the config.',
    }));
  }
  {
    groups.push({
      id: 'worktrees', title: 'Worktrees', icon: 'gear',
      subtitle: 'Where agents are allowed to branch, and off what', entries: worktrees,
    });
  }

  // ---- Retired skills (kept visible, rarely touched) -------------------------
  const retiredDir = path.join(CLAUDE_HOME, 'skills_retired');
  const retired = listDirs(retiredDir).map((n) => skillEntry(path.join(retiredDir, n), 'claude'));
  if (retired.length) {
    groups.push({
      id: 'retired', title: 'Retired skills', icon: 'archive',
      subtitle: 'Not loaded by the harness', entries: retired, collapsed: true,
    });
  }

  dropUnsafe(groups, roots.safeRoots);
  applyCapabilities(groups, editRoots);
  return { groups, home: HOME, generatedAt: Date.now() };
}

/**
 * Never publish a file the editor could not open. A CLAUDE.md symlinked to a
 * credential, a read root or anywhere outside the roots resolves out of
 * bounds; listing it would hand its bytes to search and the history mirror,
 * which read registry paths directly. An entry left with no files goes, and so
 * does a group this emptied.
 */
function dropUnsafe(groups, safe) {
  const allowed = (p) => { try { resolveSafe(p, safe); return true; } catch { return false; } };
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i];
    const had = g.entries.length;
    g.entries = g.entries.filter((e) => {
      const files = e.files.filter((f) => allowed(f.path));
      if (files.length === e.files.length) return true;
      if (!files.length) return false;
      e.files = files;
      if (!files.some((f) => f.path === e.primary)) e.primary = files[0].path;
      e.extraFiles = files.length - 1;
      return true;
    });
    if (had && !g.entries.length && !['memory', 'settings', 'worktrees'].includes(g.id)) groups.splice(i, 1);
  }
}

/**
 * What the UI may create and delete, per group.
 *
 * `protected` entries still delete, but the UI makes you type the name first —
 * these are load-bearing singletons where a misclick is expensive. Plugin
 * skills are the only things that cannot be deleted at all: the plugin manager
 * owns them and would restore them on the next update.
 */
const CREATE_KIND = {
  'claude-skills': 'claude-skill',
  'codex-skills': 'codex-skill',
  hooks: 'hook',
  agents: 'agent',
  commands: 'command',
  // Not a file scaffold — the + opens a form that runs `wtinit` for a repo.
  worktrees: 'worktree-project',
};

// The always-loaded singletons. Repo-level memory files are ordinary and
// delete without ceremony; these are not.
const singletonsFor = (editRoots) => new Set([
  path.join(CLAUDE_HOME, 'CLAUDE.md'),
  path.join(CODEX_HOME, 'AGENTS.md'),
  ...editRoots.map((r) => path.join(r.real, 'CLAUDE.md')),
]);

/**
 * Every file the registry calls `protected`, by real path where it exists:
 * the files of each protected entry, and the singletons themselves even when
 * a partial walk left one out of the groups. lib/batch-delete.js refuses a
 * batch touching any of these; the UI asks for the typed name instead.
 */
export function protectedFiles() {
  const editRoots = currentRoots().active.filter((r) => r.access === 'edit');
  const out = new Set();
  const add = (p) => { out.add(p); try { out.add(fs.realpathSync(p)); } catch {} };
  for (const p of singletonsFor(editRoots)) add(p);
  for (const g of buildRegistry().groups) for (const e of g.entries) if (e.protected) for (const f of e.files) add(f.path);
  return out;
}

function applyCapabilities(groups, editRoots) {
  const singletons = singletonsFor(editRoots);
  const rootOf = (dir) => editRoots.find((r) => dir === r.real || dir.startsWith(r.real + path.sep));

  for (const g of groups) {
    g.createKind = CREATE_KIND[g.id] ?? null;
    // A skill is a directory and can gain reference files; flat groups cannot.
    g.canAddFiles = ['claude-skills', 'codex-skills', 'retired'].includes(g.id);

    const isPlugin = g.id === 'plugin-skills';
    for (const e of g.entries) {
      // Where the file lives, so the Files page can group project files
      // without the browser knowing any root path.
      const root = rootOf(e.dir);
      e.scope = root ? 'project' : 'global';
      if (root) e.rootId = root.id;
      e.deletable = !isPlugin;
      e.protected = !isPlugin &&
        (g.id === 'settings' || e.files.some((f) => singletons.has(f.path)));
      if (isPlugin) {
        e.undeletableReason = 'Owned by the plugin manager — it would come back on the next update.';
      }
    }
  }
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
