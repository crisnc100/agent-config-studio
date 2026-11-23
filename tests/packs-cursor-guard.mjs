import fs from 'node:fs';
import path from 'node:path';
import { ROOT, sandbox, tests } from './fixtures/packs-sandbox.mjs';
import { catalogView, parseRequest } from '../lib/packs-routes.js';
import { hashSnap, snapshot } from '../lib/packs-files.js';
import { loadCatalog, machine, planInstall } from '../lib/packs.js';
import { shellCommand } from '../packs/review-gate/runtime/hooks/cursor-hooks.mjs';
import { assertRealHomesUnchanged, snapshotRealHomes } from './real-home.mjs';

const realBefore = snapshotRealHomes();
const { ok, done } = tests();
const source = path.join(ROOT, 'packs/review-gate/runtime/hooks');
const guard = (home) => path.join(home, '.agent-config-studio/review-gate/hooks/agent-guard');
const hooks = (home) => path.join(home, '.cursor/hooks.json');
const install = ['install', 'review-gate', '--part', 'agent-guard'];
const uninstall = ['uninstall', 'review-gate', '--part', 'agent-guard'];
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, doc) => fs.writeFileSync(file, JSON.stringify(doc));
const payload = (fields) => JSON.stringify({ hook_event_name: 'beforeShellExecution', cwd: '/tmp', conversation_id: 'test', ...fields });
const jsonReply = (r) => { try { return JSON.parse(r.stdout); } catch { return null; } };
const denied = (r, reason) => {
  const reply = jsonReply(r);
  return r.code === 0 && r.stderr === '' && reply?.permission === 'deny'
    && Object.keys(reply).length === 3 && reply.user_message === reply.agent_message
    && typeof reply.user_message === 'string' && reply.user_message.startsWith('review gate: ') && reason.test(reply.user_message);
};

{
  const sb = sandbox('cursor-guard-payload', { clis: [], modelId: false });
  const launcher = path.join(source, 'agent-guard');
  const run = (input, ...args) => sb.run('/bin/sh', [launcher, ...args], { input });
  const allowed = run(payload({ command: 'git status' }));
  ok('Cursor gets one explicit allow for a readable command', allowed.code === 0 && allowed.stderr === ''
    && allowed.stdout === '{"permission":"allow"}\n', allowed.out);
  const blocked = run(payload({ command: 'git push --no-verify --dry-run' }));
  ok('Cursor gets one explicit denial with the existing reason', denied(blocked, /agents may not run git push --no-verify/), blocked.out);
  for (const [label, input, reason] of [
    ['missing', payload({}), /command/],
    ['non-string', payload({ command: ['git', 'status'] }), /command/],
    ['unparseable shell', payload({ command: "echo 'unfinished" }), /guard error/],
    ['malformed JSON', '{\n  "hook_event_name" :\n  "beforeShellExecution", "command":', /guard error/],
  ]) {
    const result = run(input);
    ok(`Cursor is denied for ${label} input`, denied(result, reason), result.out);
  }
  const explicitAllow = run(JSON.stringify({ command: 'git status' }), '--cursor');
  ok('--cursor allows a readable command without an event name', explicitAllow.code === 0 && explicitAllow.stderr === ''
    && explicitAllow.stdout === '{"permission":"allow"}\n', explicitAllow.out);
  for (const [label, input, reason] of [
    ['blocked command without an event name', JSON.stringify({ command: 'git push --no-verify --dry-run' }), /agents may not run git push --no-verify/],
    ['invalid JSON', '{', /guard error/],
    ['empty stdin', '', /guard error/],
    ['empty object', '{}', /command string/],
    ['non-object payload', 'null', /command string/],
    ['non-string command', '{"command":42}', /command string/],
  ]) {
    const result = run(input, '--cursor');
    ok(`--cursor denies ${label}`, denied(result, reason), result.out);
  }
  const unreadable = sb.run('/bin/sh', ['-c', 'exec "$@" < .', 'sh', launcher, '--cursor']);
  ok('--cursor denies unreadable stdin', denied(unreadable, /guard error/), unreadable.out);
  const noNode = path.join(sb.root, 'no-node');
  fs.mkdirSync(noNode);
  for (const [name, bin] of [['cat', '/bin/cat'], ['grep', '/usr/bin/grep']]) fs.symlinkSync(bin, path.join(noNode, name));
  const unavailable = sb.run('/bin/sh', [path.join(source, 'agent-guard')], {
    input: payload({ command: 'git status' }), extra: { PATH: noNode },
  });
  ok('the launcher denies Cursor when Node cannot start', denied(unavailable, /node could not start/), unavailable.out);
  const unavailableExplicit = sb.run('/bin/sh', [launcher, '--cursor'], { input: '', extra: { PATH: noNode } });
  ok('the launcher denies --cursor without Node or an event name', denied(unavailableExplicit, /node could not start/), unavailableExplicit.out);
  const reordered = sb.run('/bin/sh', [path.join(source, 'agent-guard')], {
    input: '{ "command": "hook_event_name", "hook_event_name":\n "beforeShellExecution" }', extra: { PATH: noNode },
  });
  ok('the launcher finds the Cursor event after a command that contains the field name', denied(reordered, /node could not start/), reordered.out);
  const old = run(JSON.stringify({ tool_input: { command: 'git push --no-verify --dry-run' } }));
  ok('an existing hook still denies through stderr and exit 2', old.code === 2 && old.stdout === ''
    && /agents may not run git push --no-verify/.test(old.stderr), old.out);
}

{
  const sb = sandbox('cursor-guard-installer', { clis: [], modelId: false });
  const file = hooks(sb.home);
  const invoke = (action) => sb.run(process.execPath, [path.join(source, 'install-agent-guard.mjs'), action, '--no-claude', '--no-codex']);
  fs.mkdirSync(path.dirname(file));
  const original = { version: 1, hooks: {
    sessionStart: [{ command: 'working-agreement' }],
    beforeShellExecution: [{ command: 'user-hook', matcher: 'git', failClosed: false }],
    afterShellExecution: [{ command: 'after-hook' }],
  } };
  write(file, original);
  const missing = invoke('status');
  ok('standalone status reports the missing Cursor guard and how to repair it', missing.code === 0
    && /Cursor.*missing/.test(missing.stdout) && /install-agent-guard\.mjs.*install/.test(missing.stdout), missing.out);
  const added = invoke('install');
  const expected = structuredClone(original);
  const command = shellCommand(path.join(source, 'agent-guard'));
  expected.hooks.beforeShellExecution.push({ command: `${command} --cursor`, failClosed: true });
  ok('standalone install appends one fail-closed entry beside every existing hook', added.code === 0
    && JSON.stringify(read(file)) === JSON.stringify(expected), added.out);
  const installed = invoke('status');
  ok('standalone status reports the Cursor guard active', installed.code === 0 && /Cursor.*active/.test(installed.stdout), installed.out);
  const before = fs.readFileSync(file, 'utf8');
  const reinstalled = invoke('install');
  ok('standalone reinstall leaves the file byte-for-byte unchanged', reinstalled.code === 0
    && fs.readFileSync(file, 'utf8') === before, reinstalled.out);
  const edited = read(file);
  edited.hooks.sessionStart.push({ command: 'later-edit' });
  write(file, edited);
  const removed = invoke('uninstall');
  original.hooks.sessionStart.push({ command: 'later-edit' });
  ok('standalone uninstall strips the guard while keeping later edits', removed.code === 0
    && JSON.stringify(read(file)) === JSON.stringify(original), removed.out);
  for (const invalid of ['{', '{"hooks":[]}', '{"hooks":{"beforeShellExecution":{}}}']) {
    fs.writeFileSync(file, invalid);
    const result = invoke('install');
    ok(`standalone install refuses invalid Cursor config ${invalid}`, result.code === 1
      && /JSON|beforeShellExecution/.test(result.stderr) && fs.readFileSync(file, 'utf8') === invalid, result.out);
  }
  const prior = { version: 1, hooks: { beforeShellExecution: [
    { command, failClosed: true },
    { command, matcher: 'git', timeout: 10 },
  ] } };
  write(file, prior);
  const legacy = invoke('status');
  ok('standalone status reports the old launcher entry as needing repair', legacy.code === 0
    && /Cursor.*repair with:/.test(legacy.stdout), legacy.out);
  const fixed = invoke('install');
  const repaired = read(file).hooks.beforeShellExecution;
  ok('standalone install repairs the old entry in place and preserves a user hook using the same launcher', fixed.code === 0
    && repaired.length === 2 && repaired[0].command === `${command} --cursor` && repaired[0].failClosed === true
    && JSON.stringify(repaired[1]) === JSON.stringify(prior.hooks.beforeShellExecution[1]), fixed.out);
  const cleaned = invoke('uninstall');
  ok('uninstall removes the repaired entry and keeps the user hook', cleaned.code === 0
    && JSON.stringify(read(file).hooks.beforeShellExecution) === JSON.stringify(prior.hooks.beforeShellExecution.slice(1)), cleaned.out);
  write(file, prior);
  const legacyRemoved = invoke('uninstall');
  ok('uninstall also removes an old entry before repair and keeps the user hook', legacyRemoved.code === 0
    && JSON.stringify(read(file).hooks.beforeShellExecution) === JSON.stringify(prior.hooks.beforeShellExecution.slice(1)), legacyRemoved.out);
}

{
  const sb = sandbox('cursor-guard-pack', { clis: ['cursor-agent'], dirs: [] });
  const file = hooks(sb.home);
  const partStatus = (args = []) => sb.json(['status', ...args]).data?.packs.find((p) => p.id === 'review-gate').parts.find((p) => p.id === 'agent-guard');
  const preview = sb.json([...install, '--dry-run']);
  ok('a Cursor CLI with no settings folder is enough for the pack to preview the hook', preview.code === 0
    && preview.data?.units[0]?.harnesses.includes('cursor') && preview.data.preview.some((r) => r.path === file)
    && !fs.existsSync(file), preview.out);
  const m = machine(sb.env);
  const catalog = loadCatalog();
  const cursor = catalogView(m, { installedOf: () => false }).harnesses.find((h) => h.id === 'cursor');
  ok('the Packs catalog exposes Cursor and its CLI presence', cursor?.present && cursor?.installed, JSON.stringify(cursor));
  let apiPlan;
  try {
    const request = parseRequest({ action: 'install', pack: 'review-gate', parts: ['agent-guard'], harnesses: ['cursor'] }, { m });
    apiPlan = planInstall(request.pack, request.opts, m, undefined, catalog);
  } catch (error) { apiPlan = { refusals: [error.message] }; }
  ok('the Packs API accepts an explicit Cursor target and previews the hook', !apiPlan.refusals.length
    && apiPlan.preview.some((r) => r.path === file), JSON.stringify(apiPlan.refusals));
  const result = sb.packs([...install, '--yes']);
  ok('the pack creates a version 1 Cursor file with the installed launcher', result.code === 0
    && fs.existsSync(file) && JSON.stringify(read(file)) === JSON.stringify({ version: 1, hooks: {
      beforeShellExecution: [{ command: `${guard(sb.home)} --cursor`, failClosed: true }],
    } }), result.out);
  if (fs.existsSync(file)) {
    const run = sb.run('/bin/sh', ['-c', read(file).hooks.beforeShellExecution[0].command], {
      input: JSON.stringify({ command: 'git push --no-verify --dry-run' }),
    });
    ok('Cursor can execute the installed launcher', denied(run, /agents may not run git push --no-verify/), run.out);
    const instructions = sb.packs(['install', 'cursor', '--yes']);
    ok('the Cursor instructions pack can add sessionStart beside the guard', instructions.code === 0, instructions.out);
    const active = partStatus(['--no-trust-check']);
    ok('pack status reports Cursor active even without the Codex trust check', active?.harness?.cursor === 'active', JSON.stringify(active));
    const broken = read(file);
    broken.hooks.beforeShellExecution[0].failClosed = false;
    write(file, broken);
    const missing = partStatus();
    ok('pack status reports a guard without failClosed missing and prints the repair command', missing?.harness?.cursor === 'not installed'
      && missing.details.some((d) => d.includes('acs packs update review-gate --replace')), JSON.stringify(missing));
    const repaired = sb.packs(['update', 'review-gate', '--replace', '--yes']);
    ok('the suggested repair restores failClosed without adding a duplicate', repaired.code === 0
      && read(file).hooks.beforeShellExecution.length === 1 && read(file).hooks.beforeShellExecution[0].failClosed === true, repaired.out);
    const legacy = read(file);
    legacy.hooks.beforeShellExecution[0].command = guard(sb.home);
    write(file, legacy);
    const legacyStatus = partStatus();
    ok('pack status reports the old launcher entry as needing repair', legacyStatus?.harness?.cursor === 'not installed'
      && legacyStatus.details.some((d) => d.includes('acs packs update review-gate --replace')), JSON.stringify(legacyStatus));
    const migrated = sb.packs(['update', 'review-gate', '--replace', '--yes']);
    legacy.hooks.beforeShellExecution[0].command += ' --cursor';
    ok('pack repair replaces the old launcher entry in place without adding a duplicate', migrated.code === 0
      && JSON.stringify(read(file)) === JSON.stringify(legacy), migrated.out);
    const removal = sb.json([...uninstall, '--dry-run']);
    ok('pack uninstall previews touching the Cursor config', removal.data?.preview.some((r) => r.path === file), removal.out);
    const removed = sb.packs([...uninstall, '--yes']);
    ok('uninstalling the guard leaves the installed sessionStart entry', removed.code === 0
      && read(file).hooks.sessionStart.length === 1 && !read(file).hooks.beforeShellExecution?.length, removed.out);
  }
}

{
  const sb = sandbox('cursor-guard-upgrade');
  const legacy = sb.packs([...install, '--yes']);
  ok('a Claude guard provides a previously installed runtime', legacy.code === 0, legacy.out);
  const runtimeHooks = path.dirname(guard(sb.home));
  const statePath = path.join(sb.home, '.agent-config-studio/packs/state.json');
  const state = read(statePath);
  for (const name of ['agent-guard.mjs', 'install-agent-guard.mjs']) {
    const file = path.join(runtimeHooks, name);
    fs.writeFileSync(file, 'throw new Error("old runtime");\n');
    state.runtime.files[file].hash = hashSnap(snapshot(file));
  }
  const helper = path.join(runtimeHooks, 'cursor-hooks.mjs');
  fs.rmSync(helper, { force: true });
  delete state.runtime.files[helper];
  write(statePath, state);
  fs.mkdirSync(path.dirname(hooks(sb.home)));
  const result = sb.packs([...install, '--yes']);
  ok('adding Cursor upgrades the recorded guard runtime before invoking its installer', result.code === 0
    && fs.existsSync(helper) && sb.state().packs['review-gate'].parts['agent-guard'].harnesses.join() === 'claude,cursor'
    && read(hooks(sb.home)).hooks.beforeShellExecution[0].failClosed === true, result.out);
}

{
  const sb = sandbox('cursor-guard-external');
  fs.mkdirSync(path.dirname(hooks(sb.home)));
  const onlyClaude = sb.packs([...install, '--harness', 'claude', '--yes']);
  ok('selecting Claude leaves an available Cursor config alone', onlyClaude.code === 0 && !fs.existsSync(hooks(sb.home)), onlyClaude.out);
  const installer = path.join(path.dirname(guard(sb.home)), 'install-agent-guard.mjs');
  const external = sb.run(process.execPath, [installer, 'install', '--no-claude', '--no-codex']);
  const removed = sb.packs([...uninstall, '--yes']);
  ok('pack uninstall preserves a separately installed Cursor guard and its runtime', external.code === 0 && removed.code === 0
    && fs.existsSync(guard(sb.home)) && fs.existsSync(hooks(sb.home)), removed.out);
}

{
  const sb = sandbox('cursor-guard-shared');
  const config = path.join(sb.home, '.claude/settings.json');
  write(config, { theme: 'dark' });
  fs.mkdirSync(path.dirname(hooks(sb.home)));
  fs.symlinkSync(config, hooks(sb.home));
  const installed = sb.packs([...install, '--harness', 'claude', '--yes']);
  const installer = path.join(path.dirname(guard(sb.home)), 'install-agent-guard.mjs');
  const cursor = (action) => sb.run(process.execPath, [installer, action, '--no-claude', '--no-codex']);
  const added = cursor('install');
  const removed = cursor('uninstall');
  ok('uninstalling Cursor from a shared config preserves Claude entries and the link', installed.code === 0
    && added.code === 0 && removed.code === 0 && fs.lstatSync(hooks(sb.home)).isSymbolicLink()
    && read(config).hooks?.PreToolUse?.length === 2 && !read(config).hooks.beforeShellExecution?.length, removed.out);
  const readded = cursor('install');
  const removeClaude = sb.packs([...uninstall, '--yes']);
  ok('uninstalling Claude from the shared config preserves the external Cursor hook', readded.code === 0
    && removeClaude.code === 0 && fs.existsSync(guard(sb.home))
    && read(config).hooks?.beforeShellExecution?.[0]?.failClosed === true && !read(config).hooks.PreToolUse?.length, removeClaude.out);
}

{
  const sb = sandbox('cursor-guard-home-link');
  fs.mkdirSync(path.dirname(hooks(sb.home)));
  const homeLink = path.join(sb.root, 'linked-home');
  fs.symlinkSync(sb.home, homeLink);
  const env = { HOME: homeLink };
  const installed = sb.packs([...install, '--harness', 'cursor', '--yes'], env);
  const result = sb.json(['status', '--no-trust-check'], env);
  const status = result.data?.packs.find((p) => p.id === 'review-gate').parts.find((p) => p.id === 'agent-guard');
  ok('pack status recognizes the installed Cursor guard through a linked home', installed.code === 0
    && status?.harness?.cursor === 'active', result.out);
}

assertRealHomesUnchanged(realBefore, ok);
done();
