/**
 * The tripwire sees every path `acs install-worktree` could write. Each write
 * is planted in a temp HOME — tests/real-home.mjs reads os.homedir() at import,
 * so a child with HOME set snapshots the fixture and never the real home — and
 * the tripwire has to name it. A tripwire that passes on a planted write would
 * make every installer test below it meaningless, which is why this runs first.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TRIPWIRE = pathToFileURL(path.join(ROOT, 'tests', 'real-home.mjs')).href;

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acs-tripwire-')));
const CHILD = `
  import fs from 'node:fs';
  const { snapshotRealHomes, compareRealHomes } = await import(${JSON.stringify(TRIPWIRE)});
  const [cmd, file] = process.argv.slice(1);
  if (cmd === 'save') fs.writeFileSync(file, JSON.stringify(snapshotRealHomes()));
  else process.stdout.write(JSON.stringify(compareRealHomes(JSON.parse(fs.readFileSync(file, 'utf8')), snapshotRealHomes())));
`;
const run = (home, extraEnv, ...args) => {
  const env = { ...process.env, HOME: home, ...extraEnv };
  if (!extraEnv.ZDOTDIR) delete env.ZDOTDIR;
  return execFileSync(process.execPath, ['--input-type=module', '-e', CHILD, ...args], { env, encoding: 'utf8' });
};

let n = 0;
/** A fresh fixture home, `setup` shapes it, `plant` writes one thing; the report of what the tripwire saw. */
function scenario(setup, plant, extraEnv = {}) {
  const home = path.join(tmp, `h${n++}`);
  const put = (rel, text) => { const p = path.join(home, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); return p; };
  put('.zshrc', 'export A=1\n');
  put('.zshenv', 'export B=1\n');
  put('.config/worktree/wt.zsh', 'wnew() { :; }\n');
  put('.config/worktree/defaults.conf', 'BASE=origin/main\n');
  put('.config/worktree/repos/app.conf', 'CMD=a\nTRUNK="/x"\n');
  fs.mkdirSync(path.join(home, '.agent-config-studio'), { recursive: true });
  const ctx = { home, put, ext: path.join(tmp, `ext${n}`) };
  fs.mkdirSync(ctx.ext, { recursive: true });
  setup?.(ctx);
  const snap = path.join(tmp, `snap${n}.json`);
  run(home, extraEnv, 'save', snap);
  plant?.(ctx);
  const r = JSON.parse(run(home, extraEnv, 'compare', snap));
  return [...r.content, ...r.names].join('; ');
}
const detected = (name, report, needle) => ok(`${name} is detected`, report.includes(needle), report || '(nothing reported)');

console.log('\nworktree/tripwire');

ok('control: an untouched fixture home reports nothing', scenario(null, null) === '');

detected('an append to ~/.zshrc',
  scenario(null, ({ home }) => fs.appendFileSync(path.join(home, '.zshrc'), 'source x\n')), '.zshrc');

detected('a write THROUGH a symlinked ~/.zshrc (to its dotfiles target)',
  scenario(({ home, ext }) => {
    fs.writeFileSync(path.join(ext, 'zshrc'), 'export A=1\n');
    fs.rmSync(path.join(home, '.zshrc'));
    fs.symlinkSync(path.join(ext, 'zshrc'), path.join(home, '.zshrc'));
  }, ({ ext }) => fs.appendFileSync(path.join(ext, 'zshrc'), 'source x\n')), '.zshrc');

detected('re-pointing a symlinked ~/.zshrc at identical bytes',
  scenario(({ home, ext }) => {
    fs.writeFileSync(path.join(ext, 'zshrc'), 'export A=1\n');
    fs.writeFileSync(path.join(ext, 'zshrc2'), 'export A=1\n');
    fs.rmSync(path.join(home, '.zshrc'));
    fs.symlinkSync(path.join(ext, 'zshrc'), path.join(home, '.zshrc'));
  }, ({ home, ext }) => {
    fs.rmSync(path.join(home, '.zshrc'));
    fs.symlinkSync(path.join(ext, 'zshrc2'), path.join(home, '.zshrc'));
  }), '.zshrc');

detected('a write to $ZDOTDIR/.zshrc',
  scenario(({ put }) => put('zdot/.zshrc', 'x\n'),
    ({ home }) => fs.appendFileSync(path.join(home, 'zdot', '.zshrc'), 'source x\n'),
    { ZDOTDIR: path.join(tmp, `h${n}`, 'zdot') }), 'zdot/.zshrc');

detected('an append to ~/.zshenv',
  scenario(null, ({ home }) => fs.appendFileSync(path.join(home, '.zshenv'), 'x\n')), '.zshenv');

detected('a replaced ~/.config/worktree/wt.zsh',
  scenario(null, ({ home }) => fs.writeFileSync(path.join(home, '.config/worktree/wt.zsh'), 'new\n')), '.config/worktree/wt.zsh');

detected('a replaced ~/.config/worktree/defaults.conf',
  scenario(null, ({ home }) => fs.writeFileSync(path.join(home, '.config/worktree/defaults.conf'), 'BASE=x\n')), 'defaults.conf');

detected('a new file in ~/.config/worktree/repos',
  scenario(null, ({ put }) => put('.config/worktree/repos/new.conf', 'CMD=n\n')), 'repos/new.conf');

detected('a write THROUGH a symlinked wt.zsh',
  scenario(({ home, ext }) => {
    fs.writeFileSync(path.join(ext, 'wt.zsh'), 'old\n');
    fs.rmSync(path.join(home, '.config/worktree/wt.zsh'));
    fs.symlinkSync(path.join(ext, 'wt.zsh'), path.join(home, '.config/worktree/wt.zsh'));
  }, ({ ext }) => fs.writeFileSync(path.join(ext, 'wt.zsh'), 'new\n')), 'wt.zsh');

detected('a new file inside a symlinked ~/.config/worktree directory',
  scenario(({ home, ext }) => {
    const wt = path.join(home, '.config/worktree');
    fs.cpSync(wt, path.join(ext, 'worktree'), { recursive: true });
    fs.rmSync(wt, { recursive: true });
    fs.symlinkSync(path.join(ext, 'worktree'), wt);
  }, ({ ext }) => fs.writeFileSync(path.join(ext, 'worktree', 'repos', 'new.conf'), 'CMD=n\n')), 'repos/new.conf');

detected('a backup written under ~/.agent-config-studio/backups',
  scenario(null, ({ put }) => put('.agent-config-studio/backups/20260924T000000/wt.zsh', 'old\n')), '.agent-config-studio/backups');

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
