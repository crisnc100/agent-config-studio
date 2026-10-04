/**
 * B4, both sides, with the real worktree toolkit installed in a sandbox HOME
 * (tests/worktree-sandbox.mjs): POST /api/worktree/init on a project in a
 * READ root is refused with the terminal command and writes nothing there —
 * no .worktrees.conf, no trunk, no registration — while the same request on a
 * project in an EDIT root runs `wtinit` as it always has. Destinations are
 * judged where they really are: a trunk or root through a link into the read
 * root, and the ones the toolkit's template would pick when none is given.
 */
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, tests, requireZsh, ROOT } from './worktree-sandbox.mjs';
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

const r3 = await srv.call('/api/worktree/init', { method: 'POST', body: { repoPath: editApp, key: 'app', cmd: 'ap' } });
ok('B4 a project in an edit root still runs wtinit: trunk created, project registered',
   r3.status === 200 && r3.json?.ok && fs.existsSync(path.join(work, 'app-trunk', '.worktrees.conf'))
   && r3.json.registered.some((x) => x.key === 'app' && x.cmd === 'ap'), r3.text.slice(0, 400));

await srv.stop();
sb.cleanup();
done();
