/**
 * The read-only Worktrees panel (criterion 11) against real `node server.js`
 * in a sandbox HOME: GET /api/worktree runs the toolkit's `wls --json` and
 * `wclean --json --no-fetch` per registered project, and nothing else. Also
 * the existing register flow, POST /api/worktree/init, end to end (criterion
 * 10's "ACS worktree init").
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { sandbox, project, pr, tests, requireZsh, ROOT } from './worktree-sandbox.mjs';

requireZsh('worktree/panel');
const { ok, done } = tests();
const sb = sandbox('panel');
const p = project(sb, { cmd: 'zz' });

// A done worktree (squash-merged at HEAD), one with work left, one holding a
// detached secret.
const mk = (name, { merge = false } = {}) => {
  sb.zsh(p.trunk, `wnew ${name}`);
  const wt = p.wt(name);
  fs.writeFileSync(path.join(wt, `${name}.txt`), `${name}\n`);
  sb.git(wt, 'add', '.');
  sb.git(wt, 'commit', '-q', '-m', name);
  sb.git(wt, 'push', '-q', 'origin', `${name}:${name}`);
  if (merge) p.squash(name);
  return { wt, head: sb.git(wt, 'rev-parse', 'HEAD') };
};
const fin = mk('finished', { merge: true });
const wip = mk('wip');
const sec = mk('secret', { merge: true });
sb.zsh(sec.wt, 'wenv --detach .env');
fs.writeFileSync(path.join(sec.wt, '.env'), `API_KEY=${p.secret}-detached\n`);
p.fetch();
sb.gh({ finished: [pr(41, fin.head)], secret: [pr(42, sec.head)] });

// Two more registrations: one whose trunk is not a project, one whose config hangs.
const repos = path.join(sb.env.WT_HOME, 'repos');
const notProject = path.join(sb.root, 'not-a-project');
fs.mkdirSync(notProject);
fs.writeFileSync(path.join(repos, 'broken.conf'), `CMD=\nTRUNK="${notProject}"\n`);
const slow = path.join(sb.root, 'slow-trunk');
fs.mkdirSync(slow);
fs.writeFileSync(path.join(slow, '.worktrees.conf'), `sleep 30\nTRUNK="${slow}"\nROOT="${sb.root}"\n`);
fs.writeFileSync(path.join(repos, 'slow.conf'), `CMD=\nTRUNK="${slow}"\n`);

// A prefixless registration whose trunk path has a space, under $HOME (so its
// display form starts with ~): the command it shows must run as printed.
const spaced = path.join(sb.home, 'My Projects', 'app trunk');
fs.mkdirSync(path.dirname(spaced), { recursive: true });
fs.symlinkSync(p.trunk, spaced);
fs.writeFileSync(path.join(repos, 'spaced.conf'), `CMD=\nTRUNK="${spaced}"\n`);

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); });
});
async function start(extraEnv) {
  const port = await freePort();
  const base = `http://localhost:${port}`;
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT, env: { ...sb.env, PORT: String(port), ACS_WORKTREE_STATUS_MS: '6000', ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    try { up = (await fetch(`${base}/api/health`)).ok; } catch {}
    if (!up) await new Promise((r) => setTimeout(r, 100));
  }
  const stop = async () => { child.kill('SIGINT'); await new Promise((r) => child.once('exit', r)); };
  return { base, up, log: () => log, stop };
}
// GH_REPO in the studio's environment must not steer the toolkit's gh query.
const srv = await start({ GH_REPO: 'evil/elsewhere' });
const { up } = srv;
const log = srv.log();
const bodies = [];
const call = async (route, { headers = {}, method = 'GET', body, base = srv.base } = {}) => {
  const r = await fetch(`${base}${route}`, { method, headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  bodies.push(text);
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
};

console.log('\nworktree/panel');
ok('the server starts on a sandbox HOME', up, log.slice(-500));

// The server's own history runs git too, so the toolkit's calls are told
// apart by what only the toolkit runs.
const toolkitGit = (from) => sb.gitLog().slice(from).split('\n').filter((l) => / worktree list | status --porcelain=v1 -z | fetch /.test(` ${l} `));
const gitMark = sb.gitLog().length;
const t0 = Date.now();
const all = await call('/api/worktree', { headers: { 'sec-fetch-site': 'same-origin' } });
const elapsed = Date.now() - t0;
const proj = (k) => all.json?.projects?.find((x) => x.key === k);
const app = proj('app');
const row = (name) => app?.worktrees?.find((w) => w.name === `app-${name}`);
ok('11 GET /api/worktree returns every registered project', all.status === 200 && ['app', 'broken', 'slow', 'spaced'].every((k) => proj(k)), all.text.slice(0, 400));
const spacedCmd = proj('spaced')?.worktrees?.find((w) => w.name === 'app-finished')?.removeCmd;
const cdPart = spacedCmd?.replace(/ && wclean --remove$/, ' && pwd -P');
const cdRun = cdPart ? spawnSync('/bin/sh', ['-c', cdPart], { env: sb.env, encoding: 'utf8' }) : null;
ok('G8 a prefixless command is built from the absolute trunk, shell-quoted, and runs as shown',
   typeof spacedCmd === 'string' && spacedCmd.endsWith(' && wclean --remove') && !spacedCmd.includes('~') &&
   cdRun?.status === 0 && cdRun.stdout.trim() === fs.realpathSync(p.trunk), `${spacedCmd} → ${cdRun?.stdout}${cdRun?.stderr}`);
ok('G9 the panel\'s toolkit calls run with GIT_OPTIONAL_LOCKS=0', sb.ghCalls().length > 0 && sb.ghCalls().every((c) => c.GIT_OPTIONAL_LOCKS === '0'),
   JSON.stringify(sb.ghCalls().map((c) => c.GIT_OPTIONAL_LOCKS)));
ok('11 a project reads ok, with its base and notes', app?.status === 'ok' && app.base === 'origin/main' &&
   app.notes.some((n) => n.startsWith('not fetched')), JSON.stringify(app).slice(0, 400));
ok('11 each worktree carries its branch', row('finished')?.branch === 'finished' && row('wip')?.branch === 'wip' &&
   app.worktrees.find((w) => w.trunk)?.branch === 'main');
ok('11 each worktree carries its env summary', row('finished')?.env === 'linked' && row('secret')?.env === 'detached:1', JSON.stringify(row('secret')));
ok('11 per-file env states are names only', row('secret')?.files.every((f) => Object.keys(f).join() === 'file,state'));
ok('11 done/reason: squash-merged at HEAD is done, via the PR', row('finished')?.verdict.status === 'done' && row('finished').verdict.via === 'merged PR #41',
   JSON.stringify(row('finished')));
ok('11 done/reason: unmerged work says why', row('wip')?.verdict.status === 'not-done' && row('wip').verdict.reason === 'not merged', JSON.stringify(row('wip')));
ok('11 done/reason: a detached env file blocks', row('secret')?.verdict.reason === 'detached .env — wenv --to-trunk or delete it first');
ok('11 a done row carries the command to run, a not-done row none', row('finished')?.removeCmd === 'zzclean --remove' && row('wip')?.removeCmd === null);
ok('11 GH_REPO in the server\'s env did not reach the toolkit\'s gh', sb.ghCalls().length > 0 &&
   sb.ghCalls().every((c) => c.GH_REPO === null && c.argv[c.argv.indexOf('--repo') + 1] === 'acme/app'), JSON.stringify(sb.ghCalls().slice(-1)));
const ran = toolkitGit(gitMark);
ok('11 no fetch from a GET: the toolkit ran with --no-fetch', ran.some((l) => / worktree list /.test(` ${l} `)) && !ran.some((l) => / fetch /.test(` ${l} `)), ran.join('; '));
ok('11 a trunk that is not a project → that project is unknown, with the reason', proj('broken')?.status === 'unknown' &&
   /no \.worktrees\.conf/.test(proj('broken').error), JSON.stringify(proj('broken')));
ok('11 a toolkit call that hangs → unknown, timed out; the others still answer', proj('slow')?.status === 'unknown' &&
   proj('slow').error === 'timed out after 6s' && app?.status === 'ok' && elapsed < 15000, `${JSON.stringify(proj('slow'))} in ${elapsed}ms`);

const one = await call('/api/worktree?project=app');
ok('11 ?project=<key> narrows to that one', one.status === 200 && one.json.projects.length === 1 && one.json.projects[0].key === 'app');
for (const bad of ['../../etc', 'nonexistent', 'app.conf', '', 'APP']) {
  const r = await call(`/api/worktree?project=${encodeURIComponent(bad)}`);
  ok(`11 project key ${JSON.stringify(bad)} not in repos/ → 404`, r.status === 404, `${r.status} ${r.text.slice(0, 200)}`);
}
const ghBefore = sb.ghCalls().length, gitBefore = sb.gitLog().length;
await new Promise((r) => setTimeout(r, 300));
for (const [label, headers] of [['a foreign Origin', { origin: 'http://evil.example' }], ['Sec-Fetch-Site: cross-site', { 'sec-fetch-site': 'cross-site' }],
  ['Sec-Fetch-Site: same-site', { 'sec-fetch-site': 'same-site' }]]) {
  const r = await call('/api/worktree', { headers });
  ok(`11 ${label} → 403, before anything runs`, r.status === 403, `${r.status}`);
}
ok('11 …and the refused requests ran no toolkit (no gh, no worktree git)', sb.ghCalls().length === ghBefore && toolkitGit(gitBefore).length === 0, toolkitGit(gitBefore).join('; '));
const quick = await call('/api/worktree?status=0', { headers: { origin: 'http://evil.example' } });
ok('11 status=0 (the register form) lists without running the toolkit', quick.status === 200 && quick.json.projects === undefined &&
   quick.json.registered.length === 4 && sb.ghCalls().length === ghBefore);

ok('11 no response ever carried an env value', bodies.every((b) => !b.includes(p.secret) && !b.includes('API_KEY')), bodies.find((b) => b.includes(p.secret))?.slice(0, 300));

const nope = await call('/api/worktree/remove', { method: 'POST', body: { key: 'app', name: 'finished' } });
ok('11 there is no remove endpoint', nope.status === 404, `${nope.status}`);
const appJs = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const view = appJs.slice(appJs.indexOf('async function openWorktrees'), appJs.indexOf('/* ── trash view'));
ok('11 the view renders the command for a done row', view.length > 500 && view.includes('w.removeCmd') && view.includes("el('code', 'wt-cmd'"));
ok('11 the view has no button and makes no POST', !/el\('button'/.test(view) && !/'POST'/.test(view));
ok('11 the Worktrees button opens it', /id="btn-worktrees"/.test(fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8')) &&
   appJs.includes("$('btn-worktrees').onclick = openWorktrees;"));
const guards = spawnSync(process.execPath, [path.join(ROOT, 'tests', 'guards.mjs')], { encoding: 'utf8' });
ok('11 no new spawn kinds: the unmodified guards pass', guards.status === 0, guards.stdout.slice(-400));

// The existing register flow, end to end.
const other = path.join(sb.root, 'code', 'other');
fs.mkdirSync(other, { recursive: true });
sb.git(other, 'init', '-q');
fs.writeFileSync(path.join(other, 'a.txt'), 'a\n');
sb.git(other, 'add', '.');
sb.git(other, 'commit', '-q', '-m', 'a');
const init = await call('/api/worktree/init', { method: 'POST', body: { repoPath: other, key: 'other', cmd: 'ot' } });
ok('10 POST /api/worktree/init runs wtinit: trunk created, project registered', init.status === 200 && init.json?.ok &&
   fs.existsSync(path.join(sb.root, 'code', 'other-trunk', '.worktrees.conf')) &&
   init.json.registered.some((r) => r.key === 'other' && r.cmd === 'ot'), init.text.slice(0, 400));
const init2 = await call('/api/worktree/init', { method: 'POST', body: { repoPath: other, key: 'Bad Key' } });
ok('10 …and still refuses a bad key', init2.status >= 400, init2.text);

await srv.stop();

// A second studio launched from inside some other repository (GIT_DIR and
// GIT_WORK_TREE exported, both inside the sandbox): only GETs, and the panel
// still reads the project's own repository.
const hostile = await start({ GIT_DIR: path.join(sb.root, 'hostile.git'), GIT_WORK_TREE: path.join(sb.root, 'hostile-wt') });
const h = await call('/api/worktree?project=app', { base: hostile.base });
const hrow = h.json?.projects?.[0]?.worktrees?.find((w) => w.name === 'app-finished');
ok('11 GIT_DIR / GIT_WORK_TREE in the server\'s env did not reach the toolkit', hostile.up && h.json?.projects?.[0]?.status === 'ok' &&
   hrow?.verdict.status === 'done' && hrow.branch === 'finished', h.text.slice(0, 300));
await hostile.stop();
sb.cleanup();
done();
