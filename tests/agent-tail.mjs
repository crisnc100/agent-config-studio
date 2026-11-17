// `acs-agent tail` and the watcher's log-only mode: a review outside cmux still gets its log, and any
// terminal can follow it. The gate processes are real (tail asks the OS whether they live); the watcher's
// process table, lsof and cmux are the fakes tests/agent-watch.mjs uses.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir, track } from './fixtures/cleanup.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agentBin = path.join(root, 'bin/agent.mjs');
const fakes = path.join(root, 'tests/fixtures/watch-fakes.mjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const models = JSON.parse(fs.readFileSync(path.join(root, 'models.default.json'), 'utf8')).models;
const line = x => JSON.stringify(x) + '\n';

const home = fs.realpathSync(tempDir('acs-tail-'));
const bin = path.join(home, 'bin');
fs.mkdirSync(bin);
for (const tool of ['ps', 'lsof', 'cmux']) {
  fs.writeFileSync(path.join(bin, tool), `#!${process.execPath}\nprocess.argv.splice(2, 0, ${JSON.stringify(tool)});\nimport(${JSON.stringify(fakes)});\n`, { mode: 0o755 });
}
const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, AGENT_TEST_MODE: '1', AGENT_TEST_POLL_MS: '40', AGENT_TEST_LINGER_MS: '0', AGENT_TEST_NO_TRANSCRIPT_MS: '400', AGENT_TEST_PS: path.join(bin, 'ps'), AGENT_TEST_LSOF: path.join(bin, 'lsof') };
// Outside cmux: no socket, no workspace.
for (const key of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GROK_HOME', 'CMUX_SOCKET_PATH', 'CMUX_SURFACE_ID', 'CMUX_WORKSPACE_ID', 'CMUX_PANEL_ID']) delete env[key];
const runs = path.join(home, '.agent-config-studio/runs');
const cmuxCalls = () => { try { return fs.readFileSync(path.join(home, 'fake-cmux-calls.jsonl'), 'utf8').split('\n').filter(Boolean); } catch { return []; } };
const ps = rows => fs.writeFileSync(path.join(home, 'fake-ps.json'), JSON.stringify(rows));
const run = args => spawnSync(process.execPath, [agentBin, ...args], { env, encoding: 'utf8', timeout: 20000 });
function start(args) {
  const child = track(spawn(process.execPath, [agentBin, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] }));
  child.out = ''; child.err = '';
  child.stdout.on('data', d => { child.out += d; });
  child.stderr.on('data', d => { child.err += d; });
  child.exited = new Promise(resolve => child.on('exit', code => resolve(code)));
  return child;
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
async function exits(child, what) {
  const code = await Promise.race([child.exited, sleep(8000).then(() => 'hung')]);
  assert.notEqual(code, 'hung', `${what} did not exit`);
  return code;
}
// A stand-in for a review gate: a real process whose pid tail can check.
function gate() { return track(spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' })); }
// A pid that has exited, so neither tail nor a stray real process can mistake it for a live run.
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid;
function runFile(id, pid, kind = 'review') {
  fs.mkdirSync(runs, { recursive: true });
  fs.writeFileSync(path.join(runs, `${id}.json`), JSON.stringify({ version: 1, pid, kind, started: new Date().toISOString() }));
}
function claudeCall(pid, sessionId, cwd) {
  fs.mkdirSync(path.join(home, '.claude/sessions'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude/sessions', `${pid}.json`), JSON.stringify({ pid, sessionId, cwd, kind: 'sdk-cli' }));
  const file = path.join(home, '.claude/projects/-repo', `${sessionId}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, line({ type: 'user', cwd, sessionId, message: { role: 'user', content: 'review this diff' } }));
  return file;
}
const claudeTool = (name, input) => line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: `t${Math.random()}`, name, input }] } });

// The CLI surface: the version the gates probe for, the log-only flag, tail's arguments.
{
  assert.equal(run(['watch', '--version']).stdout.trim(), 'acs-agent watch 2', 'version 2 knows --log-only');
  assert.equal(run(['watch', '--pid', '1', '--kind', 'review', '--log-only', '--workspace', 'workspace:1']).status, 2, 'log-only takes no workspace');
  assert.equal(run(['watch', '--pid', '1', '--kind', 'review', '--log-only', '--pane']).status, 2, 'log-only has no pane');
  assert.equal(run(['watch', '--pid', '1', '--kind', 'review']).status, 2, 'a workspace or --log-only is required');
  assert.equal(run(['tail', 'a', 'b']).status, 2);
  assert.equal(run(['tail', '--bogus']).status, 2);
  assert.equal(run(['tail', '../etc', '--once']).status, 2, 'a run id is a plain name');
  assert.match(run(['--help']).stdout, /acs-agent tail \[run id\] \[--once\]/);
  const none = run(['tail', '--once']);
  assert.equal(none.status, 0, none.stderr);
  assert.match(none.stdout, /no review is running/);
  assert.equal(run(['tail', 'nosuchrun', '--once']).status, 1, 'a named run that does not exist');
  console.log('tail: arguments and version passed');
}

// The watcher outside cmux: steps go to the log, nothing goes to cmux, and a cmux watcher's stale state is left for
// a cmux watcher to clear. The tail started first, before any run, waits; it then follows the run as it happens.
{
  fs.mkdirSync(runs, { recursive: true });
  fs.writeFileSync(path.join(runs, 'cmuxdead.watch.json'), JSON.stringify({ version: 1, runId: 'cmuxdead', pid: deadPid(), watcherPid: deadPid(), workspace: 'workspace:1', keys: ['review-cmuxdead-1'], surface: 'surface:5' }));
  fs.writeFileSync(path.join(runs, 'logdead.watch.json'), JSON.stringify({ version: 1, runId: 'logdead', pid: deadPid(), watcherPid: deadPid(), workspace: null, keys: [], surface: null }));
  fs.writeFileSync(path.join(runs, 'logdead.log'), 'old\n');
  const tail = start(['tail']);
  await until('tail says it waits', () => /no review is running/.test(tail.out));
  const g = gate();
  const id = `r${g.pid}-aaaa1111`;
  runFile(id, g.pid);
  const cwd = path.join(home, 'repo');
  fs.mkdirSync(cwd, { recursive: true });
  const t = claudeCall(50011, 'aaaa1111-0000-4000-8000-000000000001', cwd);
  fs.appendFileSync(t, claudeTool('Read', { file_path: path.join(cwd, 'lib/a.js') }));
  ps([{ pid: g.pid, ppid: 1, command: 'node /x/review.mjs' }, { pid: 50011, ppid: g.pid, command: `claude -p review --model ${models.opus} --output-format json` }]);
  const w = start(['watch', '--pid', String(g.pid), '--kind', 'review', '--log-only']);
  await until('the log has the step', () => { try { return /\[review · opus\] read lib\/a\.js/.test(fs.readFileSync(path.join(runs, `${id}.log`), 'utf8')); } catch { return false; } });
  await until('tail shows the start', () => /\[review · opus\] started/.test(tail.out));
  await until('tail shows the step', () => /\[review · opus\] read lib\/a\.js/.test(tail.out));
  fs.appendFileSync(t, claudeTool('Grep', { pattern: 'needle', path: cwd }));
  await until('tail shows a new step live', () => /\[review · opus\] grep needle/.test(tail.out));
  assert.ok(!fs.existsSync(path.join(runs, 'logdead.watch.json')) && !fs.existsSync(path.join(runs, 'logdead.log')), 'a dead log-only watcher is swept');
  assert.ok(fs.existsSync(path.join(runs, 'cmuxdead.watch.json')), 'a dead cmux watcher is left for a cmux watcher to clear');
  ps([]);
  g.kill('SIGKILL');
  assert.equal(await exits(w, 'the log-only watcher'), 0, w.err);
  assert.deepEqual(cmuxCalls(), [], 'log-only never calls cmux');
  assert.deepEqual(fs.readdirSync(runs).sort(), ['cmuxdead.watch.json'], 'the watcher removes its own run state and log');
  await until('tail says the run finished', () => new RegExp(`review ${id} finished`).test(tail.out));
  assert.equal(tail.out.match(/\[review · opus\] read lib\/a\.js/g).length, 1, 'each line once');
  assert.equal(tail.exitCode, null, 'with no id, tail keeps waiting for the next run');

  // The next run: a log written straight to disk, with a hostile line. Tail picks it up and cleans it.
  const g2 = gate();
  const id2 = `a${g2.pid}-bbbb2222`;
  runFile(id2, g2.pid, 'advisor');
  fs.writeFileSync(path.join(runs, `${id2}.log`), `10:00:00 [advisor · sol] started\n10:00:01 [advisor · sol] run x\u001b]0;pwned\u0007\u001b[2Jy‮evil\n`);
  await until('tail follows the next run', () => /\[advisor · sol\] run x/.test(tail.out));
  assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮]/.test(tail.out), JSON.stringify(tail.out));
  tail.kill('SIGINT');
  assert.equal(await exits(tail, 'tail after Ctrl-C'), 0, tail.err);
  g2.kill('SIGKILL');
  console.log('tail: log-only watcher, live follow, next run, Ctrl-C passed');
}

// --once prints what is there and exits; a named run is followed until it ends, then tail exits.
{
  const g = gate();
  const id = `r${g.pid}-cccc3333`;
  runFile(id, g.pid);
  fs.writeFileSync(path.join(runs, `${id}.log`), '10:00:00 [review · sol] started\n');
  const once = run(['tail', '--once']);
  assert.equal(once.status, 0, once.stderr);
  assert.match(once.stdout, /\[review · sol\] started/);
  const named = run(['tail', id, '--once']);
  assert.equal(named.status, 0, named.stderr);
  assert.match(named.stdout, /\[review · sol\] started/);
  const follow = start(['tail', id]);
  await until('named tail prints the log', () => /\[review · sol\] started/.test(follow.out));
  fs.appendFileSync(path.join(runs, `${id}.log`), '10:00:02 [review · sol] finished after <1m\n10:00:02 run finished\n');
  assert.equal(await exits(follow, 'a named tail when its run ends'), 0, follow.err);
  assert.match(follow.out, /finished after <1m/);
  assert.match(follow.out, new RegExp(`review ${id} finished`));
  g.kill('SIGKILL');
  console.log('tail: --once and a named run passed');
}
