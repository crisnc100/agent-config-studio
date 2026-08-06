import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  CLAUDE_HOME, CODEX_HOME, PROJECTS, STUDIO_HOME, resolveSafe, tilde,
} from './paths.js';
import * as history from './history.js';

const TRASH = path.join(STUDIO_HOME, 'trash');

/* ── creation ─────────────────────────────────────────────────────────── */

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * What each kind creates and where. `dir` builds the container, `file` is the
 * primary file written inside it (or alongside it, for flat kinds).
 */
const KINDS = {
  'claude-skill': {
    label: 'Claude skill',
    root: () => path.join(CLAUDE_HOME, 'skills'),
    nested: true,
    file: 'SKILL.md',
    template: skillTemplate,
  },
  'codex-skill': {
    label: 'Codex skill',
    root: () => path.join(CODEX_HOME, 'skills'),
    nested: true,
    file: 'SKILL.md',
    template: skillTemplate,
  },
  hook: {
    label: 'hook',
    root: () => path.join(CLAUDE_HOME, 'hooks'),
    nested: false,
    ext: '.sh',
    executable: true,
    template: (name) =>
      `#!/usr/bin/env bash\n# ${name}\n# Wire this up under "hooks" in settings.json.\nset -euo pipefail\n\n`,
  },
  agent: {
    label: 'subagent',
    root: () => path.join(CLAUDE_HOME, 'agents'),
    nested: false,
    ext: '.md',
    template: (name) =>
      `---\nname: ${name}\ndescription: What this agent does, and when to delegate to it.\ntools: Read, Grep, Glob\n---\n\n` +
      `# ${name}\n\nInstructions for this subagent.\n`,
  },
  command: {
    label: 'slash command',
    root: () => path.join(CLAUDE_HOME, 'commands'),
    nested: false,
    ext: '.md',
    template: (name) =>
      `---\ndescription: What /${name} does.\n---\n\n# /${name}\n\nWhat this command should do when invoked.\n`,
  },
};

function skillTemplate(name) {
  return `---
name: ${name}
description: What this skill does, and when to use it — include the phrases a user would actually say. This text is the only thing the model sees when deciding whether to load the skill.
---

# /${name}

What this skill does when invoked.

## When to use it

## Steps
`;
}

export function listKinds() {
  return Object.entries(KINDS).map(([id, k]) => ({ id, label: k.label }));
}

/**
 * Create a new skill / hook / agent / command. Optionally seeds the body from
 * an existing file — the usual case is porting a Claude skill to Codex, where
 * the copy is a starting point and is expected to diverge.
 */
export async function create({ kind, name, sourcePath }) {
  const spec = KINDS[kind];
  if (!spec) throw bad(`unknown kind: ${kind}`);

  const clean = String(name || '').trim().toLowerCase().replace(/\s+/g, '-');
  if (!NAME_RE.test(clean)) {
    throw bad('Name must be lowercase letters, numbers and hyphens, starting with a letter or number.');
  }

  const root = spec.root();
  await fsp.mkdir(root, { recursive: true });

  const target = spec.nested
    ? path.join(root, clean, spec.file)
    : path.join(root, clean + spec.ext);

  // resolveSafe both normalises and proves the destination is inside a root.
  const abs = resolveSafe(target);
  if (fs.existsSync(abs)) throw bad(`${tilde(abs)} already exists.`);
  if (spec.nested && fs.existsSync(path.dirname(abs))) {
    throw bad(`A ${spec.label} named "${clean}" already exists.`);
  }

  let content;
  if (sourcePath) {
    const src = resolveSafe(sourcePath);
    content = await fsp.readFile(src, 'utf8');
    // Retarget the frontmatter name so the copy is not a duplicate identity.
    content = content.replace(/^(---\s*\n(?:.*\n)*?name:).*$/m, `$1 ${clean}`);
  } else {
    content = spec.template(clean);
  }

  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, content, 'utf8');
  if (spec.executable) await fsp.chmod(abs, 0o755);

  const sha = await history.record(abs, `create ${tilde(abs)}`).catch(() => null);
  return { path: abs, display: tilde(abs), sha };
}

/** Add another file inside an existing skill directory (a reference doc). */
export async function addFile({ dir, name }) {
  const absDir = resolveSafe(dir);
  if (!fs.statSync(absDir).isDirectory()) throw bad('not a directory');

  const clean = String(name || '').trim().replace(/[/\\]/g, '');
  if (!clean || clean.startsWith('.')) throw bad('Invalid file name.');
  if (!/\.(md|json|txt|sh|toml|ya?ml)$/i.test(clean)) {
    throw bad('File must end in .md, .json, .txt, .sh, .toml or .yaml.');
  }

  const abs = resolveSafe(path.join(absDir, clean));
  if (fs.existsSync(abs)) throw bad(`${clean} already exists.`);

  await fsp.writeFile(abs, clean.endsWith('.json') ? '{\n}\n' : `# ${clean.replace(/\.[^.]+$/, '')}\n\n`, 'utf8');
  const sha = await history.record(abs, `create ${tilde(abs)}`).catch(() => null);
  return { path: abs, display: tilde(abs), sha };
}

/* ── deletion ─────────────────────────────────────────────────────────── */

/**
 * Soft delete. The content is committed to the shadow repo first, then moved
 * into a trash directory, then the removal is committed. That leaves two
 * independent ways back: restore from trash, or `git show` the prior commit.
 * Nothing is ever unlinked outright.
 */
export async function remove({ path: p }) {
  const abs = resolveSafe(p);
  const stat = await fsp.stat(abs);
  const isDir = stat.isDirectory();

  if (isProtected(abs)) {
    throw bad(`${tilde(abs)} is managed by the plugin system — deleting it here would be undone on the next plugin update.`);
  }

  // Capture current contents in history before anything moves.
  const files = isDir ? walkFiles(abs) : [abs];
  for (const f of files) {
    await history.recordBaseline(f, `state of ${tilde(f)} before delete`).catch(() => {});
  }

  const id = `${stamp()}-${path.basename(abs)}`.replace(/[^A-Za-z0-9._-]/g, '_');
  const dest = path.join(TRASH, id);
  await fsp.mkdir(dest, { recursive: true });

  await fsp.rename(abs, path.join(dest, path.basename(abs)))
    .catch(async (e) => {
      if (e.code !== 'EXDEV') throw e;
      await fsp.cp(abs, path.join(dest, path.basename(abs)), { recursive: true });
      await fsp.rm(abs, { recursive: true, force: true });
    });

  await fsp.writeFile(path.join(dest, 'trash-meta.json'), JSON.stringify({
    id,
    originalPath: abs,
    display: tilde(abs),
    name: path.basename(abs),
    isDir,
    fileCount: files.length,
    deletedAt: Date.now(),
  }, null, 2));

  const sha = await history.snapshotAll(`delete ${tilde(abs)}`).catch(() => ({}));
  return { deleted: true, id, display: tilde(abs), files: files.length, sha: sha?.sha ?? null };
}

export async function listTrash() {
  let ents;
  try { ents = await fsp.readdir(TRASH, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of ents) {
    if (!e.isDirectory()) continue;
    try {
      const meta = JSON.parse(await fsp.readFile(path.join(TRASH, e.name, 'trash-meta.json'), 'utf8'));
      out.push({ ...meta, restorable: !fs.existsSync(meta.originalPath) });
    } catch { /* skip malformed trash entries */ }
  }
  return out.sort((a, b) => b.deletedAt - a.deletedAt);
}

export async function restoreTrash({ id }) {
  const safeId = String(id || '').replace(/[^A-Za-z0-9._-]/g, '');
  const dir = path.join(TRASH, safeId);
  const meta = JSON.parse(await fsp.readFile(path.join(dir, 'trash-meta.json'), 'utf8'));
  const abs = resolveSafe(meta.originalPath);

  if (fs.existsSync(abs)) {
    throw bad(`${tilde(abs)} exists again — rename or remove it before restoring.`);
  }

  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.rename(path.join(dir, meta.name), abs)
    .catch(async (e) => {
      if (e.code !== 'EXDEV') throw e;
      await fsp.cp(path.join(dir, meta.name), abs, { recursive: true });
      await fsp.rm(path.join(dir, meta.name), { recursive: true, force: true });
    });

  await fsp.rm(dir, { recursive: true, force: true });
  await history.snapshotAll(`restore ${tilde(abs)}`).catch(() => {});
  return { restored: true, path: abs, display: tilde(abs) };
}

/* ── helpers ──────────────────────────────────────────────────────────── */

/** Plugin-cache files are owned by the plugin manager; deleting them here is futile. */
function isProtected(abs) {
  return abs.startsWith(path.join(CLAUDE_HOME, 'plugins') + path.sep);
}

function walkFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkFiles(abs));
    else if (e.isFile()) out.push(abs);
  }
  return out;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
