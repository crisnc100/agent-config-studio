/**
 * What each project tells its agents: every CLAUDE.md, AGENTS.md and
 * `.cursor/rules/*.mdc` under ~/Documents/Projects, per repository, with each
 * file's heading outline — so the instructions are visible without opening
 * the codebase.
 *
 * COLLAPSING HAPPENS HERE AND NOWHERE ELSE. A worktree copy identical to trunk,
 * or an `AGENTS.md -> CLAUDE.md` link, is one entry that still lists every
 * physical path. The registry is not collapsed: lib/history.js treats it as its
 * inventory, and a copy missing from it would be recorded as deleted. Copies
 * are merged only when they sit at the same place relative to their checkout
 * — two identical files at different scopes are two instructions.
 *
 * A worktree copy whose bytes differ from trunk's is flagged as drifted; the
 * two texts are served by id for a diff. Read-only throughout, and ids are
 * random and minted here: nothing a client sends is a path.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { PROJECTS, resolveSafe, tilde } from './paths.js';
import { repoOf, mainCheckoutOf } from './gitmeta.js';

// Generated or vendored trees: never where a project keeps its instructions,
// and the bulk of the walk's cost. Dot-directories are otherwise walked —
// that is where `.cursor/rules` and `.worktrees/<name>` live.
export const CONTEXT_SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build',
  '.next', '.venv', 'venv', '__pycache__', '.cache', 'target', 'coverage', 'Pods', 'DerivedData', '.turbo', '.pnpm-store',
]);
export const CONTEXT_NAMES = new Set(['CLAUDE.md', 'AGENTS.md']);
const MAX_DEPTH = 12;
const MAX_BYTES = 2 * 1024 * 1024;

/** Is this a context file? `.mdc` counts only directly inside a `.cursor/rules` folder. */
export function isContextFile(abs) {
  const name = path.basename(abs);
  if (CONTEXT_NAMES.has(name)) return true;
  return name.endsWith('.mdc') && path.basename(path.dirname(abs)) === 'rules'
    && path.basename(path.dirname(path.dirname(abs))) === '.cursor';
}

/** Every context file under `root`, links included (never followed into directories). */
export function findContextFiles(root = PROJECTS) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > MAX_DEPTH) return;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of ents) {
      const abs = path.join(dir, d.name);
      if (d.isDirectory()) { if (!CONTEXT_SKIP_DIRS.has(d.name)) walk(abs, depth + 1); continue; }
      if ((d.isFile() || d.isSymbolicLink()) && isContextFile(abs)) out.push(abs);
    }
  };
  walk(root, 0);
  return out.sort();
}

/**
 * Headings, each with the number of lines its section runs until the next
 * heading of the same or a higher level. Frontmatter and fenced code are not
 * headings.
 */
export function outlineOf(text) {
  const lines = text.split('\n');
  const heads = [];
  let i = 0, fence = null;
  if (lines[0] === '---') {
    const end = lines.indexOf('---', 1);
    if (end > 0) i = end + 1;
  }
  for (; i < lines.length; i++) {
    const l = lines[i];
    const f = /^\s*(```|~~~)/.exec(l);
    if (f) { fence = fence === f[1] ? null : fence ?? f[1]; continue; }
    if (fence) continue;
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(l);
    if (m) heads.push({ level: m[1].length, text: m[2], line: i + 1 });
  }
  const total = lines.length - (text.endsWith('\n') ? 1 : 0);
  return heads.map((h, k) => {
    const next = heads.slice(k + 1).find((x) => x.level <= h.level);
    return { ...h, lines: (next ? next.line : total + 1) - h.line };
  });
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

const idByPath = new Map();
const pathById = new Map();
function mint(abs) {
  let id = idByPath.get(abs);
  if (!id) { id = crypto.randomBytes(12).toString('hex'); idByPath.set(abs, id); }
  pathById.set(id, abs);
  return id;
}
export const CONTEXT_ID = /^[0-9a-f]{24}$/;

/**
 * Bytes of a context file. The REAL path is what is judged: it must pass
 * resolveSafe's roots and deny-list, sit under the project tree, and itself
 * be a context file — so an `AGENTS.md` link pointing at a transcript, a
 * settings file or anything else the allowed roots contain is refused, not
 * served.
 */
function readContext(abs) {
  const real = resolveSafe(abs);
  if (!real.startsWith(PROJECTS + path.sep) || !isContextFile(real)) {
    throw Object.assign(new Error('links to something that is not an instruction file in ~/Documents/Projects'), { status: 403 });
  }
  const st = fs.statSync(real);
  if (!st.isFile()) throw Object.assign(new Error('not a file'), { status: 400 });
  if (st.size > MAX_BYTES) throw Object.assign(new Error('file too large'), { status: 413 });
  return { real, buf: fs.readFileSync(real) };
}

/**
 * Which checkout is trunk. By this machine's convention the trunk is the
 * checkout holding `.worktrees.conf`, whose TRUNK= line names it — often NOT
 * the main checkout git knows (airflo-trunk is itself a worktree of AirFlo).
 * A checkout whose conf names itself wins; then any checkout holding a conf;
 * then the main checkout.
 */
function trunkOf(roots, mainRoot) {
  let holder = null;
  for (const root of [mainRoot, ...roots]) {
    const conf = path.join(root, '.worktrees.conf');
    let text;
    try {
      if (!fs.lstatSync(conf).isFile() || fs.statSync(conf).size > 64 * 1024) continue;
      text = fs.readFileSync(conf, 'utf8');
    } catch { continue; }
    const m = /^TRUNK=["']?([^"'\n]+?)["']?\s*$/m.exec(text);
    if (m && path.resolve(m[1]) === root) return root;
    holder ??= root;
  }
  return holder ?? mainRoot;
}

/** The Context view's payload. */
export function contextMap({ base = PROJECTS } = {}) {
  const repoCache = new Map();
  const repoFor = (dir) => {
    if (!repoCache.has(dir)) repoCache.set(dir, repoOf(dir));
    return repoCache.get(dir);
  };

  const files = [];
  const unreadable = [];
  for (const abs of findContextFiles(base)) {
    let lst;
    try { lst = fs.lstatSync(abs); } catch { continue; }
    let read;
    try { read = readContext(abs); }
    catch (e) { unreadable.push({ display: tilde(abs), reason: e.message }); continue; }
    const repo = repoFor(path.dirname(abs));
    files.push({ abs, link: lst.isSymbolicLink() ? read.real : null, real: read.real, buf: read.buf, repo });
  }

  // Group by repository; files outside any checkout group by their folder.
  const groups = new Map();
  for (const f of files) {
    const key = f.repo ? `repo:${f.repo.commonDir}` : `dir:${path.dirname(f.abs)}`;
    if (!groups.has(key)) {
      const trunk = f.repo ? mainCheckoutOf(f.repo.commonDir) : path.dirname(f.abs);
      groups.set(key, { key, trunk, repo: Boolean(f.repo), files: [] });
    }
    groups.get(key).files.push(f);
  }

  const out = [];
  let totalEntries = 0, collapsedCopies = 0, drifted = 0;
  for (const g of groups.values()) {
    if (g.repo) g.trunk = trunkOf([...new Set(g.files.map((f) => f.repo.root))], g.trunk);
    const checkouts = new Map();
    const scopes = new Map();
    const realToScope = new Map();
    const checkoutOf = (f) => (f.repo ? f.repo.root : path.dirname(f.abs));
    // Real files first, so a link attaches to its target's entry.
    const ordered = [...g.files].sort((a, b) => (a.link ? 1 : 0) - (b.link ? 1 : 0) || (a.abs < b.abs ? -1 : 1));
    for (const f of ordered) {
      const root = checkoutOf(f);
      const isTrunk = root === g.trunk;
      if (!checkouts.has(root)) checkouts.set(root, { label: path.basename(root), display: tilde(root), trunk: isTrunk });
      const where = { display: tilde(f.abs), checkout: path.basename(root), trunk: isTrunk, abs: f.abs };
      // A link joins its target's entry only from the same folder (AGENTS.md
      // beside the CLAUDE.md it points at). From anywhere else it is an
      // instruction at another scope, and stays its own entry.
      if (f.link && path.dirname(f.abs) === path.dirname(f.real)) {
        const owner = realToScope.get(f.real);
        if (owner) { owner.variant.paths.push({ ...where, alias: `${path.basename(f.abs)} → ${path.basename(f.real)}` }); continue; }
      }
      const scope = path.relative(root, f.abs).split(path.sep).join('/');
      if (!scopes.has(scope)) scopes.set(scope, { scope, variants: new Map() });
      const s = scopes.get(scope);
      const sha = sha256(f.buf);
      if (!s.variants.has(sha)) {
        const text = f.buf.toString('utf8');
        s.variants.set(sha, {
          sha, paths: [], text,
          lines: text.split('\n').length - (text.endsWith('\n') ? 1 : 0),
          bytes: f.buf.length, outline: outlineOf(text),
          ...(f.link ? { linksTo: tilde(f.real) } : {}),
        });
      }
      const variant = s.variants.get(sha);
      variant.paths.push(where);
      if (!f.link) realToScope.set(f.real, { scope: s, variant });
    }

    const scopeRows = [...scopes.values()].map((s) => {
      const variants = [...s.variants.values()];
      const trunkVariant = variants.find((v) => v.paths.some((p) => p.trunk)) || null;
      const rows = variants.map((v) => {
        v.paths.sort((a, b) => (b.trunk - a.trunk) || (a.alias ? 1 : 0) - (b.alias ? 1 : 0) || a.display.localeCompare(b.display));
        const open = v.paths.find((p) => !p.alias) || v.paths[0];
        const isTrunk = v === trunkVariant;
        return {
          id: mint(open.abs), sha: v.sha.slice(0, 12), trunk: isTrunk,
          drift: Boolean(trunkVariant) && !isTrunk,
          paths: v.paths.map(({ abs, ...p }) => p),
          copies: v.paths.length,
          open: { path: open.abs, display: open.display },
          lines: v.lines, bytes: v.bytes, outline: v.outline,
          ...(v.linksTo ? { linksTo: v.linksTo } : {}),
        };
      }).sort((a, b) => (b.trunk - a.trunk) || b.copies - a.copies);
      totalEntries++;
      collapsedCopies += rows.reduce((n, r) => n + r.copies - 1, 0);
      const drift = rows.some((r) => r.drift);
      if (drift) drifted++;
      return {
        scope: s.scope,
        kind: s.scope.endsWith('.mdc') ? 'cursor-rule' : path.posix.basename(s.scope) === 'AGENTS.md' ? 'agents' : 'claude',
        drift, trunkId: rows.find((r) => r.trunk)?.id ?? null, variants: rows,
      };
    }).sort((a, b) => a.scope.split('/').length - b.scope.split('/').length || a.scope.localeCompare(b.scope));

    out.push({
      label: g.repo ? path.basename(mainCheckoutOf(g.files[0].repo.commonDir)) : path.relative(base, g.trunk) || path.basename(g.trunk),
      display: tilde(g.trunk), repo: g.repo,
      checkouts: [...checkouts.values()].sort((a, b) => (b.trunk - a.trunk) || a.label.localeCompare(b.label)),
      files: g.files.length, scopes: scopeRows,
    });
  }
  out.sort((a, b) => a.label.localeCompare(b.label));
  return {
    groups: out, unreadable,
    totals: { files: files.length, entries: totalEntries, collapsedCopies, drifted },
  };
}

/** A context file's text by id, for the drift diff. */
export function contextFile(id) {
  if (typeof id !== 'string' || !CONTEXT_ID.test(id)) throw Object.assign(new Error('not a context id'), { status: 400 });
  const abs = pathById.get(id);
  if (!abs) throw Object.assign(new Error('unknown id — reopen the Context view'), { status: 404 });
  if (!isContextFile(abs)) throw Object.assign(new Error('not a context file'), { status: 403 });
  const { buf } = readContext(abs);
  return { id, display: tilde(abs), content: buf.toString('utf8') };
}
