#!/usr/bin/env node
/**
 * Backup for the live, out-of-repo files this build rewrites.
 *
 *   node backup.mjs create <file...>   → prints the backup dir
 *   node backup.mjs finalize <dir>     → fills sha256After from the live files
 *   node backup.mjs drop <dir> <rel>   → forget a file the build ended up not editing, so a
 *                                        restore can never clobber someone else's later edit
 *
 * Layout: ~/.agent-config-studio/backups/model-registry-<ts>/
 *   files/<path relative to HOME>   the bytes as they were
 *   manifest.json                   [{ path, sha256Before, sha256After }]
 *   restore.sh [TARGET_HOME]        copies every file back and checks it against sha256Before
 *
 * restore.sh is generated with each path and checksum written out literally,
 * so restoring needs nothing but /bin/sh, cp and shasum.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = process.env.HOME || os.homedir();
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const q = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

function create(files) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(HOME, '.agent-config-studio', 'backups', `model-registry-${ts}`);
  const entries = [];
  for (const f of files) {
    const abs = path.resolve(f);
    const rel = path.relative(HOME, abs);
    if (rel.startsWith('..')) throw new Error(`${abs} is outside HOME`);
    const dest = path.join(dir, 'files', rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(abs, dest);
    entries.push({ path: rel, sha256Before: sha(abs), sha256After: null });
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ created: new Date().toISOString(), home: HOME, files: entries }, null, 2) + '\n');
  const lines = [
    '#!/bin/sh',
    '# Restore every file this backup holds, then prove each one matches its sha256Before.',
    '#   ./restore.sh              restores into $HOME',
    '#   ./restore.sh /some/dir    restores into a copy (what the test does)',
    'set -eu',
    'HERE=$(cd "$(dirname "$0")" && pwd)',
    'TARGET=${1:-$HOME}',
    'bad=0',
    'put() {',
    '  mkdir -p "$(dirname "$TARGET/$1")"',
    '  cp "$HERE/files/$1" "$TARGET/$1"',
    '  got=$(shasum -a 256 "$TARGET/$1" | cut -d" " -f1)',
    '  if [ "$got" = "$2" ]; then echo "restored $1"; else echo "MISMATCH $1" >&2; bad=1; fi',
    '}',
    ...entries.map((e) => `put ${q(e.path)} ${e.sha256Before}`),
    'exit $bad',
    '',
  ];
  fs.writeFileSync(path.join(dir, 'restore.sh'), lines.join('\n'), { mode: 0o755 });
  return dir;
}

function finalize(dir) {
  const mf = path.join(dir, 'manifest.json');
  const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
  for (const e of m.files) e.sha256After = sha(path.join(m.home, e.path));
  fs.writeFileSync(mf, JSON.stringify(m, null, 2) + '\n');
  return m;
}

function drop(dir, rel) {
  const mf = path.join(dir, 'manifest.json');
  const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
  const before = m.files.length;
  m.files = m.files.filter((e) => e.path !== rel);
  if (m.files.length === before) throw new Error(`${rel} is not in ${mf}`);
  fs.writeFileSync(mf, JSON.stringify(m, null, 2) + '\n');
  fs.rmSync(path.join(dir, 'files', rel));
  const rs = path.join(dir, 'restore.sh');
  fs.writeFileSync(rs, fs.readFileSync(rs, 'utf8').split('\n').filter((l) => !l.startsWith(`put ${q(rel)} `)).join('\n'), { mode: 0o755 });
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'create') console.log(create(rest));
else if (cmd === 'finalize') {
  const m = finalize(rest[0]);
  console.log(`${m.files.length} files; ${m.files.filter((e) => e.sha256After !== e.sha256Before).length} changed`);
} else if (cmd === 'drop') {
  drop(rest[0], rest[1]);
  console.log(`dropped ${rest[1]}`);
} else {
  console.error('usage: backup.mjs create <file...> | finalize <dir> | drop <dir> <rel>');
  process.exit(2);
}
