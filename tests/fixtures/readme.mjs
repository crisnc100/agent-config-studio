/**
 * The README, parsed the way the README tests read it: fenced blocks, and the
 * Get started section's command lines in order.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const README = path.join(ROOT, 'README.md');

export const readme = (file = README) => fs.readFileSync(file, 'utf8');

/** One section's text, from its `## ` heading to the next. */
export function section(title, text = readme()) {
  const start = text.indexOf(`\n## ${title}\n`);
  if (start === -1) return '';
  const next = text.indexOf('\n## ', start + 4);
  return text.slice(start, next === -1 ? undefined : next);
}

/** Every fenced block: `{lang, lines}`. */
export function blocks(text = readme()) {
  return [...text.matchAll(/^```(\w*)\n([\s\S]*?)^```$/gm)].map((m) => ({ lang: m[1], lines: m[2].split('\n').filter((l) => l.trim()) }));
}

/** Get started's command lines, in order — what a stranger types. */
export const getStartedCommands = (text = readme()) => blocks(section('Get started', text)).flatMap((b) => b.lines);
