import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The install, sign-in and next-step commands the setup screen shows, read
 * from builds/setup-screen/commands.md — the one place each is written down
 * with where it was verified. Nothing in the server or the page spells a
 * command itself, so a command can only change where its source is recorded.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const COMMANDS_FILE = path.join(HERE, '..', 'builds', 'setup-screen', 'commands.md');
export const ACS_BIN = path.join(HERE, '..', 'bin', 'acs');

const KEY_RE = /^(install|signin|docs|next)\.[a-z][a-z-]*$/;

/** `{key: {command, source, checked}}` from the table rows. Re-read per call; it is a few hundred bytes. */
export function readCommands(file = COMMANDS_FILE) {
  const out = {};
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return out; }
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

/**
 * The Done step's next steps. `acsOnPath` false means a fresh clone: `acs`
 * is not a command yet, so the checkout's own bin/acs is named instead.
 */
export function nextSteps({ acsOnPath, table = readCommands() }) {
  const bin = /^[\w@%+=:,./-]+$/.test(ACS_BIN) ? ACS_BIN : `'${ACS_BIN.replace(/'/g, `'\\''`)}'`;
  const spell = (c) => (acsOnPath || !c ? c : c.replace(/^acs(?= )/, () => bin));
  return [
    { key: 'next.model-id', command: spell(command('next.model-id', table)), note: 'Lets skills resolve model ids after a worktree is removed.', platforms: null },
    { key: 'next.worktree', command: spell(command('next.worktree', table)), note: 'The worktree helpers (wnew, wls, …).', platforms: 'zsh/macOS only' },
  ].filter((s) => s.command);
}
