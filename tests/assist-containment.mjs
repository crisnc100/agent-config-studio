/**
 * Assist containment, fail-closed (builds/ready-for-strangers item 4, B1, B2):
 *
 *   - grok with any MCP server configured is refused BEFORE the spawn: the fake
 *     grok's session-start side effect never happens, on /api/chat and
 *     /api/assist alike; an inspect that fails, hangs or prints garbage
 *     refuses too;
 *   - after the spawn, the init gate refuses — for claude and grok, on both
 *     Assist paths — extra tools, a contradicting toolCount, MCP servers, a
 *     malformed, repeated, missing or late init, and the same on a resumed
 *     session. A refused turn kills the process group (the fake's grandchild
 *     never writes), streams nothing, proposes no edit, and says why;
 *   - a clean init proceeds and its edit is proposed;
 *   - no init within the deadline is refused and killed;
 *   - the rule is one module, imported by the runtime and by tests/phase1.mjs.
 *
 * A real `node server.js` with HOME redirected to a temp dir holding the fake
 * CLIs. Nothing real is spawned.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshotRealHomes, assertRealHomesUnchanged } from './real-home.mjs';
import { containedCli } from './fixtures/contained-cli.mjs';
import { containmentHeld, createInitGate, grokMcpFromInspect } from '../lib/containment.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const realBefore = snapshotRealHomes();
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('\nassist containment: the shared rule');
{
  const g = (over) => ({ type: 'system', subtype: 'init', tools: ['read_file'], mcp_servers: [], ...over });
  ok('B2 {tools:[read_file], toolCount:134} FAILS', containmentHeld(g({ toolCount: 134 }), 'grok').ok === false);
  ok('a clean grok init holds', containmentHeld(g(), 'grok').ok === true);
  ok('a clean claude init holds', containmentHeld(g({ tools: ['Read'] }), 'claude').ok === true);
  ok('tools [] (grok signed out) fails', containmentHeld(g({ tools: [] }), 'grok').ok === false);
  ok('an MCP server listed fails', containmentHeld(g({ mcp_servers: [{ name: 'x' }] }), 'grok').ok === false);
  ok('a non-list tools fails', containmentHeld(g({ tools: 'read_file' }), 'grok').ok === false);
  ok('no init fails', containmentHeld(null, 'grok').ok === false);
  ok('an unknown harness fails', containmentHeld(g(), 'codex').ok === false);
  ok('the other harness\'s read tool fails', containmentHeld(g(), 'claude').ok === false);
  const gate = createInitGate('claude');
  ok('the gate lets system notices through before init', gate.see({ type: 'system', subtype: 'hook_started' }) === null);
  ok('…refuses output before init', /before the init/.test(gate.see({ type: 'stream_event' }) || ''));
  const g2 = createInitGate('claude');
  g2.see({ type: 'system', subtype: 'init', tools: ['Read'] });
  ok('…refuses a second init', /second init/.test(g2.see({ type: 'system', subtype: 'init', tools: ['Read'] }) || ''));
  ok('…and a stream that ended with none', /never reported/.test(createInitGate('grok').end() || ''));
  ok('inspect: an enabled server counts', grokMcpFromInspect({ mcpServers: [{ name: 'jev' }] }).join() === 'jev');
  ok('inspect: a compat-disabled or disabled server does not',
     grokMcpFromInspect({ mcpServers: [{ name: 'a', compatibilityStatus: 'disabled' }, { name: 'b', enabled: false }] }).length === 0);
  ok('inspect: a plugin that brings MCP servers counts', grokMcpFromInspect({ mcpServers: [], plugins: [{ name: 'p', enabled: true, provides: { mcpServers: 1 } }] }).join() === 'p (plugin)');
  let threw = false;
  try { grokMcpFromInspect({ servers: [] }); } catch { threw = true; }
  ok('inspect: an unknown shape is never read as "none"', threw);

  const src = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  ok('4 phase1.mjs imports containmentHeld from lib/containment.js, and defines no copy',
     /import\s*\{[^}]*\bcontainmentHeld\b[^}]*\}\s*from\s*'\.\.\/lib\/containment\.js'/.test(src('tests/phase1.mjs')) && !/function containmentHeld/.test(src('tests/phase1.mjs')));
  ok('4 the runtime gate is lib/containment.js\'s (harness.js imports createInitGate)',
     /import\s*\{[^}]*\bcreateInitGate\b[^}]*\}\s*from\s*'\.\/containment\.js'/.test(src('lib/harness.js')));
  ok('4 chat and assist both run through runContained', /runContained\(/.test(src('lib/chat.js')) && /runContained\(/.test(src('lib/assist.js')) &&
     !/spawnContained\(/.test(src('lib/chat.js')) && !/spawnContained\(/.test(src('lib/assist.js')));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

async function startServer(home) {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: { HOME: home, PORT: String(port), PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, TMPDIR: os.tmpdir() },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const base = `http://localhost:${port}`;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) break;
    try { if ((await fetch(`${base}/api/health`)).ok) return { child, base }; } catch {}
    await sleep(100);
  }
  child.kill('SIGKILL');
  throw new Error(`server did not start: ${log.slice(-600)}`);
}

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acs-contain-')));
const bins = { claude: path.join(home, '.local', 'bin', 'claude'), grok: path.join(home, '.grok', 'bin', 'grok') };
containedCli(bins.claude, 'claude');
containedCli(bins.grok, 'grok');
const dirOf = (h) => path.dirname(bins[h]);
const target = path.join(home, '.claude', 'CLAUDE.md');
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, '# rules\nold line\n');
const EDIT = `Here.\n\n@@EDIT ~/.claude/CLAUDE.md\n@@SEARCH\nold line\n@@REPLACE\nnew line\n@@END\n`;

const setMode = (h, mode) => {
  const d = dirOf(h);
  fs.writeFileSync(path.join(d, 'mode.json'), JSON.stringify({ reply: EDIT, ...mode }));
  for (const f of ['started.log', 'leaked.log', 'calls.jsonl']) fs.rmSync(path.join(d, f), { force: true });
};
const read = (h, f) => { try { return fs.readFileSync(path.join(dirOf(h), f), 'utf8'); } catch { return ''; } };
const calls = (h) => read(h, 'calls.jsonl').split('\n').filter(Boolean).map((l) => JSON.parse(l));

async function chat(base, body) {
  const r = await fetch(`${base}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const lines = (await r.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { status: r.status, lines, done: lines.find((l) => l.t === 'done'), error: lines.find((l) => l.t === 'error'), deltas: lines.filter((l) => l.t === 'delta') };
}
async function assist(base, harness) {
  const r = await fetch(`${base}/api/assist`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ harness, action: 'tighten', path: target, content: fs.readFileSync(target, 'utf8') }),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

const srv = await startServer(home);
try {
  console.log('\nassist containment: grok refused before the spawn when MCP is configured');
  for (const [what, inspect, want] of [
    ['a grok-native server', { mcpServers: [{ name: 'jev', source: { type: 'configToml' } }], plugins: [] }, /MCP servers configured \(jev\)/],
    ['a plugin that brings one', { mcpServers: [], plugins: [{ name: 'tools', enabled: true, provides: { mcpServers: 1 } }] }, /tools \(plugin\)/],
    ['an inspect that fails', 'fail', /could not confirm/],
    ['an inspect that prints garbage', 'garbage', /could not confirm/],
  ]) {
    setMode('grok', { kind: 'ok', inspect });
    const c = await chat(srv.base, { message: 'hi', harness: 'grok', mentions: [target] });
    ok(`B1 ${what}: /api/chat is refused with the reason`, c.error && want.test(c.error.message) && !c.done, JSON.stringify(c.lines).slice(0, 300));
    ok(`B1 ${what}: grok was never started (no session side effect)`, read('grok', 'started.log') === '', read('grok', 'started.log'));
    const as = await assist(srv.base, 'grok');
    ok(`B1 ${what}: /api/assist is refused too, nothing returned`, as.status >= 400 && !as.body.result && want.test(as.body.error || ''), JSON.stringify(as));
    ok(`B1 ${what}: …and grok was still never started`, read('grok', 'started.log') === '');
  }
  setMode('grok', { kind: 'ok', inspect: { mcpServers: [{ name: 'Neon', compatibilityStatus: 'disabled' }], plugins: [] } });
  const clean = await chat(srv.base, { message: 'hi', harness: 'grok', mentions: [target] });
  ok('B1 only compat servers (switched off for Assist): grok runs', clean.done?.ok === true, JSON.stringify(clean.lines).slice(0, 300));
  const env = calls('grok');
  ok('B1 the inspect and the turn both ran with the compat MCP sources off',
     env.length >= 2 && env.every((c) => c.argv[0] === '--version' || (c.env.GROK_CLAUDE_MCPS_ENABLED === '0' && c.env.GROK_CURSOR_MCPS_ENABLED === '0')),
     JSON.stringify(env.map((c) => [c.argv[0], c.env])));
  const inspectCall = env.find((c) => c.argv[0] === 'inspect');
  const turnCall = env.find((c) => c.argv.includes('--prompt-file'));
  ok('B1 the inspect and the spawn got the SAME environment, byte for byte (built once, passed to both)',
     inspectCall && turnCall && inspectCall.envHash === turnCall.envHash, JSON.stringify([inspectCall?.envHash, turnCall?.envHash]));
  ok('B1 …by construction: spawnContained spawns with the clearance\'s env, which clearForSpawn handed the preflight',
     /env: clearance\.env/.test(fs.readFileSync(path.join(ROOT, 'lib', 'harness.js'), 'utf8')) &&
     /const env = spawnEnv\(descriptor\);\s*const why = descriptor\.preflight \? await descriptor\.preflight\(\{ binary, cwd, env \}\)/.test(fs.readFileSync(path.join(ROOT, 'lib', 'harness.js'), 'utf8')));

  // The backstop for the window between the inspect and the spawn: a config
  // that gained an MCP server after a clean inspect shows up in init.
  setMode('grok', { kind: 'mcp', inspect: { mcpServers: [], plugins: [] } });
  const gap = await chat(srv.base, { message: 'hi', harness: 'grok', mentions: [target] });
  ok('B1 backstop: inspect clean, init lists a pending MCP server → refused, naming it',
     gap.error && /MCP servers started: probe/.test(gap.error.message) && !gap.done, JSON.stringify(gap.lines).slice(0, 300));
  ok('B1 backstop: …grok did start (this is the post-spawn layer)', read('grok', 'started.log') !== '');
  ok('B1 backstop: …no output kept (no delta, no done, no proposal)', gap.deltas.length === 0 && !gap.lines.some((l) => l.t === 'done'));
  await sleep(2200);
  ok('B1 backstop: …and the process group was killed (the grandchild never wrote)', read('grok', 'leaked.log') === '');
  ok('B1 the inspect ran before the session started', env.findIndex((c) => c.argv[0] === 'inspect') < env.findIndex((c) => c.argv.includes('--prompt-file')));

  for (const h of ['claude', 'grok']) {
    console.log(`\nassist containment: ${h}, after the spawn`);
    setMode(h, { kind: 'ok' });
    const good = await chat(srv.base, { message: 'hi', harness: h, mentions: [target] });
    ok(`4 ${h}: init [${h === 'grok' ? 'read_file' : 'Read'}] proceeds, and its edit is proposed`,
       good.done?.ok === true && good.done.proposals.length === 1 && good.done.proposals[0].proposed.includes('new line'), JSON.stringify(good.lines).slice(0, 400));
    const as = await assist(srv.base, h);
    ok(`4 ${h}: …and the one-shot Assist returns its result`, as.status === 200 && typeof as.body.result === 'string' && as.body.result.length > 0, JSON.stringify(as).slice(0, 300));

    for (const [kind, what] of [
      ['extra', 'extra tools in init'],
      ['count', 'a toolCount that contradicts the list'],
      ['mcp', 'an MCP server in init'],
      ['malformed', 'a malformed init'],
      ['repeat', 'a repeated init'],
      ['before', 'output before init'],
      ['after-partial', 'a bad init after partial output'],
      ['missing', 'no init at all'],
    ]) {
      setMode(h, { kind });
      const c = await chat(srv.base, { message: 'hi', harness: h, mentions: [target] });
      ok(`4 ${h} ${what}: refused, with the reason shown`, c.error && /did not start contained/.test(c.error.message) && !c.done, JSON.stringify(c.lines).slice(0, 300));
      ok(`4 ${h} ${what}: nothing streamed before the refusal but a gated reply`, c.deltas.every((d) => kind === 'after-partial' && d.text === 'partial '), JSON.stringify(c.deltas));
      await sleep(2200);
      ok(`4 ${h} ${what}: the process group was killed (the grandchild never wrote)`, read(h, 'leaked.log') === '');
      ok(`4 ${h} ${what}: no edit applied`, fs.readFileSync(target, 'utf8') === '# rules\nold line\n');
    }
    setMode(h, { kind: 'extra' });
    const as2 = await assist(srv.base, h);
    ok(`B2 ${h}: the one-shot Assist path refuses extra tools too, returning nothing`, as2.status === 502 && !as2.body.result && /did not start contained/.test(as2.body.error || ''), JSON.stringify(as2));

    // A resumed session goes through the same gate.
    setMode(h, { kind: 'ok', resumeKind: 'extra', session: `${h}-resume-1` });
    const first = await chat(srv.base, { message: 'hi', harness: h });
    const resumed = await chat(srv.base, { message: 'again', harness: h, sessionId: first.done?.sessionId });
    const argv = calls(h).filter((c) => c.argv[0] !== '--version' && c.argv[0] !== 'inspect').at(-1)?.argv || [];
    ok(`B2 ${h}: a resumed session is gated too`, first.done?.ok === true && (argv.includes('--resume') || argv.includes('-r')) &&
       resumed.error && /did not start contained/.test(resumed.error.message), JSON.stringify([first.done?.sessionId, argv, resumed.lines]).slice(0, 400));
  }
} finally {
  srv.child.kill('SIGKILL');
}

console.log('\nassist containment: the init deadline');
{
  process.env.HOME = home;
  const { streamTurn } = await import('../lib/chat.js');
  setMode('claude', { kind: 'silent' });
  const t0 = Date.now();
  const turn = streamTurn({ message: 'hi', mentions: [], cwd: home, harness: 'claude', initDeadlineMs: 500 }, () => {});
  let err = null;
  try { await turn.done; } catch (e) { err = e; }
  ok('B2 no init within the deadline: refused', err?.refused === true && /no init event within/.test(err.message), err?.message);
  ok('B2 …promptly, not at the CLI\'s leisure', Date.now() - t0 < 5000, `${Date.now() - t0} ms`);
  await sleep(3500);
  ok('B2 …and the process group is gone (the grandchild never wrote)', read('claude', 'leaked.log') === '');
}

fs.rmSync(home, { recursive: true, force: true });
assertRealHomesUnchanged(realBefore, ok);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
