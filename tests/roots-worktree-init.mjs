/**
 * B4, both sides, with the real worktree toolkit installed in a sandbox HOME
 * (tests/worktree-sandbox.mjs): POST /api/worktree/init on a project in a
 * READ root is refused with the terminal command and writes nothing there —
 * no .worktrees.conf, no trunk, no registration — while the same request on a
 * project in an EDIT root runs `wtinit` as it always has. Destinations are
 * judged where they really are: a trunk or root through a link into the read
 * root, and the ones the toolkit's template would pick when none is given.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, tests, requireZsh, ROOT, ZSH } from './worktree-sandbox.mjs';
import { startServer } from './fixtures/roots-home.mjs';

requireZsh('roots/worktree init');
const { ok, done } = tests();
const sb = sandbox('roots-init');

const repo = (dir) => {
  fs.mkdirSync(dir, { recursive: true });
  sb.git(dir, 'init', '-q');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  sb.git(dir, 'add', '.');
  sb.git(dir, 'commit', '-q', '-m', 'a');
  return dir;
};
const work = path.join(sb.home, 'code', 'work');
const client = path.join(sb.home, 'clients');
const editApp = repo(path.join(work, 'app'));
const readApp = repo(path.join(client, 'capp'));
fs.mkdirSync(path.join(sb.home, '.agent-config-studio'), { recursive: true });
fs.writeFileSync(path.join(sb.home, '.agent-config-studio', 'roots.json'), JSON.stringify({ version: 1, roots: [
  { id: 'work', path: work, label: 'Work', access: 'edit' },
  { id: 'clients', path: client, label: 'Clients', access: 'read' },
] }));
const reposDir = path.join(sb.env.WT_HOME, 'repos');
const listing = (d) => { try { return fs.readdirSync(d).sort(); } catch { return []; } };

console.log('\nroots/worktree init');
const srv = await startServer(sb.home, { root: ROOT, env: sb.env });
ok('the server starts on a sandbox HOME with the toolkit installed', srv.up, srv.log().slice(-400));

const clientBefore = listing(client);
const capBefore = listing(readApp);
const r = await srv.call('/api/worktree/init', { method: 'POST', body: { repoPath: readApp, key: 'capp', cmd: 'ca' } });
ok('B4 a project in a read root: 403, naming the wtinit command to run instead',
   r.status === 403 && /read-only folder/.test(r.json?.error) && /cd .*capp.* && wtinit --key capp/.test(r.json?.error), r.text);
ok('B4 …and nothing was written there: no .worktrees.conf, no trunk beside it',
   !fs.existsSync(path.join(readApp, '.worktrees.conf')) && !fs.existsSync(path.join(client, 'capp-trunk'))
   && JSON.stringify(listing(client)) === JSON.stringify(clientBefore) && JSON.stringify(listing(readApp)) === JSON.stringify(capBefore),
   JSON.stringify(listing(client)));
ok('B4 …and no registration', !listing(reposDir).some((f) => f.startsWith('capp')), JSON.stringify(listing(reposDir)));
// The command it suggests must run as printed: an absolute path, quoted, from anywhere.
{
  const cmd = (r.json?.error || '').split('run in a terminal: ')[1] || '';
  const cdOnly = cmd.replace(/ && wtinit .*$/, ' && pwd -P');
  const elsewhere = fs.mkdtempSync(path.join(sb.root, 'cwd-'));
  const run = spawnSync(ZSH, ['-f', '-c', cdOnly], { cwd: elsewhere, env: sb.env, encoding: 'utf8' });
  ok('B4 the suggested command is absolute and shell-quoted, and its cd works from another folder under zsh -f',
     !cmd.includes('~') && /^cd '/.test(cmd) && run.status === 0 && run.stdout.trim() === fs.realpathSync(readApp), `${cmd} → ${run.status} ${run.stdout}${run.stderr}`);
}

const r2 = await srv.call('/api/worktree/init', { method: 'POST', body: { repoPath: editApp, key: 'app', trunk: path.join(client, 'app-trunk') } });
ok('B4 an edit-root project asking for its trunk inside a read root: 403, nothing written',
   r2.status === 403 && !fs.existsSync(path.join(client, 'app-trunk')) && !listing(reposDir).some((f) => f.startsWith('app')), r2.text);

// An alias: a link elsewhere that points INTO the read root. The trunk does
// not exist yet, so it is judged by its nearest existing ancestor's realpath.
const alias = path.join(sb.root, 'alias');
fs.symlinkSync(client, alias);
const r4 = await srv.call('/api/worktree/init', { method: 'POST', body: { repoPath: editApp, key: 'app', trunk: path.join(alias, 'new-trunk') } });
ok('B4 a trunk given through an alias of the read root (/alias/new-trunk): 403, nothing written',
   r4.status === 403 && /read-only folder/.test(r4.json?.error) && !fs.existsSync(path.join(client, 'new-trunk'))
   && JSON.stringify(listing(client)) === JSON.stringify(clientBefore), r4.text);
const r5 = await srv.call('/api/worktree/init', { method: 'POST', body: { repoPath: editApp, key: 'app', root: path.join(alias, 'wts') } });
ok('B4 …and a worktrees root given the same way', r5.status === 403 && !fs.existsSync(path.join(client, 'wts')), r5.text);

// The implicit destination: no trunk or root in the request, but the
// toolkit's template would put them in the read root — directly, or through
// the alias. The server computes them by the toolkit's own rule first.
const tmpl = path.join(sb.env.WT_HOME, 'defaults.conf');
const tmplText = fs.readFileSync(tmpl, 'utf8');
for (const [how, base] of [['directly', client], ['through the alias', alias]]) {
  fs.writeFileSync(tmpl, tmplText.replace(/^TRUNK=.*$/m, `TRUNK=${base}/{key}-trunk`));
  const r6 = await srv.call('/api/worktree/init', { method: 'POST', body: { repoPath: editApp, key: 'app' } });
  ok(`B4 an implicit trunk the template puts in the read root (${how}): 403, nothing written`,
     r6.status === 403 && /read-only folder/.test(r6.json?.error) && !fs.existsSync(path.join(client, 'app-trunk'))
     && JSON.stringify(listing(client)) === JSON.stringify(clientBefore) && !listing(reposDir).some((f) => f.startsWith('app')), r6.text);
}
fs.writeFileSync(tmpl, tmplText);

// A leaf file wtinit writes through: an allowed trunk whose .worktrees.conf is
// a DANGLING link into the read root (the toolkit would create the target),
// and a repos/<key>.conf linked the same way.
{
  const preTrunk = path.join(work, 'pre-trunk');
  fs.mkdirSync(preTrunk, { recursive: true });
  fs.symlinkSync(path.join(client, 'new.conf'), path.join(preTrunk, '.worktrees.conf'));
  const r7 = await srv.call('/api/worktree/init', { method: 'POST', body: { repoPath: editApp, key: 'app', trunk: preTrunk } });
  ok('B4 an allowed trunk whose .worktrees.conf dangles into the read root: 403, and the target is never created',
     r7.status === 403 && /read-only folder/.test(r7.json?.error) && !fs.existsSync(path.join(client, 'new.conf'))
     && JSON.stringify(listing(client)) === JSON.stringify(clientBefore), r7.text);
  fs.rmSync(preTrunk, { recursive: true });
  fs.mkdirSync(reposDir, { recursive: true });
  fs.symlinkSync(path.join(client, 'reg.conf'), path.join(reposDir, 'app2.conf'));
  const r8 = await srv.call('/api/worktree/init', { method: 'POST', body: { repoPath: editApp, key: 'app2' } });
  ok('B4 …and a repos/<key>.conf linked into the read root: 403, target never created',
     r8.status === 403 && !fs.existsSync(path.join(client, 'reg.conf')) && !fs.existsSync(path.join(work, 'app2-trunk')), r8.text);
  fs.unlinkSync(path.join(reposDir, 'app2.conf'));
}

// One test per write site wtinit can make (lib/worktree.js writeSites), each
// linked into the read root in a fresh edit-root repo: 403, and nothing in
// the read root changes. The `..` case resolves the way the kernel would.
{
  const jump = path.join(work, 'jump');
  fs.mkdirSync(path.join(client, 'sub'), { recursive: true });
  fs.symlinkSync(path.join(client, 'sub'), jump);
  const clientNow = () => JSON.stringify([listing(client), listing(path.join(client, 'sub'))]);
  const site = async (label, key, arrange, body = {}) => {
    const app = repo(path.join(work, key));
    const extra = arrange(app) || {};
    const before = clientNow();
    const r = await srv.call('/api/worktree/init', { method: 'POST', body: { repoPath: app, key, ...extra, ...body } });
    ok(`B4 write site: ${label} linked into the read root: 403, nothing created there`,
       r.status === 403 && /read-only folder|cannot tell/.test(r.json?.error) && clientNow() === before
       && !fs.existsSync(path.join(work, `${key}-trunk`)), `${r.status} ${r.text.slice(0, 300)}`);
  };
  await site('the trunk\'s .worktrees.conf via jump/../ (the kernel lands it in the read root)', 'dotdot', () => {
    const t = path.join(work, 'dotdot-pre');
    fs.mkdirSync(t, { recursive: true });
    fs.symlinkSync(`${jump}/../new.conf`, path.join(t, '.worktrees.conf'));
    return { trunk: t };
  });
  await site('the git folder itself (.git a link into the read root)', 'gitdir', (app) => {
    fs.renameSync(path.join(app, '.git'), path.join(client, 'gitdir.git'));
    fs.symlinkSync(path.join(client, 'gitdir.git'), path.join(app, '.git'));
  });
  const site2 = (label, key, arrange) => site(label, key, (app) => { arrange(path.join(app, '.git')); });
  await site2('.git/info (wt.zsh 1531)', 'ginfo', (g) => { fs.rmSync(path.join(g, 'info'), { recursive: true, force: true }); fs.symlinkSync(path.join(client, 'info-dir'), path.join(g, 'info')); });
  await site2('.git/info/exclude (wt.zsh 1534)', 'gexcl', (g) => { fs.mkdirSync(path.join(g, 'info'), { recursive: true }); fs.rmSync(path.join(g, 'info', 'exclude'), { force: true }); fs.symlinkSync(path.join(client, 'exclude'), path.join(g, 'info', 'exclude')); });
  await site2('.git/info/exclude via jump/.. (the kernel lands it in the read root)', 'gexcl2', (g) => { fs.mkdirSync(path.join(g, 'info'), { recursive: true }); fs.rmSync(path.join(g, 'info', 'exclude'), { force: true }); fs.symlinkSync(`${jump}/../exclude2`, path.join(g, 'info', 'exclude')); });
  await site2('.git/worktrees, git\'s worktree admin dir (wt.zsh 1486)', 'gwts', (g) => { fs.symlinkSync(path.join(client, 'wts-admin'), path.join(g, 'worktrees')); });
  await site2('.git/config, where checkout -B records the upstream (wt.zsh 1489)', 'gcfg', (g) => { fs.copyFileSync(path.join(g, 'config'), path.join(client, 'sub', 'gcfg.config')); fs.rmSync(path.join(g, 'config')); fs.symlinkSync(path.join(client, 'sub', 'gcfg.config'), path.join(g, 'config')); });
  await site2('a ref under .git/refs/heads (wt.zsh 1489)', 'gref', (g) => { fs.symlinkSync(path.join(client, 'ref-x'), path.join(g, 'refs', 'heads', 'main-x')); });
  const reposLinked = path.join(sb.env.WT_HOME, 'repos');
  const reposBackup = `${reposLinked}.bak`;
  await site('the registry folder ~/.config/worktree/repos (wt.zsh 1563)', 'greg', () => {
    fs.renameSync(reposLinked, reposBackup);
    fs.symlinkSync(path.join(client, 'repos-x'), reposLinked);
  });
  fs.unlinkSync(reposLinked);
  fs.renameSync(reposBackup, reposLinked);
}

// Code wtinit would run: a post-checkout hook in .git/hooks, one through a
// repo-local core.hooksPath, and ~/.zshenv — each would write into the read
// root. None may run, and init still succeeds.
{
  const hook = (dir, mark) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'post-checkout'), `#!/bin/sh\necho ran > "${path.join(client, mark)}"\n`, { mode: 0o755 });
  };
  const zshenv = path.join(sb.home, '.zshenv');
  fs.writeFileSync(zshenv, `echo ran > "${path.join(client, 'ZSHENV-RAN')}"\n`);
  const a = repo(path.join(work, 'hooked'));
  hook(path.join(a, '.git', 'hooks'), 'HOOK-DEFAULT-RAN');
  const ra = await srv.call('/api/worktree/init', { method: 'POST', body: { repoPath: a, key: 'hooked' } });
  ok('B4 a post-checkout hook in .git/hooks never runs, and init still succeeds',
     ra.status === 200 && ra.json?.ok && fs.existsSync(path.join(work, 'hooked-trunk', '.worktrees.conf'))
     && !fs.existsSync(path.join(client, 'HOOK-DEFAULT-RAN')), ra.text.slice(0, 300));
  const b = repo(path.join(work, 'hooked2'));
  hook(path.join(b, 'myhooks'), 'HOOK-LOCAL-RAN');
  sb.git(b, 'config', 'core.hooksPath', path.join(b, 'myhooks'));
  const rb = await srv.call('/api/worktree/init', { method: 'POST', body: { repoPath: b, key: 'hooked2' } });
  ok('B4 …nor one set by the repo\'s own core.hooksPath',
     rb.status === 200 && rb.json?.ok && !fs.existsSync(path.join(client, 'HOOK-LOCAL-RAN')), rb.text.slice(0, 300));
  ok('B4 …and ~/.zshenv is not read by the init shell', !fs.existsSync(path.join(client, 'ZSHENV-RAN')));
  // The hooks are live outside ACS — the probe is real.
  sb.git(b, 'checkout', '-q', '-b', 'probe');
  ok('B4 (probe) the same hook does run for a plain git checkout', fs.existsSync(path.join(client, 'HOOK-LOCAL-RAN')));
  fs.rmSync(path.join(client, 'HOOK-LOCAL-RAN'), { force: true });
  fs.rmSync(zshenv);
}

// Cris, 2026-10-04: a repo containing symlinks is refused outright — in any
// commit wtinit could check out, or anywhere in its .git.
{
  const snap = () => JSON.stringify([listing(client), listing(reposDir)]);
  const refused = async (label, key, arrange) => {
    const app = repo(path.join(work, key));
    arrange(app);
    const before = snap();
    const r = await srv.call('/api/worktree/init', { method: 'POST', body: { repoPath: app, key } });
    ok(`B4 symlinks: ${label}: 403 "contains symlinks", nothing created`,
       r.status === 403 && /^This repo contains symlinks, so ACS won't set up worktrees for it — run in a terminal: cd '[^']+' && wtinit --key /.test(r.json?.error || '')
       && snap() === before && !fs.existsSync(path.join(work, `${key}-trunk`)), `${r.status} ${r.text.slice(0, 300)}`);
  };
  const commitLink = (app, name, target) => {
    fs.symlinkSync(target, path.join(app, name));
    sb.git(app, 'add', name);
    sb.git(app, 'commit', '-q', '-m', `link ${name}`);
  };
  await refused('a committed .worktrees.conf linked into the read root (regrade 3 #1)', 'commitconf',
    (app) => commitLink(app, '.worktrees.conf', path.join(client, 'cl.conf')));
  await refused('.git/refs a link to a refstore whose heads link into the read root (regrade 3 #2)', 'refstore', (app) => {
    const g = path.join(app, '.git');
    const store = path.join(work, 'refstore-store');
    fs.renameSync(path.join(g, 'refs'), store);
    fs.symlinkSync(store, path.join(g, 'refs'));
    fs.renameSync(path.join(store, 'heads'), path.join(client, 'heads-x'));
    fs.symlinkSync(path.join(client, 'heads-x'), path.join(store, 'heads'));
  });
  await refused('an unrelated committed symlink (README.link -> a.txt)', 'unrelated',
    (app) => commitLink(app, 'README.link', 'a.txt'));
  await refused('a symlink only in the planned base (origin/main), not in HEAD', 'basebranch', (app) => {
    commitLink(app, 'x.link', 'a.txt');
    sb.git(app, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    sb.git(app, 'reset', '-q', '--hard', 'HEAD~1');
  });
  await refused('a symlink deep in .git/objects', 'gitobjects', (app) => {
    fs.mkdirSync(path.join(app, '.git', 'objects', 'info'), { recursive: true });
    fs.symlinkSync(path.join(app, 'a.txt'), path.join(app, '.git', 'objects', 'info', 'stray'));
  });
  await refused('a symlink anywhere else in .git (an unused file)', 'gitstray',
    (app) => fs.symlinkSync('description', path.join(app, '.git', 'description-link')));
}

// An explicit base fails closed: "-" (git worktree's @{-1}) and a ref that
// names no commit are refused, never treated as "nothing to check".
{
  const before = JSON.stringify([listing(client), listing(reposDir)]);
  for (const [what, base] of [['"-"', '-'], ['"--orphan"', '--orphan'], ['a ref that names no commit', 'no-such-branch']]) {
    const app = repo(path.join(work, `base-${base.replace(/[^a-z]/g, '') || 'dash'}`));
    const key = path.basename(app);
    const r = await srv.call('/api/worktree/init', { method: 'POST', body: { repoPath: app, key, base } });
    ok(`B4 base ${what}: 403, nothing created`, r.status === 403 && JSON.stringify([listing(client), listing(reposDir)]) === before
       && !fs.existsSync(path.join(work, `${key}-trunk`)), `${r.status} ${r.text.slice(0, 200)}`);
  }
}

// Hard links: a read-root file hard-linked to a file wtinit writes in place.
{
  const hard = async (label, key, arrange) => {
    const app = repo(path.join(work, key));
    const shared = arrange(app);
    const bytes = fs.readFileSync(shared);
    // The trunk case arranges the trunk folder itself; it must stay as made.
    const trunkBefore = listing(path.join(work, `${key}-trunk`));
    const r = await srv.call('/api/worktree/init', { method: 'POST', body: { repoPath: app, key } });
    ok(`B4 hard link: ${label}: 403 with a plain message, the read-root copy unchanged`,
       r.status === 403 && /has hard links, and wtinit writes it in place/.test(r.json?.error || '')
       && fs.readFileSync(shared).equals(bytes)
       && JSON.stringify(listing(path.join(work, `${key}-trunk`))) === JSON.stringify(trunkBefore), `${r.status} ${r.text.slice(0, 250)}`);
  };
  // Replace `inRepo` with a hard link to a new read-root file holding its bytes.
  const linkFrom = (inRepo, name) => {
    const shared = path.join(client, name);
    fs.mkdirSync(path.dirname(inRepo), { recursive: true });
    fs.writeFileSync(shared, fs.existsSync(inRepo) ? fs.readFileSync(inRepo) : 'shared\n');
    fs.rmSync(inRepo, { force: true });
    fs.linkSync(shared, inRepo);
    return shared;
  };
  await hard('.git/info/exclude (appended, wt.zsh 1534)', 'hlexcl', (app) => linkFrom(path.join(app, '.git', 'info', 'exclude'), 'hl-exclude'));
  await hard('.git/config (upstream, 1489)', 'hlcfg', (app) => linkFrom(path.join(app, '.git', 'config'), 'hl-config'));
  await hard('.git/packed-refs', 'hlpacked', (app) => { sb.git(app, 'pack-refs', '--all'); return linkFrom(path.join(app, '.git', 'packed-refs'), 'hl-packed'); });
  await hard('a ref file, .git/refs/heads/main', 'hlref', (app) => linkFrom(path.join(app, '.git', 'refs', 'heads', 'main'), 'hl-ref'));
  await hard('a reflog, .git/logs/HEAD (appended)', 'hllog', (app) => linkFrom(path.join(app, '.git', 'logs', 'HEAD'), 'hl-log'));
  await hard('an existing trunk .worktrees.conf (truncated, 1501)', 'hltrunk', (app) => linkFrom(path.join(work, 'hltrunk-trunk', '.worktrees.conf'), 'hl-wtconf'));
  await hard('an existing repos/<key>.conf (truncated, 1567)', 'hlreg', () => linkFrom(path.join(reposDir, 'hlreg.conf'), 'hl-reg'));
  for (const f of ['hltrunk-trunk']) fs.rmSync(path.join(work, f), { recursive: true, force: true });
  fs.rmSync(path.join(reposDir, 'hlreg.conf'), { force: true });
}

const r3 = await srv.call('/api/worktree/init', { method: 'POST', body: { repoPath: editApp, key: 'app', cmd: 'ap' } });
ok('B4 a symlink-free project in an edit root still runs wtinit: trunk created, project registered',
   r3.status === 200 && r3.json?.ok && fs.existsSync(path.join(work, 'app-trunk', '.worktrees.conf'))
   && r3.json.registered.some((x) => x.key === 'app' && x.cmd === 'ap'), r3.text.slice(0, 400));

await srv.stop();
sb.cleanup();
done();
