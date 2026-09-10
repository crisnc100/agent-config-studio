import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadSeats, registryPath } from './seats.js';

/**
 * Shell shortcuts: one generated zsh file that gives each seat a command word.
 *
 * The point is that switching subscriptions is a word you type, not a path you
 * remember — `codex team` instead of `CODEX_HOME=~/.codex-seats/... codex`.
 *
 * TWO RULES GOVERN THIS FILE, and both exist because its output is executed by
 * every shell the user opens:
 *
 * 1. ACS never edits a file a human owns. It generates THIS file wholly, and
 *    ~/.zshenv gets a single `source` line appended once. Regenerating can
 *    therefore never damage hand-written shell config, and uninstalling is
 *    removing one line.
 * 2. Nothing reaches the generated file unvalidated. A command word is checked
 *    against a strict allowlist and a home must be an absolute real directory,
 *    because a stray quote or `$(...)` here is arbitrary code execution on
 *    every new terminal — a far worse outcome than any bad config value.
 */

/** zsh reads .zshenv for EVERY shell — interactive, login, script, or not.
 *  .zshrc is interactive-only, which is why shortcuts installed there appear
 *  to work "sometimes" and are the usual source of "it didn't stick". */
export const zshenvPath = (home = os.homedir()) => path.join(home, '.zshenv');

export const shortcutsPath = (studioHome = path.join(os.homedir(), '.agent-config-studio')) =>
  path.join(studioHome, 'shell', 'seats.zsh');

const SOURCE_MARK = '# agent-config-studio: seat shortcuts';

/** Reserved because shadowing these breaks the shell or the tool itself. */
const RESERVED = new Set([
  'codex', 'claude', 'grok', 'cd', 'ls', 'rm', 'mv', 'cp', 'git', 'sudo', 'env',
  'export', 'source', 'exec', 'eval', 'kill', 'set', 'unset', 'alias', 'test',
]);

/**
 * A command word becomes a shell function name and is typed by hand, so it is
 * deliberately narrow: lowercase, starts with a letter, no separators that the
 * shell would interpret. Anything else is refused rather than escaped — there
 * is no legitimate seat word that needs a quote in it.
 */
export function validateWord(word) {
  if (typeof word !== 'string' || word === '') return 'a command word is required';
  if (word.length > 24) return 'a command word must be 24 characters or fewer';
  if (!/^[a-z][a-z0-9-]*$/.test(word)) {
    return 'a command word must be lowercase letters, numbers and dashes, starting with a letter';
  }
  if (RESERVED.has(word)) return `"${word}" is reserved — pick another word`;
  return null;
}

/** Flags are passed to codex verbatim, so they are held to the same standard. */
export function validateFlags(flags) {
  if (flags === undefined || flags === null || flags === '') return null;
  if (typeof flags !== 'string') return 'flags must be a string';
  if (flags.length > 120) return 'flags must be 120 characters or fewer';
  // No quotes, no expansion, no separators: a default-flags box is not a place
  // to smuggle a second command into every shell.
  if (!/^[-a-zA-Z0-9 =._/]*$/.test(flags)) {
    return 'flags may only contain letters, numbers, dashes, dots, slashes, equals and spaces';
  }
  if (/(^|\s)(?!-)\S/.test(flags.trim()) && flags.trim() !== '') {
    if (!flags.trim().split(/\s+/).every((t) => t.startsWith('-') || /^[-a-zA-Z0-9=._/]+$/.test(t))) {
      return 'flags must be command-line flags';
    }
  }
  return null;
}

/** A home must be a real absolute directory. A path that does not exist would
 *  silently produce a shortcut that starts codex against an empty home and
 *  reports "not signed in" — a confusing failure far from its cause. */
export function validateHome(home) {
  if (!home || typeof home !== 'string') return 'a home directory is required';
  if (!path.isAbsolute(home)) return 'a home must be an absolute path';
  if (/[\n\r\0]/.test(home)) return 'a home may not contain newlines';
  let st;
  try { st = fs.statSync(home); } catch { return `no such directory: ${home}`; }
  if (!st.isDirectory()) return `not a directory: ${home}`;
  return null;
}

/** Env var name for a seat word. Words are already [a-z0-9-] only, so this
 *  cannot produce an invalid identifier. */
const varName = (word) => `ACS_SEAT_${word.toUpperCase().replace(/-/g, '_')}`;

/** Single-quote for zsh: the only metacharacter inside '' is ' itself. */
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/**
 * Build the shortcut list from the registry. Only codex seats get a shortcut:
 * they are the only vendor whose account is selected by an environment
 * variable. Claude and Grok hold one credential per machine, so a word that
 * "switched" them would be a lie.
 */
export function shortcutsFromSeats(seats, config = {}) {
  const words = config.words || {};
  const flags = config.flags || {};
  const used = new Set();
  const codex = seats.filter((s) => s.vendor === 'codex' && s.home);
  // Which seat a bare `codex` bills is an explicit choice, never registry
  // order: reordering seats must not silently move a subscription's spend.
  // Falls back to the first seat only when nothing is chosen yet.
  const defaultId = codex.some((s) => s.id === config.defaultId)
    ? config.defaultId : (codex[0] || {}).id;
  return codex.map((seat) => {
    let word = words[seat.id];
    if (!word || validateWord(word)) {
      // Derive a word from the label, then make it unique. A collision that
      // silently overwrote another seat's function would route a subscription
      // to the wrong account.
      let base = String(seat.label || seat.id).toLowerCase()
        .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').split('-')
        .find((p) => p && !RESERVED.has(p)) || seat.id.replace(/[^a-z0-9]/g, '');
      base = base.slice(0, 24) || 'seat';
      word = base;
      let n = 2;
      while (used.has(word)) word = `${base}${n++}`.slice(0, 24);
    }
    used.add(word);
    return {
      id: seat.id, label: seat.label, word, home: seat.home,
      flags: flags[seat.id] || '', isDefault: seat.id === defaultId,
    };
  });
}

/**
 * Render the generated file. Pure: same input, same bytes — so a redeploy that
 * changes nothing rewrites nothing meaningful and the file stays diffable.
 */
export function renderShortcuts(shortcuts, { generatedAt = null } = {}) {
  const lines = [
    '# ─────────────────────────────────────────────────────────────────────────',
    '# GENERATED BY AGENT CONFIG STUDIO — DO NOT EDIT.',
    '# Rewritten in full whenever seats change. Edit your seats in the Studio;',
    '# hand edits here are lost on the next save.',
    generatedAt ? `# generated ${new Date(generatedAt).toISOString()}` : null,
    '#',
    '# Each Codex subscription lives in its own CODEX_HOME, so switching between',
    '# them never re-authenticates: every home keeps its own auth.json and',
    '# refresh token. The seat is fixed when the process starts — quit a running',
    '# session before switching, or it keeps writing under the home it began in.',
    '# ─────────────────────────────────────────────────────────────────────────',
    '',
  ].filter((l) => l !== null);

  for (const s of shortcuts) {
    lines.push(`# ${s.label}`);
    lines.push(`export ${varName(s.word)}=${q(s.home)}`);
  }
  lines.push('');

  // One wrapper around `codex` so a seat word works as `codex <word> ...` too.
  // `command codex` bypasses this function, so there is no recursion.
  // Export CODEX_HOME for the default seat rather than only defaulting inside
  // the function. A shell function cannot reach a child that is not a shell —
  // a Node spawn, a script, an editor's terminal task — and those would
  // otherwise silently fall through to ~/.codex, the one home with writers a
  // seat cannot control. The export makes the choice visible in one place.
  const fallbackSeat = shortcuts.find((s) => s.isDefault) || shortcuts[0];
  if (fallbackSeat) {
    lines.push(`# Bare \`codex\` runs this seat: ${fallbackSeat.label}`);
    lines.push(`export CODEX_HOME="\${CODEX_HOME:-$${varName(fallbackSeat.word)}}"`);
    lines.push('');
  }

  lines.push('codex() {');
  const fallback = fallbackSeat ? `$${varName(fallbackSeat.word)}` : '$HOME/.codex';
  lines.push(`  local home="\${CODEX_HOME:-${fallback}}"`);
  lines.push('  local extra=()');
  lines.push('  case "$1" in');
  for (const s of shortcuts) {
    const extra = s.flags ? `; extra=(${s.flags.trim().split(/\s+/).map(q).join(' ')})` : '';
    lines.push(`    ${s.word}) home=${q(s.home)}${extra}; shift ;;`);
  }
  lines.push('  esac');
  lines.push('  CODEX_HOME="$home" command codex "${extra[@]}" "$@"');
  lines.push('}');
  lines.push('');

  for (const s of shortcuts) {
    lines.push(`${s.word}() { codex ${s.word} "$@"; }`);
    lines.push(`codex-${s.word}() { codex ${s.word} "$@"; }`);
  }
  lines.push('');
  return lines.join('\n');
}

/** Atomic, same as the registry: a crash mid-write must never leave a shell
 *  startup file half-parsed, which would break every new terminal. */
export function writeShortcuts(text, file = shortcutsPath()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, { mode: 0o644 });
  fs.renameSync(tmp, file);
  return file;
}

/** Is the source line present in ~/.zshenv? */
export function isInstalled(zshenv = zshenvPath()) {
  try { return fs.readFileSync(zshenv, 'utf8').includes(SOURCE_MARK); }
  catch { return false; }
}

/**
 * Append the single source line, once. Never rewrites or reorders anything
 * already in the file — this is the only touch ACS makes to a human-owned file.
 */
export function install({ zshenv = zshenvPath(), file = shortcutsPath() } = {}) {
  if (isInstalled(zshenv)) return { installed: true, changed: false, zshenv };
  let existing = '';
  try { existing = fs.readFileSync(zshenv, 'utf8'); } catch { existing = ''; }
  const block = `${existing && !existing.endsWith('\n') ? '\n' : ''}\n${SOURCE_MARK}\n` +
    `# .zshenv, not .zshrc: zsh reads this one for every shell, so the seat\n` +
    `# words work in new tabs, scripts and non-interactive shells alike.\n` +
    `[ -f ${q(file)} ] && source ${q(file)}\n`;
  fs.appendFileSync(zshenv, block, { mode: 0o644 });
  return { installed: true, changed: true, zshenv };
}

/** Remove only the lines this module added, leaving everything else byte-identical. */
export function uninstall({ zshenv = zshenvPath() } = {}) {
  let text;
  try { text = fs.readFileSync(zshenv, 'utf8'); } catch { return { installed: false, changed: false }; }
  if (!text.includes(SOURCE_MARK)) return { installed: false, changed: false };
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === SOURCE_MARK) {
      // Skip the marker, its explanatory comments, and the source line itself.
      i++;
      while (i < lines.length && (lines[i].startsWith('#') || lines[i].startsWith('[ -f '))) i++;
      i--;
      while (out.length && out[out.length - 1].trim() === '') out.pop();
      continue;
    }
    out.push(lines[i]);
  }
  fs.writeFileSync(zshenv, out.join('\n').replace(/\n*$/, '\n'), { mode: 0o644 });
  return { installed: false, changed: true };
}

export const shortcutConfigPath = (studioHome = path.join(os.homedir(), '.agent-config-studio')) =>
  path.join(studioHome, 'shortcuts.json');

/** The user's word/flag choices. Kept separate from seats.json so the registry
 *  stays the record of WHAT is tracked and this stays the record of how it is
 *  typed — removing a seat never has to rewrite preferences it does not own. */
export function readShortcutConfig(file = shortcutConfigPath()) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    // Re-validate on read: a hand-edited file must not become shell.
    const words = {}, flags = {};
    for (const [id, w] of Object.entries(raw.words || {})) if (!validateWord(w)) words[id] = w;
    for (const [id, f] of Object.entries(raw.flags || {})) if (!validateFlags(f)) flags[id] = f;
    const defaultId = typeof raw.defaultId === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(raw.defaultId)
      ? raw.defaultId : null;
    return { words, flags, defaultId };
  } catch { return { words: {}, flags: {}, defaultId: null }; }
}

export function writeShortcutConfig(config, file = shortcutConfigPath()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, ...config }, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  return file;
}

/** Regenerate from the registry. The one call the server route needs. */
export function syncShortcuts({
  file = registryPath(), out = shortcutsPath(), config = {}, generatedAt = Date.now(),
} = {}) {
  const { seats } = loadSeats(file);
  const shortcuts = shortcutsFromSeats(seats, config);
  const problems = [];
  for (const s of shortcuts) {
    const w = validateWord(s.word); if (w) problems.push(`${s.label}: ${w}`);
    const h = validateHome(s.home); if (h) problems.push(`${s.label}: ${h}`);
    const f = validateFlags(s.flags); if (f) problems.push(`${s.label}: ${f}`);
  }
  if (problems.length) return { ok: false, problems, shortcuts };
  writeShortcuts(renderShortcuts(shortcuts, { generatedAt }), out);
  return { ok: true, problems: [], shortcuts, file: out };
}
