/**
 * Criterion 8: the backup of the live skill files is restorable.
 *
 * First the mechanism, end to end in a temp HOME. Then the REAL backup this
 * build took: copied to a temp dir and restored into a temp target, never over
 * the live files. The real ~/.agent-config-studio is only read.
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BACKUP = path.join(ROOT, 'builds', 'model-registry', 'backup.mjs');
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const temps = [];
const tmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); temps.push(d); return d; };

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

function checkRestore(dir, label) {
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  ok(`${label}: manifest lists every file with both checksums`, m.files.length > 0 &&
     m.files.every((e) => /^[0-9a-f]{64}$/.test(e.sha256Before) && /^[0-9a-f]{64}$/.test(e.sha256After ?? '')), `${m.files.length} files`);
  ok(`${label}: every manifest file is in the backup`, m.files.every((e) => fs.existsSync(path.join(dir, 'files', e.path))));
  const copy = tmp('acs-bk-copy-');
  fs.cpSync(dir, copy, { recursive: true });
  const target = tmp('acs-bk-target-');
  const r = spawnSync('/bin/sh', [path.join(copy, 'restore.sh'), target], { encoding: 'utf8' });
  ok(`${label}: restore.sh into a temp target exits 0`, r.status === 0, r.stderr);
  const bad = m.files.filter((e) => sha(path.join(target, e.path)) !== e.sha256Before);
  ok(`${label}: every restored file matches sha256Before`, bad.length === 0, bad.map((e) => e.path).join(', '));
  return m;
}

console.log('\nmodels/backup');

// --- the mechanism, in a temp HOME ------------------------------------------
{
  const home = fs.realpathSync(tmp('acs-bk-home-'));
  const a = path.join(home, '.claude', 'skills', 'x', 'SKILL.md');
  const b = path.join(home, '.claude', 'CLAUDE.md');
  fs.mkdirSync(path.dirname(a), { recursive: true });
  fs.writeFileSync(a, 'before a\n');
  fs.writeFileSync(b, 'before b\n');
  const env = { HOME: home, PATH: '/usr/bin:/bin' };
  const c = spawnSync(process.execPath, [BACKUP, 'create', a, b], { encoding: 'utf8', env });
  const dir = c.stdout.trim();
  ok('create writes under ~/.agent-config-studio/backups/', c.status === 0 && dir.startsWith(path.join(home, '.agent-config-studio', 'backups', 'model-registry-')), c.stderr);
  fs.writeFileSync(a, 'after a\n');
  spawnSync(process.execPath, [BACKUP, 'finalize', dir], { env });
  const m = checkRestore(dir, 'temp HOME');
  ok('temp HOME: sha256After records the edited bytes', m.files.find((e) => e.path.endsWith('SKILL.md')).sha256After === sha(a));
  ok('temp HOME: the live files were not touched by the restore test', fs.readFileSync(a, 'utf8') === 'after a\n');
}

// --- the real backup this build took ---------------------------------------
{
  const base = path.join(os.homedir(), '.agent-config-studio', 'backups');
  const dirs = fs.existsSync(base) ? fs.readdirSync(base).filter((d) => d.startsWith('model-registry-')).sort() : [];
  ok('a real model-registry backup exists', dirs.length > 0, base);
  if (dirs.length) checkRestore(path.join(base, dirs.at(-1)), `real ${dirs.at(-1)}`);
}

for (const t of temps) fs.rmSync(t, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
