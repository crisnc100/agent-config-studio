import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  CLAUDE_HOME, CODEX_HOME, CURSOR_HOME, GROK_HOME, HOME, STUDIO_HOME,
  assertWritable, currentRoots, resolveSafe,
} from './paths.js';
import { withStateLock } from './packs-files.js';
import { bad } from './proposals.js';

export const HARNESSES = Object.freeze({
  claude: { key: 'claude', label: 'Claude', home: CLAUDE_HOME, file: 'CLAUDE.md', delivery: 'file', note: '' },
  codex: {
    key: 'codex', label: 'Codex', home: CODEX_HOME, file: 'AGENTS.md', delivery: 'file',
    note: '## In Codex\n\nRead this file as your global instructions. Follow the repository’s instructions when working in a project.\n',
  },
  grok: {
    key: 'grok', label: 'Grok', home: GROK_HOME, file: 'AGENTS.md', delivery: 'file',
    note: '## In Grok\n\nRead this file as your global instructions. Use project instructions for repository-specific commands and checks.\n',
  },
  cursor: {
    key: 'cursor', label: 'Cursor', home: CURSOR_HOME, file: 'acs-note.md', delivery: 'via-claude',
    note: new URL('../packs/cursor/session/cursor-note.md', import.meta.url),
  },
});

const registryFile = path.join(STUDIO_HOME, 'harnesses.json');
const registryLimit = 1024 * 1024;
export const instructionPath = (entry) => path.join(entry.home, entry.file);

export function resolveInstruction(entry) {
  if (!entry.custom && entry.delivery === 'file') return resolveSafe(instructionPath(entry));
  const roots = currentRoots().safeRoots;
  const home = resolveSafe(entry.home, roots);
  if (entry.custom && !roots.includes(home)) throw bad(403, 'Choose a built-in CLI folder or a project folder registered for editing.');
  const real = resolveSafe(instructionPath(entry), roots);
  if (entry.delivery === 'via-claude' && real !== path.join(home, entry.file)) {
    throw bad(403, 'The local session note must be a regular file in its home folder.');
  }
  if (!real.startsWith(home + path.sep)) throw bad(403, 'The instruction file resolves outside its home folder.');
  return real;
}

const keyOf = (label) => label.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}\p{M}]+/gu, '-').replace(/^-|-$/g, '');
const cleanText = (v) => typeof v === 'string' && v === v.trim() && v !== '' && !/[\p{Cc}\p{Cf}]/u.test(v);
const stateError = (reason) => ({ raw: [], entries: [], warnings: [reason], error: reason });

function validate(entry, existing) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)
    || Object.keys(entry).some((key) => !['key', 'label', 'home', 'file'].includes(key))) {
    throw bad(400, 'Use a label, a home folder and an instruction file name.');
  }
  const { key, label, home, file } = entry;
  if (!cleanText(label) || label.length > 60 || !/[\p{L}\p{N}]/u.test(label) || key !== keyOf(label)) {
    throw bad(400, 'Use a label of up to 60 characters with at least one letter or digit.');
  }
  if (Object.hasOwn(HARNESSES, key)) throw bad(409, 'That label is reserved for a built-in CLI.');
  if (existing.some((e) => e.key === key)) throw bad(409, 'That label is already in the list.');
  if (!cleanText(home) || !path.isAbsolute(home) || home.split(path.sep).includes('..')) {
    throw bad(400, 'Use an absolute home folder path or start it with ~/.');
  }
  if (!cleanText(file) || file === '.' || file.includes('..') || /[/\\]/.test(file)) {
    throw bad(400, 'Use a plain instruction file name without slashes or two dots in a row.');
  }
  let stat;
  try { stat = fs.statSync(home); } catch {}
  if (!stat?.isDirectory()) throw bad(400, 'The home must be an existing folder.');
  const target = {
    key, label, home, file, custom: true, delivery: 'file',
    note: '## In this CLI\n\nFollow the project’s instructions when working in a repository.\n',
  };
  const real = resolveInstruction(target);
  assertWritable(real);
  if ([...Object.values(HARNESSES), ...existing].some((other) => {
    if (instructionPath(other) === instructionPath(target)) return true;
    try { return resolveInstruction(other) === real; } catch { return false; }
  })) throw bad(409, 'That instruction file is already in the list.');
  return target;
}

export function loadHarnesses() {
  let doc;
  try {
    const fd = fs.openSync(registryFile, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile() || st.nlink !== 1 || st.size > registryLimit) return stateError('The CLI list must be a regular file under 1 MB with no other links.');
      doc = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(fd)));
    } finally { fs.closeSync(fd); }
  } catch (e) {
    if (e.code === 'ENOENT') return { raw: [], entries: [], warnings: [] };
    if (e instanceof SyntaxError || e instanceof TypeError) return stateError('The CLI list contains invalid JSON.');
    return stateError('The CLI list could not be read. Check that it is a regular file and that ACS has access.');
  }
  if (doc?.version !== 1 || !Array.isArray(doc.harnesses)) return stateError('The CLI list has an unknown format.');
  const entries = [];
  const warnings = [];
  for (const [i, entry] of doc.harnesses.entries()) {
    try { entries.push(validate(entry, entries)); }
    catch (e) { warnings.push(`CLI entry ${i + 1} was ignored. ${e.message}`); }
  }
  return { raw: doc.harnesses, entries, warnings };
}

function save(entries) {
  const bytes = JSON.stringify({ version: 1, harnesses: entries }, null, 2) + '\n';
  if (Buffer.byteLength(bytes) > registryLimit) throw bad(413, 'The CLI list would exceed 1 MB.');
  fs.mkdirSync(STUDIO_HOME, { recursive: true });
  const tmp = `${registryFile}.tmp-${crypto.randomBytes(8).toString('hex')}`;
  try {
    fs.writeFileSync(tmp, bytes, { flag: 'wx', mode: 0o600 });
    fs.renameSync(tmp, registryFile);
  }
  finally { fs.rmSync(tmp, { force: true }); }
}

function changeRegistry(change) {
  return withStateLock(registryFile, () => {
    const state = loadHarnesses();
    if (state.error) throw bad(409, state.error);
    return change(state);
  });
}

export function addHarness(input) {
  const label = typeof input.label === 'string' ? input.label.trim() : '';
  const home = typeof input.home === 'string' ? input.home.trim() : '';
  const file = typeof input.file === 'string' ? input.file.trim() : '';
  const entry = { key: keyOf(label), label, home: home.startsWith('~/') ? HOME + home.slice(1) : home, file };
  return changeRegistry(({ raw, entries }) => {
    validate(entry, entries);
    if (raw.some((e) => e?.key === entry.key)) throw bad(409, 'That label is already in the list.');
    save([...raw, entry]);
    return { key: entry.key };
  });
}

export function removeHarness(key) {
  return changeRegistry(({ raw, entries }) => {
    if (!entries.some((entry) => entry.key === key)) throw bad(404, 'That CLI is not in the list of added CLIs.');
    save(raw.filter((entry) => entry?.key !== key));
    return { removed: key };
  });
}
