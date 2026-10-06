/**
 * The setup screen's server half (builds/setup-screen/plan.md), against a real
 * `node server.js` on temp HOMEs:
 *
 *   S14  GET /api/setup/status — none, done, skipped, migrated, and error for
 *        a malformed or unreadable setup.json; POST /api/setup/complete writes
 *        it, refuses a bad value, and reports a failed write as an error
 *   S1   a first-time user with ~/Documents/Projects gets setup, not a migration
 *   S11  POST /api/roots/preview + add: canonical path, confirm === canonical
 *        for edit, a symlink re-pointed between preview and add is refused,
 *        relative paths and malformed bodies are 400 with nothing written
 *   5    every lib/roots.js rejection surfaces through the route with its own
 *        message; a valid add lands in roots.json and shows in Context,
 *        Skills and the registry, with a roots event; remove works; a read
 *        folder added here 403s on write
 *   S12  every new mutating route refuses a foreign Origin, another localhost
 *        port, Origin: null and Sec-Fetch-Site: same-site without Origin —
 *        and leaves the files as they were
 *   F3   /api/worktree/bases with no repo is a 400
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshotRealHomes, assertRealHomesUnchanged } from './real-home.mjs';
import { seedProjectTree, seedGlobals, startServer } from './fixtures/roots-home.mjs';
import { FOREIGN } from './fixtures/setup-home.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const realHome = os.homedir();
const realBefore = snapshotRealHomes();
const R = await import('../lib/roots.js');

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const temps = [];
const mkTemp = (tag) => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `acs-setup-${tag}-`))); temps.push(d); return d; };
const mk = (...p) => { fs.mkdirSync(path.join(...p), { recursive: true }); return path.join(...p); };
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };

/** fetch with the headers a request carries, JSON either way. */
const call = (base) => async (p, { method = 'GET', body, headers = {} } = {}) => {
  const r = await fetch(base + p, {
    method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
};

console.log('\nsetup routes');
ok('the real HOME is never a test HOME', !temps.includes(realHome));

/* ── S14 + S1: setup state, on a first-time machine ───────────────────── */
{
  const home = mkTemp('state');
  seedGlobals(home);
  mk(home, 'Documents', 'Projects');            // a first-time user's ordinary folder
  const studio = path.join(home, '.agent-config-studio');
  const srv = await startServer(home, { root: ROOT });
  const api = call(srv.base);
  ok('the server boots', srv.up, srv.log().slice(-400));
  ok('S1 a first-time user with ~/Documents/Projects: roots.json is empty and setup has not run',
     JSON.parse(read(path.join(studio, 'roots.json'))).roots.length === 0 && !fs.existsSync(path.join(studio, 'setup.json')));
  let s = await api('/api/setup/status');
  ok('S14 status is "none" before setup', s.status === 200 && s.json.state === 'none', s.text);

  for (const bad of [{ completed: 'migrated' }, { completed: 1 }, {}, []]) {
    const r = await api('/api/setup/complete', { method: 'POST', body: bad });
    ok(`S14 complete refuses ${JSON.stringify(bad)} with a 400 and writes nothing`, r.status === 400 && !fs.existsSync(path.join(studio, 'setup.json')), r.text);
  }
  const skip = await api('/api/setup/complete', { method: 'POST', body: { completed: 'skipped' } });
  ok('S14 Skip writes {completed: skipped}', skip.status === 200 && JSON.parse(read(path.join(studio, 'setup.json'))).completed === 'skipped', skip.text);
  s = await api('/api/setup/status');
  ok('S14 …and status says skipped', s.json.state === 'skipped');
  const done = await api('/api/setup/complete', { method: 'POST', body: { completed: 'done' } });
  ok('S14 Finish writes {completed: done}', done.status === 200 && JSON.parse(read(path.join(studio, 'setup.json'))).completed === 'done', done.text);

  fs.writeFileSync(path.join(studio, 'setup.json'), '{"completed": "done"');
  s = await api('/api/setup/status');
  ok('S14 a malformed setup.json is "error" with a reason, never "none"', s.json.state === 'error' && /not valid/.test(s.json.error), s.text);
  fs.writeFileSync(path.join(studio, 'setup.json'), '{"completed": "maybe"}');
  s = await api('/api/setup/status');
  ok('S14 …so is an unknown completed value', s.json.state === 'error', s.text);
  if (process.getuid?.() !== 0) {
    fs.chmodSync(path.join(studio, 'setup.json'), 0o000);
    s = await api('/api/setup/status');
    ok('S14 an unreadable setup.json is "error"', s.json.state === 'error' && /could not be read/.test(s.json.error), s.text);
    fs.chmodSync(path.join(studio, 'setup.json'), 0o600);
  }
  const fix = await api('/api/setup/complete', { method: 'POST', body: { completed: 'done' } });
  ok('S14 complete rewrites a broken file (the notice\'s "rewrite it")', fix.status === 200 && (await api('/api/setup/status')).json.state === 'done');
  if (process.getuid?.() !== 0) {
    fs.rmSync(path.join(studio, 'setup.json'));
    fs.chmodSync(studio, 0o500);
    const failed = await api('/api/setup/complete', { method: 'POST', body: { completed: 'done' } });
    fs.chmodSync(studio, 0o700);
    ok('S14 a write that fails is an error response, and status stays "none"',
       failed.status >= 500 && /could not be written/.test(failed.json?.error || '') && (await api('/api/setup/status')).json.state === 'none', failed.text);
  }
  const bases = await api('/api/worktree/bases');
  ok('F3 /api/worktree/bases with no repo → 400 repo required', bases.status === 400 && /repo required/.test(bases.json?.error), bases.text);
  await srv.stop();
}

/* ── S1 on a machine that used ACS before: migrated, as today ──────────── */
{
  const home = mkTemp('prior');
  mk(home, 'Documents', 'Projects');
  mk(home, '.agent-config-studio');
  fs.writeFileSync(path.join(home, '.agent-config-studio', 'seats.json'), '{"version":1,"seats":[]}\n');
  const srv = await startServer(home, { root: ROOT });
  const s = await call(srv.base)('/api/setup/status');
  ok('S1 prior ACS state + legacy folder → migrated, setup does not open', s.json?.state === 'migrated'
     && JSON.parse(read(path.join(home, '.agent-config-studio', 'roots.json'))).roots.map((r) => r.id).join() === 'projects', s.text);
  await srv.stop();
}

/* ── roots routes: preview, add, remove, rejections, live ─────────────── */
{
  const home = mkTemp('roots');
  seedGlobals(home);
  mk(home, '.ssh', 'keys');
  const work = path.join(home, 'code', 'work');
  seedProjectTree(work, 'work');
  const notes = path.join(home, 'code', 'notes');
  seedProjectTree(notes, 'notes');
  const elsewhere = mkTemp('outside');
  const studio = path.join(home, '.agent-config-studio');
  const srv = await startServer(home, { root: ROOT });
  const api = call(srv.base);
  const rootsFile = path.join(studio, 'roots.json');
  const before = () => read(rootsFile);

  // The event stream, as an open tab holds it.
  const events = [];
  let rawBytes = 0, streamErr = null;
  const ac = new AbortController();
  const stream = await fetch(`${srv.base}/api/events`, { signal: ac.signal });
  (async () => {
    const dec = new TextDecoder(); let buf = '';
    try {
      for await (const chunk of stream.body) {
        buf += dec.decode(chunk, { stream: true }); rawBytes += chunk.length;
        let i;
        while ((i = buf.indexOf('\n\n')) !== -1) {
          const line = buf.slice(0, i).split('\n').find((l) => l.startsWith('data: ')); buf = buf.slice(i + 2);
          if (line) { try { events.push(JSON.parse(line.slice(6))); } catch {} }
        }
      }
    } catch (e) { streamErr = e; }
  })();
  await sleep(300);

  // S11: preview
  const pv = await api('/api/roots/preview', { method: 'POST', body: { path: '~/code/work' } });
  ok('S11 preview names the canonical path, its display form and each access verdict',
     pv.status === 200 && pv.json.canonical === work && pv.json.display === '~/code/work' && pv.json.access.edit === null && pv.json.access.read === null, pv.text);
  ok('S11 …and writes nothing (a cancelled confirm leaves no trace)', JSON.parse(before()).roots.length === 0);
  const link = path.join(home, 'link-to-work');
  fs.symlinkSync(work, link);
  const pl = await api('/api/roots/preview', { method: 'POST', body: { path: link } });
  ok('S11 an alias (a symlink) previews as where it really leads', pl.json?.canonical === work && pl.json.display === '~/code/work' && pl.json.typed === '~/link-to-work', pl.text);
  const rel = await api('/api/roots/preview', { method: 'POST', body: { path: 'code/work' } });
  const relAdd = await api('/api/roots/add', { method: 'POST', body: { path: 'code/work', access: 'read' } });
  ok('S11 a relative path is a 400 on preview and add, nothing written',
     rel.status === 400 && relAdd.status === 400 && /relative/.test(relAdd.json?.error) && JSON.parse(before()).roots.length === 0, relAdd.text);

  // S11: malformed bodies
  const snap0 = before();
  for (const [what, body] of [
    ['an array body', '[]'], ['a string body', '"x"'], ['not JSON', '{nope'],
    ['a numeric path', { path: 5, access: 'read' }], ['no access', { path: work }],
    ['an unknown access', { path: work, access: 'write' }], ['a numeric label', { path: work, access: 'read', label: 7 }],
    ['a numeric confirm', { path: work, access: 'edit', confirm: 1 }],
  ]) {
    const r = await api('/api/roots/add', { method: 'POST', body });
    ok(`S11 ${what} → 400, nothing written`, r.status === 400 && before() === snap0, `${r.status} ${r.text}`);
  }

  // The confirm contract.
  const noConfirm = await api('/api/roots/add', { method: 'POST', body: { path: work, access: 'edit' } });
  ok('5 an edit add without confirm → 400', noConfirm.status === 400 && /confirm/.test(noConfirm.json?.error) && before() === snap0, noConfirm.text);
  const wrong = await api('/api/roots/add', { method: 'POST', body: { path: work, access: 'edit', confirm: notes } });
  ok('S11 an edit add whose confirm is not the canonical path → 400', wrong.status === 400 && before() === snap0, wrong.text);
  const typedConfirm = await api('/api/roots/add', { method: 'POST', body: { path: link, access: 'edit', confirm: link } });
  ok('S11 …the typed alias is not the canonical path either', typedConfirm.status === 400 && before() === snap0, typedConfirm.text);

  // Retargeted between preview and add.
  const moving = path.join(home, 'moving');
  fs.symlinkSync(work, moving);
  const mp = await api('/api/roots/preview', { method: 'POST', body: { path: moving } });
  fs.unlinkSync(moving); fs.symlinkSync(notes, moving);
  const mv = await api('/api/roots/add', { method: 'POST', body: { path: moving, access: 'edit', confirm: mp.json.canonical } });
  ok('S11 a symlink re-pointed between preview and add is refused, nothing written',
     mp.json.canonical === work && mv.status === 400 && /no longer leads/.test(mv.json?.error) && before() === snap0, mv.text);
  fs.unlinkSync(moving);

  // 5 + S12: the full rejection set, each with lib/roots.js's own message.
  fs.symlinkSync(path.join(home, '.ssh'), path.join(home, 'ssh-alias'));
  fs.symlinkSync(home, path.join(home, 'home-alias'));
  mk(home, 'code', 'work', 'inner');
  const cases = [
    ['the filesystem root', { path: '/', access: 'read' }],
    ['HOME itself', { path: home, access: 'read' }],
    ['HOME through a link', { path: path.join(home, 'home-alias'), access: 'read' }],
    ['~/.ssh', { path: path.join(home, '.ssh'), access: 'read' }],
    ['inside ~/.ssh', { path: path.join(home, '.ssh', 'keys'), access: 'read' }],
    ['~/.ssh by a link (realpath rule)', { path: path.join(home, 'ssh-alias'), access: 'read' }],
    ['inside a built-in home', { path: path.join(home, '.claude', 'skills'), access: 'read' }],
    ['the studio\'s own folder', { path: studio, access: 'read' }],
    ['an edit folder outside HOME', { path: elsewhere, access: 'edit', confirm: elsewhere }],
    ['a folder that does not exist', { path: path.join(home, 'nope'), access: 'read' }],
    ['a file, not a folder', { path: path.join(work, 'CLAUDE.md'), access: 'read' }],
    ['an 81-character label', { path: work, access: 'read', label: 'x'.repeat(81) }],
  ];
  for (const [what, body] of cases) {
    const expected = R.validateRoot({ id: 'probe', path: path.resolve(body.path), label: body.label ?? (path.basename(body.path) || body.path), access: body.access }, [], { home });
    const r = await api('/api/roots/add', { method: 'POST', body });
    ok(`5 refused through the route: ${what}`, r.status === 400 && expected && r.json?.error === expected && before() === snap0, `${r.status} ${r.json?.error} | expected ${expected}`);
  }

  // A valid read add, then overlap rules against it.
  const t0 = Date.now();
  const addRead = await api('/api/roots/add', { method: 'POST', body: { path: '~/code/work', access: 'read', label: 'Work' } });
  ok('5 a valid read add lands in roots.json and returns the roots view',
     addRead.status === 200 && JSON.parse(before()).roots.some((r) => r.id === 'work' && r.access === 'read' && r.path === work)
     && addRead.json.roots.roots.some((r) => r.id === 'work'), addRead.text);
  for (const [what, body] of [
    ['already registered (by an alias)', { path: link, access: 'read' }],
    ['inside a registered folder', { path: path.join(work, 'inner'), access: 'read' }],
    ['containing a registered folder', { path: path.join(home, 'code'), access: 'read' }],
  ]) {
    const entries = JSON.parse(before()).roots;
    const expected = R.validateRoot({ id: 'probe2', path: path.resolve(body.path), label: path.basename(body.path), access: body.access }, entries, { home });
    const snap = before();
    const r = await api('/api/roots/add', { method: 'POST', body });
    ok(`5 refused through the route (overlap): ${what}`, r.status === 400 && expected && r.json?.error === expected && before() === snap, `${r.json?.error} | ${expected}`);
  }

  // Shows within 3 s in Context, Skills and the registry; a roots event went out.
  let seen = null;
  for (let i = 0; i < 30 && !seen; i++) {
    const [ctx, skills] = [await api('/api/context'), await api('/api/skills')];
    if (JSON.stringify(ctx.json).includes('work-app') && skills.json?.skills?.some((s) => s.source === 'work')
        && events.some((e) => e.type === 'roots' && e.roots?.some((r) => r.id === 'work'))) seen = Date.now() - t0;
    // Not faster: /api/skills rewrites its usage cache in the studio folder,
    // and roots.json's watcher debounces on that folder's events.
    else await sleep(300);
  }
  ok('5 within 3 s the read folder is in Context and Skills, and a roots event went out', seen !== null && seen < 3000,
     `seen=${seen} ctx=${JSON.stringify((await api('/api/context')).json).includes('work-app')} skills=${JSON.stringify((await api('/api/skills')).json?.skills?.map((s) => s.source))} events=${JSON.stringify(events.map((e) => e.type))} bytes=${rawBytes} err=${streamErr}`);
  const put = await api('/api/file', { method: 'PUT', body: { path: path.join(work, 'CLAUDE.md'), content: '# changed\n' } });
  ok('5 a read folder added from setup 403s on write', put.status === 403 && read(path.join(work, 'CLAUDE.md')) === '# work workspace\n', put.text);

  // An edit add with the right confirm.
  const np = await api('/api/roots/preview', { method: 'POST', body: { path: '~/code/notes', label: 'Notes' } });
  const addEdit = await api('/api/roots/add', { method: 'POST', body: { path: '~/code/notes', access: 'edit', label: 'Notes', confirm: np.json.canonical } });
  ok('S11 an edit add whose confirm equals preview.canonical lands', addEdit.status === 200 && JSON.parse(before()).roots.some((r) => r.id === 'notes' && r.access === 'edit'), addEdit.text);
  let inRegistry = false;
  for (let i = 0; i < 30 && !inRegistry; i++) {
    const reg = await api('/api/registry');
    inRegistry = JSON.stringify(reg.json).includes(path.join(notes, 'notes-app', 'CLAUDE.md'));
    if (!inRegistry) await sleep(100);
  }
  ok('5 …and the registry lists its files', inRegistry);

  // S12: every new mutating route, every refused origin, files unchanged.
  const files = () => [rootsFile, path.join(studio, 'setup.json'), path.join(studio, 'seats.json')].map(read).join('\0');
  const filesBefore = files();
  const routes = [
    ['POST', '/api/roots/preview', { path: '~/code/work' }],
    ['POST', '/api/roots/add', { path: home + '/code/notes/notes-app', access: 'read' }],
    ['POST', '/api/roots/remove', { id: 'work' }],
    ['POST', '/api/setup/complete', { completed: 'done' }],
    ['POST', '/api/setup/seats', { vendor: 'claude', label: 'Claude' }],
    ['GET', '/api/setup/clis'], ['GET', '/api/setup/scan'], ['GET', '/api/setup/accounts'],
  ];
  for (const [method, p, body] of routes) {
    for (const [why, headers] of Object.entries(FOREIGN(srv.base))) {
      const r = await api(p, { method, body, headers });
      ok(`S12 ${method} ${p} — ${why} → 403`, r.status === 403, `${r.status} ${r.text.slice(0, 120)}`);
    }
  }
  ok('S12 …and no refused request changed roots.json, setup.json or seats.json', files() === filesBefore);

  const rm = await api('/api/roots/remove', { method: 'POST', body: { id: 'work' } });
  ok('5 remove works', rm.status === 200 && !JSON.parse(before()).roots.some((r) => r.id === 'work') && !rm.json.roots.roots.some((r) => r.id === 'work'), rm.text);
  const rm2 = await api('/api/roots/remove', { method: 'POST', body: { id: 'work' } });
  ok('5 removing an unknown id → 404', rm2.status === 404, rm2.text);
  const rm3 = await api('/api/roots/remove', { method: 'POST', body: { id: 3 } });
  ok('S11 remove with a non-string id → 400', rm3.status === 400, rm3.text);
  ok('5 the folder itself is untouched by remove', fs.existsSync(path.join(work, 'CLAUDE.md')));
  ac.abort();
  await srv.stop();
}

/* ── S12: the rest of lib/roots.js's rejection set, through the route ─── */
{
  const home = mkTemp('relocated');
  seedGlobals(home);
  mk(home, '.config', 'worktree');
  // ~/.ssh and ~/.claude both live elsewhere, through links.
  mk(home, 'stuff', 'keys');
  fs.symlinkSync(path.join(home, 'stuff', 'keys'), path.join(home, '.ssh'));
  fs.renameSync(path.join(home, '.claude'), path.join(home, 'dots-claude'));
  mk(home, 'dots');
  fs.renameSync(path.join(home, 'dots-claude'), path.join(home, 'dots', 'claude'));
  fs.symlinkSync(path.join(home, 'dots', 'claude'), path.join(home, '.claude'));
  mk(home, 'dots', 'claude', 'projects-x');
  mk(home, 'stuff', 'keys', 'sub');
  const srv = await startServer(home, { root: ROOT });
  const api = call(srv.base);
  const rootsFile = path.join(home, '.agent-config-studio', 'roots.json');
  const snap = read(rootsFile);
  for (const [what, body, pattern] of [
    ['a folder containing a protected subtree (~/.config holds ~/.config/worktree)', { path: path.join(home, '.config'), access: 'read' }, /contains ~\/\.config\/worktree/],
    ['a folder containing the relocated ~/.ssh target', { path: path.join(home, 'stuff'), access: 'read' }, /contains ~\/\.ssh/],
    ['a folder inside the relocated ~/.ssh target', { path: path.join(home, 'stuff', 'keys', 'sub'), access: 'read' }, /inside ~\/\.ssh/],
    ['a folder containing a relocated built-in home (~/.claude -> ~/dots/claude)', { path: path.join(home, 'dots'), access: 'read' }, /contains ~\/\.claude/],
    ['a folder inside a relocated built-in home', { path: path.join(home, 'dots', 'claude', 'projects-x'), access: 'read' }, /inside ~\/\.claude/],
  ]) {
    const expected = R.validateRoot({ id: 'probe', path: body.path, label: path.basename(body.path), access: body.access }, [], { home });
    const r = await api('/api/roots/add', { method: 'POST', body });
    ok(`S12 refused through the route: ${what}`, r.status === 400 && expected && r.json?.error === expected && pattern.test(expected) && read(rootsFile) === snap,
       `${r.status} ${r.json?.error} | expected ${expected}`);
  }
  await srv.stop();
}

assertRealHomesUnchanged(realBefore, ok);
for (const t of temps) fs.rmSync(t, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
