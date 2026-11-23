import fs from 'node:fs';
import path from 'node:path';
import { ROOT, sandbox, tests } from './fixtures/packs-sandbox.mjs';

const { ok, done } = tests();
const sb = sandbox('guide-targets', { clis: [], modelId: false, dirs: ['claude', 'codex'] });
Object.assign(process.env, sb.env);
const { createApp } = await import('../server.js');
const { server } = createApp();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

const home = (...parts) => path.join(sb.home, ...parts);
const studio = home('.agent-config-studio');
const claude = home('.claude', 'CLAUDE.md');
const codex = home('.codex', 'AGENTS.md');
const cursor = home('.cursor', 'acs-note.md');
const installed = home('.agent-config-studio', 'cursor', 'hooks');
const registry = path.join(studio, 'harnesses.json');
const read = (file) => fs.readFileSync(file, 'utf8');
const write = (file, value) => fs.writeFileSync(file, value);
const json = (file, value) => write(file, JSON.stringify(value));
const countBlocks = (s) => (s.match(/<!-- acs:model-guide v1/g) || []).length;
const withoutBlock = (s) => s.replace(/<!-- acs:model-guide v1[^]*?<!-- \/acs:model-guide -->/, '');
const route = '/api/model-guide';

async function request(url, body, headers = {}) {
  const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`, body === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

const guide = async () => (await request(route)).data;
const row = async (key) => (await guide()).targets.find((t) => t.key === key);
const propose = (target, action = 'template') => request(`${route}/propose`, { target, action });
const accept = (p) => request(`${route}/accept`, { id: p.id });
const register = (spec, headers) => request(`${route}/targets`, spec, headers);
const remove = (key) => request(`${route}/targets/remove`, { key });
const hook = () => {
  const r = sb.run(path.join(installed, 'session-context'), [], { input: '{}\n' });
  return r.code === 0 ? JSON.parse(r.stdout).additional_context : null;
};

try {
  fs.mkdirSync(studio, { recursive: true });
  ok('status lists the four shipped keys in order', (await guide()).targets.map((t) => t.key).join(',') === 'claude,codex,grok,cursor');
  ok('a missing home refuses a template without creating a folder', (await propose('grok')).status === 409 && !fs.existsSync(home('.grok')));
  ok('Claude keeps Add for its missing instruction file', (await row('claude')).canTemplate === false && (await propose('claude')).status === 409);
  const noAgreement = await propose('codex');
  ok('a missing agreement is explained in the proposal with one guide block and a CLI note', noAgreement.status === 200
    && /CLAUDE.md does not exist/.test(noAgreement.data.note) && countBlocks(noAgreement.data.proposed) === 1
    && noAgreement.data.proposed.includes('## In Codex') && !fs.existsSync(codex));

  write(claude, '# Working agreement\r\n\r\nKeep the original bytes.\r\n');
  const first = (await propose('claude', 'install')).data;
  ok('the existing block-only proposal still accepts', (await accept(first)).status === 200);
  const preview = await propose('codex');
  ok('the template copies CRLF agreement bytes and puts one new guide before the note', preview.status === 200
    && preview.data.proposed.startsWith('# Working agreement\r\n\r\nKeep the original bytes.\r\n\r\n<!-- acs:model-guide')
    && preview.data.proposed.indexOf('## In Codex') > preview.data.proposed.indexOf('<!-- /acs:model-guide -->')
    && !/(?<!\r)\n/.test(preview.data.proposed) && countBlocks(preview.data.proposed) === 1);
  ok('proposing does not create the instruction file', !fs.existsSync(codex));
  ok('Accept writes exactly the template preview', (await accept(preview.data)).status === 200 && read(codex) === preview.data.proposed);
  ok('an existing file refuses the template', (await propose('codex')).status === 409);

  fs.mkdirSync(home('.cursor'));
  const fallback = await propose('cursor');
  const shipped = read(path.join(ROOT, 'packs', 'cursor', 'session', 'cursor-note.md'));
  ok('missing installed runtime seeds the shipped note and reports the missing hook', fallback.status === 200
    && fallback.data.proposed === shipped && (await row('cursor')).hookInstalled === false && !fs.existsSync(cursor));
  const pack = sb.packs(['install', 'cursor', '--yes']);
  ok('the Cursor pack installs in the temp home', pack.code === 0, pack.out);
  const legacy = `${read(claude)}\n\n${shipped}`;
  ok('the installed hook still serves the agreement and installed note with no override', hook() === legacy);
  write(path.join(installed, 'cursor-note.md'), 'Keep this installed edit.\n');
  ok('Cursor reports the hook and inherits the guide status', (await row('cursor')).hookInstalled && (await row('cursor')).status === 'current');
  ok('Cursor refuses an independent guide block', (await propose('cursor', 'install')).status === 409);
  fs.rmSync(path.join(installed, 'cursor-note.md'));
  ok('a missing installed note uses the shipped bytes and reports the incomplete hook',
    (await propose('cursor')).data.proposed === shipped && !(await row('cursor')).hookInstalled);
  write(path.join(installed, 'cursor-note.md'), 'Keep this installed edit.\n');
  const cursorPreview = await propose('cursor');
  ok('the Cursor preview contains the edited installed note and writes nothing', cursorPreview.status === 200
    && cursorPreview.data.proposed === 'Keep this installed edit.\n' && !fs.existsSync(cursor));
  ok('Cursor Accept creates the exact reviewed note', (await accept(cursorPreview.data)).status === 200 && read(cursor) === cursorPreview.data.proposed);
  write(cursor, 'Edited local session note.\n');
  const currentContext = () => `${read(claude)}\n\n${read(cursor)}`;
  ok('the hook serves the local edit with exactly one current guide block', hook() === currentContext() && countBlocks(hook()) === 1);
  for (const options of [[], ['--replace']]) {
    const r = sb.packs(['update', 'cursor', '--yes', ...options]);
    ok(`the pack ${options.length ? 'repair' : 'update'} preserves the local note and session context`,
      r.code === 0 && read(cursor) === 'Edited local session note.\n' && hook() === currentContext(), r.out);
  }

  const folder = home('registered');
  fs.mkdirSync(folder);
  fs.mkdirSync(home('unregistered'));
  fs.mkdirSync(home('read-only'));
  fs.mkdirSync(path.join(folder, 'child'));
  json(path.join(studio, 'roots.json'), { version: 1, roots: [
    { id: 'example', label: 'Example', path: folder, access: 'edit' },
    { id: 'readonly', label: 'Read only', path: home('read-only'), access: 'read' },
  ] });
  const spec = { label: 'Example CLI', home: '~/registered', file: 'INSTRUCTIONS.md' };
  ok('registration requires same origin', (await register(spec, { Origin: 'https://other.example' })).status === 403 && !fs.existsSync(registry));
  for (const [why, patch] of [
    ['a missing home', { home: '~/missing' }],
    ['an unregistered home', { home: '~/unregistered' }],
    ['a read-only home', { home: '~/read-only' }],
    ['a child of an edit root', { home: '~/registered/child' }],
    ['a shipped key', { label: 'Cursor' }],
    ['a slash', { file: 'child/INSTRUCTIONS.md' }],
    ['two dots', { file: 'a..md' }],
  ]) {
    const r = await register({ ...spec, ...patch });
    ok(`registration refuses ${why}`, r.status >= 400 && r.status < 500 && !fs.existsSync(registry), JSON.stringify(r.data));
  }
  fs.symlinkSync(codex, path.join(folder, 'outside.md'));
  ok('registration rejects a link outside the home even into another edit root', (await register({ ...spec, file: 'outside.md' })).status === 403);
  const custom = (await register(spec)).data.key;
  const customFile = path.join(folder, spec.file);
  ok('registration adds only a registry entry and a template row', custom === 'example-cli' && (await row(custom)).canTemplate
    && !fs.existsSync(customFile) && (fs.statSync(registry).mode & 0o777) === 0o600);
  ok('duplicate keys and files are refused', (await register(spec)).status === 409 && (await register({ ...spec, label: 'Another CLI' })).status === 409);
  const cp = (await propose(custom)).data;
  ok('a user target can accept a template with one guide block', (await accept(cp)).status === 200 && read(customFile) === cp.proposed && countBlocks(cp.proposed) === 1);
  write(customFile, read(customFile).replace('## In this CLI', '## A custom note'));
  const before = read(customFile);
  json(path.join(studio, 'roles.json'), { version: 2, roles: { builder: { use: 'sol' } } });
  ok('a role change marks the custom file and inherited Cursor guide stale', (await row(custom)).status === 'stale' && (await row('cursor')).status === 'stale');
  const update = await propose(custom, 'update');
  ok('Accept changes only the guide bytes after a role change', update.status === 200
    && (await accept(update.data)).status === 200 && read(customFile) === update.data.proposed
    && read(customFile) !== before && withoutBlock(read(customFile)) === withoutBlock(before));
  const sharedUpdate = await propose('claude', 'update');
  ok('accepting the shared guide update refreshes Cursor with one block and the same note', sharedUpdate.status === 200
    && (await accept(sharedUpdate.data)).status === 200 && (await row('cursor')).status === 'current'
    && hook() === currentContext() && countBlocks(hook()) === 1 && read(cursor) === 'Edited local session note.\n');
  ok('removing the CLI leaves its instruction file', (await remove(custom)).status === 200 && !(await row(custom)) && read(customFile) === update.data.proposed);

  const old = (await register({ ...spec, file: 'first.md' })).data.key;
  const pending = (await propose(old)).data;
  await remove(old);
  ok('a pending proposal cannot write after its CLI is removed', (await accept(pending)).status === 409 && !fs.existsSync(path.join(folder, 'first.md')));
  const retained = { key: 'valid', label: 'Valid', home: folder, file: 'valid.md' };
  json(registry, { version: 1, harnesses: [
    { ...retained, key: 'cursor', label: 'Cursor' },
    { ...retained, key: 'bad', label: 'Bad', file: 'outside.md' },
    { ...retained, key: 'relative', label: 'Relative', home: 'relative' },
    retained,
  ] });
  const hostile = await guide();
  ok('bad entries show indexed reasons, and the valid entry remains', hostile.targets.map((t) => t.key).join(',') === 'claude,codex,grok,cursor,valid'
    && hostile.registryWarnings.length === 3 && /reserved/.test(hostile.registryWarnings[0])
    && /outside/.test(hostile.registryWarnings[1]) && /absolute/.test(hostile.registryWarnings[2]));
  write(registry, '{broken');
  const malformed = await guide();
  ok('bad JSON shows a reason and is left in place', malformed.targets.length === 4 && /invalid JSON/.test(malformed.registryWarnings[0])
    && (await register(spec)).status === 409 && read(registry) === '{broken');

  fs.rmSync(codex);
  const account = (vendor, label) => request('/api/usage/seats', { vendor, label });
  const one = await account('codex', 'First account');
  ok('the first compatible account offers the existing template flow and writes no guide file', one.status === 200
    && one.data.guideTemplate === 'codex' && !fs.existsSync(codex));
  const two = await account('codex', 'Another account');
  ok('a second account has no template offer', two.status === 200 && !Object.hasOwn(two.data, 'guideTemplate'));
  const gemini = await account('gemini', 'Another subscription');
  ok('a subscription with no guide target has no offer', gemini.status === 200 && !Object.hasOwn(gemini.data, 'guideTemplate'));
} catch (e) {
  ok('the harness registry checks completed', false, e.stack);
} finally {
  await new Promise((resolve) => server.close(resolve));
  done();
}
