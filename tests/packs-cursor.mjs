import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, sandbox, tests } from './fixtures/packs-sandbox.mjs';

const { ok, done } = tests();
const install = ['install', 'cursor', '--yes'];
const uninstall = ['uninstall', 'cursor', '--yes'];
const hooksPath = (home) => path.join(home, '.cursor', 'hooks.json');
const runtime = (home) => path.join(home, '.agent-config-studio', 'cursor', 'hooks');
const read = (p) => fs.readFileSync(p, 'utf8');
const write = (p, value) => fs.writeFileSync(p, JSON.stringify(value));
const equal = (name, actual, expected) => { assert.deepEqual(actual, expected); ok(name, true); };
const status = (sb, env) => sb.json(['status', '--no-trust-check'], env).data.packs.find((p) => p.id === 'cursor').parts[0];

{
  const sb = sandbox('cursor-empty', { clis: [], modelId: false });
  const home = path.join(sb.root, "home with 'quotes'");
  fs.renameSync(sb.home, home);
  const env = { HOME: home };
  const hooks = hooksPath(home);
  const dir = runtime(home);
  const launcher = path.join(dir, 'session-context');
  const agreement = path.join(home, '.claude', 'CLAUDE.md');

  const preview = sb.packs(['install', 'cursor', '--dry-run'], env);
  ok('preview describes the hook and its runtime files before writing', preview.code === 0
    && preview.out.includes('hooks.json') && preview.out.includes('session-context') && preview.out.includes('cursor-note.md')
    && !fs.existsSync(hooks) && !fs.existsSync(dir), preview.out);
  const result = sb.packs(install, env);
  ok('install succeeds in an empty home', result.code === 0, result.out);
  const command = `'${launcher.replaceAll("'", "'\\''")}'`;
  const config = { version: 1, hooks: { sessionStart: [{ command }] } };
  equal('a new hooks file has one sessionStart entry with an absolute shell command', JSON.parse(read(hooks)), config);
  equal('Cursor installs no review-gate runtime or harness skills', JSON.parse(read(path.join(home, '.agent-config-studio', 'packs', 'state.json'))).runtime, null);
  equal('status reports the installed part', status(sb, env).statuses, ['installed']);

  const invoke = () => sb.run('/bin/sh', ['-c', command], { input: '{"session_id":"stub"}\n', extra: { ...env, PATH: '/usr/bin:/bin' } });
  const checkOutput = (label, output) => {
    const r = invoke();
    equal(label, [r.code, r.stdout, r.stderr], [0, `${JSON.stringify(output)}\n`, '']);
  };
  checkOutput('missing working agreement yields one empty object', {});
  fs.mkdirSync(agreement, { recursive: true });
  checkOutput('unreadable working agreement yields one empty object', {});
  fs.rmdirSync(agreement);
  const live = `# Working agreement\n${'Full working agreement in UTF-8 — keep every line.\n'.repeat(600)}`;
  fs.writeFileSync(agreement, live);
  const shippedNote = read(path.join(ROOT, 'packs', 'cursor', 'session', 'cursor-note.md'));
  checkOutput('Dock-like PATH uses installed Node and emits the full agreement and note', { additional_context: `${live}\n\n${shippedNote}` });
  fs.writeFileSync(agreement, 'changed agreement\n');
  fs.writeFileSync(path.join(dir, 'cursor-note.md'), 'changed installed note\n');
  checkOutput('each session reads both files live', { additional_context: 'changed agreement\n\n\nchanged installed note\n' });
  equal('status reports edited runtime files', status(sb, env).statuses, ['edited by you']);
  fs.writeFileSync(path.join(dir, 'node-path'), '/absent/node\n');
  const fallback = sb.run('/bin/sh', ['-c', command], { input: '{}', extra: { ...env, PATH: sb.env.PATH } });
  equal('the launcher falls back to node on PATH', JSON.parse(fallback.stdout), { additional_context: 'changed agreement\n\n\nchanged installed note\n' });

  write(hooks, { version: 1, hooks: { sessionEnd: [{ command: 'leave' }] } });
  ok('status reports a removed entry', status(sb, env).statuses.includes('installed but not working'));
  ok('ordinary update keeps an edited config and note', sb.packs(['update', 'cursor', '--yes'], env).code === 0
    && JSON.parse(read(hooks)).hooks.sessionStart === undefined && read(path.join(dir, 'cursor-note.md')) === 'changed installed note\n');
  const repair = sb.packs(['update', 'cursor', '--replace', '--yes'], env);
  ok('update --replace repairs the entry and the note', repair.code === 0 && read(path.join(dir, 'cursor-note.md')) === shippedNote, repair.out);
  equal('repair preserves other events', JSON.parse(read(hooks)).hooks, { sessionEnd: [{ command: 'leave' }], sessionStart: [{ command }] });
  ok('uninstall succeeds after repair', sb.packs(uninstall, env).code === 0);
  equal('uninstall after repair strips only the added entry', JSON.parse(read(hooks)).hooks, { sessionEnd: [{ command: 'leave' }], sessionStart: [] });
  ok('uninstall removes the launcher', !fs.existsSync(launcher));
}

{
  const sb = sandbox('cursor-launcher-mode', { clis: [], modelId: false });
  const dir = runtime(sb.home);
  const launcher = path.join(dir, 'session-context');
  const mode = (file) => fs.statSync(file).mode & 0o777;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(launcher, 'original launcher\n', { mode: 0o600 });
  fs.chmodSync(launcher, 0o600);

  ok('install sets the launcher mode to 0755', sb.packs(install).code === 0 && mode(launcher) === 0o755);
  const installed = read(launcher);
  const siblingFiles = ['session-context.mjs', 'cursor-note.md', 'node-path'].map((name) => path.join(dir, name));
  siblingFiles.push(hooksPath(sb.home));
  const siblingState = () => siblingFiles.map((file) => [read(file), mode(file), fs.statSync(file).ino]);
  const siblings = siblingState();
  fs.chmodSync(launcher, 0o644);

  const broken = status(sb);
  ok('status reports a non-executable launcher and gives the repair command', broken.statuses.includes('installed but not working')
    && broken.details.some((detail) => detail.includes('session-context') && detail.includes('acs packs update cursor --replace')), JSON.stringify(broken));
  const update = sb.packs(['update', 'cursor', '--yes']);
  ok('ordinary update keeps the launcher mode', update.code === 0 && mode(launcher) === 0o644, update.out);
  const repair = sb.packs(['update', 'cursor', '--replace', '--yes']);
  ok('update --replace restores the launcher mode with identical bytes', repair.code === 0 && mode(launcher) === 0o755
    && read(launcher) === installed, repair.out);
  equal('mode repair leaves the other installed files untouched', siblingState(), siblings);
  equal('status reports the repaired part as installed', status(sb).statuses, ['installed']);
  ok('uninstall restores the original launcher bytes and mode', sb.packs(uninstall).code === 0
    && read(launcher) === 'original launcher\n' && mode(launcher) === 0o600);
}

{
  const sb = sandbox('cursor-existing', { clis: [], modelId: false });
  const hooks = hooksPath(sb.home);
  fs.mkdirSync(path.dirname(hooks));
  const commands = [{ command: 'launch', timeout: 2 }, { command: 'next' }];
  const events = { sessionStart: commands, preToolUse: [{ command: 'protect', matcher: 'Shell' }] };
  const original = { version: 1, hooks: events, marker: { keep: true } };
  const bytes = `${JSON.stringify(original)}\n`;
  fs.writeFileSync(hooks, bytes, { mode: 0o600 });
  const command = path.join(runtime(sb.home), 'session-context');
  ok('install succeeds with other sessionStart entries and other hook events', sb.packs(install).code === 0);
  const installed = { ...original, hooks: { ...events, sessionStart: [...commands, { command }] } };
  equal('merge keeps the existing keys, event order and hook options', JSON.parse(read(hooks)), installed);
  equal('merge keeps the hooks file mode', fs.statSync(hooks).mode & 0o777, 0o600);
  const recorded = structuredClone(sb.state());
  ok('reinstall succeeds', sb.packs(install).code === 0);
  equal('reinstall changes neither the hook count nor the ownership record', [JSON.parse(read(hooks)), sb.state()], [installed, recorded]);
  ok('uninstall succeeds when the file has not changed', sb.packs(uninstall).code === 0);
  equal('uninstall restores exact original bytes', read(hooks), bytes);
  ok('a fresh reinstall after uninstall succeeds', sb.packs(install).code === 0);
  const handEdited = { ...installed, hooks: { ...installed.hooks, sessionStart: [{ command, timeout: 6 }, ...installed.hooks.sessionStart, { command: 'later' }] } };
  write(hooks, handEdited);
  ok('uninstall succeeds when other hooks were added', sb.packs(uninstall).code === 0);
  equal('surgical uninstall preserves all other entries, including an authored variant with the launcher command', JSON.parse(read(hooks)), {
    ...handEdited, hooks: { ...events, sessionStart: [{ command, timeout: 6 }, ...commands, { command: 'later' }] },
  });
}

{
  const sb = sandbox('cursor-malformed', { clis: [], modelId: false });
  const hooks = hooksPath(sb.home);
  const dir = runtime(sb.home);
  fs.mkdirSync(path.dirname(hooks));
  fs.writeFileSync(hooks, '{"hooks":');
  const bad = sb.packs(install);
  ok('invalid JSON refuses installation with a clear error before writing', bad.code !== 0 && /hooks\.json is not valid JSON/.test(bad.out)
    && read(hooks) === '{"hooks":' && !fs.existsSync(dir), bad.out);
  fs.rmSync(hooks);
  ok('retry works after malformed JSON is fixed', sb.packs(install).code === 0);
  const saved = read(hooks);
  fs.writeFileSync(hooks, 'bad again');
  const remove = sb.packs(uninstall);
  ok('invalid JSON refuses uninstall and leaves the part intact', remove.code !== 0 && /hooks\.json is not valid JSON/.test(remove.out)
    && read(hooks) === 'bad again' && fs.existsSync(dir) && !!sb.state().packs.cursor, remove.out);
  fs.writeFileSync(hooks, saved);
  ok('uninstall from an unchanged file created by the pack removes that file', sb.packs(uninstall).code === 0 && !fs.existsSync(hooks));
}

{
  const sb = sandbox('cursor-files', { clis: [], modelId: false });
  const hooks = hooksPath(sb.home);
  const folder = path.dirname(hooks);
  fs.mkdirSync(folder);
  fs.writeFileSync(hooks, '{"version":1}');
  fs.writeFileSync(path.join(folder, 'cli-config.json'), '{"model":"auto"}');
  for (const name of ['mcp.json', 'auth.json', '.credentials.json']) {
    const renamed = path.join(folder, `${name.replaceAll('.', '-')}-store`);
    fs.writeFileSync(renamed, '{"token":"fixture"}');
    fs.symlinkSync(renamed, path.join(folder, name));
  }
  const r = sb.run(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import path from 'node:path';
    import { buildRegistry } from './lib/registry.js';
    import { assertWritable, currentRoots, readUserText, resolveSafe } from './lib/paths.js';
    const home = path.join(process.env.HOME, '.cursor');
    assert.ok(currentRoots().safeRoots.includes(home));
    const settings = buildRegistry().groups.find((g) => g.id === 'settings').entries;
    assert.deepEqual(settings.filter((e) => e.harness === 'cursor').flatMap((e) => e.files.map((f) => f.path)), ['hooks.json', 'cli-config.json'].map((f) => path.join(home, f)));
    assert.equal(readUserText(resolveSafe('~/.cursor/hooks.json')), '{"version":1}');
    for (const name of ['mcp.json', 'auth.json', '.credentials.json']) {
      assert.throws(() => resolveSafe(path.join(home, name)), { status: 403 });
      const renamed = path.join(home, name.replaceAll('.', '-') + '-store');
      assert.throws(() => readUserText(renamed), { status: 403 });
      assert.throws(() => assertWritable(renamed), { status: 403 });
    }
  `], { cwd: ROOT });
  ok('Files exposes the safe config and refuses Cursor credentials by name and inode', r.code === 0, r.out);
}

done();
