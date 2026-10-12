import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The install, sign-in and next-step commands the setup screen shows, read
 * from lib/commands.md — the one place each is written down
 * with where it was verified. Nothing in the server or the page spells a
 * command itself, so a command can only change where its source is recorded.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const COMMANDS_FILE = path.join(HERE, 'commands.md');
export const ACS_BIN = path.join(HERE, '..', 'bin', 'acs');

/**
 * How `acs` is spelled when it is not a command yet, under npm: null for a
 * checkout or a copy (the absolute bin/acs is named instead). npx and bunx
 * put acs on PATH only for their own run, so the runner is named; a global
 * install whose bin dir a new terminal lacks gets the absolute bin/acs too.
 * The same rule as bin/acs: the package sits in a node_modules folder.
 */
export function npmRunner(pkg = path.join(HERE, '..')) {
  if (path.basename(path.dirname(pkg)) !== 'node_modules') return null;
  if (/[\\/]_npx[\\/]/.test(pkg)) return 'npx agent-config-studio';
  if (/[\\/]bunx-/.test(pkg)) return 'bunx agent-config-studio';
  return 'acs';
}

/**
 * Whether the `acs` a new terminal's PATH holds (`located`, from
 * locateBinary) is a real install. Under npx or bunx this package's own
 * bin/acs is on PATH only because the runner put its cache there for this
 * one run, and a login shell keeps that inherited entry.
 */
export function acsInstalled(located, runner = npmRunner()) {
  if (!located.installed) return false;
  if (!runner || runner === 'acs') return true;
  try { return located.binary !== fs.realpathSync(ACS_BIN); } catch { return true; }
}

const KEY_RE = /^(install|signin|docs|next)\.[a-z][a-z-]*$/;

/**
 * `{key: {command, source, checked}}` from the table rows. Re-read per call;
 * it is a few hundred bytes. A missing table throws: without it the setup
 * screen would silently show no commands at all.
 */
export function readCommands(file = COMMANDS_FILE) {
  const out = {};
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    throw new Error(`the setup command table ${file} could not be read (${e.code || e.message}) — this install of Agent Config Studio is incomplete`);
  }
  for (const line of text.split('\n')) {
    if (!line.startsWith('| ')) continue;
    // Split on unescaped pipes only; `\|` is a pipe inside a command.
    const cells = line.slice(1, line.trimEnd().endsWith('|') ? line.trimEnd().length - 1 : undefined)
      .split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
    const [key, command, source, checked] = cells;
    if (!KEY_RE.test(key || '') || !command || !source || !/^\d{4}-\d{2}-\d{2}$/.test(checked || '')) continue;
    out[key] = { command: command.replace(/^`|`$/g, ''), source, checked };
  }
  return out;
}

/** One command's text, or null when the table has no verified entry for it. */
export function command(key, table = readCommands()) {
  return table[key]?.command ?? null;
}

const shellBin = () => (/^[\w@%+=:,./-]+$/.test(ACS_BIN) ? ACS_BIN : `'${ACS_BIN.replace(/'/g, `'\\''`)}'`);

/**
 * The Done step's "put acs on your PATH" row: commands.md's `acs install`,
 * spelled with this checkout's bin/acs, or null once acs is on the login
 * PATH (`acsOnPath` true) — and when the table has no verified entry. Under
 * npm, where `acs install` refuses, it is the global npm install instead.
 */
export function pathStep({ acsOnPath, table = readCommands(), runner = npmRunner() }) {
  if (runner) {
    const n = command('next.npm', table);
    if (acsOnPath === true || !n) return null;
    return { key: 'next.npm', command: n, note: 'Installs acs as a command, so `acs` starts the studio from any terminal.' };
  }
  const c = command('next.path', table);
  if (acsOnPath === true || !c) return null;
  return { key: 'next.path', command: c.replace(/^acs(?= )/, shellBin), note: 'Puts acs on your PATH, so `acs` starts the studio from any terminal. It never edits a shell profile.' };
}

/**
 * The Done step's next steps. `acsOnPath` false means a fresh clone: `acs`
 * is not a command yet, so the checkout's own bin/acs is named instead.
 */
export function nextSteps({ acsOnPath, table = readCommands(), runner = npmRunner() }) {
  const bin = runner && runner !== 'acs' ? runner : shellBin();
  const spell = (c) => (acsOnPath || !c ? c : c.replace(/^acs(?= )/, () => bin));
  return [
    { key: 'next.model-id', command: spell(command('next.model-id', table)), note: 'Lets skills resolve model ids after a worktree is removed.', platforms: null },
    { key: 'next.worktree', command: spell(command('next.worktree', table)), note: 'The worktree helpers (wnew, wls, …).', platforms: 'zsh/macOS only' },
  ].filter((s) => s.command);
}
