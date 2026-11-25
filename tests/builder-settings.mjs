import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { guideText, loadRoles, mergeRoles } from '../lib/roles.js';
import { renderBlock } from '../lib/model-guide.js';
import { describeCli } from './fixtures/describe-cli.mjs';
import { tempDir, track } from './fixtures/cleanup.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const API = '/api/models/roles';
const builder = { use: [{ family: 'sol', effort: 'high' }, 'opus'], alt: { family: 'neon', effort: 'low' }, effort: 'medium', note: 'Implements from a brief.' };
const advisor = { use: [{ family: 'astra', effort: 'max' }], alt: { family: 'fable', effort: 'high' } };
const flavor = { sol: { likes: ['Builds'], quirks: ['Needs a scope'], brief: 'Name the checks.', effort: 'xhigh', avoid: ['advisor'] } };
const configured = { version: 2, roles: { builder, advisor }, flavor };
const random = { mode: 'random', design: 'opus', reservePercent: 0 };
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const json = (doc) => `${JSON.stringify(doc, null, 2)}\n`;

async function sandbox(t, seed = configured) {
  const home = fs.realpathSync(tempDir('acs-builder-settings-'));
  const studio = path.join(home, '.agent-config-studio');
  const roles = path.join(studio, 'roles.json');
  write(roles, json(seed));
  const fake = describeCli(path.join(home, '.local', 'bin', 'claude'));
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const { port } = listener.address();
  listener.close();
  await once(listener, 'close');
  const env = { HOME: home, PORT: String(port), PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, TMPDIR: os.tmpdir() };
  const child = track(spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] }));
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (data) => { output += data; });
  const stopped = once(child, 'exit');
  t.after(async () => { child.kill(); await stopped; });
  const base = `http://localhost:${port}`;
  const call = async (route, body) => {
    const res = await fetch(`${base}${route}`, body === undefined ? undefined : {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  let ready = false;
  for (let i = 0; i < 100 && child.exitCode === null; i++) {
    try { if ((await call('/api/health')).status === 200) { ready = true; break; } } catch {}
    await sleep(100);
  }
  assert.ok(ready, output);
  const view = async () => { const res = await call(API); assert.equal(res.status, 200, json(res.body)); return res.body; };
  const set = async (name, fields) => call(`${API}/set`, { name, fields, base: (await view()).base });
  const describe = (description, reply) => {
    write(path.join(path.dirname(fake), 'mode.json'), json({ reply: json(reply) }));
    return call(`${API}/describe`, { description });
  };
  return { home, studio, roles, env, view, call, set, describe, read: () => fs.readFileSync(roles, 'utf8') };
}

test('all builder modes round-trip through the roles API, history and installed CLI', async (t) => {
  const s = await sandbox(t);
  const install = spawnSync(process.execPath, ['bin/model-id.mjs', '--install'], { cwd: ROOT, env: s.env, encoding: 'utf8' });
  assert.equal(install.status, 0, install.stderr);
  const cli = path.join(s.home, '.local', 'bin', 'model-id');
  for (const pick of [{ mode: 'ordered' }, random, { mode: 'jev', reservePercent: 100 }]) {
    const saved = await s.set('builder', { ...builder, pick });
    assert.equal(saved.status, 200, json(saved.body));
    assert.ok(saved.body.sha, json(saved.body));
    const view = await s.view();
    const role = view.roles.find((r) => r.name === 'builder');
    assert.deepEqual(role.pick, pick);
    assert.equal(role.members[0].own, 'high');
    assert.equal(role.altMember.own, 'low');
    assert.deepEqual(JSON.parse(s.read()), { ...configured, roles: { builder: { ...builder, pick }, advisor } });
    const backup = path.join(s.studio, 'history', 'home', '.agent-config-studio', 'roles.json');
    assert.equal(fs.readFileSync(backup, 'utf8'), s.read());
    const result = spawnSync(cli, ['--pick', 'builder', '--json', '--exclude', 'opus'], { env: s.env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).mode, pick.mode);
    assert.equal(JSON.parse(result.stdout).effort, 'high');
  }
  const revised = await s.set('builder', { ...builder, note: 'Uses the agreed brief.' });
  assert.equal(revised.status, 200, json(revised.body));
  assert.deepEqual(JSON.parse(s.read()).roles.builder.pick, { mode: 'jev', reservePercent: 100 });
  assert.equal((await s.set('advisor', { ...advisor, pick: random })).status, 400);
  const before = s.read();
  for (const pick of [null, { mode: 'random', reservePercent: 101 }, { mode: 'random', reservePercent: '0' }]) {
    assert.equal((await s.set('builder', { ...builder, pick })).status, 400);
    assert.equal(s.read(), before);
  }
});

test('a stale installed reader refuses both direct save and Describe acceptance before history or roles writes', async (t) => {
  const s = await sandbox(t, { version: 1 });
  const resolverRoles = path.join(s.studio, 'resolver', 'lib', 'roles.js');
  write(resolverRoles, '// old resolver\n');
  assert.equal((await s.view()).resolverStale, true);
  const before = s.read();
  const entries = fs.readdirSync(s.studio);
  const direct = await s.set('builder', { use: ['sol'], pick: random });
  assert.equal(direct.status, 409);
  assert.match(direct.body.error, /builder selection settings.*acs install-model-id/);
  assert.equal(s.read(), before);
  assert.deepEqual(fs.readdirSync(s.studio), entries);
  const proposal = await s.describe('Pick randomly for new tasks.', { roles: { builder: { use: 'sol', pick: random } } });
  assert.equal(proposal.status, 200, json(proposal.body));
  const rejected = await s.call(`${API}/proposal/accept`, { id: proposal.body.id });
  assert.equal(rejected.status, 409);
  assert.match(rejected.body.error, /builder selection settings.*acs install-model-id/);
  assert.equal(s.read(), before);
  assert.deepEqual(fs.readdirSync(s.studio), entries);
  const legacy = await s.set('builder', { use: ['sol'] });
  assert.equal(legacy.status, 200, json(legacy.body));
  assert.equal(JSON.parse(s.read()).roles.builder.pick, undefined);
});

test('Describe preserves an omitted builder policy in the preview and writes those bytes on accept', async (t) => {
  const s = await sandbox(t, { ...configured, roles: { builder: { ...builder, pick: random }, advisor } });
  const proposedAdvisor = { ...advisor, note: 'Checks the plan.' };
  for (const proposedBuilder of [undefined, builder]) {
    const before = s.read();
    const reply = { ...configured, roles: { advisor: proposedAdvisor, ...(proposedBuilder ? { builder: proposedBuilder } : {}) } };
    const proposal = await s.describe('Change only the advisor note.', reply);
    assert.equal(proposal.status, 200, json(proposal.body));
    const prompt = fs.readFileSync(path.join(s.home, '.local', 'bin', 'prompt.txt'), 'utf8');
    assert.match(prompt, /"mode": "ordered" \| "random" \| "jev"/);
    assert.equal(proposal.body.current, before);
    assert.equal(s.read(), before);
    assert.deepEqual(JSON.parse(proposal.body.proposed), { ...configured, roles: { advisor: proposedAdvisor, builder: { ...builder, pick: random } } });
    const accepted = await s.call(`${API}/proposal/accept`, { id: proposal.body.id });
    assert.equal(accepted.status, 200, json(accepted.body));
    assert.equal(s.read(), proposal.body.proposed);
    assert.equal(s.read(), accepted.body.written);
    write(s.roles, before);
  }
  const pick = { mode: 'ordered' };
  const changed = await s.describe('Pick the first available, with no preference or usage check.', { ...configured, roles: { builder: { ...builder, pick }, advisor } });
  assert.deepEqual(JSON.parse(changed.body.proposed).roles.builder.pick, pick);
});

test('the design preference holds a synced family outside the lineup and on an unset role', async (t) => {
  const pick = { mode: 'random', design: 'visual' };
  const s = await sandbox(t, { ...configured, roles: { builder: { ...builder, pick }, advisor } });
  const families = path.join(s.studio, 'families.json');
  const text = json({ version: 1, families: { visual: { id: 'gpt-6-visual' } } });
  write(families, text);
  for (const current of [{ ...builder, pick }, { pick }]) {
    write(s.roles, json({ ...configured, roles: { builder: current, advisor } }));
    const removal = await s.call('/api/models/remove', { family: 'visual' });
    assert.equal(removal.status, 409);
    assert.match(removal.body.error, /the builder's new visual design preference/);
    assert.equal(fs.readFileSync(families, 'utf8'), text);
  }
});

test('saving a policy makes the installed guide stale and its update describes task ownership', async (t) => {
  const s = await sandbox(t);
  const file = path.join(s.home, '.claude', 'CLAUDE.md');
  write(file, `# Instructions\n\n${renderBlock(guideText(loadRoles({ home: s.home })), 0)}\n`);
  const guideStatus = async () => (await s.call('/api/model-guide')).body.targets.find((x) => x.key === 'claude').status;
  assert.equal(await guideStatus(), 'current');
  const saved = await s.set('builder', { ...builder, pick: random });
  assert.equal(saved.status, 200, json(saved.body));
  assert.equal(await guideStatus(), 'stale');
  const update = await s.call('/api/model-guide/propose', { target: 'claude', action: 'update' });
  assert.equal(update.status, 200, json(update.body));
  assert.match(update.body.proposed, /Give every eligible builder an equal chance/);
  assert.match(update.body.proposed, /once per meaningful task.*use it for the task’s phases, fixes and resumes/);
  assert.match(update.body.proposed, /new frontend visual design.*prefer opus when eligible/);
  assert.match(update.body.proposed, /Cached usage filters out builders known to be exhausted\./);
  const applied = await s.call('/api/model-guide/accept', { id: update.body.id });
  assert.equal(applied.status, 200, json(applied.body));
  assert.equal(await guideStatus(), 'current');
});

test('a role without a policy keeps the original guide bytes', () => {
  const roles = mergeRoles({ roles: {}, flavor: {} }, { version: 2, roles: { builder } });
  assert.equal(guideText({ ...roles, families: [] }), [
    '## Model guide', '',
    'Generated by Agent Config Studio from your model roles. Edit roles in ACS, not here. Edits inside this block are overwritten.', '',
    '**Roles.** The first family is the answer; the rest are fallbacks, in order. A second opinion is used only when asked for.', '',
    'Roles skip paused accounts (ACS → Usage → Pause); `model-id --role <name>` gives the current answer.', '',
    '- **builder**: sol at high effort; fallbacks: opus at medium effort; second opinion: neon at low effort — Implements from a brief.', '',
    '`model-id --role <name>` / `model-id --flavor <family>` print these; `model-id <family>` prints the current id.', '',
  ].join('\n'));
});
