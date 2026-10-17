import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as history from './history.js';
import { linkedWorktree } from './gitmeta.js';
import { inspect as inspectGuide } from './model-guide.js';
import { EFFORTS, LINT_PATTERNS, loadRegistry } from './models.js';
import {
  AGENTS_HOME, CLAUDE_HOME, CODEX_HOME, GROK_HOME, HOME,
  assertWritable, currentRoots, isDenied, openUserFile, readUserText, realHome, resolveSafe, safeRoots, skillRoots, tilde,
} from './paths.js';
import { bad, baseOf, createProposals, sha256 } from './proposals.js';
import { loadRoles, memberEffort } from './roles.js';
import { parseFrontmatter, readInSkill } from './skills.js';
import { CONTEXT_SKIP_DIRS } from './context-map.js';

/**
 * The audit: where skills and instruction files hardcode a model or an
 * effort, where an id has gone stale, and where a hand-written lanes section
 * sits beside the generated model guide. Deterministic and free; it never
 * writes. A fix is a proposal (lib/proposals.js): the full file before and
 * after, written only on Accept.
 *
 * What is scanned is the physical files (builds/skills-audit R9, R11):
 *   ~/.claude/skills (synced/ is `synced`, .system/ is `vendor`),
 *   ~/.codex/skills (.system/ is `vendor`), ~/.agents/skills,
 *   .claude/skills, .codex/skills and .agents/skills under every edit and read root,
 *   enabled Claude plugins at their newest cached version (`plugin`),
 *   the three global instruction files, and every CLAUDE.md / AGENTS.md
 *   under the edit and read roots.
 * Not scanned: Codex plugins and Grok's bundled skills.
 *
 * Every content read goes through a chokepoint: readInSkill for a file in a
 * skill (its link, hard-link, credential and swap refusals), openUserFile for
 * the rest. Clients get opaque refs and display paths, never a real path.
 */

export const AUDIT_LIMITS = Object.freeze({
  depth: 6, files: 2000, fileBytes: 1024 * 1024, totalBytes: 32 * 1024 * 1024,
  cacheMs: 60_000, proposalTtlMs: 10 * 60_000, proposalsPerTarget: 3, dismissed: 5000,
});

/** Least to most restrictive; a file's class is the most restrictive that applies. */
export const CLASSES = ['user', 'synced', 'readonly', 'plugin', 'vendor'];
const rank = (c) => CLASSES.indexOf(c);
const stricter = (a, b) => (rank(a) >= rank(b) ? a : b);
/** The stricter of two classes — for a caller joining a class from elsewhere (lib/assist-files.js). */
export const stricterClass = stricter;
export const FIXABLE_CLASSES = new Set(['user', 'synced']);

const SKIP_DIRS = new Set([...CONTEXT_SKIP_DIRS, '.hg', '.svn']);
const INSTRUCTION_NAMES = new Set(['CLAUDE.md', 'AGENTS.md']);
const PROJECT_SKILL_HOMES = new Set(['.claude', '.codex', '.agents']);
const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.gz', '.tgz', '.tar', '.woff', '.woff2', '.ttf', '.otf', '.mp3', '.mp4', '.mov', '.wasm', '.bin', '.so', '.dylib', '.db', '.sqlite']);

const realOr = (p) => { try { return fs.realpathSync.native(p); } catch { return p; } };
const under = (p, dir) => p === dir || p.startsWith(dir + path.sep);
const refOf = (real) => sha256(`audit\0${real}`).slice(0, 16);

/* ── where a file belongs ─────────────────────────────────────────────── */

/** The real directories that decide a file's class, as they are now. */
function classDirs() {
  return {
    vendor: [path.join(CLAUDE_HOME, 'skills', '.system'), path.join(CODEX_HOME, 'skills', '.system')].map(realOr),
    plugin: [realOr(path.join(CLAUDE_HOME, 'plugins'))],
    readonly: currentRoots().readRoots,
    synced: [realOr(path.join(CLAUDE_HOME, 'skills', 'synced'))],
  };
}

/** A real path's class: vendor > plugin > readonly root > synced > user, never below `hint`. */
export function classOf(real, hint = 'user', dirs = classDirs()) {
  for (const c of ['vendor', 'plugin', 'readonly', 'synced']) {
    if (dirs[c].some((d) => under(real, d))) return stricter(c, hint);
  }
  return hint;
}

/** Display paths: ~-relative, or `<root label>/…` for a root outside HOME. Never absolute. */
export function displayer(roots) {
  const homes = [...new Set([HOME, realHome()])];
  const outside = roots.filter((r) => r.real && !homes.some((h) => under(r.real, h)));
  const show = (abs) => {
    if (homes.some((h) => under(abs, h))) return tilde(abs);
    const r = outside.find((x) => under(abs, x.real));
    if (r) return abs === r.real ? r.label : `${r.label}/${path.relative(r.real, abs)}`;
    return `…/${path.basename(abs)}`;
  };
  /** Every absolute path a message could carry, replaced the same way. */
  const redact = (msg) => {
    let out = String(msg);
    for (const r of outside) out = out.split(r.real).join(r.label);
    for (const h of homes) out = out.split(h).join('~');
    return out.replace(/(^|[\s(:'"])\/(?:[^\s'")]+\/)*([^\s'")/]+)/g, '$1…/$2');
  };
  return { show, redact };
}

/* ── the registry, as rules ───────────────────────────────────────────── */

/** An id's shape: version segments folded to `#`, so two releases of one family share a shape. */
export function shapeOf(id) {
  const out = [];
  for (const seg of id.split('-')) {
    const v = /^\d+(?:\.\d+)*$/.test(seg) ? '#' : seg;
    if (!(v === '#' && out[out.length - 1] === '#')) out.push(v);
  }
  return out.join('-');
}

/**
 * id → family, through the registry only: an exact current id first, then
 * the retired table, then the family's shape. `ambiguous` when more than one
 * family fits (grok vs grok-prev); null when none does.
 */
export function familyIndex(registry) {
  const exact = new Map(), shapes = new Map(), retired = new Map();
  const push = (m, k, v) => { const l = m.get(k) || []; if (!l.includes(v)) l.push(v); m.set(k, l); };
  for (const [fam, id] of Object.entries(registry.models || {})) { push(exact, id, fam); push(shapes, shapeOf(id), fam); }
  for (const a of Object.values(registry.assist || {})) {
    for (const [old, to] of Object.entries(a.retired || {})) if (Object.hasOwn(registry.models, to)) push(retired, old, to);
  }
  return (token) => {
    const one = (fams, extra) => (fams.length === 1 ? { family: fams[0], ...extra } : { ambiguous: fams });
    if (exact.has(token)) return one(exact.get(token), { current: true, exact: true });
    if (retired.has(token)) return one(retired.get(token), { stale: true, exact: true });
    const fams = shapes.get(shapeOf(token));
    return fams ? one(fams, { stale: true, exact: false }) : null;
  };
}

/** The efforts roles.json gives each family and each role, as memberEffort resolves them. */
function effortTable(loaded) {
  const byFamily = new Map(), byRole = new Map();
  const add = (m, k, e) => { if (!m.has(k)) m.set(k, new Set()); m.get(k).add(e); };
  for (const [name, role] of Object.entries(loaded.roles || {})) {
    byRole.set(name, new Set());
    for (const m of [...(role.members || []), ...(role.altMember ? [role.altMember] : [])]) {
      const { effort } = memberEffort(m, role, loaded.flavor || {});
      if (effort) { add(byFamily, m.family, effort); add(byRole, name, effort); }
    }
  }
  for (const [fam, f] of Object.entries(loaded.flavor || {})) if (f?.effort) add(byFamily, fam, f.effort);
  return { byFamily, byRole };
}

/** What the rules need from the registry and roles; errors switch the policy rules off (R12). */
export function auditPolicy({ home = HOME } = {}) {
  const reg = loadRegistry({ home });
  const roles = loadRoles({ home });
  const error = reg.error ? `models: ${reg.error}` : roles.error ? `roles: ${roles.error}` : null;
  return {
    error,
    families: Object.keys(reg.registry.models || {}),
    roleNames: Object.keys(roles.roles || {}),
    map: error ? () => null : familyIndex(reg.registry),
    current: reg.registry.models || {},
    efforts: error ? null : effortTable(roles),
  };
}

/* ── the rules ────────────────────────────────────────────────────────── */

const ID_PATTERNS = LINT_PATTERNS.slice(0, 3);
const isIdToken = (t) => ID_PATTERNS.some((re) => re.test(t));
const NAME_RE = new RegExp(`${LINT_PATTERNS[3].source}[\\d.]*|${LINT_PATTERNS[4].source}[\\w.-]*|${LINT_PATTERNS[5].source}[\\d.]*`, 'g');
const RESOLVER_RE = /\$\(\s*model-id\s+([^)|]*)\)/g;
const SHELL_LANGS = new Set(['bash', 'sh', 'zsh', 'shell']);
const COMMAND_RE = /^(?:claude|codex|grok)\b/;
const FLAG_BEFORE = /(?:^|[\s"'`(])(?:--model|-m)(?:\s+|=)(["']?)$/;
const KEY_BEFORE = /["']?\bmodel["']?\s*[:=]\s*(["']?)$/;
const FLAG_FAMILY_RE = /(?:^|[\s"'`(])(--model|-m)(?:\s+|=)(["']?)([A-Za-z][\w.-]*)/g;
const EFFORT_RES = [/\bmodel_reasoning_effort\s*=\s*["']?([a-z]+)/g, /--effort(?:\s+|=)["']?([a-z]+)/g, /\beffort["']?\s*:\s*["']([a-z]+)["']/g];
/** "Model lanes", "Lanes" or "Model routing" as the heading's own name: a qualifier after it, never another word ("Routing: build here…" is not one). */
const LANES_HEADING = /^#{1,6}\s+(?:model\s+lanes|lanes|model\s+routing)\b(?!\s*\w)/i;
/** `<id>-<effort>`: a preset label (`gpt-6-sol-high`), not an id. */
const EFFORT_SUFFIX = new RegExp(`^(.+)-(${[...EFFORTS].join('|')})$`);
const DATA_FENCES = new Set(['json', 'jsonc', 'json5', 'toml', 'yaml', 'yml']);

/** What kind of text a file is, from its name (and a shebang when it has no extension). */
export function kindOf(name, text = '') {
  const ext = path.extname(name).toLowerCase();
  if (['.sh', '.bash', '.zsh'].includes(ext)) return 'shell';
  if (['.md', '.markdown'].includes(ext)) return 'markdown';
  if (['.json', '.toml', '.yaml', '.yml'].includes(ext)) return 'data';
  if (['.js', '.mjs', '.cjs', '.ts', '.py', '.rb'].includes(ext)) return 'code';
  if (!ext && /^#!.*\b(?:ba|z|da)?sh\b/.test(text)) return 'shell';
  return 'text';
}

/** Each line's content (no terminator) and where it starts in `text`. */
function linesOf(text) {
  const out = [];
  let at = 0;
  while (at < text.length) {
    const nl = text.indexOf('\n', at);
    const stop = nl === -1 ? text.length : nl;
    const end = stop > at && text[stop - 1] === '\r' ? stop - 1 : stop;
    out.push({ n: out.length + 1, start: at, content: text.slice(at, end) });
    if (nl === -1) break;
    at = nl + 1;
  }
  return out;
}

/** The quote open at `pos` in a shell string: `'`, `"` or null. */
function quoteAt(s, pos) {
  let q = null;
  for (let i = 0; i < pos; i++) {
    const c = s[i];
    if (q === "'") { if (c === "'") q = null; continue; }
    if (c === '\\') { i++; continue; }
    if (q === '"') { if (c === '"') q = null; continue; }
    if (c === "'" || c === '"') q = c;
  }
  return q;
}

/**
 * Shell quoting carried from line to line through a shell file or fence:
 * an open quote, and here-documents — a quoted one's body (`<<'EOF'`,
 * `<<"EOF"`, `<<\EOF`) is literal text, an unquoted one's expands
 * `$(…)` the way double quotes do. Returns, for one line, the quote in
 * force at each position: `'` (nothing expands), `"` or null, and
 * `terminator` for a here-document's closing line.
 */
function shellLine(line, st) {
  if (st.body) {
    const h = st.body;
    if ((h.strip ? line.replace(/^\t+/, '') : line) === h.delim) {
      st.body = st.pending.shift() || null;
      return { at: () => "'", terminator: true };
    }
    return { at: () => (h.quoted ? "'" : '"') };
  }
  const states = new Array(line.length + 1);
  let q = st.quote;
  for (let i = 0; i < line.length; i++) {
    states[i] = q;
    const c = line[i];
    if (q === "'") { if (c === "'") q = null; continue; }
    if (c === '\\') { states[i + 1] = q; i++; continue; }
    if (q === '"') { if (c === '"') q = null; continue; }
    if (c === "'" || c === '"') { q = c; continue; }
    if (c === '<' && line[i + 1] === '<' && line[i + 2] !== '<') {
      const m = /^<<(-?)[ \t]*(?:(['"])([^'"\s]+)\2|(\\?)([A-Za-z_][\w.-]*))/.exec(line.slice(i));
      if (m) {
        st.pending.push({ strip: m[1] === '-', quoted: Boolean(m[2] || m[4]), delim: m[3] || m[5] });
        for (let k = i + 1; k < i + m[0].length; k++) states[k] = q;
        i += m[0].length - 1;
      }
    }
  }
  states[line.length] = q;
  st.quote = q;
  if (!st.body && st.pending.length) st.body = st.pending.shift();
  return { at: (pos) => (pos < states.length ? states[pos] : q) ?? null };
}
const freshShell = () => ({ quote: null, pending: [], body: null });

/**
 * The command segment of `line` around `pos`: split on `&&`, `||`, `;` and
 * `|` outside quotes and `$(…)`, so `codex … && codex …` is two commands.
 */
function segmentAt(line, pos) {
  let q = null, depth = 0, start = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q === "'") { if (c === "'") q = null; continue; }
    if (c === '\\') { i++; continue; }
    if (q === '"') { if (c === '"') q = null; else if (c === '$' && line[i + 1] === '(') { depth++; i++; } else if (c === ')' && depth) depth--; continue; }
    if (c === "'" || c === '"') { q = c; continue; }
    if (c === '$' && line[i + 1] === '(') { depth++; i++; continue; }
    if (c === ')' && depth) { depth--; continue; }
    if (depth) continue;
    const two = line.slice(i, i + 2);
    const sep = two === '&&' || two === '||' ? 2 : c === ';' || c === '|' ? 1 : 0;
    if (!sep) continue;
    if (i >= pos) return { start, end: i };
    start = i + sep;
    i += sep - 1;
  }
  return { start, end: line.length };
}

/** Inline code spans on a markdown line. */
function spansOf(line) {
  const out = [];
  for (const m of line.matchAll(/(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g)) out.push({ start: m.index + m[1].length, end: m.index + m[0].length - m[1].length, text: m[2] });
  return out;
}

/**
 * Where a position on a line can take a shell substitution (R1): a shell
 * file, a bash/sh/zsh/shell fence, or an inline-code command that starts
 * with claude, codex or grok outside a table row — and only unquoted, inside
 * double quotes or in an unquoted here-document's body (shellLine), never
 * where single quotes or a quoted here-document keep it literal.
 * Returns the quote state ('' or '"') when it can, null when it cannot.
 */
function shellSlot(ctx, pos, flagPos) {
  let s = null, at = pos;
  if (ctx.shell) {
    if (ctx.shell.terminator) return null;
    const q = ctx.shell.at(pos);
    return q === "'" ? null : (q || '');
  }
  if (ctx.kind === 'markdown' && ctx.fence === null && !/^\s*\|/.test(ctx.line)) {
    // Not in a table row: the fallback's `||` would split the cell.
    const span = ctx.spans.find((x) => pos >= x.start && pos < x.end);
    if (span && flagPos >= span.start && COMMAND_RE.test(span.text.trimStart())) { s = span.text; at = pos - span.start; }
  }
  if (s === null) return null;
  const q = quoteAt(s, at);
  return q === "'" ? null : (q || '');
}

/**
 * Whether the token at [pos, end) names a JSON, TOML or YAML key: its quoted
 * string, or the bare token, is followed by `:` or `=`, or it sits in a TOML
 * table header.
 */
function keyAt(line, pos, end) {
  if (/^\s*\[\[?[^\]]*\]\]?\s*(?:#.*)?$/.test(line) && /^[^\]]*\]/.test(line.slice(end))) return true;
  const q = quoteAt(line, pos);
  if (q) {
    const close = line.indexOf(q, end);
    return close !== -1 && /^\s*[:=]/.test(line.slice(close + 1));
  }
  return /^\s*(?::(?=\s|$)|=(?!=))/.test(line.slice(end));
}

/** What a name and a version ("Grok 4.7", "Opus 5.5") would be as an id, for the registry to place. */
function nameAsId(name) {
  const m = /^(Fable|Opus|Sonnet|Haiku|Grok|GPT)[ -](\d[\d.]*?)\.?$/.exec(name);
  if (!m) return null;
  if (m[1] === 'Grok') return `grok-${m[2]}`;
  if (m[1] === 'GPT') return `gpt-${m[2]}`;
  return `claude-${m[1].toLowerCase()}-${m[2].replace(/\./g, '-')}`;
}

const substitution = (arg, fallback, quote) => {
  const sub = `$(model-id ${arg} || echo MODEL-ID-UNRESOLVED-${fallback})`;
  return quote === '"' ? sub : `"${sub}"`;
};

/**
 * The findings for one file's text. Pure: `ctx` carries the file's ref,
 * name, whether it is an instruction file, and the policy (auditPolicy).
 * Each finding's id is a hash of rule, ref, line text, which copy of that
 * line it is, its match and which occurrence of that match on the line —
 * stable across runs, new when the line changes.
 */
export function analyze(text, { ref, name, instruction = false, policy }) {
  const kind = kindOf(name, text);
  const lines = linesOf(text);
  const findings = [];
  const seenLine = new Map();
  const guide = instruction || kind === 'markdown' ? guideRange(text) : { range: null, broken: false };
  const inGuide = (n) => Boolean(guide.range && n >= guide.range[0] && n <= guide.range[1]);
  const policyOn = !policy.error;
  let fence = null, fenceMark = null;
  let sh = freshShell();

  for (const l of lines) {
    const dup = seenLine.get(l.content) || 0;
    seenLine.set(l.content, dup + 1);
    if (kind === 'markdown') {
      const fm = /^\s*(`{3,}|~{3,})\s*([\w+-]*)/.exec(l.content);
      if (fm && fence === null) { fence = fm[2].toLowerCase(); fenceMark = fm[1]; sh = freshShell(); continue; }
      if (fm && fence !== null && fm[1][0] === fenceMark[0] && fm[1].length >= fenceMark.length && !fm[2]) { fence = null; fenceMark = null; continue; }
    }
    const line = l.content;
    const inShell = kind === 'shell' || (fence !== null && SHELL_LANGS.has(fence));
    const ctx = { kind, fence, line, spans: kind === 'markdown' && fence === null ? spansOf(line) : [], shell: inShell ? shellLine(line, sh) : null };
    const prose = (pos) => kind === 'text' || (kind === 'markdown' && fence === null && !ctx.spans.some((x) => pos >= x.start && pos < x.end));
    const dataLine = kind === 'data' || (fence !== null && DATA_FENCES.has(fence));
    const occ = new Map();
    const add = (f) => {
      const k = `${f.rule}\0${f.match}`;
      const i = occ.get(k) || 0;
      occ.set(k, i + 1);
      const guarded = inGuide(l.n);
      const note = guarded ? ' This is inside the generated model guide: update it in Models → Model guide.'
        : guide.broken && f.fix ? ' The model guide markers in this file are broken, so ACS offers no fixes here.' : '';
      const out = { id: sha256(`${f.rule}\0${ref}\0${line}\0${dup}\0${f.match}\0${i}`).slice(0, 16), line: l.n, ...f, message: f.message + note };
      if (guarded || guide.broken || !policyOn) delete out.fix;
      if (guarded) out.guide = true;
      findings.push(out);
    };

    // Ids written as a literal on this line — in code, a flag value or a key: a prose copy beside one is not fixed (C5).
    const ids = [];
    for (const m of line.matchAll(/[A-Za-z0-9._-]+/g)) {
      const token = m[0].replace(/[._-]+$/, '');
      if (!isIdToken(token)) continue;
      const before = line.slice(0, m.index);
      const flag = FLAG_BEFORE.exec(before);
      const inKey = !flag && dataLine && keyAt(line, m.index, m.index + token.length);
      ids.push({ token, pos: m.index, before, flag, inKey });
    }
    const literal = new Set(ids.filter((x) => x.flag || x.inKey || !prose(x.pos)).map((x) => x.token));
    const LITERAL_NOTE = 'The same id is also written on this line as a literal (in code, a flag value or a key), so changing only this copy could make the sentence wrong; there is no automatic fix.';

    // D1 + D2: literal ids, one finding per token occurrence; a flag or a model key's value is D2, any other key is D1.
    for (const { token, pos, before, flag, inKey } of ids) {
      const key = !flag && !inKey && !prose(pos) && KEY_BEFORE.exec(before);
      let fam = policy.map(token);
      // A preset label is classed by its base; an exact registered id is never stripped.
      const suffix = fam?.exact ? null : EFFORT_SUFFIX.exec(token);
      const preset = suffix && isIdToken(suffix[1]) ? { base: suffix[1], effort: suffix[2] } : null;
      if (preset) fam = policy.map(preset.base);
      const id = preset ? preset.base : token;
      const f = { rule: flag || key ? 'D2' : 'D1', severity: 'warn', match: token, col: pos + 1 };
      if (fam?.family) { f.family = fam.family; if (fam.stale) { f.stale = true; f.current = policy.current[fam.family]; } }
      const label = preset ? `\`${token}\` is a preset label: \`${id}\` at effort ${preset.effort}. ` : '';
      const what = label + (!policyOn ? `\`${id}\` is a model id written out.`
        : fam?.ambiguous ? `\`${id}\` could be ${fam.ambiguous.join(' or ')}; ACS can't tell which, so it offers no fix.`
          : !fam ? `\`${id}\` looks like a model id, but no family in the registry has that shape.`
            : fam.stale ? `\`${id}\` is an old ${fam.family} id: the registry's ${fam.family} is now \`${policy.current[fam.family]}\`.`
              : `\`${id}\` is ${fam.family}'s current id written out; it goes stale on the next bump.`);
      if (preset) {
        f.message = `${what} A label is not a setting, so ACS offers no fix.`;
      } else if (inKey) {
        f.message = `${what} It is a key here, not a model setting.`;
      } else if (flag) {
        const slot = fam?.family ? shellSlot(ctx, pos, before.search(/(?:--model|-m)(?:\s+|=)["']?$/)) : null;
        if (slot !== null) {
          f.fix = { start: pos, end: pos + token.length, replacement: substitution(fam.family, fam.family, slot) };
          f.message = `${what} Resolve it at run time instead.`;
        } else {
          f.message = `${what} ${fam?.family ? 'This spot can\'t take a shell substitution (single quotes, a table row, or not a shell command), so there is no automatic fix.' : ''}`.trim();
        }
      } else if (key) {
        f.message = `${what} A JSON or TOML value can't run model-id: use a family name here if whatever reads it resolves families.`;
      } else if (fam?.family && fam.exact && prose(pos) && literal.has(token)) {
        f.message = `${what} ${LITERAL_NOTE}`;
      } else if (fam?.family && fam.exact && prose(pos)) {
        f.fix = { start: pos, end: pos + token.length, replacement: fam.family };
        f.message = `${what} In prose, the family name says the same thing and never goes stale.`;
      } else {
        f.message = what;
      }
      if (f.rule === 'D1' && prose(pos) && !f.stale) f.severity = fam?.family ? 'info' : 'warn';
      add(f);
    }

    // D1, written as a family name and a version: lint flags it, so the audit does. In
    // prose, a name the registry places exactly is fixed to the family name.
    for (const m of line.matchAll(NAME_RE)) {
      const text = m[0].replace(/\.+$/, '');
      const as = nameAsId(text);
      const fam = as ? policy.map(as) : null;
      const f = { rule: 'D1', severity: 'info', match: m[0], col: m.index + 1, name: true, message: `"${m[0]}" names a model version; it dates when the family moves on.` };
      if (fam?.family && fam.exact && prose(m.index)) {
        f.family = fam.family;
        if (literal.has(as)) f.message += ` ${LITERAL_NOTE.replace('same id', `id it names (\`${as}\`)`)}`;
        else {
          f.fix = { start: m.index, end: m.index + text.length, replacement: fam.family };
          f.message += ` In prose, the family name (${fam.family}) says the same thing and never goes stale.`;
        }
      }
      add(f);
    }

    // D2, a family name as a literal flag value on a claude/codex/grok command line.
    for (const m of line.matchAll(FLAG_FAMILY_RE)) {
      const value = m[3];
      if (isIdToken(value) || !policy.families.includes(value)) continue;
      if (!/\b(?:claude|codex|grok)\b/.test(line.slice(0, m.index))) continue;
      add({ rule: 'D2', severity: 'info', match: `${m[1]} ${value}`, col: m.index + m[0].indexOf(m[1]) + 1, family: value,
        message: `\`${m[1]} ${value}\` picks the model by hand; \`$(model-id --role <role> || echo …)\` would follow the roles.` });
    }

    // D3: a resolver call with no fallback.
    for (const m of line.matchAll(RESOLVER_RE)) {
      const args = m[1].trim().split(/\s+/);
      let fallback = null;
      if (args.length === 1 && policy.families.includes(args[0])) fallback = args[0];
      else if (args.length === 2 && args[0] === '--role' && /^[a-z][a-z0-9-]*$/.test(args[1])) fallback = `role-${args[1]}`;
      else if (args.length === 3 && args[0] === '--json' && args[1] === '--role' && /^[a-z][a-z0-9-]*$/.test(args[2])) fallback = `role-${args[2]}`;
      const f = { rule: 'D3', severity: 'warn', match: m[0], col: m.index + 1,
        message: `\`${m[0]}\` has no fallback: where model-id is not on PATH it expands to "", and the CLI silently uses its own default.` };
      if (fallback && shellSlot(ctx, m.index, m.index) !== null) {
        f.fix = { start: m.index, end: m.index + m[0].length, replacement: `${m[0].slice(0, -1).replace(/\s+$/, '')} || echo MODEL-ID-UNRESOLVED-${fallback})` };
      }
      add(f);
    }

    // D4: a literal effort, against the efforts roles.json uses for that family or role.
    if (policyOn) {
      for (const re of EFFORT_RES) {
        for (const m of line.matchAll(re)) {
          const effort = m[1];
          if (!EFFORTS.has(effort)) continue;
          const seg = segmentAt(line, m.index);
          const who = subjectOf(line.slice(seg.start, seg.end), m.index - seg.start, policy);
          if (!who) continue;
          const used = (who.role ? policy.efforts.byRole.get(who.role) : policy.efforts.byFamily.get(who.family)) || new Set();
          if (used.has(effort)) continue;
          const name = who.role ? `the ${who.role} role` : who.family;
          add({ rule: 'D4', severity: 'info', match: m[0], col: m.index + 1, ...(who.family ? { family: who.family } : { role: who.role }),
            message: `effort \`${effort}\` for ${name}, but no role uses ${name} at ${effort}${used.size ? ` (roles use: ${[...used].join(', ')})` : ''}. Informational — efforts here are never changed automatically.` });
        }
      }
    }

    // D5: a hand-written lanes section beside the generated block.
    if (instruction && guide.range && !inGuide(l.n) && fence === null && LANES_HEADING.test(line)) {
      add({ rule: 'D5', severity: 'info', match: line.trim().slice(0, 80), col: 1,
        message: 'A hand-written lanes section sits next to the generated model guide; the two can drift apart.' });
    }
  }
  return findings;
}

/**
 * Whose effort the one command `seg` sets at `pos`: the nearest model before
 * it — a `--role` resolver, a family resolver, a literal id or a family flag
 * — or, with none before, the nearest after.
 */
function subjectOf(seg, pos, policy) {
  const found = [];
  for (const m of seg.matchAll(/\$\(\s*model-id\s+(?:--json\s+)?--role\s+([a-z][a-z0-9-]*)/g)) if (policy.roleNames.includes(m[1])) found.push({ at: m.index, who: { role: m[1] } });
  for (const m of seg.matchAll(/\$\(\s*model-id\s+([a-z][\w-]*)/g)) if (policy.families.includes(m[1])) found.push({ at: m.index, who: { family: m[1] } });
  for (const m of seg.matchAll(/[A-Za-z0-9._-]+/g)) {
    const t = m[0].replace(/[._-]+$/, '');
    if (isIdToken(t)) { const f = policy.map(t); if (f?.family) found.push({ at: m.index, who: { family: f.family } }); }
  }
  for (const m of seg.matchAll(FLAG_FAMILY_RE)) if (policy.families.includes(m[3])) found.push({ at: m.index, who: { family: m[3] } });
  const before = found.filter((x) => x.at < pos).sort((a, b) => b.at - a.at)[0];
  const after = found.filter((x) => x.at >= pos).sort((a, b) => a.at - b.at)[0];
  return (before || after)?.who ?? null;
}

/** The generated block's line range, or `broken` when its markers are (then nothing in the file is fixed). */
function guideRange(text) {
  const seen = inspectGuide(text, null);
  if (seen.status === 'absent') return { range: null, broken: false };
  if (seen.status === 'malformed') return { range: null, broken: true };
  return { range: seen.block.lines, broken: false };
}

/**
 * The file's bytes with `fixes` applied, from its original buffer: every
 * byte outside the replaced spans is copied. A fix on a line of the
 * generated model guide, or overlapping another, is refused (R2).
 */
export function applyFixes(buf, text, fixes) {
  const lines = linesOf(text);
  const guide = guideRange(text);
  const spans = [];
  for (const f of fixes) {
    if (guide.broken || (guide.range && f.line >= guide.range[0] && f.line <= guide.range[1])) {
      throw bad(409, 'That edit would touch the generated model guide; update it in Models → Model guide instead.');
    }
    const l = lines[f.line - 1];
    if (!l || f.fix.end > l.content.length) throw bad(409, 'The file changed since the audit ran. Run it again.');
    const at = Buffer.byteLength(text.slice(0, l.start + f.fix.start));
    const to = Buffer.byteLength(text.slice(0, l.start + f.fix.end));
    spans.push({ at, to, replacement: Buffer.from(f.fix.replacement) });
  }
  spans.sort((a, b) => a.at - b.at);
  for (let i = 1; i < spans.length; i++) if (spans[i].at < spans[i - 1].to) throw bad(409, 'Two of those fixes overlap; fix them one at a time.');
  const parts = [];
  let cur = 0;
  for (const s of spans) { parts.push(buf.subarray(cur, s.at), s.replacement); cur = s.to; }
  parts.push(buf.subarray(cur));
  return Buffer.concat(parts);
}

const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/* ── the walk ─────────────────────────────────────────────────────────── */

/** Newest version directory last, numerically. */
const byVersion = (a, b) => {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; }
  return a.localeCompare(b);
};
const dirsIn = (dir) => { try { return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return []; } };

/** Enabled Claude plugins' skills folders, newest cached version only. */
function pluginSkillDirs() {
  let settings;
  try { settings = JSON.parse(readUserText(path.join(CLAUDE_HOME, 'settings.json'))); } catch { return []; }
  const out = [];
  for (const [key, on] of Object.entries(settings?.enabledPlugins || {})) {
    if (on !== true) continue;
    const [plugin, market] = key.split('@');
    if (!plugin || !market || [plugin, market].some((s) => s.includes('/') || s.startsWith('.'))) continue;
    const base = path.join(CLAUDE_HOME, 'plugins', 'cache', market, plugin);
    const version = dirsIn(base).sort(byVersion).pop();
    if (!version) continue;
    for (const rel of ['skills', path.join('.claude', 'skills')]) out.push(path.join(base, version, rel));
  }
  return out;
}

/**
 * One bounded walk over the inventory (R10): depth, file count, per-file and
 * total bytes are enforced as it goes, and what it cut is reported. Linked
 * git worktrees under the roots are walked last, so under a cap they are
 * what is cut; past it they are only counted, and the count reported.
 */
let walkHook = null;
/** A test seam: runs after a file's size check and before its read. Nothing in the app sets it. */
export function _setWalkHook(fn) { walkHook = fn; }

async function walk({ limits, roots }) {
  const files = new Map();                 // real path -> entry
  const refusals = [];
  const skipped = { tooLarge: 0, binary: 0, backup: 0 };
  const cut = new Set();
  let bytes = 0, seen = 0;
  // The linked worktree being walked ({ commonDir, main }), its files left unread past a cap, and why.
  let curWt = null, counting = false, wtSkipped = 0, wtWhy = null;
  const deferred = [];
  const dirs = classDirs();
  const allowedLinks = [...skillRoots(), realOr(path.join(CLAUDE_HOME, 'plugins'))];
  const yieldEvery = async () => { if (++seen % 200 === 0) await new Promise((r) => setImmediate(r)); };
  const full = () => {
    if (files.size >= limits.files) { cut.add(`stopped at ${limits.files} files`); return true; }
    if (bytes >= limits.totalBytes) { cut.add(`stopped at ${limits.totalBytes / 1024 / 1024} MB read`); return true; }
    return false;
  };
  /** Past a cap: stop — or, in a linked worktree, go on only counting what is left unread. */
  const halt = () => {
    if (counting || !full()) return false;
    if (!curWt) return true;
    counting = true;
    wtWhy ||= files.size >= limits.files ? 'file cap' : 'byte budget';
    return false;
  };
  const refuse = (abs, reason) => { if (!counting) refusals.push({ abs, reason }); };

  const totalCut = () => cut.add(`stopped at ${limits.totalBytes / 1024 / 1024} MB read`);
  /**
   * Bytes through the right chokepoint, or null after counting why not. The
   * stat size is only an early skip: `read(cap)` is given what is left of the
   * per-file and total budgets and must refuse past it, and the bytes it
   * returns are what is counted.
   */
  const take = (abs, size, read) => {
    if (size > limits.fileBytes) { skipped.tooLarge++; return null; }
    if (BINARY_EXT.has(path.extname(abs).toLowerCase())) { skipped.binary++; return null; }
    // A backup is loaded by no agent (model-id --lint skips them the same way).
    if (path.basename(abs).includes('.bak')) { skipped.backup++; return null; }
    if (bytes + size > limits.totalBytes) { totalCut(); if (curWt) { wtSkipped++; wtWhy ||= 'byte budget'; } return null; }
    if (walkHook) walkHook(abs);
    const left = limits.totalBytes - bytes;
    const cap = Math.min(limits.fileBytes, left);
    let buf;
    try { buf = read(cap); }
    catch (e) {
      if (e.status !== 413) { refuse(abs, e.message); return null; }
      if (cap < limits.fileBytes) totalCut(); else skipped.tooLarge++;
      return null;
    }
    if (buf.length > cap) { if (cap < limits.fileBytes) totalCut(); else skipped.tooLarge++; return null; }
    bytes += buf.length;
    if (buf.includes(0)) { skipped.binary++; return null; }
    try { return { buf, text: UTF8.decode(buf) }; } catch { skipped.binary++; return null; }
  };

  const keep = (real, entry) => {
    const had = files.get(real);
    if (had) { had.cls = stricter(had.cls, entry.cls); had.aliases++; return; }
    files.set(real, { ...entry, real, aliases: 0, wt: curWt });
  };

  /** Every file in one skill, read through readInSkill. `base` is the skill folder's depth below its inventory root. */
  const skillFiles = async (skillDir, hint, skill, base) => {
    const cls = classOf(skillDir, hint, dirs);
    const inner = async (rel, depth) => {
      if (depth > limits.depth) { cut.add(`folders deeper than ${limits.depth} levels were skipped`); return; }
      let entries;
      try { entries = fs.readdirSync(rel ? path.join(skillDir, rel) : skillDir, { withFileTypes: true }); } catch (e) { refuse(path.join(skillDir, rel), e.code || e.message); return; }
      for (const d of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
        if (halt()) return;
        await yieldEvery();
        const r = rel ? `${rel}/${d.name}` : d.name;
        const abs = path.join(skillDir, r);
        if (counting) {
          if (d.isDirectory() && !d.isSymbolicLink() && !SKIP_DIRS.has(d.name)) await inner(r, depth + 1);
          else if (d.isFile()) wtSkipped++;
          continue;
        }
        if (d.isSymbolicLink()) { refuse(abs, 'symlink inside a skill folder'); continue; }
        if (isDenied(abs)) { refuse(abs, 'protected path'); continue; }
        if (d.isDirectory()) { if (!SKIP_DIRS.has(d.name)) await inner(r, depth + 1); continue; }
        if (!d.isFile()) continue;
        let size;
        try { size = fs.lstatSync(abs).size; } catch { continue; }
        const got = take(abs, size, (cap) => readInSkill(skillDir, r, { budget: { remaining: cap } }));
        if (got) keep(abs, { ...got, cls, kind: 'skill', skill, rel: r, skillDir, name: d.name, instruction: false });
      }
    };
    await inner('', base);
  };

  /** A skills folder: every SKILL.md directory under it, one root-level link resolved. */
  const skillsTree = async (root, hint, depth = 0, rootLevel = true) => {
    if (depth > limits.depth) { cut.add(`folders deeper than ${limits.depth} levels were skipped`); return; }
    let entries;
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
    for (const d of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (halt()) return;
      if (SKIP_DIRS.has(d.name)) continue;
      const abs = path.join(root, d.name);
      let real = abs;
      if (d.isSymbolicLink()) {
        if (!rootLevel) continue;
        try { real = fs.realpathSync.native(abs); if (!fs.statSync(real).isDirectory()) continue; } catch { refuse(abs, 'symlink target is missing'); continue; }
        try { resolveSafe(real, allowedLinks); } catch { refuse(abs, 'symlink points outside the skill roots'); continue; }
      } else if (!d.isDirectory()) continue;
      let h = hint;
      if (rootLevel && d.name === '.system') h = stricter(h, 'vendor');
      if (rootLevel && d.name === 'synced') h = stricter(h, 'synced');
      let isSkill = false;
      try { isSkill = fs.lstatSync(path.join(real, 'SKILL.md')).isFile(); } catch {}
      if (depth + 1 > limits.depth) { cut.add(`folders deeper than ${limits.depth} levels were skipped`); continue; }
      if (isSkill) await skillFiles(real, h, path.basename(real), depth + 1);
      else await skillsTree(real, h, depth + 1, false);
    }
  };

  /** A skills root, itself perhaps a link: scanned only where it really is inside the allowed trees. */
  const skillsRoot = async (root, hint, depth = 0) => {
    let st;
    try { st = fs.lstatSync(root); } catch { return; }
    if (!st.isDirectory() && !st.isSymbolicLink()) return;
    let real;
    try { real = fs.realpathSync.native(root); resolveSafe(real, allowedLinks); } catch { refuse(root, 'skills folder resolves outside the skill roots'); return; }
    await skillsTree(real, hint, depth);
  };

  /** An instruction file by path: links resolved once, into an edit or read root or a harness home. */
  const instruction = (abs, hint, scope, allowed) => {
    let real;
    try { real = resolveSafe(abs, allowed); } catch (e) { refuse(abs, e.message); return; }
    let st;
    try { st = fs.statSync(real); } catch { return; }
    if (!st.isFile()) return;
    if (files.has(real)) { const had = files.get(real); had.aliases++; had.cls = stricter(had.cls, hint); return; }
    if (halt()) return;
    if (counting) { wtSkipped++; return; }
    const got = take(real, st.size, (cap) => openUserFile(real, { maxBytes: cap }).buf);
    if (got) keep(real, { ...got, cls: classOf(real, hint, dirs), kind: 'instruction', scope, name: path.basename(real), instruction: true });
  };

  // The global instruction files first, then the skills homes, then the roots.
  const homes = safeRoots();
  for (const f of [path.join(CLAUDE_HOME, 'CLAUDE.md'), path.join(CODEX_HOME, 'AGENTS.md'), path.join(GROK_HOME, 'AGENTS.md')]) {
    try { fs.lstatSync(f); } catch { continue; }
    instruction(f, 'user', 'global', homes);
  }
  await skillsRoot(path.join(CLAUDE_HOME, 'skills'), 'user');
  await skillsRoot(path.join(CODEX_HOME, 'skills'), 'user');
  await skillsRoot(path.join(AGENTS_HOME, 'skills'), 'user');

  // Edit roots before plugins and read roots: under the file cap, what can be fixed is read first.
  const rootAllowed = [...homes, ...roots.filter((r) => r.access === 'read').map((r) => r.real)];
  const rootTree = async (r) => {
    const hint = r.access === 'read' ? 'readonly' : 'user';
    const tree = async (dir, depth) => {
      if (depth > limits.depth) { cut.add(`folders deeper than ${limits.depth} levels were skipped`); return; }
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const d of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
        if (halt()) return;
        await yieldEvery();
        const abs = path.join(dir, d.name);
        if (d.isDirectory()) {
          if (SKIP_DIRS.has(d.name) || isDenied(abs)) continue;
          // A linked worktree is a copy of a repository: read after everything else.
          const wt = linkedWorktree(abs);
          if (wt) { deferred.push({ wt, run: () => tree(abs, depth + 1) }); continue; }
          // A project's harness folders hold its skills, as lib/skills.js reads them.
          if (PROJECT_SKILL_HOMES.has(d.name)) {
            if (depth + 2 <= limits.depth) await skillsRoot(path.join(abs, 'skills'), hint, depth + 2);
            else cut.add(`folders deeper than ${limits.depth} levels were skipped`);
            continue;
          }
          await tree(abs, depth + 1);
        } else if ((d.isFile() || d.isSymbolicLink()) && INSTRUCTION_NAMES.has(d.name)) {
          instruction(abs, hint, abs === path.join(r.real, d.name) ? 'root' : 'project', rootAllowed);
        }
      }
    };
    const wt = linkedWorktree(r.real);
    if (wt) deferred.push({ wt, run: () => tree(r.real, 0) });
    else await tree(r.real, 0);
  };
  for (const r of roots.filter((x) => x.access === 'edit')) await rootTree(r);
  for (const dir of pluginSkillDirs()) await skillsRoot(dir, 'plugin');
  for (const r of roots.filter((x) => x.access === 'read')) await rootTree(r);
  // A worktree found inside a worktree joins the queue.
  for (let i = 0; i < deferred.length; i++) { curWt = deferred[i].wt; await deferred[i].run(); }
  curWt = null;
  if (wtSkipped) cut.add(`${wtSkipped} file${wtSkipped === 1 ? '' : 's'} in linked worktrees ${wtSkipped === 1 ? 'was' : 'were'} skipped: ${wtWhy}`);
  return { files, refusals, skipped, cut: [...cut], bytes };
}

/**
 * What Assist may ask for (lib/assist-files.js): the audit's own inventory —
 * the same walk, the same classes, the same display paths — keeping no file
 * contents, only a SKILL.md's frontmatter description.
 */
export async function assistInventory({ limits = AUDIT_LIMITS } = {}) {
  const roots = currentRoots().active;
  const { show } = displayer(roots);
  const w = await walk({ limits, roots });
  const files = [];
  for (const [real, e] of w.files) {
    const description = e.kind === 'skill' && e.rel === 'SKILL.md' ? parseFrontmatter(e.text)?.description ?? null : null;
    files.push({
      real, display: show(real), cls: e.cls, kind: e.kind, name: e.name,
      skill: e.skill ?? null, skillDir: e.skillDir ?? null, rel: e.rel ?? null, scope: e.scope ?? null, description,
    });
  }
  return { files, cut: w.cut };
}

/* ── the service ──────────────────────────────────────────────────────── */

const STALE = 'The file changed since this was proposed. Nothing was written; run the audit again.';
const CLASS_REFUSAL = {
  plugin: 'This file belongs to a plugin: the next plugin update replaces it, so ACS shows findings only.',
  vendor: 'This file ships with the CLI itself, so ACS shows findings only.',
  readonly: 'This file is in a read-only folder, so ACS shows findings only.',
};
const SYNCED = 'This skill is synced: the next sync overwrites this fix. Confirm that you want to fix it anyway.';

/** Refuse a write the class does not allow; synced needs the acknowledgement. */
export function policyCheck(cls, ackSync) {
  if (!FIXABLE_CLASSES.has(cls)) throw bad(403, CLASS_REFUSAL[cls], { reason: cls, cls });
  if (cls === 'synced' && ackSync !== true) throw bad(409, SYNCED, { reason: 'synced', cls });
}

export function createAudit({ home = HOME, hist = history, now = Date.now, limits = AUDIT_LIMITS } = {}) {
  const store = createProposals({ hist, now, ttlMs: limits.proposalTtlMs, perTarget: limits.proposalsPerTarget, maxBytes: limits.fileBytes });
  const dismissedFile = path.join(home, '.agent-config-studio', 'audit-dismissed.json');
  let cache = null;          // { at, sig, result }
  let inventory = new Map(); // ref -> entry of the last run (no text kept)
  let running = null;
  let summary = null;
  let runs = 0;

  const rootsSig = () => JSON.stringify(currentRoots().active.map((r) => [r.id, r.real, r.access]));

  function readDismissed() {
    try {
      const doc = JSON.parse(readUserText(dismissedFile));
      return doc && typeof doc.dismissed === 'object' && doc.dismissed ? doc.dismissed : {};
    } catch { return {}; }
  }
  function writeDismissed(map) {
    fs.mkdirSync(path.dirname(dismissedFile), { recursive: true });
    const tmp = `${dismissedFile}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, dismissed: map }, null, 2)}\n`);
    fs.renameSync(tmp, dismissedFile);
  }

  function invalidate() {
    cache = null;
    if (summary) summary = { ...summary, stale: true };
  }

  async function scan() {
    const roots = currentRoots().active;
    const sig = rootsSig();
    const policy = auditPolicy({ home });
    const { show, redact } = displayer(roots);
    const w = await walk({ limits, roots });
    const dismissed = readDismissed();
    const entries = [];
    const nextInventory = new Map();
    for (const [real, e] of w.files) {
      const ref = refOf(real);
      const findings = analyze(e.text, { ref, name: e.name, instruction: e.instruction, policy });
      const display = show(real);
      nextInventory.set(ref, { real, cls: e.cls, kind: e.kind, skillDir: e.skillDir, rel: e.rel, name: e.name, instruction: e.instruction, display });
      entries.push({ ref, real, display, cls: e.cls, kind: e.kind, skill: e.skill, scope: e.scope, aliases: e.aliases,
        wt: e.wt ? { repo: refOf(e.wt.commonDir), label: show(e.wt.main) } : null,
        group: `${e.cls}\0${kindOf(e.name, e.text)}\0${e.instruction}\0${sha256(e.buf)}`, findings });
    }
    inventory = nextInventory;

    // Identical copies of one class: one card, the shallowest copy first (R9), a copy outside a linked worktree before one in it.
    const depth = (e) => e.display.split('/').length;
    const groups = new Map();
    for (const e of entries.sort((a, b) => (rank(a.cls) - rank(b.cls)) || (Boolean(a.wt) - Boolean(b.wt)) || (depth(a) - depth(b)) || (a.display < b.display ? -1 : 1))) {
      if (!groups.has(e.group)) groups.set(e.group, []);
      groups.get(e.group).push(e);
    }
    const out = [];
    const byClass = Object.fromEntries(CLASSES.map((c) => [c, { files: 0, findings: 0, fixable: 0 }]));
    let findings = 0, fixable = 0;
    for (const [, [first, ...rest]] of groups) {
      for (const e of [first, ...rest]) byClass[e.cls].files++;
      if (!first.findings.length) continue;
      const pub = first.findings.map(({ fix, ...f }) => ({
        ...f, fixable: Boolean(fix) && FIXABLE_CLASSES.has(first.cls), ...(fix ? { replacement: fix.replacement } : {}),
        dismissed: Object.hasOwn(dismissed, f.id),
      }));
      for (const f of pub) {
        if (f.dismissed) continue;
        byClass[first.cls].findings++;
        if (f.fixable) byClass[first.cls].fixable++;
        if (first.cls !== 'vendor') { findings++; if (f.fixable) fixable++; }
      }
      out.push({
        ref: first.ref, display: first.display, cls: first.cls, kind: first.kind,
        ...(first.skill ? { skill: first.skill } : {}), ...(first.scope ? { scope: first.scope } : {}),
        aliases: first.aliases,
        ...(first.wt ? { worktree: first.wt } : {}),
        copies: rest.map((c) => ({ ref: c.ref, display: c.display, cls: c.cls })),
        findings: pub,
      });
    }
    out.sort((a, b) => (a.display < b.display ? -1 : 1));
    // Each repository's linked worktrees, for the view's collapsed section: physical files read.
    const worktrees = new Map();
    for (const e of entries) {
      if (!e.wt) continue;
      if (!worktrees.has(e.wt.repo)) worktrees.set(e.wt.repo, { ...e.wt, files: 0 });
      worktrees.get(e.wt.repo).files++;
    }
    const result = {
      scannedAt: now(), run: ++runs,
      partial: w.cut.length > 0, partialReasons: w.cut,
      policyError: policy.error ? redact(policy.error) : null,
      counts: { files: w.files.size, findings, fixable, skipped: w.skipped, refused: w.refusals.length, byClass },
      refusals: w.refusals.slice(0, 200).map((r) => ({ path: show(r.abs), reason: redact(r.reason) })),
      files: out,
      worktrees: [...worktrees.values()].sort((a, b) => (a.label < b.label ? -1 : 1)),
    };
    summary = { state: result.partial ? 'partial' : 'ok', findings, fixable, scannedAt: result.scannedAt, stale: false };
    cache = { at: now(), sig, result };
    return result;
  }

  /** The deterministic pass: concurrent callers share one run; the result is kept for a minute. */
  function run({ refresh = false } = {}) {
    if (!refresh && cache && now() - cache.at < limits.cacheMs && cache.sig === rootsSig()) return Promise.resolve(cache.result);
    if (running) return running;
    running = scan().finally(() => { running = null; });
    return running;
  }

  /** What Home shows: the last run's counts, never a new scan. */
  function cached() {
    if (!summary) return { state: 'not-audited' };
    return cache && cache.sig !== rootsSig() ? { ...summary, stale: true } : summary;
  }

  /** The file a ref names, re-read and re-analyzed now, with its class as of now. */
  function current(ref, ackSync) {
    if (typeof ref !== 'string' || !/^[0-9a-f]{16}$/.test(ref)) throw bad(400, 'unknown file');
    const e = inventory.get(ref);
    if (!e) throw bad(409, 'That file is not in the last audit. Run it again.');
    const { redact } = displayer(currentRoots().active);
    // The class first, before anything is read: the strictest of the audit's and now.
    const cls = classOf(realOr(e.real), e.cls);
    policyCheck(cls, ackSync);
    let real;
    try { real = resolveSafe(e.real); } catch (err) { throw bad(403, redact(err.message), { reason: 'unsafe-path' }); }
    if (real !== e.real) throw bad(409, STALE);
    let opened;
    try {
      const contained = e.kind === 'skill' ? readInSkill(e.skillDir, e.rel) : null;
      opened = openUserFile(real, { maxBytes: limits.fileBytes });
      if (contained && !contained.equals(opened.buf)) throw new Error('the file changed while it was read');
    } catch (err) { throw bad(409, `${e.display}: ${redact(err.message)}`); }
    let text;
    try { text = UTF8.decode(opened.buf); } catch { throw bad(409, `${e.display} is not valid UTF-8.`); }
    return { e, cls, real, buf: opened.buf, stat: opened.stat, text };
  }

  function propose({ fileRef, findingIds, ackSync } = {}) {
    if (!Array.isArray(findingIds) || !findingIds.length || findingIds.length > 500 || !findingIds.every((x) => typeof x === 'string' && /^[0-9a-f]{16}$/.test(x))) {
      throw bad(400, 'findingIds must be a list of finding ids');
    }
    const { e, cls, real, buf, stat, text } = current(fileRef, ackSync);
    assertWritable(real);
    const policy = auditPolicy({ home });
    if (policy.error) throw bad(409, 'The model registry or the roles are invalid, so ACS offers no fixes until they are fixed (Models).');
    const all = analyze(text, { ref: fileRef, name: e.name, instruction: e.instruction, policy });
    const want = new Set(findingIds);
    const chosen = all.filter((f) => want.has(f.id));
    if (chosen.length !== want.size) throw bad(409, 'Some of those findings are no longer in the file. Run the audit again.');
    const unfixable = chosen.filter((f) => !f.fix);
    if (unfixable.length) throw bad(400, `${unfixable.length} of those findings ${unfixable.length === 1 ? 'has' : 'have'} no automatic fix.`);
    const bytes = applyFixes(buf, text, chosen);
    // The result must stay auditable: over the cap, the next scan would skip it.
    if (bytes.length > limits.fileBytes) {
      throw bad(413, `${e.display} would be ${bytes.length} bytes with these fixes; the audit reads files of at most ${limits.fileBytes / 1024 / 1024} MB.`, { reason: 'too-large' });
    }
    const base = baseOf(buf);
    const { id, expires } = store.add(fileRef, { real, ident: `${stat.dev}:${stat.ino}`, base, bytes, cls, ackSync: ackSync === true, display: e.display });
    const copies = cache?.result.files.find((f) => f.ref === fileRef)?.copies.length ?? 0;
    return {
      id, fileRef, path: e.display, cls, fixes: chosen.length, base,
      current: buf.toString('utf8'), proposed: bytes.toString('utf8'), expiresAt: expires, copies,
    };
  }

  async function accept({ id } = {}) {
    const p = store.take(id);
    const { redact } = displayer(currentRoots().active);
    try {
      const { sha, warnings } = await store.commit(p, {
        locate: () => resolveSafe(p.real),
        stale: STALE,
        // The class again, as of the write: the strictest of propose and now.
        recheck: (q) => policyCheck(classOf(realOr(q.real), q.cls), q.ackSync),
        baselineMessage: `state of ${p.display} before an audit fix`,
        recordMessage: `audit: fix in ${p.display}`,
      });
      invalidate();
      return { saved: true, path: p.display, sha, warnings: warnings.map(redact), historyError: warnings.length ? redact(warnings.join(' ')) : null };
    } catch (e) {
      e.message = redact(e.message);
      throw e;
    }
  }

  function dismiss({ id, undo = false } = {}) {
    if (typeof id !== 'string' || !/^[0-9a-f]{16}$/.test(id)) throw bad(400, 'unknown finding');
    const map = readDismissed();
    if (undo) delete map[id];
    else {
      map[id] = now();
      const keys = Object.keys(map);
      if (keys.length > limits.dismissed) for (const k of keys.sort((a, b) => map[a] - map[b]).slice(0, keys.length - limits.dismissed)) delete map[k];
    }
    writeDismissed(map);
    invalidate();
    return { dismissed: !undo, id };
  }

  return {
    run, cached, propose, accept, invalidate, dismiss,
    /** The real paths the last run read — for tests/audit-real-run.mjs's before/after hashes; no route returns it. */
    scannedFiles: () => [...inventory.values()].map((e) => e.real),
    reject({ id } = {}) { store.take(id); return { rejected: true }; },
  };
}
