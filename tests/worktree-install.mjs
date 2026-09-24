/**
 * `./bin/acs install-worktree` (criterion 1), run through bin/acs itself
 * against a temp HOME with WT_HOME and ZDOTDIR inside it. Nothing here reads
 * or writes the real ~/.zshrc; the one real-home READ is the byte comparison
 * of the toolkit's first commit against the live ~/.config/worktree/wt.zsh.
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { ROOT, TOOLKIT, ZSH, tests } from './worktree-sandbox.mjs';

const { ok, done } = tests();
const ACS = path.join(ROOT, 'bin', 'acs');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acs-wt-install-')));
const OURS = { 'wt.zsh': fs.readFileSync(path.join(TOOLKIT, 'wt.zsh')), 'defaults.conf': fs.readFileSync(path.join(TOOLKIT, 'defaults.conf')) };
const LIVE_LINE = '[ -f "$HOME/.config/worktree/wt.zsh" ] && source "$HOME/.config/worktree/wt.zsh"';

let n = 0;
function home({ zdot = false } = {}) {
  const h = path.join(tmp, `h${n++}`);
  fs.mkdirSync(h, { recursive: true });
  const env = {
    PATH: process.env.PATH, HOME: h, WT_HOME: path.join(h, '.config', 'worktree'),
    ZDOTDIR: zdot ? path.join(h, 'zdot') : h, TMPDIR: os.tmpdir(), ACS_PORT: String(40000 + Math.floor(Math.random() * 20000)),
  };
  if (zdot) fs.mkdirSync(env.ZDOTDIR, { recursive: true });
  const install = (...args) => {
    const r = spawnSync('/bin/sh', [ACS, 'install-worktree', ...args], { env, encoding: 'utf8', timeout: 30000 });
    return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
  };
  return { h, env, install, rc: path.join(env.ZDOTDIR, '.zshrc'), wt: env.WT_HOME };
}
/** Every path under `dir` with its bytes (or link target) and mode — for "nothing changed". */
function tree(dir) {
  const out = {};
  const walk = (p) => {
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) out[p] = `link:${fs.readlinkSync(p)}`;
    else if (st.isDirectory()) { out[p] = `dir:${st.mode & 0o777}`; for (const e of fs.readdirSync(p)) walk(path.join(p, e)); }
    else out[p] = `${st.mode & 0o777}:${crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}`;
  };
  walk(dir);
  return JSON.stringify(out);
}
const backups = (h) => {
  const dir = path.join(h, '.agent-config-studio', 'backups');
  try { return fs.readdirSync(dir).map((d) => path.join(dir, d)); } catch { return []; }
};
const read = (p) => fs.readFileSync(p, 'utf8');

console.log('\nworktree/install');

{
  const t = home();
  const r = t.install();
  ok('1 fresh install: exit 0', r.code === 0, r.out);
  ok('1 fresh install: wt.zsh and defaults.conf are this checkout\'s bytes',
     fs.readFileSync(path.join(t.wt, 'wt.zsh')).equals(OURS['wt.zsh']) && fs.readFileSync(path.join(t.wt, 'defaults.conf')).equals(OURS['defaults.conf']));
  ok('1 fresh install: a .zshrc is created holding only the marked stanza', /^# >>> agent-config-studio worktree tools >>>\n.*wt\.zsh.*\n# <<< agent-config-studio worktree tools <<<\n$/.test(read(t.rc)), read(t.rc));
  if (ZSH) {
    const z = spawnSync(ZSH, ['-f', '-c', `source ${JSON.stringify(t.rc)}; whence -w wnew wclean wenv`], { env: t.env, encoding: 'utf8' });
    ok('1 fresh install: a shell sourcing that .zshrc has wnew, wclean, wenv', z.stdout.includes('wnew: function') && z.stdout.includes('wclean: function'), z.stdout + z.stderr);
  }
  const before = tree(t.h);
  const again = t.install();
  ok('1 a second run is a no-op: same bytes, modes and entries, no backup', again.code === 0 && tree(t.h) === before && backups(t.h).length === 0 &&
     again.out.includes('wt.zsh: up to date') && again.out.includes('already sources wt.zsh'), again.out);
}

{
  const t = home();
  const text = `export PATH="$HOME/bin:$PATH"\n${LIVE_LINE}\nalias k=kubectl\n`;
  fs.writeFileSync(t.rc, text);
  const r = t.install();
  ok('1 the live guarded source line is recognised: .zshrc untouched', r.code === 0 && read(t.rc) === text && r.out.includes('already sources wt.zsh (line 2)'), r.out);
}
{
  const t = home();
  for (const form of ['source ~/.config/worktree/wt.zsh', '. "$WT_HOME/wt.zsh"', 'if true; then source /opt/wt/wt.zsh; fi']) {
    fs.writeFileSync(t.rc, `${form}\n`);
    const r = t.install();
    ok(`1 other active forms count too: ${form}`, read(t.rc) === `${form}\n`, r.out);
  }
}
{
  const t = home();
  const text = '# source ~/.config/worktree/wt.zsh\n  #[ -f x/wt.zsh ] && source x/wt.zsh\nexport A=1\n';
  fs.writeFileSync(t.rc, text);
  const r = t.install();
  ok('1 a commented-out source line is NOT recognised: the stanza is appended after the original bytes',
     read(t.rc).startsWith(text) && read(t.rc).slice(text.length).startsWith('# >>> agent-config-studio worktree tools >>>'), r.out);
  ok('1 …and the previous .zshrc is backed up first', backups(t.h).length === 1 &&
     read(path.join(backups(t.h)[0], '.zshrc')) === text);
}
{
  const t = home();
  const dot = path.join(t.h, 'dotfiles');
  fs.mkdirSync(dot);
  fs.writeFileSync(path.join(dot, 'zshrc'), 'export A=1');   // no final newline
  fs.chmodSync(path.join(dot, 'zshrc'), 0o600);
  fs.symlinkSync(path.join(dot, 'zshrc'), t.rc);
  const r = t.install();
  ok('1 a symlinked .zshrc stays a link to the same target', r.code === 0 && fs.lstatSync(t.rc).isSymbolicLink() && fs.readlinkSync(t.rc) === path.join(dot, 'zshrc'), r.out);
  const after = read(path.join(dot, 'zshrc'));
  ok('1 …its target is what gained the stanza, after the original bytes', after.startsWith('export A=1\n# >>> agent-config-studio'), JSON.stringify(after.slice(0, 40)));
  ok('1 a missing final newline is added before the stanza, nothing else changes', after.split('\n')[0] === 'export A=1' && after.endsWith('<<<\n'));
  ok('1 the file mode is preserved (0600)', (fs.statSync(path.join(dot, 'zshrc')).mode & 0o777) === 0o600);
}
{
  const t = home({ zdot: true });
  const r = t.install();
  ok('1 $ZDOTDIR/.zshrc is the file used when ZDOTDIR is set', r.code === 0 && fs.existsSync(t.rc) && !fs.existsSync(path.join(t.h, '.zshrc')), r.out);
}
{
  const t = home();
  fs.mkdirSync(path.join(t.wt, 'repos'), { recursive: true });
  fs.writeFileSync(path.join(t.wt, 'repos', 'kylie.conf'), 'CMD=k\nTRUNK="/x/kylie-trunk"\n');
  fs.writeFileSync(path.join(t.wt, 'repos', 'other.txt'), 'keep\n');
  const reposBefore = tree(path.join(t.wt, 'repos'));
  fs.writeFileSync(path.join(t.wt, 'wt.zsh'), '# an older toolkit\n');
  fs.chmodSync(path.join(t.wt, 'wt.zsh'), 0o640);
  const r = t.install();
  ok('1 repos/ is untouched', tree(path.join(t.wt, 'repos')) === reposBefore);
  ok('1 a differing wt.zsh is replaced with ours, keeping its mode', fs.readFileSync(path.join(t.wt, 'wt.zsh')).equals(OURS['wt.zsh']) &&
     (fs.statSync(path.join(t.wt, 'wt.zsh')).mode & 0o777) === 0o640, r.out);
  ok('1 …after being backed up to ~/.agent-config-studio/backups/<ts>/', backups(t.h).length === 1 &&
     read(path.join(backups(t.h)[0], 'wt.zsh')) === '# an older toolkit\n' && r.out.includes('previous saved to ~/.agent-config-studio/backups/'), r.out);
}
{
  const t = home();
  fs.mkdirSync(t.wt, { recursive: true });
  fs.writeFileSync(path.join(t.wt, 'wt.zsh'), '# an older toolkit\n');
  fs.writeFileSync(t.rc, 'export A=1\n');
  fs.writeFileSync(path.join(t.h, '.agent-config-studio'), 'a file where the backups directory would go\n');
  const before = tree(t.h);
  const r = t.install();
  ok('1 a failed backup aborts: non-zero exit, nothing changed', r.code !== 0 && tree(t.h) === before && r.out.includes('backup failed'), r.out);
}
{
  const t = home();
  fs.mkdirSync(t.wt, { recursive: true });
  const mine = OURS['defaults.conf'].toString().replace('ROOT={parent}', 'ROOT={parent}/{key}-wt');
  fs.writeFileSync(path.join(t.wt, 'defaults.conf'), mine);
  let r = t.install();
  ok('1 a customised defaults.conf is kept without --replace-defaults', read(path.join(t.wt, 'defaults.conf')) === mine &&
     r.out.includes('defaults.conf: kept yours'), r.out);
  r = t.install('--replace-defaults');
  ok('1 --replace-defaults replaces it, after a backup', fs.readFileSync(path.join(t.wt, 'defaults.conf')).equals(OURS['defaults.conf']) &&
     backups(t.h).some((b) => fs.existsSync(path.join(b, 'defaults.conf')) && read(path.join(b, 'defaults.conf')) === mine), r.out);
}
{
  const t = home();
  fs.mkdirSync(t.wt, { recursive: true });
  fs.writeFileSync(path.join(t.wt, 'wt.zsh'), '# old\n');
  fs.writeFileSync(path.join(t.wt, 'defaults.conf'), '# mine\n');
  fs.writeFileSync(t.rc, 'export A=1');
  const before = tree(t.h);
  const r = t.install('--dry-run', '--replace-defaults');
  ok('1 --dry-run writes nothing (not even a backup), and says what it would do', r.code === 0 && tree(t.h) === before &&
     r.out.includes('would update') && r.out.includes('would append'), r.out);
  const fresh = home();
  const r2 = fresh.install('--dry-run');
  ok('1 --dry-run on a fresh home creates nothing at all', r2.code === 0 && fs.readdirSync(fresh.h).length === 0, fs.readdirSync(fresh.h).join(' '));
}
{
  const t = home();
  const listening = (port) => new Promise((res) => {
    const s = net.connect(Number(port), '127.0.0.1');
    s.on('connect', () => { s.destroy(); res(true); });
    s.on('error', () => res(false));
  });
  const r = t.install();
  const bad = t.install('--bogus');
  ok('1 install-worktree never starts the server', r.code === 0 && !r.out.includes('starting Agent Config Studio') &&
     !(await listening(t.env.ACS_PORT)), r.out);
  ok('1 an unknown flag is refused, and still no server', bad.code === 2 && !bad.out.includes('starting') && !(await listening(t.env.ACS_PORT)), bad.out);
}

// The first commit of tools/worktree/wt.zsh is the live file, byte for byte.
{
  const git = (...a) => spawnSync('git', ['-C', ROOT, ...a], { encoding: 'buffer' });
  const first = git('log', '--diff-filter=A', '--format=%H', '--', 'tools/worktree/wt.zsh').stdout?.toString().trim().split('\n').pop();
  const live = path.join(os.homedir(), '.config', 'worktree');
  if (!first) {
    console.log('  SKIP 1 first-commit identity — no git history here; NOT checked');
  } else if (!fs.existsSync(path.join(live, 'wt.zsh'))) {
    console.log('  SKIP 1 first-commit identity — no live ~/.config/worktree/wt.zsh on this machine; NOT checked');
  } else if (fs.readFileSync(path.join(live, 'wt.zsh')).equals(OURS['wt.zsh'])) {
    console.log('  SKIP 1 first-commit identity — the live toolkit is already this checkout\'s (installed); NOT re-checked');
  } else {
    for (const f of ['wt.zsh', 'defaults.conf']) {
      const committed = git('show', `${first}:tools/worktree/${f}`).stdout;
      ok(`1 the first commit's tools/worktree/${f} is byte-identical to the live ~/.config/worktree/${f}`,
         Buffer.isBuffer(committed) && committed.equals(fs.readFileSync(path.join(live, f))));
    }
  }
}

fs.rmSync(tmp, { recursive: true, force: true });
done();
