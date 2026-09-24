#!/usr/bin/env node
/**
 * install-worktree — put this checkout's worktree toolkit where zsh loads it.
 *
 *   acs install-worktree [--dry-run] [--replace-defaults]
 *
 * Copies tools/worktree/{wt.zsh,defaults.conf} into $WT_HOME (default
 * ~/.config/worktree) and makes sure $ZDOTDIR/.zshrc (default ~/.zshrc)
 * sources wt.zsh. Never touches $WT_HOME/repos — that is the user's registry.
 *
 * A differing file is backed up to ~/.agent-config-studio/backups/<ts>/ first,
 * and a backup that fails stops the install before anything is written. A
 * defaults.conf that differs is the user's customised convention, kept unless
 * --replace-defaults. The .zshrc is only ever appended to, through a link if it
 * is one, so its bytes, mode and link survive; any existing uncommented line
 * that sources wt.zsh counts as installed.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'tools', 'worktree');
const HOME = os.homedir();
const WT_HOME = process.env.WT_HOME || path.join(HOME, '.config', 'worktree');
const ZSHRC = path.join(process.env.ZDOTDIR || HOME, '.zshrc');
const BACKUPS = path.join(HOME, '.agent-config-studio', 'backups');
const MARK_BEGIN = '# >>> agent-config-studio worktree tools >>>';
const MARK_END = '# <<< agent-config-studio worktree tools <<<';

const USAGE = 'usage: acs install-worktree [--dry-run] [--replace-defaults]';
const args = process.argv.slice(2);
const dry = args.includes('--dry-run');
const replaceDefaults = args.includes('--replace-defaults');
if (args.some((a) => a !== '--dry-run' && a !== '--replace-defaults')) {
  console.error(USAGE);
  process.exit(2);
}

const tilde = (p) => (p === HOME || p.startsWith(HOME + path.sep) ? '~' + p.slice(HOME.length) : p);
const read = (p) => { try { return fs.readFileSync(p); } catch { return null; } };
/** Where a write to `p` lands: through a link, so a dotfiles-managed file stays linked. */
const target = (p) => { try { return fs.realpathSync(p); } catch { return p; } };

/** Any uncommented line that sources a wt.zsh — the guarded `[ -f … ] && source …` form included. */
function sourcesToolkit(text) {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    const code = line.replace(/\s#.*$/, '');
    if (/(^|[\s;&|{(])(source|\.)\s+["']?[^"'\s;]*wt\.zsh["']?(\s|;|$|\))/.test(code)) return i + 1;
  }
  return 0;
}

/** $WT_HOME/wt.zsh as the stanza names it: under $HOME when it is, so the line survives a moved home. */
function stanza() {
  const lib = path.join(WT_HOME, 'wt.zsh');
  const shown = lib.startsWith(HOME + path.sep) ? `$HOME${lib.slice(HOME.length)}` : lib;
  return `${MARK_BEGIN}\n[ -f "${shown}" ] && source "${shown}"\n${MARK_END}\n`;
}

const plan = [];   // { name, dest, ours, action, backup }
for (const name of ['wt.zsh', 'defaults.conf']) {
  const ours = fs.readFileSync(path.join(SRC, name));
  const dest = path.join(WT_HOME, name);
  const theirs = read(dest);
  if (theirs === null) plan.push({ name, dest, ours, action: 'install' });
  else if (theirs.equals(ours)) plan.push({ name, dest, action: 'same' });
  else if (name === 'defaults.conf' && !replaceDefaults) plan.push({ name, dest, action: 'keep' });
  else plan.push({ name, dest, ours, action: 'replace', backup: true });
}

const rcText = read(ZSHRC);
const rcLine = rcText === null ? 0 : sourcesToolkit(rcText.toString('utf8'));
const rc = { dest: ZSHRC, action: rcLine ? 'same' : rcText === null ? 'create' : 'append', line: rcLine };

const say = (s) => console.log(s);
const describe = (p) => ({
  install: `${p.name}: ${dry ? 'would install' : 'installed'} → ${tilde(p.dest)}`,
  same: `${p.name}: up to date`,
  keep: `${p.name}: kept yours — it differs from this checkout's (customised?). Replace it with --replace-defaults.`,
  replace: `${p.name}: ${dry ? 'would update' : 'updated'} ${tilde(p.dest)}`,
}[p.action]);

if (dry) say('dry run — nothing is written');

// Backups first, every one of them, before any write: a failed backup must
// leave the user's files exactly as they were.
let backupDir = null;
const needBackup = plan.filter((p) => p.backup);
if (rc.action === 'append') needBackup.push({ name: '.zshrc', dest: ZSHRC });
if (needBackup.length && !dry) {
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, 'Z');
  backupDir = path.join(BACKUPS, `${ts}-worktree`);
  try {
    let n = 0, dir = backupDir;
    while (fs.existsSync(dir)) dir = `${backupDir}-${++n}`;
    backupDir = dir;
    fs.mkdirSync(backupDir, { recursive: true });
    for (const p of needBackup) {
      const out = path.join(backupDir, p.name);
      fs.copyFileSync(target(p.dest), out);
      if (!fs.readFileSync(out).equals(fs.readFileSync(target(p.dest)))) throw new Error(`backup of ${p.name} does not match`);
    }
  } catch (e) {
    console.error(`install-worktree: backup failed (${e.message}) — nothing was changed`);
    process.exit(1);
  }
}

try {
  if (!dry) fs.mkdirSync(WT_HOME, { recursive: true });
  for (const p of plan) {
    if (p.action === 'install' || p.action === 'replace') {
      if (!dry) {
        const dest = target(p.dest);
        const mode = (() => { try { return fs.statSync(dest).mode & 0o777; } catch { return 0o644; } })();
        const tmp = `${dest}.acs-${process.pid}.tmp`;
        fs.writeFileSync(tmp, p.ours, { mode });
        fs.renameSync(tmp, dest);
      }
    }
    say(describe(p) + (p.backup && backupDir ? ` (previous saved to ${tilde(path.join(backupDir, p.name))})` : ''));
  }

  if (rc.action === 'same') {
    say(`${tilde(ZSHRC)}: already sources wt.zsh (line ${rc.line})`);
  } else {
    const dest = target(ZSHRC);
    const pre = rc.action === 'append' && rcText.length && rcText[rcText.length - 1] !== 0x0a ? '\n' : '';
    if (!dry) {
      if (rc.action === 'create') fs.writeFileSync(dest, stanza(), { mode: 0o644, flag: 'wx' });
      else fs.appendFileSync(dest, pre + stanza());
    }
    say(`${tilde(ZSHRC)}: ${dry ? 'would append' : 'appended'} a source line for wt.zsh${backupDir && rc.action === 'append' ? ` (previous saved to ${tilde(path.join(backupDir, '.zshrc'))})` : ''}`);
  }
} catch (e) {
  console.error(`install-worktree: ${e.message}`);
  process.exit(1);
}

if (!dry && (plan.some((p) => p.action === 'install' || p.action === 'replace') || rc.action !== 'same')) {
  say('open a new terminal (or: source ~/.zshrc) to pick it up');
}
