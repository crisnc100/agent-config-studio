// `acs-agent watch`: follows a review's process tree through fake `ps`/`lsof`/`cmux` and fixture
// transcripts per harness, and must tell each model call's transcript apart by process, never by cwd.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir, track } from './fixtures/cleanup.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fakes = path.join(root, 'tests/fixtures/watch-fakes.mjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const models = JSON.parse(fs.readFileSync(path.join(root, 'models.default.json'), 'utf8')).models;
const line = x => JSON.stringify(x) + '\n';
// WATCH_CASE=<name> runs one case alone.
const want = name => !process.env.WATCH_CASE || process.env.WATCH_CASE === name;

function scenario() {
  const home = fs.realpathSync(tempDir('acs-watch-'));
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  for (const tool of ['ps', 'lsof', 'cmux']) {
    fs.writeFileSync(path.join(bin, tool), `#!${process.execPath}\nprocess.argv.splice(2, 0, ${JSON.stringify(tool)});\nimport(${JSON.stringify(fakes)});\n`, { mode: 0o755 });
  }
  const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, AGENT_TEST_MODE: '1', AGENT_TEST_POLL_MS: '40', AGENT_TEST_LINGER_MS: '0', AGENT_TEST_NO_TRANSCRIPT_MS: '400', CMUX_SOCKET_PATH: path.join(home, 'socket') };
  // The watcher is started detached by the gate: no pane of its own to identify.
  for (const key of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GROK_HOME', 'CMUX_SURFACE_ID', 'CMUX_WORKSPACE_ID', 'CMUX_PANEL_ID']) delete env[key];
  const s = {
    home, env,
    ps(rows) { fs.writeFileSync(path.join(home, 'fake-ps.json'), JSON.stringify(rows)); },
    lsof(map) { fs.writeFileSync(path.join(home, 'fake-lsof.json'), JSON.stringify(map)); },
    calls() {
      try { return fs.readFileSync(path.join(home, 'fake-cmux-calls.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; }
    },
    // Latest value per live key, from the fake cmux's log.
    statuses() {
      const live = new Map();
      for (const c of s.calls()) {
        const verb = c.find(a => a === 'set-status' || a === 'clear-status');
        if (!verb) continue;
        const pos = positionals(c, verb);
        if (verb === 'set-status') live.set(pos[0], pos[1]); else live.delete(pos[0]);
      }
      return live;
    },
    everSet() { return new Set(s.calls().filter(c => c.includes('set-status')).map(c => positionals(c, 'set-status')[0])); },
    cleared() { return new Set(s.calls().filter(c => c.includes('clear-status')).map(c => positionals(c, 'clear-status')[0])); },
    start(args, extra = {}) {
      const child = track(spawn(process.execPath, [path.join(root, 'bin/agent.mjs'), 'watch', ...args], { env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] }));
      let stderr = '';
      child.stderr.on('data', d => { stderr += d; });
      child.exited = new Promise(resolve => child.on('exit', code => resolve({ code, stderr })));
      return child;
    },
  };
  return s;
}
function positionals(call, verb) {
  const out = [];
  for (let i = call.indexOf(verb) + 1; i < call.length; i++) {
    if (call[i].startsWith('--')) { i++; continue; }
    out.push(call[i]);
  }
  return out;
}
async function until(what, fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = fn();
    if (value) return value;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}
async function finished(child, what) {
  const r = await Promise.race([child.exited, sleep(8000).then(() => null)]);
  assert.ok(r, `${what}: watcher did not exit after its run ended`);
  assert.equal(r.code, 0, `${what}: ${r.stderr}`);
  return r;
}
const statusValues = s => [...s.statuses().values()].sort();
const has = (s, re) => [...s.statuses().values()].some(v => re.test(v));
function noControlChars(text) { return !/[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/.test(text); }
function claudeCall(home, pid, sessionId, cwd, project = '-repo') {
  fs.mkdirSync(path.join(home, '.claude/sessions'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude/sessions', `${pid}.json`), JSON.stringify({ pid, sessionId, cwd, kind: 'sdk-cli' }));
  const file = path.join(home, '.claude/projects', project, `${sessionId}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, line({ type: 'user', cwd, sessionId, message: { role: 'user', content: 'review this diff' } }));
  return file;
}
const claudeTool = (name, input) => line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: `t${Math.random()}`, name, input }] } });
const claudeArgv = id => `claude -p review the diff --model ${id} --effort high --output-format json --tools Read,Grep,Glob`;

// Two concurrent same-cwd Claude calls (team lenses) plus a same-vendor security pass under the
// security worker: each key follows its own transcript.
if (want('claude')) {
  const s = scenario();
  const cwd = path.join(s.home, 'repo');
  fs.mkdirSync(cwd);
  const a = claudeCall(s.home, 40011, 'aaaa1111-0000-4000-8000-000000000001', cwd);
  const b = claudeCall(s.home, 40012, 'bbbb2222-0000-4000-8000-000000000002', cwd);
  const sec = claudeCall(s.home, 40021, 'cccc3333-0000-4000-8000-000000000003', cwd);
  // The operator's own session in the same project folder is never a candidate.
  claudeCall(s.home, 777, 'dddd4444-0000-4000-8000-000000000004', cwd);
  fs.appendFileSync(path.join(s.home, '.claude/projects/-repo/dddd4444-0000-4000-8000-000000000004.jsonl'), claudeTool('Read', { file_path: path.join(cwd, 'operator.js') }));
  fs.appendFileSync(a, claudeTool('Read', { file_path: path.join(cwd, 'lib/a.js') }));
  fs.appendFileSync(b, claudeTool('Grep', { pattern: 'needle', path: cwd }));
  fs.appendFileSync(sec, claudeTool('Read', { file_path: path.join(cwd, 'lib/secret.js') }));
  s.ps([
    { pid: 40000, ppid: 1, command: 'node /x/review.mjs' },
    { pid: 40011, ppid: 40000, command: claudeArgv(models.opus) },
    { pid: 40012, ppid: 40000, command: claudeArgv(models.sonnet) },
    { pid: 40020, ppid: 40000, command: 'node /x/review.mjs --security-worker /tmp/review-security-1/job.json' },
    { pid: 40021, ppid: 40020, command: claudeArgv(models.opus) },
    { pid: 777, ppid: 1, command: 'claude' },
  ]);
  const w = s.start(['--pid', '40000', '--kind', 'review', '--workspace', 'workspace:1']);
  await until('three live lines', () => s.statuses().size === 3 && statusValues(s).every(v => !/starting|running$/.test(v)));
  assert.deepEqual(statusValues(s), ['review · opus · <1m · read lib/a.js', 'review · sonnet · <1m · grep needle', 'security · opus · <1m · read lib/secret.js'].sort());
  const keyOf = re => [...s.statuses()].find(([, v]) => re.test(v))[0];
  const aKey = keyOf(/read lib\/a\.js/), bKey = keyOf(/grep needle/);
  fs.appendFileSync(a, claudeTool('Read', { file_path: path.join(cwd, 'lib/a2.js') }));
  await until('call A moves on', () => /read lib\/a2\.js$/.test(s.statuses().get(aKey)));
  assert.match(s.statuses().get(bKey), /grep needle$/);
  assert.ok(![...s.statuses().values()].some(v => /operator/.test(v)), 'the operator session never shows');
  for (const c of s.calls().filter(c => c.includes('set-status'))) {
    assert.ok(c.indexOf('set-status') < c.indexOf('--workspace') && c.indexOf('--workspace') < c.length - 3, 'flags come before the key and value');
    assert.match(positionals(c, 'set-status')[0], /^review-[A-Za-z0-9-]+-\d+$/);
  }
  assert.ok(!s.calls().some(c => c.includes('identify') || c.includes('focus-pane') || c.includes('new-pane')), 'sidebar mode: no pane, no pane context needed');
  // Lens A finishes first: its line goes, the others stay.
  s.ps([
    { pid: 40000, ppid: 1, command: 'node /x/review.mjs' },
    { pid: 40012, ppid: 40000, command: claudeArgv(models.sonnet) },
    { pid: 40020, ppid: 40000, command: 'node /x/review.mjs --security-worker /tmp/review-security-1/job.json' },
    { pid: 40021, ppid: 40020, command: claudeArgv(models.opus) },
    { pid: 777, ppid: 1, command: 'claude' },
  ]);
  await until('call A cleared', () => !s.statuses().has(aKey));
  assert.equal(s.statuses().size, 2);
  // The gate dies (Ctrl-C); the detached security worker is re-parented and its call keeps its line.
  s.ps([{ pid: 40020, ppid: 1, command: 'node /x/review.mjs --security-worker /tmp/review-security-1/job.json' }, { pid: 40021, ppid: 40020, command: claudeArgv(models.opus) }, { pid: 777, ppid: 1, command: 'claude' }]);
  await until('lens B cleared', () => s.statuses().size === 1);
  assert.match([...s.statuses().values()][0], /^security · opus/);
  await sleep(200);
  assert.equal(w.exitCode, null, 'the watcher waits for a CLI still running after the gate is gone');
  s.ps([{ pid: 777, ppid: 1, command: 'claude' }]);
  await finished(w, 'claude');
  assert.equal(s.statuses().size, 0, 'every key set is cleared on exit');
  assert.deepEqual(s.cleared(), s.everSet());
  assert.deepEqual(fs.readdirSync(path.join(s.home, '.agent-config-studio/runs')), [], 'the watcher removes its own run state');
  console.log('watch: concurrent same-cwd claude calls and a same-vendor security pass passed');
}

// Codex through its Node launcher: the native child holds the rollout open for writing. Hostile
// tool input (escape sequences, bidi overrides, huge text) is cleaned before it reaches cmux.
if (want('codex')) {
  const s = scenario();
  const cwd = path.join(s.home, 'repo');
  fs.mkdirSync(cwd);
  const sessions = path.join(s.home, '.codex/sessions/2026/11/16');
  fs.mkdirSync(sessions, { recursive: true });
  const mine = path.join(sessions, 'rollout-2026-11-16T10-00-00-0001.jsonl');
  const other = path.join(sessions, 'rollout-2026-11-16T10-00-00-0002.jsonl');
  fs.writeFileSync(mine, line({ type: 'session_meta', payload: { id: '0001', cwd } }));
  fs.writeFileSync(other, line({ type: 'session_meta', payload: { id: '0002', cwd } }) + line({ type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', 'cat other.js'] }) } }));
  const hostile = `cat \u001b[2J\u001b]0;pwned\u0007spoof‮evil -- --icon=x ${'z'.repeat(5000)}`;
  fs.appendFileSync(mine, line({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', input: `const r=await tools.exec_command({cmd:${JSON.stringify(hostile)},"max_output_tokens":1000});` } }));
  const codexArgv = (exe, id) => `${exe} exec -c mcp_servers={} -c model=${id} -c model_reasoning_effort=xhigh -s read-only --output-schema /tmp/s.json -o /tmp/o.json review the diff`;
  s.ps([
    { pid: 41000, ppid: 1, command: 'node /x/review.mjs' },
    { pid: 41001, ppid: 41000, command: codexArgv('node /opt/homebrew/bin/codex', models.sol) },
    { pid: 41002, ppid: 41001, command: codexArgv('/opt/homebrew/lib/node_modules/@openai/codex/vendor/aarch64-apple-darwin/codex/codex', models.sol) },
  ]);
  s.lsof({ 41002: [{ fd: '3r', mode: 'r', name: other }, { fd: '12w', mode: 'w', name: mine }] });
  const w = s.start(['--pid', '41000', '--kind', 'review', '--workspace', 'workspace:1']);
  await until('codex step', () => has(s, /^review · sol · <1m · run cat/));
  assert.equal(s.statuses().size, 1, 'launcher and native child are one call');
  const value = [...s.statuses().values()][0];
  assert.ok(noControlChars(value), JSON.stringify(value));
  assert.ok(value.length <= 120, `capped: ${value.length}`);
  assert.ok(!/other\.js/.test(value));
  fs.appendFileSync(mine, line({ type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', 'git diff --stat'] }) } }));
  await until('codex next step', () => has(s, /run git diff --stat$/));
  for (const c of s.calls()) for (const a of c) assert.ok(noControlChars(a), `no control characters reach cmux: ${JSON.stringify(a)}`);
  s.ps([]);
  await finished(w, 'codex');
  assert.equal(s.statuses().size, 0);
  console.log('watch: codex through a launcher child, escapes stripped passed');
}

// Grok under a real-style GROK_HOME (not the temp HOME the gate gives it), in a cwd with a space; a
// read-only handle to another session's events is ignored.
if (want('grok')) {
  const s = scenario();
  const grokHome = path.join(s.home, 'real-grok');
  const cwd = path.join(s.home, 'my repo');
  fs.mkdirSync(cwd);
  const group = path.join(grokHome, 'sessions', encodeURIComponent(cwd));
  const own = path.join(group, '01a1-own'), foreign = path.join(group, '01a1-foreign');
  for (const d of [own, foreign]) { fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'events.jsonl'), ''); }
  const update = (title, rawInput) => line({ method: 'session/update', params: { update: { sessionUpdate: 'tool_call', toolCallId: `c${Math.random()}`, title, rawInput } } });
  fs.writeFileSync(path.join(own, 'updates.jsonl'), update('read_file', { path: path.join(cwd, 'src/main.js') }));
  fs.writeFileSync(path.join(foreign, 'updates.jsonl'), update('read_file', { path: path.join(cwd, 'foreign.js') }));
  s.ps([
    { pid: 42000, ppid: 1, command: 'node /x/ask-model.mjs --role judge' },
    { pid: 42001, ppid: 42000, command: `grok -p judge this -m ${models.grok} --reasoning-effort high --cwd ${cwd} --tools read_file,list_dir,grep` },
  ]);
  s.lsof({ 42001: [{ fd: '9r', mode: 'r', name: path.join(foreign, 'events.jsonl') }, { fd: '11w', mode: 'w', name: path.join(own, 'events.jsonl') }] });
  const w = s.start(['--pid', '42000', '--kind', 'grade', '--workspace', 'workspace:1'], { GROK_HOME: grokHome });
  await until('grok step', () => has(s, /^grade · grok · <1m · read src\/main\.js$/));
  fs.appendFileSync(path.join(own, 'updates.jsonl'), update('grep', { pattern: 'TODO' }));
  await until('grok next step', () => has(s, /grep TODO$/));
  assert.ok(!has(s, /foreign/));
  s.ps([]);
  await finished(w, 'grok');
  assert.equal(s.statuses().size, 0);
  console.log('watch: grok under GROK_HOME passed');
}

// No transcript ever appears: the line says so honestly instead of guessing; the pane opens without
// taking focus, carries tagged lines, and closes at the end. A dead run's leftovers are swept first.
if (want('pane')) {
  const s = scenario();
  const runs = path.join(s.home, '.agent-config-studio/runs');
  fs.mkdirSync(runs, { recursive: true });
  fs.writeFileSync(path.join(runs, 'deadrun.json'), JSON.stringify({ version: 1, pid: 99001, kind: 'review' }));
  fs.writeFileSync(path.join(runs, 'deadrun.watch.json'), JSON.stringify({ version: 1, runId: 'deadrun', pid: 99001, watcherPid: 99002, workspace: 'workspace:1', keys: ['review-deadrun-1', 'review-deadrun-2'], surface: 'surface:5' }));
  fs.writeFileSync(path.join(runs, 'liverun.json'), JSON.stringify({ version: 1, pid: 43500, kind: 'review' }));
  fs.writeFileSync(path.join(runs, 'gate.json'), JSON.stringify({ version: 1, pid: 43000, kind: 'review', intent: 'fix check' }));
  s.ps([
    { pid: 43000, ppid: 1, command: 'node /x/review.mjs' },
    { pid: 43001, ppid: 43000, command: claudeArgv(models.fable) },
    { pid: 43500, ppid: 1, command: 'node /x/review.mjs' },
  ]);
  const w = s.start(['--pid', '43000', '--kind', 'review', '--workspace', 'workspace:1', '--pane']);
  await until('stale keys swept', () => s.cleared().has('review-deadrun-1') && s.cleared().has('review-deadrun-2'));
  assert.ok(s.calls().some(c => c.includes('close-surface') && c.includes('surface:5')), 'the dead run pane is closed');
  await until('dead run files removed', () => !fs.existsSync(path.join(runs, 'deadrun.json')) && !fs.existsSync(path.join(runs, 'deadrun.watch.json')));
  assert.ok(fs.existsSync(path.join(runs, 'liverun.json')), 'a live run is left alone');
  await until('starting line', () => has(s, /^fix check · fable · <1m · starting$/));
  await until('honest running line', () => has(s, /^fix check · fable · <1m · running$/));
  const pane = s.calls().find(c => c.includes('new-pane'));
  assert.ok(pane, 'pane mode opens a pane');
  assert.equal(pane[pane.indexOf('--focus') + 1], 'false');
  assert.ok(!s.calls().some(c => c.includes('focus-pane') || c.includes('identify')));
  const log = pane[pane.indexOf('--command') + 1].match(/'([^']+)'$/)[1];
  await until('pane line', () => /fix check · fable.*no transcript/.test(fs.readFileSync(log, 'utf8')));
  // A late session file is pid-specific evidence, not a guess: the call picks it up.
  const t = claudeCall(s.home, 43001, 'eeee5555-0000-4000-8000-000000000005', s.home);
  fs.appendFileSync(t, claudeTool('Glob', { pattern: '**/*.md' }));
  await until('late transcript', () => has(s, /glob \*\*\/\*\.md$/));
  assert.match(fs.readFileSync(log, 'utf8'), /\[fix check · fable\] glob \*\*\/\*\.md/);
  s.ps([{ pid: 43500, ppid: 1, command: 'node /x/review.mjs' }]);
  await finished(w, 'pane');
  assert.equal(s.statuses().size, 0);
  assert.ok(s.calls().some(c => c.includes('close-surface') && c.includes('surface:77')), 'the pane closes at the end');
  assert.ok(!fs.existsSync(path.join(runs, 'gate.json')), 'its own run file goes with it');
  console.log('watch: honest line, pane, stale sweep passed');
}

// Version probe for the gate, a bad pid, and a hung or missing cmux never fail the watcher.
if (want('args')) {
  const s = scenario();
  const probe = s.start(['--version']);
  assert.equal((await probe.exited).code, 0);
  const bad = s.start(['--pid', 'x', '--kind', 'review', '--workspace', 'workspace:1']);
  assert.equal((await bad.exited).code, 2);
  const badKind = s.start(['--pid', '1', '--kind', '--rm', '--workspace', 'workspace:1']);
  assert.equal((await badKind.exited).code, 2);
  s.ps([{ pid: 44000, ppid: 1, command: 'node /x/review.mjs' }, { pid: 44001, ppid: 44000, command: claudeArgv(models.opus) }]);
  const w = s.start(['--pid', '44000', '--kind', 'review', '--workspace', 'workspace:1'], { FAKE_CMUX_FAIL: '1' });
  await until('cmux attempted', () => s.calls().some(c => c.includes('set-status')));
  s.ps([]);
  await finished(w, 'cmux down');
  console.log('watch: version, bad args, cmux down passed');
}
