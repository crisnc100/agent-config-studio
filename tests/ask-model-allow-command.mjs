/**
 * --allow-command: a native agy build's task commands, compiled into one session --settings allow list. Offline only:
 * argvFor and the list check in process (HOME is a temp folder before ask-model is imported), ask-model from this
 * checkout against a fake agy on PATH with a temp HOME, and both build skills' launch blocks under strict bash and zsh
 * against a recording ask-model stub. No model CLI is started.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { tempDir } from './fixtures/cleanup.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.HOME = fs.realpathSync(tempDir('acs-allow-command-import-'));
const { allowCommandsProblem, argvFor } = await import(path.join(ROOT, 'tools', 'ask-model.mjs'));
const MODELS = JSON.parse(fs.readFileSync(path.join(ROOT, 'models.default.json'), 'utf8')).models;
const NEON = MODELS.neon;
const ASK = path.join(ROOT, 'tools', 'ask-model.mjs');

// The rules the scoped live probes passed to agy by hand (builds/neon-build-refusals/log.md); the wrapper compiles the same shape.
const PROBE_COMMANDS = ['node test.cjs', 'git add value.cjs', 'git commit -m "Neon fixture edit"', 'node boundary-probe.cjs'];
const PROBE_SETTINGS = '{"permissions":{"allow":["command(node test.cjs)","command(git add value.cjs)",'
  + '"command(git commit -m \\"Neon fixture edit\\")","command(node boundary-probe.cjs)"]}}';
const PREAMBLE = 'You are the implementer for this task. Do not invoke other models, delegate, or run reviews or grades. '
  + 'Do not push, open a pull request, or merge. Follow the task and report what you changed and checked.\n\n';
const BRIEF = 'Fixture brief.\n';
const ALLOWED = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 _-./:=@,+"\'';

const base = { id: NEON, effort: 'high', prompt: 'P', cwd: '/w', logFile: '/l/agy.log' };
const plainBuild = ['-p', 'P', '--model', NEON, '--effort', 'high', '--output-format', 'stream-json', '--print-timeout', '1800s',
  '--disable-slash-commands', '--mode', 'accept-edits', '--log-file', '/l/agy.log'];
const readOnly = ['-p', 'P', '--model', NEON, '--effort', 'high', '--output-format', 'stream-json', '--print-timeout', '1800s',
  '--disable-slash-commands', '--settings',
  '{"permissions":{"deny":["command(*)","write_file(*)","mcp(*)","read_url(*)","download_url(*)","execute_url(*)"]}}', '--log-file', '/l/agy.log'];
const unsafe = (argv) => argv.filter((a) => /--sandbox|skip-permissions|bypass|^auto$|^--yolo$/.test(a));

test('without commands the build argv is unchanged, and no other mode or vendor takes one', () => {
  assert.deepEqual(argvFor('agy', { ...base, mode: 'build' }), plainBuild);
  assert.deepEqual(argvFor('agy', { ...base, mode: 'build', allowCommands: [] }), plainBuild);
  assert.deepEqual(argvFor('agy', { ...base, mode: 'read-only' }), readOnly);
  assert.deepEqual(argvFor('agy', { ...base, mode: 'read-only', allowCommands: [] }), readOnly);
  for (const [vendor, mode] of [['agy', 'read-only'], ['claude', 'read-only'], ['claude', 'investigate'], ['codex', 'read-only'], ['grok', 'read-only']]) {
    assert.throws(() => argvFor(vendor, { ...base, mode, allowCommands: ['node test.cjs'] }), /--allow-command is only for an agy --build/, `${vendor} ${mode}`);
  }
});

test('commands become one --settings allow list, in order, beside accept-edits and nothing else', () => {
  const argv = argvFor('agy', { ...base, mode: 'build', allowCommands: PROBE_COMMANDS });
  assert.deepEqual(argv, ['-p', 'P', '--model', NEON, '--effort', 'high', '--output-format', 'stream-json', '--print-timeout', '1800s',
    '--disable-slash-commands', '--mode', 'accept-edits', '--settings', PROBE_SETTINGS, '--log-file', '/l/agy.log']);
  assert.deepEqual(JSON.parse(PROBE_SETTINGS), { permissions: { allow: PROBE_COMMANDS.map((c) => `command(${c})`) } });
  assert.equal(argv.filter((a) => a === '--settings').length, 1);
  assert.deepEqual(unsafe(argv), []);
  for (const bad of [['node test.cjs; git push'], ['a', 'a'], Array.from({ length: 17 }, (_, i) => `node t${i}.cjs`), [42]]) {
    assert.throws(() => argvFor('agy', { ...base, mode: 'build', allowCommands: bad }), /--allow-command/, JSON.stringify(bad));
  }
});

test('the list check takes only the closed character set, trimmed, 1 to 512 characters, at most 16, no repeats', () => {
  for (let code = 0; code < 128; code++) {
    const ch = String.fromCharCode(code);
    const got = allowCommandsProblem([`run${ch}x`]);
    if (ALLOWED.includes(ch)) assert.equal(got, null, JSON.stringify(ch));
    else assert.match(got, /holds a character other than letters, digits, spaces and _ - \. \/ : = @ , \+ " '$/, JSON.stringify(ch));
  }
  for (const ch of ['é', ' ', ' ', '​', '＊', '\u{1f600}']) assert.match(allowCommandsProblem([`run${ch}x`]), /holds a character other than/, ch);
  assert.equal(allowCommandsProblem([]), null);
  assert.equal(allowCommandsProblem(PROBE_COMMANDS), null);
  assert.equal(allowCommandsProblem(['x'.repeat(512)]), null);
  assert.equal(allowCommandsProblem(['git  add  -A']), null, 'inner spaces are kept as given');
  assert.match(allowCommandsProblem(['x'.repeat(513)]), /takes 1 to 512 characters, not 513$/);
  assert.match(allowCommandsProblem(['']), /takes 1 to 512 characters, not 0$/);
  for (const c of [' node test.cjs', 'node test.cjs ', ' ']) assert.match(allowCommandsProblem([c]), /starts or ends with a space$/, JSON.stringify(c));
  const sixteen = Array.from({ length: 16 }, (_, i) => `node t${i}.cjs`);
  assert.equal(allowCommandsProblem(sixteen), null);
  assert.match(allowCommandsProblem([...sixteen, 'node t16.cjs']), /is given 17 times; at most 16 commands$/);
  assert.match(allowCommandsProblem(['git add -A', 'node test.cjs', 'git add -A']), /"git add -A" is given twice$/);
  for (const c of [1, null, undefined, ['node test.cjs'], { c: 'node' }]) assert.match(allowCommandsProblem([c]), /takes a command string$/, JSON.stringify(c));
  assert.match(allowCommandsProblem('node test.cjs'), /takes a list of command strings$/);
});

function fixture(t) {
  const dir = fs.realpathSync.native(tempDir('acs-allow-command-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home');
  const work = path.join(dir, 'work');
  const stubs = path.join(dir, 'stubs');
  const tmp = path.join(dir, 'tmp');
  for (const d of [home, work, stubs, tmp]) fs.mkdirSync(d);
  const env = { HOME: home, PATH: `${stubs}:/usr/bin:/bin`, TMPDIR: tmp, GIT_CONFIG_NOSYSTEM: '1' };
  assert.equal(spawnSync('/usr/bin/git', ['init', '-q'], { cwd: work, env }).status, 0);
  const prompt = path.join(dir, 'brief.md');
  fs.writeFileSync(prompt, BRIEF);
  const marks = { call: path.join(dir, 'agy-call.json'), version: path.join(dir, 'agy-version'), other: path.join(dir, 'other-cli') };
  fs.writeFileSync(path.join(stubs, 'agy'), `#!${process.execPath}
const fs = require('node:fs');
const argv = process.argv.slice(2);
if (argv[0] === '--version') { fs.writeFileSync(${JSON.stringify(marks.version)}, ''); console.log('1.5.14'); process.exit(0); }
const at = (flag) => argv[argv.indexOf(flag) + 1];
fs.writeFileSync(${JSON.stringify(marks.call)}, JSON.stringify(argv));
fs.writeFileSync(at('--log-file'), 'fixture keychain log');
const events = [
  { event: 'init', init: { model: at('--model') } },
  { event: 'step_update', step_update: { step_index: 0, state: 'ACTIVE', tool_name: 'write_to_file', tool_info: { parameters: { TargetFile: './source.txt' } } } },
  { event: 'step_update', step_update: { step_index: 0, state: 'DONE', tool_name: 'write_to_file' } },
  ...(process.env.FAKE_AGY === 'denied' ? [{ event: 'step_update', step_update: {
    step_index: 1, state: 'ERROR', tool_name: 'run_command', tool_info: { error: { message: 'permission check failed: Matches user-configured deny rule' } },
  } }] : []),
  { event: 'result', result: { status: 'SUCCESS', response: 'fixture answer' } },
];
console.log(events.map((e) => JSON.stringify(e)).join('\\n'));
`, { mode: 0o700 });
  for (const cli of ['claude', 'codex', 'grok']) fs.writeFileSync(path.join(stubs, cli), `#!/bin/sh\ntouch "${marks.other}"\nexit 93\n`, { mode: 0o700 });
  const ask = (args, { build = true, family = ['--family', 'neon'], kind = 'clean' } = {}) => {
    for (const m of Object.values(marks)) fs.rmSync(m, { force: true });
    const r = spawnSync(process.execPath, [ASK, ...family, '--prompt-file', prompt, ...(build ? ['--build'] : []), '--cwd', work, '--json', ...args],
      { cwd: work, env: { ...env, FAKE_AGY: kind }, encoding: 'utf8', timeout: 15_000 });
    assert.ifError(r.error);
    return r;
  };
  const started = () => Object.values(marks).filter((m) => fs.existsSync(m)).map((m) => path.basename(m));
  const agyArgv = () => JSON.parse(fs.readFileSync(marks.call, 'utf8'));
  return { ask, started, agyArgv, work, tmp };
}
const grants = (commands) => commands.flatMap((c) => ['--allow-command', c]);

test('each refused value, count, repeat, missing --build and non-agy family exits 64 before any CLI starts', (t) => {
  const f = fixture(t);
  const refusedChar = /holds a character other than letters, digits, spaces and _ - \. \/ : = @ , \+ " '/;
  const cases = [
    ['without --build', grants(['node test.cjs']), { build: false }, /--allow-command is only for --build/],
    ['without --build, another vendor', grants(['node test.cjs']), { build: false, family: ['--family', 'fable'] }, /--allow-command is only for --build/],
    ['a codex family', grants(['node test.cjs']), { family: ['--family', 'sol'] }, /--build uses the agy builder.*codex/],
    ['a claude family', grants(['node test.cjs']), { family: ['--family', 'fable'] }, /--build uses the agy builder.*claude/],
    ['a role other than builder', grants(['node test.cjs']), { family: ['--role', 'advisor'] }, /--build only accepts the builder role/],
    ['no value', ['--allow-command'], {}, /--allow-command needs a value/],
    ['a flag for its value', ['--allow-command', '--effort', 'high'], {}, /--allow-command needs a value/],
    ['an empty value', grants(['']), {}, /takes 1 to 512 characters, not 0/],
    ['513 characters', grants(['x'.repeat(513)]), {}, /takes 1 to 512 characters, not 513/],
    ['a leading space', grants([' node test.cjs']), {}, /starts or ends with a space/],
    ['a trailing space', grants(['node test.cjs ']), {}, /starts or ends with a space/],
    ['17 commands', grants(Array.from({ length: 17 }, (_, i) => `node t${i}.cjs`)), {}, /is given 17 times; at most 16 commands/],
    ['a repeat', grants(['git add -A', 'git add -A']), {}, /"git add -A" is given twice/],
    ...[
      ['a wildcard', 'npm test *'], ['a question mark', 'ls ?.cjs'], ['brackets', 'ls [ab].cjs'], ['braces', 'ls {a,b}.cjs'], ['a tilde', 'cat ~/x'],
      ['parentheses', 'node test.cjs) command(git push'], ['a semicolon', 'node test.cjs; git push'], ['an ampersand', 'node test.cjs && git push'],
      ['a pipe', 'node test.cjs | tee out'], ['redirection out', 'node test.cjs > out'], ['redirection in', 'node test.cjs < in'],
      ['a dollar', 'echo $HOME'], ['a backtick', 'echo `id`'], ['a backslash', 'node test\\.cjs'], ['a newline', 'node test.cjs\ngit push'],
      ['a tab', 'node\ttest.cjs'], ['a carriage return', 'node test.cjs\rgit push'], ['an escape', 'node test.cjs\x1b[0m'], ['a bang', 'git commit -m "done!"'],
      ['a hash', 'node test.cjs # x'], ['a percent', 'node %x'], ['a caret', 'git show HEAD^'], ['non-ASCII', 'node café.cjs'],
    ].map(([label, c]) => [label, grants(['git add -A', c]), {}, refusedChar]),
  ];
  for (const [label, args, opts, message] of cases) {
    const r = f.ask(args, opts);
    assert.equal(r.status, 64, `${label}: ${r.stderr}`);
    assert.match(r.stderr, message, label);
    assert.equal(r.stdout, '', label);
    assert.deepEqual(f.started(), [], `${label}: no CLI was started`);
  }
});

test('without the flag the build argv and prompt are byte for byte what they were', (t) => {
  const f = fixture(t);
  const r = f.ask(['--effort', 'high']);
  assert.equal(r.status, 0, r.stderr);
  const argv = f.agyArgv();
  const log = argv[argv.indexOf('--log-file') + 1];
  assert.deepEqual(argv, ['-p', PREAMBLE + BRIEF, '--model', NEON, '--effort', 'high', '--output-format', 'stream-json', '--print-timeout', '1800s',
    '--disable-slash-commands', '--mode', 'accept-edits', '--log-file', log]);
});

test('granted commands reach agy as session rules and the prompt lists them verbatim, with an unchanged receipt', (t) => {
  const f = fixture(t);
  const plain = f.ask(['--effort', 'high']);
  assert.equal(plain.status, 0, plain.stderr);
  const plainDoc = JSON.parse(plain.stdout);
  const r = f.ask(['--effort', 'high', ...grants(PROBE_COMMANDS)]);
  assert.equal(r.status, 0, r.stderr);
  const argv = f.agyArgv();
  const log = argv[argv.indexOf('--log-file') + 1];
  const list = PROBE_COMMANDS.map((c) => `- \`${c}\``).join('\n');
  assert.deepEqual(argv, ['-p', argv[1], '--model', NEON, '--effort', 'high', '--output-format', 'stream-json', '--print-timeout', '1800s',
    '--disable-slash-commands', '--mode', 'accept-edits', '--settings', PROBE_SETTINGS, '--log-file', log]);
  assert.deepEqual(unsafe(argv), []);
  assert.ok(argv[1].startsWith(PREAMBLE), 'the usual preamble comes first');
  assert.ok(argv[1].endsWith(`\n${list}\n\n${BRIEF}`), 'each command on its own line, verbatim and in order, before the brief');
  assert.match(argv[1], /run it exactly as written/);
  assert.match(argv[1], /A different command may be refused, and any refused action fails the build/);
  assert.doesNotMatch(argv[1], /(?:all|every|any) other commands? (?:is|are|will be) refused|anything else is refused|only these/i);

  const doc = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(doc).sort(), Object.keys(plainDoc).sort(), 'no receipt field is added');
  assert.deepEqual(doc.build, { execution: 'native', completed: true });
  assert.equal(doc.served.verified, false);
  for (const c of [...PROBE_COMMANDS, 'command(']) assert.ok(!r.stdout.includes(c), `the receipt does not carry ${c}`);
  assert.deepEqual(fs.readdirSync(f.tmp), []);

  const most = Array.from({ length: 16 }, (_, i) => `node t${String(i).padStart(2, '0')} ${'x'.repeat(503)}`);
  assert.ok(most.every((c) => c.length === 512));
  const full = f.ask(grants(most));
  assert.equal(full.status, 0, full.stderr);
  const fullArgv = f.agyArgv();
  assert.deepEqual(JSON.parse(fullArgv[fullArgv.indexOf('--settings') + 1]), { permissions: { allow: most.map((c) => `command(${c})`) } });
});

test('a refused action still fails the build when commands were granted', (t) => {
  const f = fixture(t);
  const r = f.ask(grants(PROBE_COMMANDS), { kind: 'denied' });
  assert.equal(r.status, 4, r.stderr);
  const doc = JSON.parse(r.stdout);
  assert.match(doc.error, /^agy refused 1 of the builder's action\(s\), so the build is not complete\. Inspect the worktree/);
  assert.equal(doc.answer, null);
  assert.ok(!Object.hasOwn(doc, 'build'));
  assert.deepEqual(doc.denied, ['run_command: blocked by deny rule']);
  assert.equal(f.agyArgv()[f.agyArgv().indexOf('--settings') + 1], PROBE_SETTINGS);
});

// ── the build skills' launch: an optional array of task commands, expanded safely under strict shells ──
function blocks(skill, prefix) {
  const found = [...skill.matchAll(/^```bash\n([\s\S]*?)\n^```$/gm)].map((m) => m[1]).filter((b) => b.startsWith(prefix));
  assert.equal(found.length, 1, prefix);
  return found[0];
}
const SHELLS = [['/bin/bash', ['-euo', 'pipefail']], ['/bin/zsh', ['-f', '-euo', 'pipefail']]].filter(([sh]) => fs.existsSync(sh));

for (const harness of ['claude', 'codex']) {
  test(`${harness} build skill: the launch adds one --allow-command per task command and none when unset or empty`, (t) => {
    const skill = fs.readFileSync(path.join(ROOT, 'packs/build/skills', harness, 'build/SKILL.md'), 'utf8');
    const example = blocks(skill, 'ALLOWED_COMMANDS=(');
    const launch = blocks(skill, 'WORKTREE=$(git rev-parse');
    for (const [family, id] of Object.entries(MODELS)) {
      for (const block of [example, launch]) {
        assert.ok(!block.includes(id), `${harness}: no model id in the launch blocks (${id})`);
        assert.doesNotMatch(block, new RegExp(`\\b${family}\\b`, 'i'), `${harness}: no family name in the launch blocks (${family})`);
      }
    }
    const printed = spawnSync('/bin/bash', ['-euo', 'pipefail', '-c', `${example}\nprintf '%s\\0' "\${ALLOWED_COMMANDS[@]}"`], { encoding: 'utf8', env: {} });
    assert.equal(printed.status, 0, printed.stderr);
    const exampleCommands = printed.stdout.split('\0').slice(0, -1);
    assert.ok(exampleCommands.length >= 3, 'the example shows a check, staging and a commit');
    assert.equal(allowCommandsProblem(exampleCommands), null, 'the example passes ask-model\'s check');

    const dir = fs.realpathSync.native(tempDir('acs-allow-command-skill-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const bin = path.join(dir, 'bin');
    const work = path.join(dir, 'fixture worktree');
    for (const d of [bin, work]) fs.mkdirSync(d);
    const record = path.join(dir, 'ask-model.json');
    fs.writeFileSync(path.join(bin, 'ask-model'), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o755 });
    const env = { HOME: dir, PATH: `${bin}:/usr/bin:/bin`, BUILDER: 'fixture-builder', EFFORT: '', BRIEF_FILE: path.join(work, 'phase brief.md'), GIT_CONFIG_NOSYSTEM: '1' };
    assert.equal(spawnSync('/usr/bin/git', ['init', '-q'], { cwd: work, env }).status, 0);
    const head = ['--family', 'fixture-builder', '--build', '--cwd', work, '--effort', '', '--prompt-file', env.BRIEF_FILE];
    for (const [sh, options] of SHELLS) {
      for (const [label, setup, expected] of [
        ['unset', '', []],
        ['empty', 'ALLOWED_COMMANDS=()', []],
        ['the example', example, grants(exampleCommands)],
        ['spaces and both quotes', `ALLOWED_COMMANDS=('node --test "tests/a b.test.mjs"' "git commit -m 'Fix the parser'")`,
          grants(['node --test "tests/a b.test.mjs"', "git commit -m 'Fix the parser'"])],
      ]) {
        fs.rmSync(record, { force: true });
        const r = spawnSync(sh, [...options, '-c', `${setup}\n${launch}`], { cwd: work, env, encoding: 'utf8', timeout: 10_000 });
        assert.equal(r.status, 0, `${harness} ${sh} ${label}: ${r.stderr}`);
        assert.deepEqual(JSON.parse(fs.readFileSync(record, 'utf8')), [...head, ...expected, '--json'], `${harness} ${sh} ${label}`);
      }
    }
  });
}
