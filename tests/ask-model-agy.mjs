/**
 * ask-model on agy (a gemini- id), run as a child process against a stub agy that records its argv, cwd, stdin and
 * env and answers in agy 1.5.13's stream-json shape (builds/gemini-family/containment-probe.md). PATH holds no real
 * model CLI and HOME is a temp folder, so no model is called and the real ~/.gemini is never read.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './fixtures/cleanup.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASK = path.join(ROOT, 'tools', 'ask-model.mjs');
const NEON = JSON.parse(fs.readFileSync(path.join(ROOT, 'models.default.json'), 'utf8')).models.neon;
const J = JSON.stringify;
const same = (a, b) => J(a) === J(b);

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

const tmp = fs.realpathSync(tempDir('acs-ask-agy-'));
const mk = (...p) => { const d = path.join(tmp, ...p); fs.mkdirSync(d, { recursive: true }); return d; };
const STUBS = mk('stubs');
const LOG = path.join(tmp, 'calls.jsonl');
const SYSTEM = ['/usr/bin', '/bin'];

// STUB_MODE: ok | status-error | deadline | denied-empty | other-model | no-result. STUB_ANSWER replaces the response.
fs.writeFileSync(path.join(STUBS, 'agy'), `#!${process.execPath}
const fs = require('node:fs');
const a = process.argv.slice(2);
const val = (f) => { const i = a.indexOf(f); return i === -1 ? undefined : a[i + 1]; };
const st = fs.fstatSync(0);
fs.appendFileSync(process.env.STUB_LOG, JSON.stringify({ argv: a, cwd: process.cwd(), stdin: st.isCharacterDevice() ? 'chardev' : 'other',
  cmuxHooksOff: process.env.CMUX_ANTIGRAVITY_HOOKS_DISABLED ?? null }) + '\\n');
const mode = process.env.STUB_MODE || 'ok';
const model = val('--model');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const cid = 'c0ffee';
out({ event: 'init', conversation_id: cid, init: { model: mode === 'other-model' ? 'gemini-other' : model, cwd: process.cwd(), tools: ['view_file'], permission_mode: 'default' } });
if (mode === 'deadline') { process.stderr.write('AGY_ERROR DEADLINE_EXCEEDED\\n'); process.exit(3); }
if (mode === 'no-result') process.exit(0);
if (mode === 'denied-empty') {
  out({ event: 'step_update', step_update: { conversation_id: cid, step_index: 2, state: 'ERROR', step_type: 'tool', tool_name: 'write_file',
    tool_info: { name: 'write_file', error: { type: 'TOOL_ERROR', message: 'permission check failed for write_file "x": Permission denied for write_file(x). Matches user-configured deny rule.' } } } });
}
const status = mode === 'status-error' ? 'ERROR' : 'SUCCESS';
const response = process.env.STUB_ANSWER ?? (mode === 'denied-empty' ? '' : 'answer from ' + model);
out({ event: 'result', result: { conversation_id: cid, status, response, duration_seconds: 1, num_turns: 1, usage: { total_tokens: 1 } } });
process.exit(status === 'SUCCESS' ? 0 : 1);
`, { mode: 0o755 });

const PROMPT = 'Read brief.md and say what you think.\n';
const PF = path.join(tmp, 'prompt.txt');
fs.writeFileSync(PF, PROMPT);
const WORK = mk('work');

function home(gemini = {}) {
  const h = mk(`home-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(path.join(h, '.agent-config-studio'));
  fs.writeFileSync(path.join(h, '.agent-config-studio', 'roles.json'), J({ version: 1 }));
  const dir = path.join(h, '.gemini', 'config');
  for (const [name, text] of Object.entries(gemini)) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, name), text); }
  return h;
}
function ask(args, { env = {}, h = home(), pathDirs = [STUBS, ...SYSTEM] } = {}) {
  fs.writeFileSync(LOG, '');
  const r = spawnSync(process.execPath, [ASK, '--prompt-file', PF, ...args], {
    cwd: WORK, encoding: 'utf8', env: { HOME: h, PATH: pathDirs.join(':'), STUB_LOG: LOG, ...env },
  });
  const calls = fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  let j = null;
  try { j = JSON.parse(r.stdout); } catch {}
  return { code: r.status, out: r.stdout, err: r.stderr, calls, argv: calls[0]?.argv, j, home: h };
}
const show = (r) => J({ code: r.code, out: r.out, err: r.err, calls: r.calls });
const DENY = J({ permissions: { deny: ['command(*)', 'write_file(*)', 'mcp(*)', 'read_url(*)'] } });

console.log('\nask-model agy: no real agy is reachable');
{
  const real = SYSTEM.map((d) => path.join(d, 'agy')).filter((p) => fs.existsSync(p));
  ok('no agy in /usr/bin or /bin (the only system dirs on PATH)', real.length === 0, real.join(' '));
  if (real.length) process.exit(1);
}

console.log('\nask-model agy: the call');
{
  const r = ask(['--family', 'neon', '--effort', 'high', '--cwd', WORK, '--json']);
  const logFile = r.j?.logFile;
  const want = ['-p', PROMPT, '--model', NEON, '--effort', 'high', '--output-format', 'stream-json', '--print-timeout', '1800s',
    '--disable-slash-commands', '--settings', DENY, '--log-file', logFile];
  ok('exact argv: the deny list, stream-json, a print timeout, slash commands off, a per-call log file', r.code === 0 && same(r.argv, want), show(r));
  ok('the log file is a fresh path under ~/.agent-config-studio/logs/agy', typeof logFile === 'string'
    && path.dirname(logFile) === path.join(r.home, '.agent-config-studio', 'logs', 'agy') && fs.statSync(path.dirname(logFile)).isDirectory(), J(logFile));
  ok('stdin is /dev/null, it runs in --cwd, cmux\'s hooks are switched off', r.calls.length === 1 && r.calls[0].stdin === 'chardev'
    && r.calls[0].cwd === WORK && r.calls[0].cmuxHooksOff === '1', show(r));
  ok('--json: the answer, and the model marked requested but unverified', r.j?.answer === `answer from ${NEON}`
    && same(r.j?.served, { requested: NEON, verified: false }) && r.j?.error === null, show(r));
  ok('stderr says the model is unverified and names the log', /agy does not report which model answered; .* was requested \(unverified\)\. Its log: /.test(r.err)
    && r.err.includes(logFile), r.err);
  const plain = ask(['--family', 'neon']);
  ok('without --json: the answer on stdout; no effort flag when none is set', plain.code === 0 && plain.out === `answer from ${NEON}\n`
    && !plain.argv.includes('--effort'), show(plain));
  const two = [ask(['--family', 'neon', '--json']).j?.logFile, ask(['--family', 'neon', '--json']).j?.logFile];
  ok('each call gets its own log file', two[0] && two[1] && two[0] !== two[1], J(two));
}

console.log('\nask-model agy: failures');
{
  const st = ask(['--family', 'neon', '--json'], { env: { STUB_MODE: 'status-error' } });
  ok('status other than SUCCESS → exit 4 naming it', st.code === 4 && /agy failed \(exit 1, status ERROR\)|agy reported status "ERROR"/.test(st.j?.error ?? ''), show(st));
  const dl = ask(['--family', 'neon', '--json'], { env: { STUB_MODE: 'deadline' } });
  ok('the print timeout (agy exit 3) → exit 4, never 3 (3 means not installed)', dl.code === 4 && /DEADLINE_EXCEEDED/.test(dl.j?.error ?? ''), show(dl));
  const nr = ask(['--family', 'neon', '--json'], { env: { STUB_MODE: 'no-result' } });
  ok('no result event → exit 4', nr.code === 4 && /agy failed/.test(nr.j?.error ?? ''), show(nr));
  const de = ask(['--family', 'neon', '--json'], { env: { STUB_MODE: 'denied-empty' } });
  ok('SUCCESS with an empty answer after a denied tool call → exit 4 naming the denial', de.code === 4
    && /empty answer after its deny list refused 1 tool call\(s\): write_file: permission check failed/.test(de.j?.error ?? ''), show(de));
  ok('...and the denied step is on stderr', /ask-model: agy: denied write_file: /.test(de.err), de.err);
  const blank = ask(['--family', 'neon', '--json'], { env: { STUB_ANSWER: '   \n' } });
  ok('a blank answer → exit 4', blank.code === 4 && /empty answer/.test(blank.j?.error ?? ''), show(blank));
  const om = ask(['--family', 'neon', '--json'], { env: { STUB_MODE: 'other-model' } });
  ok('init names another model → exit 2, not its answer', om.code === 2 && /asked for .*, but agy reports it was asked for gemini-other/.test(om.j?.error ?? '') && om.j?.answer === null, show(om));
  const none = ask(['--family', 'neon'], { pathDirs: SYSTEM });
  ok('agy not on PATH → exit 3', none.code === 3 && /the agy CLI is not on PATH/.test(none.err), show(none));
}

console.log('\nask-model agy: modes it refuses, nothing run');
for (const [flag, re] of [['--investigate', /--investigate is not available for agy/], ['--no-tools', /--no-tools is not available/], ['--min-tools', /--min-tools is not available/]]) {
  const r = ask(['--family', 'neon', flag]);
  ok(`${flag} → exit 4, agy not run`, r.code === 4 && re.test(r.err) && r.calls.length === 0, show(r));
}
{
  const r = ask(['--family', 'neon', '--x-search']);
  ok('--x-search → exit 64 (grok only), agy not run', r.code === 64 && /--x-search uses grok/.test(r.err) && r.calls.length === 0, show(r));
}

console.log('\nask-model agy: ~/.gemini/config');
{
  const CMUX = (cmd) => J({ cmux: { SessionStart: [{ type: 'command', command: `: cmux-antigravity-hook-v2; ${cmd}`, timeout: 10 }],
    PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: ': cmux-antigravity-hook-v2; true' }] }] } });
  const cases = [
    ['an empty mcp_config.json (0 bytes) runs', { 'mcp_config.json': '' }, 0],
    ['an empty server list runs', { 'mcp_config.json': J({ mcpServers: {} }) }, 0],
    ['{} runs', { 'mcp_config.json': '{}' }, 0],
    ['an MCP server → exit 4 naming it', { 'mcp_config.json': J({ mcpServers: { probe: { command: 'sh' } } }) }, 4, /configures MCP servers \(probe\)/],
    ['an mcp_config.json that is not JSON → exit 4', { 'mcp_config.json': '{nope' }, 4, /mcp_config\.json is not JSON/],
    ['another top-level key beside an empty list → exit 4', { 'mcp_config.json': J({ mcpServers: {}, servers: { x: {} } }) }, 4, /more than an empty server list/],
    ['only cmux\'s hooks (flat and grouped) run', { 'hooks.json': CMUX('true') }, 0],
    ['a hook without the cmux marker → exit 4 naming it', { 'hooks.json': J({ mine: { SessionStart: [{ type: 'command', command: 'touch x' }] } }) }, 4, /not cmux's \(mine\.SessionStart\)/],
    ['a foreign handler inside a grouped tool hook → exit 4', { 'hooks.json': J({ cmux: { PreToolUse: [{ matcher: '*', hooks: [{ command: 'evil' }] }] } }) }, 4, /cmux\.PreToolUse/],
    ['a hooks.json that is not JSON → exit 4', { 'hooks.json': '[' }, 4, /hooks\.json is not JSON/],
    ['a hooks.json that is a list → exit 4', { 'hooks.json': '[]' }, 4, /not a JSON object of named hooks/],
  ];
  for (const [name, files, code, re] of cases) {
    const r = ask(['--family', 'neon'], { h: home(files) });
    ok(name, r.code === code && (code === 0 ? r.calls.length === 1 : r.calls.length === 0 && re.test(r.err) && /so agy was not run/.test(r.err)), show(r));
  }
}

console.log('\nask-model agy: --schema');
{
  const sf = path.join(tmp, 'schema.json');
  const schema = { type: 'object', properties: { verdict: { type: 'string' } }, required: ['verdict'], additionalProperties: false };
  fs.writeFileSync(sf, J(schema));
  const r = ask(['--family', 'neon', '--schema', sf], { env: { STUB_ANSWER: J({ verdict: 'fine' }) } });
  ok('--json-schema carries the schema; the checked JSON is printed', r.code === 0 && r.argv.at(-2) === '--json-schema' && same(JSON.parse(r.argv.at(-1)), schema)
    && same(JSON.parse(r.out), { verdict: 'fine' }), show(r));
  const bad = ask(['--family', 'neon', '--schema', sf], { env: { STUB_ANSWER: J({ other: 1 }) } });
  ok('an answer that misses the schema → exit 6', bad.code === 6, show(bad));
}

console.log('\nask-model agy: the exported pieces name each vendor explicitly');
{
  const { argvFor, sandboxProblem, readAnswer } = await import(ASK);
  ok('sandboxProblem(agy) says agy gets no shell', /gives agy no shell/.test(sandboxProblem('agy') ?? ''), J(sandboxProblem('agy')));
  ok('sandboxProblem(codex) is null (its read-only sandbox)', sandboxProblem('codex') === null);
  ok('sandboxProblem for a vendor it does not know names it', /knows no shell sandbox for acme/.test(sandboxProblem('acme') ?? ''));
  let thrown = null;
  try { argvFor('agy', { id: NEON, prompt: 'p', cwd: tmp, mode: 'investigate', logFile: '/x' }); } catch (e) { thrown = e; }
  ok('argvFor(agy) refuses any mode but read-only', /read-only only/.test(thrown?.message ?? ''), String(thrown));
  thrown = null;
  try { argvFor('agy', { id: NEON, prompt: 'p', cwd: tmp, mode: 'read-only' }); } catch (e) { thrown = e; }
  ok('argvFor(agy) refuses a call with no log file', /log-file/.test(thrown?.message ?? ''), String(thrown));
  const unknown = readAnswer('acme', 'acme-1', { code: 0, stdout: '{}', stderr: '' });
  ok('readAnswer still refuses a vendor it cannot read', unknown.exit === 4 && /no acme CLI wiring/.test(unknown.error), J(unknown));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
