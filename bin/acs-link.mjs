#!/usr/bin/env node
/**
 * `acs install` / `acs uninstall` — put this checkout's bin/acs on PATH as a
 * symlink, and take it off again.
 *
 * A link is this checkout's only when it resolves to this checkout's bin/acs;
 * nothing else is ever replaced or removed — not a file, not a dangling or
 * looping link, not another checkout's link. Install refuses when an `acs`
 * earlier on PATH would answer instead. No shell profile is ever edited: when
 * no directory of the user's is on PATH, the line to add is printed.
 *
 * The PATH judged is a new terminal's (lib/login-path.js), because that is
 * where the person will type `acs`; if the login shell does not answer, the
 * PATH this ran with.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loginPathRead, loginShell } from '../lib/login-path.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OURS = fs.realpathSync(path.join(ROOT, 'bin', 'acs'));
const HOME = process.env.HOME || os.homedir();
const tilde = (p) => (p === HOME || p.startsWith(HOME + path.sep) ? '~' + p.slice(HOME.length) : p);
const PREFERRED = [path.join(HOME, '.local', 'bin'), path.join(HOME, 'bin')];

const [cmd, ...rest] = process.argv.slice(2);
if (rest.length || (cmd !== 'install' && cmd !== 'uninstall')) {
  console.error('usage: acs install | acs uninstall');
  process.exit(2);
}

/** What an `acs` entry in a directory is, from this checkout's point of view. */
function inspect(file) {
  let st;
  try { st = fs.lstatSync(file); } catch { return { kind: 'none' }; }
  if (!st.isSymbolicLink()) return { kind: 'file' };
  const target = fs.readlinkSync(file);
  let real;
  try { real = fs.realpathSync(file); } catch (e) {
    return { kind: e.code === 'ELOOP' ? 'loop' : 'dangling', target };
  }
  return { kind: real === OURS ? 'ours' : 'foreign', target, real };
}

function describe(file, s) {
  if (s.kind === 'file') return `${tilde(file)} is a file, not a link`;
  if (s.kind === 'dangling') return `${tilde(file)} is a dangling link (→ ${s.target})`;
  if (s.kind === 'loop') return `${tilde(file)} is a link that loops (→ ${s.target})`;
  return `${tilde(file)} links to ${tilde(s.real)}, not this checkout`;
}

function writable(dir) {
  try { fs.accessSync(dir, fs.constants.W_OK); return fs.statSync(dir).isDirectory(); } catch { return false; }
}

const inHome = (d) => d.startsWith(HOME + path.sep);

const login = await loginPathRead({ home: HOME });
/** PATH as the shell searches it, every entry kept: an empty or relative one means "the current folder". */
const entries = login.fromShell ? login.raw : (process.env.PATH || '').split(path.delimiter);
const pathDirs = [...new Set(entries.filter((d) => path.isAbsolute(d)).map((d) => path.normalize(d)))];

if (cmd === 'uninstall') {
  let removed = 0;
  for (const dir of [...new Set([...PREFERRED, ...pathDirs])]) {
    const file = path.join(dir, 'acs');
    const s = inspect(file);
    if (s.kind === 'ours') {
      fs.unlinkSync(file);
      removed++;
      console.log(`removed ${tilde(file)}`);
    } else if (s.kind !== 'none' && inHome(dir)) {
      console.log(`left alone: ${describe(file, s)}`);
    }
  }
  if (!removed) console.log('not installed: no acs link to this checkout was found.');
  process.exit(0);
}

// install: the first directory of the user's on PATH that can take the link,
// preferring the conventional ones.
const onPath = (d) => pathDirs.includes(d);
const candidates = [...PREFERRED.filter(onPath), ...pathDirs.filter((d) => inHome(d) && !PREFERRED.includes(d))];
const dir = candidates.find(writable) ?? null;
const dest = dir ?? PREFERRED[0];
const file = path.join(dest, 'acs');

// A relative or empty entry before ours is searched in whatever folder the
// person is standing in, so any folder holding an `acs` would answer first.
// Nothing here can rule that out; refuse and say which entry.
const before = dir ? entries.slice(0, entries.findIndex((e) => path.isAbsolute(e) && path.normalize(e) === dir)) : entries;
const relative = before.find((e) => !path.isAbsolute(e));
if (relative !== undefined) {
  console.error(`acs install: refusing — your PATH has ${relative === '' ? 'an empty entry' : `the relative entry "${relative}"`} ahead of ${dir ? tilde(dir) : 'any folder of yours'}, ` +
    'so an `acs` in whatever folder you are in would answer instead of this one. Remove it from PATH (or put it last), then run this again.');
  process.exit(1);
}

// An `acs` earlier on PATH answers before ours would.
const order = dir ? pathDirs.slice(0, pathDirs.indexOf(dir)) : pathDirs;
for (const d of order) {
  const s = inspect(path.join(d, 'acs'));
  if (s.kind === 'none' || s.kind === 'ours') continue;
  console.error(`acs install: refusing — ${describe(path.join(d, 'acs'), s)}, and it comes first on PATH, so it would answer instead.\n` +
    'Remove it (or run that checkout\'s `acs uninstall`), then run this again.');
  process.exit(1);
}

const existing = inspect(file);
if (existing.kind === 'ours') {
  console.log(`already installed: ${tilde(file)} → ${OURS}`);
} else if (existing.kind !== 'none') {
  console.error(`acs install: refusing — ${describe(file, existing)}. Not replacing it.`);
  process.exit(1);
} else {
  fs.mkdirSync(dest, { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.symlinkSync(OURS, tmp);
  fs.renameSync(tmp, file);
  console.log(`linked ${tilde(file)} → ${OURS}`);
}

if (dir) {
  console.log('Open a new terminal (or run `hash -r` in this one), then run: acs');
} else {
  const shell = path.basename(loginShell());
  const profile = shell === 'zsh' ? '~/.zshrc' : shell === 'bash' ? (process.platform === 'darwin' ? '~/.bash_profile' : '~/.bashrc') : '~/.profile';
  console.log(`\n${tilde(dest)} is not on your PATH yet. Add this line to ${profile} (acs does not edit it for you):\n\n` +
    `  export PATH="$HOME/${path.relative(HOME, dest)}:$PATH"\n\nthen open a new terminal and run: acs`);
}
