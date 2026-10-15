import fs from 'node:fs';
import path from 'node:path';
import { assistInventory, classOf, displayer, FIXABLE_CLASSES, stricterClass } from './audit.js';
import { loadRegistry } from './models.js';
import {
  AGENTS_HOME, CLAUDE_HOME, CODEX_HOME, GROK_HOME,
  currentRoots, isCredential, isDenied, readContained, resolveSafe, safeRoots, tilde,
} from './paths.js';
import { buildRegistry } from './registry.js';
import { loadRoles, memberEffort } from './roles.js';
import { matchLines } from './search.js';
import { readInSkill } from './skills.js';

/**
 * The files Assist can find for itself (builds/assist-auto-files).
 *
 * The model never touches the filesystem: it runs tool-less, sees a MANIFEST
 * of the config files ACS already knows about (paths, kinds and a skill's
 * description — never contents, never an absolute path), and asks for files
 * by exact manifest path (`@@NEED`) or by a literal search (`@@FIND`). ACS
 * loads what it asked for through the contained readers, under budgets.
 *
 * The manifest is the audit's inventory (skills as physical files, aliases
 * collapsed, plugin and vendor classes, read roots) joined with the file
 * registry's edit-root files (settings, hooks, agents, commands, .mcp.json).
 * A file in a class ACS does not edit is loaded for reading only.
 */

export const ASSIST_LIMITS = Object.freeze({
  manifestEntries: 400,
  manifestBytes: 48 * 1024,
  descriptionChars: 160,
  requestRounds: 2,
  filesPerMessage: 20,
  loadedBytesPerMessage: 512 * 1024,
  fileBytes: 512 * 1024,
  turnBytes: 768 * 1024,
  searchFiles: 60,
  searchLines: 3,
  searchFileBytes: 1024 * 1024,
  searchBytes: 32 * 1024 * 1024,
  queryChars: 200,
  cacheMs: 60_000,
});

const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const under = (p, dir) => p === dir || p.startsWith(dir + '/');
const oneLine = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

const READ_ONLY_WHY = {
  plugin: 'belongs to a plugin',
  vendor: 'ships with the CLI',
  readonly: 'in a read-only folder',
};

/** Which agent reads a file, by where it is. */
function harnessOf(real, name) {
  if (under(real, CLAUDE_HOME)) return 'claude';
  if (under(real, CODEX_HOME)) return 'codex';
  if (under(real, GROK_HOME)) return 'grok';
  if (under(real, AGENTS_HOME)) return 'shared';
  if (name === 'AGENTS.md') return 'codex';
  if (name === 'CLAUDE.md') return 'claude';
  return 'both';
}

/** Earlier is listed first, so a cut manifest keeps what is most often asked for. */
function priority(e) {
  const ro = !FIXABLE_CLASSES.has(e.cls) ? 10 : 0;
  if (e.kind === 'instruction' && e.scope === 'global') return 0 + ro;
  if (e.kind === 'skill') return 1 + ro;
  if (e.kind === 'instruction') return 2 + ro;
  if (e.kind === 'auto-memory') return 8 + ro;
  if (e.kind === 'skill file') return 5 + ro;
  return 3 + ro;
}

/** One manifest line: path · kind · agent [· read-only (why)] [· synced] [— description]. */
function manifestLine(e) {
  let line = `${e.display} · ${e.kind} · ${e.harness}`;
  if (e.readOnly) line += ` · read-only (${READ_ONLY_WHY[e.cls] || e.cls})`;
  else if (e.cls === 'synced') line += ' · synced';
  if (e.description) line += ` — ${e.description}`;
  return line;
}

/**
 * Every file Assist may ask for, as `{ all, byDisplay, text, cut }`. `all` is
 * the whole list; `text` is the capped rendering the model is shown, and says
 * when it was cut — a path cut from the text can still be found by @@FIND.
 */
export async function buildManifest({ limits = ASSIST_LIMITS } = {}) {
  const roots = currentRoots().active;
  const { show } = displayer(roots);
  const inv = await assistInventory();
  const byReal = new Map();
  const add = (e) => {
    if (isDenied(e.real) || isCredential(e.real) || byReal.has(e.real)) return;
    byReal.set(e.real, { ...e, readOnly: !FIXABLE_CLASSES.has(e.cls) });
  };
  for (const f of inv.files) {
    add({
      real: f.real, display: f.display, cls: f.cls, name: f.name, scope: f.scope,
      kind: f.kind === 'skill' ? (f.rel === 'SKILL.md' ? 'skill' : 'skill file') : 'instruction',
      harness: harnessOf(f.real, f.name),
      description: f.description ? oneLine(f.description, limits.descriptionChars) : null,
      skillDir: f.skillDir, rel: f.rel,
    });
  }
  for (const g of buildRegistry().groups) {
    for (const entry of g.entries) {
      for (const file of entry.files) {
        add({
          real: file.path, display: show(file.path), cls: classOf(file.path), name: file.name, scope: null,
          kind: entry.kindLabel || g.id, harness: entry.harness || harnessOf(file.path, file.name),
          description: null, skillDir: null, rel: null,
        });
      }
    }
  }
  const all = [...byReal.values()].sort((a, b) => (priority(a) - priority(b)) || (a.display < b.display ? -1 : 1));
  const byDisplay = new Map();
  for (const e of all) if (!byDisplay.has(e.display)) byDisplay.set(e.display, e);

  const lines = [];
  let bytes = 0;
  for (const e of all) {
    const line = manifestLine(e);
    const size = Buffer.byteLength(line) + 1;
    if (lines.length >= limits.manifestEntries || bytes + size > limits.manifestBytes) break;
    lines.push(line);
    bytes += size;
  }
  const notes = [];
  if (lines.length < all.length) notes.push(`MANIFEST CUT: ${all.length - lines.length} more files are not listed here. Use @@FIND to search all ${all.length}.`);
  if (inv.cut.length) notes.push(`The file inventory itself was partial (${inv.cut.join('; ')}).`);
  return { all, byDisplay, byReal, text: [...lines, ...notes].join('\n'), cut: lines.length < all.length, partial: inv.cut.length > 0, partialReasons: inv.cut };
}

/** Where a non-skill file may be read from: the agents' homes, edit roots and read roots. */
const readableRoots = () => [...safeRoots(), ...currentRoots().readRoots];

/** Decode as text, or say why not: a NUL or invalid UTF-8 is not a config file to show a model. */
function asText(buf) {
  if (buf.includes(0)) throw Object.assign(new Error('binary file'), { status: 415 });
  try { return UTF8.decode(buf); } catch { throw Object.assign(new Error('not valid UTF-8'), { status: 415 }); }
}

/**
 * One manifest entry's bytes, through a contained reader with pre/post
 * identity checks: readInSkill for a file in a skill, readContained for the
 * rest. Returns { buf, text }.
 */
export function readEntry(e, maxBytes = ASSIST_LIMITS.fileBytes) {
  let buf;
  if (e.skillDir && e.rel) {
    buf = readInSkill(e.skillDir, e.rel, { budget: { remaining: maxBytes } });
  } else {
    buf = readContained(e.real, readableRoots(), { maxBytes }).buf;
  }
  return { buf, text: asText(buf) };
}

/**
 * A file's class as the inventory knows it: the strictest of where it really
 * is and every alias the audit collapsed into it — a user skill that an
 * enabled plugin links to is the plugin's, and read-only.
 */
export function classIn(manifest, real, hint = 'user') {
  return stricterClass(classOf(real, hint), manifest?.byReal?.get(real)?.cls ?? 'user');
}

/**
 * A file the user attached (an absolute path from the page), resolved inside
 * the edit roots as before and read the same contained way. Its class is the
 * inventory's (classIn), so an attached plugin file — or a plugin's alias of
 * one — is read-only too.
 */
export function readAttached(abs, maxBytes = ASSIST_LIMITS.fileBytes, manifest = null) {
  const { show } = displayer(currentRoots().active);
  const { buf, real } = readContained(abs, safeRoots(), { maxBytes });
  const cls = classIn(manifest, real);
  return { real, display: show(real), cls, readOnly: !FIXABLE_CLASSES.has(cls), buf, text: asText(buf) };
}

/** A file's size by stat — never a read — so a budget is checked before any byte is. Null when it cannot be stat'd. */
export function sizeOf(p) {
  try { const st = fs.statSync(p); return st.isFile() ? st.size : null; } catch { return null; }
}
export const entryPath = (e) => (e.skillDir && e.rel ? path.join(e.skillDir, e.rel) : e.real);

/** The bytes a proposal is made against, read again now — for the "changed while it worked" check. */
export function rereadEditable(real, maxBytes) {
  return readContained(real, safeRoots(), { maxBytes });
}

/**
 * `@@FIND`: the /api/search matcher over every manifest file (the whole list,
 * not only the part the model was shown). Up to `searchFiles` files with
 * `searchLines` lines each. Partial, with each reason, when anything kept a
 * match from being seen whole: a file too large to search (judged by stat,
 * never read), one that could not be read, the byte budget for one search,
 * more matching lines in a file than are shown, a shown line cut short, more
 * matching files than are listed, or a partial inventory.
 */
export function searchManifest(manifest, query, { limits = ASSIST_LIMITS, skip = () => false } = {}) {
  const hits = [];
  let searched = 0, unreadable = 0, tooLarge = 0, overBudget = 0, bytes = 0, moreLines = 0, clippedLines = 0;
  for (const e of manifest.all) {
    if (skip(e)) continue;
    const size = sizeOf(entryPath(e));
    if (size === null) { unreadable++; continue; }
    if (size > limits.searchFileBytes) { tooLarge++; continue; }
    if (bytes + size > limits.searchBytes) { overBudget++; continue; }
    let r;
    try { r = readEntry(e, Math.min(limits.searchFileBytes, limits.searchBytes - bytes)); } catch { unreadable++; continue; }
    bytes += r.buf.length;
    searched++;
    const { matches, total, clipped } = matchLines(r.text, query, { max: limits.searchLines });
    if (!total) continue;
    if (total > matches.length) moreLines++;
    if (clipped) clippedLines++;
    hits.push({ display: e.display, readOnly: e.readOnly, matches, total });
  }
  hits.sort((a, b) => b.total - a.total);
  const reasons = [];
  const n = (k, one, many) => `${k} ${k === 1 ? one : many}`;
  if (hits.length > limits.searchFiles) reasons.push(`${hits.length - limits.searchFiles} more matching files not listed`);
  if (tooLarge) reasons.push(`${n(tooLarge, 'file', 'files')} over ${limits.searchFileBytes / 1024 / 1024} MB not searched`);
  if (overBudget) reasons.push(`${n(overBudget, 'file', 'files')} past the ${limits.searchBytes / 1024 / 1024} MB search budget not searched`);
  if (unreadable) reasons.push(`${n(unreadable, 'file', 'files')} could not be read`);
  if (moreLines) reasons.push(`${n(moreLines, 'file has', 'files have')} more matching lines than shown`);
  if (clippedLines) reasons.push(`${n(clippedLines, 'file has', 'files have')} a matching line cut short`);
  if (manifest.partial) reasons.push('the file inventory itself was partial');
  return { query, searched, unreadable, bytes, matched: hits.length, hits: hits.slice(0, limits.searchFiles), partial: reasons.length > 0, reasons };
}

/**
 * The FACTS block: the model registry and the roles as they are on disk now,
 * read in-process on every call. Invalid data is said to be invalid, never
 * papered over with a guess.
 */
export function factsText() {
  const reg = loadRegistry();
  const roles = loadRoles();
  const lines = [
    'FACTS (read by Agent Config Studio just now; trust these over anything a file says about models):',
    '- ~/.agent-config-studio/models.json holds only the user\'s overrides on top of the defaults that ship with ACS. It is not the whole registry.',
  ];
  if (reg.error) {
    lines.push(`- The user's model registry is INVALID (${tilde(reg.error)}). The ids below are the shipped defaults, not what the user set.`);
  }
  const models = Object.entries(reg.registry.models || {});
  lines.push(models.length
    ? `- Model families → current ids: ${models.map(([f, id]) => `${f} → ${id}`).join(', ')}.`
    : '- No model families are known.');
  if (roles.error) {
    lines.push(`- The roles are INVALID (${tilde(roles.error)}). ACS cannot say who does which job until they are fixed in Models → Roles.`);
  } else {
    const at = (role, m) => `${m.family}@${memberEffort(m, role, roles.flavor).effort || 'default'}`;
    const names = Object.keys(roles.roles).sort();
    lines.push(names.length ? '- Roles (job → families in order, first is the answer; @effort):' : '- No roles are defined.');
    for (const name of names) {
      const r = roles.roles[name];
      let line = `  - ${name}: ${r.members.map((m) => at(r, m)).join(', ')}`;
      if (r.alt) line += `; second opinion ${at(r, r.altMember || { family: r.alt })}`;
      lines.push(line);
    }
    const avoids = roles.families.filter((f) => roles.flavor[f]?.avoid?.length).map((f) => `${f} avoids ${roles.flavor[f].avoid.join(', ')}`);
    if (avoids.length) lines.push(`- Avoid lists: ${avoids.join('; ')}.`);
  }
  lines.push('- When you cannot verify something here, name the exact command for the user to run: `model-id --table` (every family and id), `model-id --role <role>` (one role).');
  return lines.join('\n');
}

/** A manifest path as the model wrote it, or why it is refused. Exact match only. */
export function lookup(manifest, asked) {
  const p = String(asked).trim();
  if (!p) return { error: 'empty path' };
  if (p.startsWith('/')) return { error: 'absolute paths are never accepted — use the path exactly as the manifest lists it' };
  if (p.split('/').includes('..')) return { error: 'a path with .. is never accepted' };
  if (isDenied(p)) return { error: 'that file is protected' };
  const e = manifest.byDisplay.get(p);
  if (!e) return { error: 'not in the manifest' };
  // The manifest is a minute old at most; the path must still be where it was.
  try {
    if (!e.skillDir && resolveSafe(e.real, readableRoots()) !== e.real) return { error: 'that file has moved' };
  } catch (err) { return { error: err.message }; }
  return { entry: e };
}

/**
 * The manifest, built at most once a minute (and again after `invalidate`,
 * which the server calls on every file change) — never per request round.
 */
export function createAssistFiles({ limits = ASSIST_LIMITS, now = Date.now } = {}) {
  let cache = null;
  let building = null;
  const sig = () => JSON.stringify(currentRoots().active.map((r) => [r.id, r.real, r.access]));
  return {
    /** `maxAgeMs`: how old a cached manifest may be — short for a check at Accept. */
    async manifest({ maxAgeMs = limits.cacheMs } = {}) {
      if (cache && now() - cache.at < maxAgeMs && cache.sig === sig()) return cache.value;
      if (building) return building;
      const s = sig();
      building = buildManifest({ limits }).then((value) => { cache = { at: now(), sig: s, value }; return value; })
        .finally(() => { building = null; });
      return building;
    },
    invalidate() { cache = null; },
  };
}
