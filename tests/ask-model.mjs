/**
 * ask-model (tools/ask-model.mjs), run as a child process: the argv each CLI
 * gets, an effort flag only when there is an effort, read-only and
 * --investigate tools, the model proof, every exit code, --json, roles, and
 * the launcher `model-id --install` writes. claude, codex and grok are stubs
 * that record their argv and answer from canned output; PATH holds no real
 * model CLI and HOME is a temp folder, so no model is ever called.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './fixtures/cleanup.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASK = path.join(ROOT, 'tools', 'ask-model.mjs');
const IDS = JSON.parse(fs.readFileSync(path.join(ROOT, 'models.default.json'), 'utf8')).models;
const ROLES = JSON.parse(fs.readFileSync(path.join(ROOT, 'lib', 'roles.default.json'), 'utf8'));
const J = JSON.stringify;
const same = (a, b) => J(a) === J(b);

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

const tmp = fs.realpathSync(tempDir('acs-ask-model-'));
const mk = (...p) => { const d = path.join(tmp, ...p); fs.mkdirSync(d, { recursive: true }); return d; };
const STUBS = mk('stubs');
const EMPTY = mk('empty-path');
const LOG = path.join(tmp, 'calls.jsonl');
const SYSTEM = ['/usr/bin', '/bin'];
const PATHS = [STUBS, ...SYSTEM].join(':');

// Each stub logs its argv, cwd and what its stdin is, then answers as STUB_MODE says.
// Codex rejects an empty effort the way the real one does. Its `mcp list --json` reports
// the servers in STUB_MCP and applies an inline-table -c override, as codex was seen to
// (STUB_MCP_IGNORE: it does not; STUB_MCP_FAIL: it fails). Grok's `inspect --json` prints
// STUB_GROK_INSPECT, or no servers. Claude's envelope comes as a verbose event list with STUB_VERBOSE.
const stub = (name) => `#!${process.execPath}
const fs = require('node:fs');
const a = process.argv.slice(2);
const val = (...f) => { const i = a.findIndex((x) => f.includes(x)); return i === -1 ? undefined : a[i + 1]; };
const st = fs.fstatSync(0);
fs.appendFileSync(process.env.STUB_LOG, JSON.stringify({ name: ${J(name)}, argv: a, cwd: process.cwd(),
  stdin: st.isFIFO() ? 'pipe' : st.isCharacterDevice() ? 'chardev' : st.isFile() ? 'file' : 'other',
  mcpEnv: [process.env.GROK_CLAUDE_MCPS_ENABLED ?? null, process.env.GROK_CURSOR_MCPS_ENABLED ?? null] }) + '\\n');
if (${J(name)} === 'grok' && a[0] === 'inspect') {
  if (process.env.STUB_GROK_INSPECT_FAIL) { process.stderr.write('inspect: boom\\n'); process.exit(1); }
  process.stdout.write(process.env.STUB_GROK_INSPECT || JSON.stringify({ grokVersion: 'stub', mcpServers: [], plugins: [] }));
  process.exit(0);
}
if (${J(name)} === 'codex' && a[0] === 'mcp') {
  if (process.env.STUB_MCP_FAIL) { process.stderr.write('mcp: boom\\n'); process.exit(1); }
  if (process.env.STUB_MCP_PLUGIN) {
    // STUB_MCP_PLUGIN: servers a plugin provides, as codex 0.160.0 was seen to treat them. An mcp_servers
    // entry for one has no transport, so codex refuses the config; features.plugins=false drops them
    // (STUB_PLUGINS_STICKY: it does not). Every -c is read, not only the first.
    const sets = a.flatMap((x, i) => (x === '-c' ? [a[i + 1]] : []));
    const off = sets.flatMap((s) => [...s.matchAll(/"([^"]+)"=\\{enabled=false\\}/g)].map((m) => m[1]));
    const plugin = JSON.parse(process.env.STUB_MCP_PLUGIN);
    const bad = plugin.find((n) => off.includes(n));
    if (bad) { process.stderr.write('Error: failed to load bootstrap configuration\\n\\nCaused by:\\n    invalid transport\\n    in \`mcp_servers.' + bad + '\`\\n'); process.exit(1); }
    const dropped = sets.includes('features.plugins=false') && !process.env.STUB_PLUGINS_STICKY;
    const all = [...JSON.parse(process.env.STUB_MCP || '[]'), ...(dropped ? [] : plugin)];
    process.stdout.write(JSON.stringify(all.map((n) => ({ name: n, enabled: !off.includes(n) }))));
    process.exit(0);
  }
  const override = val('-c') || '';
  const off = process.env.STUB_MCP_IGNORE ? [] : [...override.matchAll(/"([^"]+)"=\\{enabled=false\\}/g)].map((m) => m[1]);
  process.stdout.write(JSON.stringify(JSON.parse(process.env.STUB_MCP || '[]').map((n) => ({ name: n, enabled: !off.includes(n) }))));
  process.exit(0);
}
for (const f of (process.env.STUB_WRITE || '').split(',').filter(Boolean)) fs.appendFileSync(f, 'written by the stub\\n');
for (const f of (process.env.STUB_CHMOD || '').split(',').filter(Boolean)) fs.chmodSync(f, 0o755);
if (process.env.STUB_GIT) require('node:child_process').execFileSync('git', process.env.STUB_GIT.split(' '), { stdio: 'ignore' });
if (process.env.STUB_STDERR) process.stderr.write(process.env.STUB_STDERR + '\\n');
const mode = process.env.STUB_MODE || 'ok';
const model = val('--model', '-m') || 'none';
// STUB_ANSWER replaces the reply's text; STUB_STRUCTURED is claude's structured_output and grok's structuredOutput.
const answer = process.env.STUB_ANSWER ?? (mode === 'empty' ? '' : 'answer from ' + model);
const structured = process.env.STUB_STRUCTURED;
if (${J(name)} === 'codex') {
  if (a.includes('model_reasoning_effort=')) { process.stderr.write("Error: invalid value for model_reasoning_effort: ''\\n"); process.exit(1); }
  if (mode === 'fail') { process.stderr.write('codex: boom\\n'); process.exit(1); }
  process.stdout.write(answer + '\\n');
} else if (${J(name)} === 'claude') {
  if (mode === 'garbage') { process.stdout.write('not json'); process.exit(0); }
  const out = (o) => process.stdout.write(JSON.stringify(process.env.STUB_VERBOSE
    ? [{ type: 'system', subtype: 'init', model }, { type: 'assistant', message: { content: [{ type: 'text', text: 'thinking' }] } }, o] : o));
  if (mode === 'is_error') {
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'claude: boom', modelUsage: {} });
    process.exit(1);
  }
  if (mode === 'errors') {
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['first problem', { message: 'second problem' }] });
    process.exit(1);
  }
  if (mode === 'no_result') { process.stdout.write(JSON.stringify([{ type: 'system', subtype: 'init', model }])); process.exit(0); }
  const used = mode === 'downgrade' ? 'claude-sonnet-stub' : model;
  out({ type: 'result', subtype: 'success', is_error: false, result: answer, modelUsage: { [used]: { inputTokens: 1 } },
    ...(structured ? { structured_output: JSON.parse(structured) } : {}) });
} else {
  if (mode === 'fail') { process.stdout.write(JSON.stringify({ type: 'error', message: 'grok: boom' })); process.exit(1); }
  const usage = mode === 'downgrade' ? { 'claude-sonnet-stub': {} } : mode === 'sibling' ? { 'grok-sibling-stub': {} } : { [model]: { modelCalls: 1 } };
  process.stdout.write(JSON.stringify({ text: answer, stopReason: 'end_turn', modelUsage: usage, ...(structured ? { structuredOutput: structured } : {}) }));
}
`;
for (const name of ['claude', 'codex', 'grok']) fs.writeFileSync(path.join(STUBS, name), stub(name), { mode: 0o755 });

// The file's bytes are the prompt, its last newline included.
const PROMPT = 'Read brief.md and say what you think.\n';
const PF = path.join(tmp, 'prompt.txt');
fs.writeFileSync(PF, PROMPT);
const HOME = mk('home-defaults');
const USER_HOME = mk('home-user', '.agent-config-studio');
fs.writeFileSync(path.join(USER_HOME, 'roles.json'), J({
  version: 1,
  roles: { advisor: { use: [{ family: 'sol', effort: 'xhigh' }, 'opus'] } },
  flavor: { fable: { effort: 'max' } },
}));
const GIT_ENV = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(tmp, 'gitconfig') };

function ask(args, { env = {}, home = HOME, cwd = tmp, prompt = PF } = {}) {
  fs.writeFileSync(LOG, '');
  const r = spawnSync(process.execPath, [ASK, ...(prompt ? ['--prompt-file', prompt] : []), ...args], {
    cwd, encoding: 'utf8', env: { HOME: home, PATH: PATHS, STUB_LOG: LOG, ...GIT_ENV, ...env },
  });
  const all = fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  // Model calls apart from the MCP checks before them: codex's `mcp list`, grok's `inspect`.
  const calls = all.filter((c) => c.argv[0] !== 'mcp' && c.argv[0] !== 'inspect');
  const mcp = all.filter((c) => c.argv[0] === 'mcp');
  const inspect = all.filter((c) => c.argv[0] === 'inspect');
  return { code: r.status, out: r.stdout, err: r.stderr, calls, mcp, inspect, argv: calls[0]?.argv };
}
const show = (r) => J({ code: r.code, out: r.out, err: r.err, calls: r.calls, mcp: r.mcp, inspect: r.inspect });

const CLAUDE_RO = (id, effort) => ['-p', PROMPT, '--model', id, ...(effort ? ['--effort', effort] : []), '--output-format', 'json',
  '--dangerously-skip-permissions', '--tools', 'Read,Grep,Glob', '--strict-mcp-config', '--setting-sources', 'user'];
const CODEX = (id, effort) => ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '-m', id,
  ...(effort ? ['-c', `model_reasoning_effort=${effort}`] : []), PROMPT];
const GROK_RO = (id, effort, cwd) => ['-p', PROMPT, '-m', id, ...(effort ? ['--reasoning-effort', effort] : []), '--cwd', cwd,
  '--tools', 'read_file,list_dir,grep', '--disallowed-tools', 'search_tool,use_tool', '--deny', 'MCPTool',
  '--disable-web-search', '--no-subagents', '--max-turns', '40', '--output-format', 'json'];

console.log('\nask-model: no real model CLI is reachable');
{
  const real = ['claude', 'codex', 'grok'].flatMap((n) => SYSTEM.map((d) => path.join(d, n))).filter((p) => fs.existsSync(p));
  ok('none of claude, codex, grok in /usr/bin or /bin (the only system dirs on PATH)', real.length === 0, real.join(' '));
  if (real.length) process.exit(1);
}

console.log('\nask-model: each CLI\'s argv');
const WORK = mk('work');
{
  const r = ask(['--family', 'fable', '--effort', 'high']);
  ok('claude: exact argv, read-only tools, no MCP', r.code === 0 && same(r.argv, CLAUDE_RO(IDS.fable, 'high')), show(r));
  ok('claude: the answer on stdout, one label line on stderr',
     r.out === `answer from ${IDS.fable}\n` && r.err === `ask-model: fable (${IDS.fable}, effort high, read-only)\n`, show(r));
  ok('claude: stdin is /dev/null, one call', r.calls.length === 1 && r.calls[0].stdin === 'chardev', show(r));

  const c = ask(['--family', 'sol', '--effort', 'xhigh', '--cwd', WORK]);
  ok('codex: exact argv (read-only sandbox, -m, the effort as -c)', c.code === 0 && c.calls[0]?.name === 'codex' && same(c.argv, CODEX(IDS.sol, 'xhigh')), show(c));
  ok('codex: stdin is /dev/null and it runs in --cwd', c.calls[0]?.stdin === 'chardev' && c.calls[0]?.cwd === WORK, show(c));
  ok('codex: its stdout is the answer', c.out === `answer from ${IDS.sol}\n`, show(c));

  const g = ask(['--family', 'grok', '--effort', 'high', '--cwd', WORK]);
  ok('grok: exact argv (read tools only, MCP denied, JSON out)', g.code === 0 && g.calls[0]?.name === 'grok' && same(g.argv, GROK_RO(IDS.grok, 'high', WORK)), show(g));
  ok('grok: stdin is /dev/null; the answer is the reply\'s text', g.calls[0]?.stdin === 'chardev' && g.out === `answer from ${IDS.grok}\n`, show(g));

  const dash = path.join(tmp, 'dash.txt');
  fs.writeFileSync(dash, '---\ntitle: brief\n');
  const d = ask(['--family', 'fable'], { prompt: dash });
  ok('a prompt starting with "-" goes in after a newline, so no CLI reads it as a flag', d.code === 0 && d.argv?.[1] === '\n---\ntitle: brief\n', show(d));
}

console.log('\nask-model: an empty effort passes no effort flag');
{
  const unset = ['opus', 'astra', 'grok'].filter((f) => !ROLES.flavor[f]?.effort);
  ok('precondition: opus, astra and grok have no flavor effort in the defaults', unset.length === 3, unset.join());
  const c = ask(['--family', 'opus']);
  ok('claude: no --effort', c.code === 0 && same(c.argv, CLAUDE_RO(IDS.opus, '')) && / effort none, /.test(c.err), show(c));
  const x = ask(['--family', 'astra']);
  ok('codex: no -c at all (the stub rejects an empty one, as codex does)', x.code === 0 && same(x.argv, CODEX(IDS.astra, '')), show(x));
  const g = ask(['--family', 'grok', '--cwd', WORK]);
  ok('grok: no --reasoning-effort', g.code === 0 && same(g.argv, GROK_RO(IDS.grok, '', WORK)), show(g));
  const e = ask(['--role', 'advisor', '--effort', '']);
  ok('--effort "" overrides the role\'s effort with none', e.code === 0 && !e.argv.includes('--effort') && / effort none, /.test(e.err), show(e));
}

console.log('\nask-model: roles and families');
{
  const rev = ROLES.roles.reviewer;
  const fam = [].concat(rev.use)[0];
  const r = ask(['--role', 'reviewer']);
  ok(`--role reviewer: the role's first family (${fam}) at the role's effort (${rev.effort})`,
     r.code === 0 && same(r.argv, CODEX(IDS[fam], rev.effort)) && r.err.startsWith(`ask-model: ${fam} (${IDS[fam]}, effort ${rev.effort}, read-only)`), show(r));
  const home = path.dirname(USER_HOME);
  const u = ask(['--role', 'advisor'], { home });
  ok('a user roles.json: the first member, at its own effort', u.code === 0 && same(u.argv, CODEX(IDS.sol, 'xhigh')), show(u));
  const o = ask(['--role', 'advisor', '--effort', 'low'], { home });
  ok('--effort wins over the role\'s', o.code === 0 && same(o.argv, CODEX(IDS.sol, 'low')), show(o));
  const f = ask(['--family', 'fable'], { home });
  ok('--family: the family\'s flavor effort', f.code === 0 && same(f.argv, CLAUDE_RO(IDS.fable, 'max')), show(f));
  const nr = ask(['--role', 'nobody']);
  ok('an unknown role: exit 64, says why, calls nothing', nr.code === 64 && /unknown role "nobody"/.test(nr.err) && nr.calls.length === 0, show(nr));
  const nf = ask(['--family', 'opuss']);
  ok('an unknown family: exit 64, calls nothing', nf.code === 64 && /"opuss" is not a model family/.test(nf.err) && nf.calls.length === 0, show(nf));
  const raw = ask(['--family', IDS.opus]);
  ok('a raw id is refused: name the family', raw.code === 64 && raw.calls.length === 0, show(raw));
}

console.log('\nask-model: read-only and --investigate');
const git = (...a) => {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: WORK, encoding: 'utf8', env: { PATH: SYSTEM.join(':'), HOME, ...GIT_ENV } });
  if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
  return r.stdout;
};
git('init', '-q');
fs.writeFileSync(path.join(WORK, 'a.txt'), 'a\n');
fs.writeFileSync(path.join(WORK, 'dirty.txt'), 'committed\n');
git('add', '.');
git('commit', '-q', '-m', 'base');
// Dirty before any call: a write to it must still show.
fs.writeFileSync(path.join(WORK, 'dirty.txt'), 'committed\nedited by hand\n');
const resetWork = () => {
  fs.rmSync(path.join(WORK, 'new file.txt'), { force: true });
  fs.writeFileSync(path.join(WORK, 'dirty.txt'), 'committed\nedited by hand\n');
};
{
  const c = ask(['--family', 'fable', '--investigate', '--cwd', WORK]);
  const tools = c.argv?.[c.argv.indexOf('--tools') + 1];
  ok('claude --investigate: Bash added to the tools, MCP still off', c.code === 0 && tools === 'Read,Grep,Glob,Bash' && c.argv.includes('--strict-mcp-config') && !c.argv.some((a) => /^--mcp-config/.test(a)), show(c));
  ok('…and the label says investigate', / effort none, investigate\)\n/.test(c.err), show(c));
  const ro = ask(['--family', 'fable', '--cwd', WORK]);
  ok('claude read-only: no Bash, MCP off, prompts skipped only with the allowlist set',
     ro.argv?.[ro.argv.indexOf('--tools') + 1] === 'Read,Grep,Glob' && ro.argv.includes('--strict-mcp-config') && ro.argv.includes('--dangerously-skip-permissions'), show(ro));
  const g = ask(['--family', 'grok', '--investigate', '--cwd', WORK]);
  ok('grok --investigate: its shell tool added, MCP still denied', g.code === 0 && g.argv?.[g.argv.indexOf('--tools') + 1] === 'read_file,list_dir,grep,run_terminal_cmd' && g.argv.includes('MCPTool'), show(g));
  const xi = ask(['--family', 'astra', '--investigate', '--cwd', WORK]);
  ok('codex --investigate: the same read-only sandbox argv', xi.code === 0 && same(xi.argv, CODEX(IDS.astra, '')), show(xi));

  const w = ask(['--family', 'sol', '--investigate', '--cwd', WORK], { env: { STUB_WRITE: 'new file.txt,dirty.txt' } });
  ok('a write under --investigate: exit 5, each changed file named (an already-dirty one too)',
     w.code === 5 && /files changed under --investigate/.test(w.err) && /\n {2}dirty\.txt\n/.test(w.err) && /\n {2}new file\.txt\n/.test(w.err), show(w));
  ok('…the answer is still printed, and nothing is reverted',
     w.out === `answer from ${IDS.sol}\n` && fs.existsSync(path.join(WORK, 'new file.txt')) && /written by the stub/.test(fs.readFileSync(path.join(WORK, 'dirty.txt'), 'utf8')), show(w));
  resetWork();
  const wj = ask(['--family', 'grok', '--investigate', '--json', '--cwd', WORK], { env: { STUB_WRITE: 'new file.txt' } });
  const wjo = JSON.parse(wj.out || '{}');
  ok('--json: changed lists the files', wj.code === 5 && same(wjo.changed, ['new file.txt']) && /files changed/.test(wjo.error), show(wj));
  resetWork();
  const wf = ask(['--family', 'sol', '--investigate', '--cwd', WORK], { env: { STUB_WRITE: 'new file.txt', STUB_MODE: 'fail' } });
  ok('a failed call that changed files: exit 5, both reported', wf.code === 5 && /codex: boom/.test(wf.err) && /new file\.txt/.test(wf.err), show(wf));
  resetWork();
  const clean = ask(['--family', 'fable', '--investigate', '--json', '--cwd', WORK]);
  ok('no write: exit 0, changed is []', clean.code === 0 && same(JSON.parse(clean.out || '{}').changed, []), show(clean));
  const plain = mk('not-a-repo');
  const nr = ask(['--family', 'fable', '--investigate', '--json', '--cwd', plain]);
  ok('outside a git work tree: it says changes are not checked, changed is null',
     nr.code === 0 && /is not in a git work tree — changes are not checked/.test(nr.err) && JSON.parse(nr.out || '{}').changed === null, show(nr));
  const rj = ask(['--family', 'fable', '--json', '--cwd', WORK]);
  ok('read-only takes no snapshot: changed is null', rj.code === 0 && JSON.parse(rj.out || '{}').changed === null, show(rj));
}

console.log('\nask-model: proof of model and failures');
{
  const d = ask(['--family', 'fable'], { env: { STUB_MODE: 'downgrade' } });
  ok('claude: another model in modelUsage → exit 2, no answer, both models named',
     d.code === 2 && d.out === '' && d.err.includes(IDS.fable) && d.err.includes('claude-sonnet-stub'), show(d));
  const g = ask(['--family', 'grok'], { env: { STUB_MODE: 'downgrade' } });
  ok('grok: no grok model in modelUsage → exit 2, no answer', g.code === 2 && g.out === '' && /claude-sonnet-stub/.test(g.err), show(g));
  const m = ask(['--family', 'fable'], { env: { PATH: EMPTY } });
  ok('the CLI not on PATH → exit 3, says which', m.code === 3 && /the claude CLI is not on PATH/.test(m.err) && m.calls.length === 0, show(m));
  const e = ask(['--family', 'fable'], { env: { STUB_MODE: 'is_error' } });
  ok('claude is_error → exit 4, its message on stderr, no answer', e.code === 4 && /claude: boom/.test(e.err) && e.out === '', show(e));
  const n = ask(['--family', 'fable'], { env: { STUB_MODE: 'garbage' } });
  ok('claude output that is not JSON → exit 4', n.code === 4 && /without a JSON reply/.test(n.err), show(n));
  const x = ask(['--family', 'sol'], { env: { STUB_MODE: 'fail' } });
  ok('codex exits non-zero → exit 4, its stderr shown', x.code === 4 && /codex exited 1: codex: boom/.test(x.err), show(x));
  const ge = ask(['--family', 'grok'], { env: { STUB_MODE: 'fail' } });
  ok('grok\'s error object → exit 4', ge.code === 4 && /grok: boom/.test(ge.err), show(ge));
  const em = ask(['--family', 'fable'], { env: { STUB_MODE: 'empty' } });
  ok('an empty answer → exit 4', em.code === 4 && /empty answer/.test(em.err), show(em));
}

console.log('\nask-model: --json');
{
  const r = ask(['--family', 'fable', '--effort', 'high', '--json']);
  const o = JSON.parse(r.out || '{}');
  ok('the keys, in order', same(Object.keys(o), ['family', 'id', 'effort', 'mode', 'answer', 'changed', 'error']), r.out);
  ok('the values', r.code === 0 && same(o, { family: 'fable', id: IDS.fable, effort: 'high', mode: 'read-only', answer: `answer from ${IDS.fable}`, changed: null, error: null }), r.out);
  const none = JSON.parse(ask(['--family', 'opus', '--json']).out || '{}');
  ok('no effort is null', none.effort === null, J(none));
  const d = ask(['--family', 'fable', '--json'], { env: { STUB_MODE: 'downgrade' } });
  const dj = JSON.parse(d.out || '{}');
  ok('a failure still prints the object: answer null, the reason in error', d.code === 2 && dj.answer === null && /claude-sonnet-stub/.test(dj.error), d.out);
}

console.log('\nask-model: usage');
{
  const empty = path.join(tmp, 'empty.txt');
  fs.writeFileSync(empty, ' \n');
  for (const [what, args, prompt = PF] of [
    ['no arguments', [], null],
    ['no --prompt-file', ['--family', 'fable'], null],
    ['both --role and --family', ['--role', 'advisor', '--family', 'fable']],
    ['neither', ['--json']],
    ['an effort that is not one', ['--family', 'fable', '--effort', 'huge']],
    ['an unknown flag', ['--family', 'fable', '--bogus']],
    ['a flag given twice', ['--family', 'fable', '--family', 'opus']],
    ['a flag with no value', ['--family']],
    ['a prompt file that is not there', ['--family', 'fable'], path.join(tmp, 'nope.txt')],
    ['an empty prompt file', ['--family', 'fable'], empty],
    ['a --cwd that is not there', ['--family', 'fable', '--cwd', path.join(tmp, 'nope')]],
  ]) {
    const r = ask(args, { prompt });
    ok(`${what}: exit 64 with the usage line, nothing called`, r.code === 64 && /usage: ask-model /.test(r.err) && r.calls.length === 0 && r.out === '', show(r));
  }
  const h = ask(['--help'], { prompt: null });
  ok('--help: the usage line, exit 0', h.code === 0 && /^usage: ask-model /.test(h.out), show(h));
}

console.log('\nask-model: model-id --install');
{
  const home = mk('home-install');
  const inst = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'model-id.mjs'), '--install'], { encoding: 'utf8', env: { HOME: home, PATH: SYSTEM.join(':') } });
  const studio = path.join(home, '.agent-config-studio');
  const launcher = path.join(studio, 'bin', 'ask-model');
  const link = path.join(home, '.local', 'bin', 'ask-model');
  ok('model-id --install succeeds and says where ask-model went', inst.status === 0
     && inst.stdout.includes('launcher  ~/.agent-config-studio/bin/ask-model\nlinked    ~/.local/bin/ask-model → ~/.agent-config-studio/bin/ask-model\n'), J(inst));
  ok('~/.local/bin/ask-model is a symlink to the launcher', fs.lstatSync(link).isSymbolicLink() && fs.readlinkSync(link) === launcher);
  const installed = path.join(studio, 'resolver', 'bin', 'ask-model.mjs');
  ok('the resolver holds a byte-for-byte copy beside model-id', fs.readFileSync(installed).equals(fs.readFileSync(ASK)) && !fs.lstatSync(installed).isSymbolicLink());
  const imports = [...fs.readFileSync(installed, 'utf8').matchAll(/^import[\s\S]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
  ok('…which imports only node: builtins and the resolver\'s ../lib/', imports.every((i) => i.startsWith('node:') || /^\.\.\/lib\/(models|roles)\.js$/.test(i)), imports.join());
  const src = fs.readFileSync(launcher, 'utf8');
  ok('the launcher pins the node that ran the install', src.includes(`NODE='${process.execPath}'`) && (fs.statSync(launcher).mode & 0o111) !== 0);

  const shPath = [STUBS, ...SYSTEM, path.join(home, '.local', 'bin')].join(':');
  fs.writeFileSync(LOG, '');
  const sh = spawnSync('/bin/sh', ['-c', `ask-model --family fable --effort high --prompt-file '${PF}'`], { encoding: 'utf8', env: { HOME: home, PATH: shPath, STUB_LOG: LOG } });
  const argv = JSON.parse(fs.readFileSync(LOG, 'utf8').split('\n')[0] || '{}').argv;
  ok('/bin/sh -c "ask-model …" through the link, with no node on PATH', sh.status === 0 && sh.stdout === `answer from ${IDS.fable}\n` && same(argv, CLAUDE_RO(IDS.fable, 'high')), J(sh));

  fs.writeFileSync(launcher, src.replace(/^NODE=.*$/m, "NODE='/nonexistent/node'"));
  const noNode = spawnSync('/bin/sh', ['-c', `ask-model --family fable --prompt-file '${PF}'`], { encoding: 'utf8', env: { HOME: home, PATH: shPath, STUB_LOG: LOG, MODEL_ID_BREW_NODE: '/nonexistent/node' } });
  ok('pinned node gone and none found → exit 3, "node not found"', noNode.status === 3 && /ask-model: node not found/.test(noNode.stderr), J(noNode));

  const home2 = mk('home-clash');
  fs.mkdirSync(path.join(home2, '.local', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(home2, '.local', 'bin', 'ask-model'), '#!/bin/sh\necho mine\n');
  const clash = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'model-id.mjs'), '--install'], { encoding: 'utf8', env: { HOME: home2, PATH: SYSTEM.join(':') } });
  ok('a real file at ~/.local/bin/ask-model: install exits 1 and leaves it alone',
     clash.status === 1 && /ask-model exists and is not a symlink/.test(clash.stderr) && fs.readFileSync(path.join(home2, '.local', 'bin', 'ask-model'), 'utf8') === '#!/bin/sh\necho mine\n', J(clash));
  ok('…while model-id is still installed and linked', fs.lstatSync(path.join(home2, '.local', 'bin', 'model-id')).isSymbolicLink());
}

console.log('\nask-model: codex runs with its configured MCP servers off');
{
  // Names may hold '.', ':', '@' and '/', which codex accepts and a dotted -c path cannot quote.
  const names = ['writer', 'a.b', 'x:y@z/w'];
  const off = 'mcp_servers={"writer"={enabled=false},"a.b"={enabled=false},"x:y@z/w"={enabled=false}}';
  const r = ask(['--family', 'sol', '--cwd', WORK], { env: { STUB_MCP: J(names) } });
  ok('every server mcp list reports is disabled by one inline-table override',
     r.code === 0 && same(r.argv, ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '-m', IDS.sol, '-c', off, PROMPT]), show(r));
  ok('…found by mcp list in the call\'s folder, then checked under the override, stdin /dev/null',
     r.mcp.length === 2 && same(r.mcp[0].argv, ['mcp', 'list', '--json']) && same(r.mcp[1].argv, ['mcp', 'list', '--json', '-c', off])
     && r.mcp.every((c) => c.cwd === WORK && c.stdin === 'chardev'), show(r));
  const e = ask(['--family', 'sol', '--effort', 'high'], { env: { STUB_MCP: J(['writer']) } });
  ok('with an effort: both overrides, the effort first',
     e.code === 0 && same(e.argv, ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '-m', IDS.sol,
       '-c', 'model_reasoning_effort=high', '-c', 'mcp_servers={"writer"={enabled=false}}', PROMPT]), show(e));
  const none = ask(['--family', 'sol']);
  ok('no server configured: no override, one mcp list', none.code === 0 && same(none.argv, CODEX(IDS.sol, '')) && none.mcp.length === 1, show(none));
  const ign = ask(['--family', 'sol'], { env: { STUB_MCP: J(['writer']), STUB_MCP_IGNORE: '1' } });
  ok('a server still enabled under the override: exit 4, codex never run',
     ign.code === 4 && ign.calls.length === 0 && /codex MCP servers still enabled under the override: writer — codex was not run/.test(ign.err), show(ign));
  const fl = ask(['--family', 'sol'], { env: { STUB_MCP_FAIL: '1' } });
  ok('mcp list fails: exit 4, codex never run', fl.code === 4 && fl.calls.length === 0 && /codex mcp list failed: mcp: boom/.test(fl.err), show(fl));
  const cl = ask(['--family', 'fable'], { env: { STUB_MCP: J(['writer']) } });
  const gr = ask(['--family', 'grok'], { env: { STUB_MCP: J(['writer']) } });
  ok('claude and grok never run mcp list', cl.code === 0 && gr.code === 0 && cl.mcp.length === 0 && gr.mcp.length === 0, show(cl));
}

console.log('\nask-model: grok --investigate may run the shell');
{
  const g = ask(['--family', 'grok', '--investigate', '--cwd', WORK]);
  ok('exact argv: the shell tool, the shell allowed, the read tools and MCP denial kept',
     g.code === 0 && same(g.argv, ['-p', PROMPT, '-m', IDS.grok, '--cwd', WORK, '--tools', 'read_file,list_dir,grep,run_terminal_cmd',
       '--disallowed-tools', 'search_tool,use_tool', '--deny', 'MCPTool', '--allow', 'Bash', '--disable-web-search', '--no-subagents',
       '--max-turns', '40', '--output-format', 'json']), show(g));
  const ro = ask(['--family', 'grok', '--cwd', WORK]);
  ok('read-only allows nothing', ro.code === 0 && !ro.argv.includes('--allow'), show(ro));
  const refused = 'permission required: Bash ls was not run, as a headless run cannot ask for approval';
  const p = ask(['--family', 'grok', '--investigate', '--cwd', WORK], { env: { STUB_STDERR: `a note grok printed\n${refused}` } });
  ok('a permission grok refused (it still exits 0) is passed on to stderr, and only that line',
     p.code === 0 && p.err.includes(`ask-model: grok: ${refused}\n`) && !p.err.includes('a note grok printed'), show(p));
}

console.log('\nask-model: grok must report the resolved id');
{
  const s2 = ask(['--family', 'grok'], { env: { STUB_MODE: 'sibling' } });
  ok('another grok model in modelUsage → exit 2, no answer', s2.code === 2 && s2.out === '' && /grok-sibling-stub/.test(s2.err) && s2.err.includes(IDS.grok), show(s2));
}

console.log('\nask-model: a chmod under --investigate');
{
  const dirty = path.join(WORK, 'dirty.txt');
  const ch = ask(['--family', 'sol', '--investigate', '--cwd', WORK], { env: { STUB_CHMOD: 'dirty.txt' } });
  ok('a mode change to an already-dirty file: exit 5, the file named', ch.code === 5 && /\n {2}dirty\.txt\n/.test(ch.err) && (fs.statSync(dirty).mode & 0o111) !== 0, show(ch));
  fs.chmodSync(dirty, 0o644);
  resetWork();
}

console.log('\nask-model: the installed model-id --install restores ask-model');
{
  const home = mk('home-reinstall');
  const env = { HOME: home, PATH: SYSTEM.join(':') };
  const first = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'model-id.mjs'), '--install'], { encoding: 'utf8', env });
  const studio = path.join(home, '.agent-config-studio');
  const launcher = path.join(studio, 'bin', 'ask-model');
  const link = path.join(home, '.local', 'bin', 'ask-model');
  const installed = path.join(studio, 'resolver', 'bin', 'ask-model.mjs');
  fs.rmSync(launcher);
  fs.rmSync(link);
  const again = spawnSync(process.execPath, [path.join(studio, 'resolver', 'bin', 'model-id.mjs'), '--install'], { encoding: 'utf8', env });
  ok('a re-run of the installed copy puts the launcher and the link back',
     first.status === 0 && again.status === 0 && fs.existsSync(launcher) && fs.readlinkSync(link) === launcher && /linked {4}~\/\.local\/bin\/ask-model/.test(again.stdout), J(again));
  ok('…its ask-model unchanged', fs.readFileSync(installed).equals(fs.readFileSync(ASK)));
  fs.writeFileSync(LOG, '');
  const sh = spawnSync('/bin/sh', ['-c', `ask-model --family fable --prompt-file '${PF}'`], {
    encoding: 'utf8', env: { HOME: home, PATH: [STUBS, ...SYSTEM, path.join(home, '.local', 'bin')].join(':'), STUB_LOG: LOG },
  });
  ok('…and it runs', sh.status === 0 && sh.stdout === `answer from ${IDS.fable}\n`, J(sh));
}

console.log('\nask-model: grok runs only when no MCP server would start');
{
  const g = ask(['--family', 'grok', '--cwd', WORK]);
  ok('grok inspect runs first, in the call\'s folder, with the Claude and Cursor MCP sources off',
     g.code === 0 && g.inspect.length === 1 && same(g.inspect[0].argv, ['inspect', '--json']) && g.inspect[0].cwd === WORK
     && g.inspect[0].stdin === 'chardev' && same(g.inspect[0].mcpEnv, ['0', '0']), show(g));
  ok('…and the call itself runs with them off', same(g.calls[0]?.mcpEnv, ['0', '0']), show(g));
  const inspect = (servers, plugins = []) => ({ STUB_GROK_INSPECT: J({ grokVersion: 'stub', mcpServers: servers, plugins }) });
  const own = ask(['--family', 'grok'], { env: inspect([{ name: 'own', source: { type: 'configToml' } },
    { name: 'fromclaude', compatibilityStatus: 'disabled' }, { name: 'off', enabled: false }]) });
  ok('a server of its own still enabled: exit 4, named with the fix, grok never run',
     own.code === 4 && own.calls.length === 0 && /grok would start MCP servers no flag keeps out of a run \(own\), so grok was not run/.test(own.err)
     && /grok mcp disable <name>/.test(own.err), show(own));
  const pl = ask(['--family', 'grok'], { env: inspect([], [{ name: 'kit', provides: { mcpServers: 2 } },
    { name: 'quiet', enabled: false, provides: { mcpServers: 1 } }, { name: 'tools', provides: { mcpServers: 0 } }]) });
  ok('a plugin that brings servers: exit 4, named as a plugin', pl.code === 4 && pl.calls.length === 0 && /\(kit \(plugin\)\)/.test(pl.err), show(pl));
  const clear = ask(['--family', 'grok'], { env: inspect([{ name: 'fromclaude', compatibilityStatus: 'disabled' }, { name: 'off', enabled: false }],
    [{ name: 'tools', provides: { mcpServers: 0 } }]) });
  ok('only disabled servers and server-less plugins: grok runs', clear.code === 0 && clear.calls.length === 1, show(clear));
  const odd = ask(['--family', 'grok'], { env: { STUB_GROK_INSPECT: J({ mcpServers: [{ name: 'x', enabled: 'yes' }], plugins: [] }) } });
  ok('output of another shape is not read as "no servers": exit 4', odd.code === 4 && odd.calls.length === 0 && /enabled is not a boolean/.test(odd.err), show(odd));
  const nolist = ask(['--family', 'grok'], { env: { STUB_GROK_INSPECT: J({ plugins: [] }) } });
  ok('…nor a missing server list', nolist.code === 4 && nolist.calls.length === 0 && /no mcpServers and plugins lists/.test(nolist.err), show(nolist));
  const fail = ask(['--family', 'grok'], { env: { STUB_GROK_INSPECT_FAIL: '1' } });
  ok('grok inspect fails: exit 4, grok never run', fail.code === 4 && fail.calls.length === 0 && /grok inspect failed: inspect: boom/.test(fail.err), show(fail));
  const cl = ask(['--family', 'fable']);
  const cx = ask(['--family', 'sol']);
  ok('claude and codex run no grok inspect and get no grok switches',
     cl.code === 0 && cx.code === 0 && cl.inspect.length === 0 && cx.inspect.length === 0 && same(cl.calls[0]?.mcpEnv, [null, null]) && same(cx.calls[0]?.mcpEnv, [null, null]), show(cl));
}

console.log('\nask-model: a HEAD move under --investigate');
{
  fs.writeFileSync(path.join(WORK, 'b.txt'), 'b\n');
  git('add', 'b.txt');
  git('commit', '-q', '-m', 'second');
  const branch = git('symbolic-ref', '--short', 'HEAD').trim();
  const tip = git('rev-parse', 'HEAD').trim().slice(0, 12);
  const base = git('rev-parse', 'HEAD~1').trim().slice(0, 12);
  // dirty.txt is the same in both commits, so git status reads the same before and after.
  const co = ask(['--family', 'sol', '--investigate', '--json', '--cwd', WORK], { env: { STUB_GIT: 'checkout -q HEAD~1' } });
  const moved = `HEAD ${tip} (${branch}) → ${base} (detached)`;
  ok('a checkout that leaves git status as it was: exit 5, both commits named',
     co.code === 5 && same(JSON.parse(co.out || '{}').changed, [moved]) && co.err.includes(`\n  ${moved}\n`), show(co));
  git('checkout', '-q', branch);
  git('branch', 'other');
  const sw = ask(['--family', 'sol', '--investigate', '--cwd', WORK], { env: { STUB_GIT: 'checkout -q other' } });
  ok('a switch to another branch at the same commit is named too', sw.code === 5 && sw.err.includes(`\n  HEAD ${tip} (${branch}) → ${tip} (other)\n`), show(sw));
  git('checkout', '-q', branch);
}

console.log('\nask-model: claude\'s verbose event list, and its errors');
{
  const v = ask(['--family', 'fable'], { env: { STUB_VERBOSE: '1' } });
  ok('a list of events: the last result event is the reply', v.code === 0 && v.out === `answer from ${IDS.fable}\n`, show(v));
  const vd = ask(['--family', 'fable'], { env: { STUB_VERBOSE: '1', STUB_MODE: 'downgrade' } });
  ok('…whose modelUsage is checked: another model → exit 2', vd.code === 2 && vd.out === '' && /claude-sonnet-stub/.test(vd.err), show(vd));
  const ve = ask(['--family', 'fable'], { env: { STUB_VERBOSE: '1', STUB_MODE: 'is_error' } });
  ok('…and whose is_error is checked: exit 4 with its message', ve.code === 4 && /claude returned an error: claude: boom/.test(ve.err), show(ve));
  const nr = ask(['--family', 'fable'], { env: { STUB_MODE: 'no_result' } });
  ok('a list with no result event: exit 4', nr.code === 4 && /claude printed no result event/.test(nr.err), show(nr));
  const er = ask(['--family', 'fable'], { env: { STUB_MODE: 'errors' } });
  ok('an error with an errors list and no result: the errors are the message',
     er.code === 4 && er.err.includes('claude returned an error: first problem; {"message":"second problem"}'), show(er));
}

console.log('\nask-model: acs names a stale copy');
{
  const acs = fs.readFileSync(path.join(ROOT, 'bin', 'acs'), 'utf8');
  ok('a pull that changes tools/ask-model.mjs says to reinstall', /diff --quiet "\$before" "\$after" -- [^\n]*tools\/ask-model\.mjs[^\n]*\n\s+echo "  the model-id resolver changed/.test(acs));
  ok('an installed ask-model that differs from the package is named', acs.includes('! cmp -s "$r/bin/ask-model.mjs" "$DIR/tools/ask-model.mjs"'));
}

console.log('\nask-model: codex servers a plugin provides');
{
  const full = 'mcp_servers={"writer"={enabled=false},"cua_repl"={enabled=false}}';
  const rest = 'mcp_servers={"writer"={enabled=false}}';
  const env = { STUB_MCP: J(['writer']), STUB_MCP_PLUGIN: J(['cua_repl']) };
  const r = ask(['--family', 'sol', '--cwd', WORK], { env });
  ok('the override is refused for a plugin\'s server: plugins go off, the override covers the rest',
     r.code === 0 && same(r.argv, ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '-m', IDS.sol,
       '-c', 'features.plugins=false', '-c', rest, PROMPT]), show(r));
  ok('…found by mcp list, the refused check, a list with plugins off, then the check under both',
     r.mcp.length === 4 && same(r.mcp.map((c) => c.argv), [['mcp', 'list', '--json'], ['mcp', 'list', '--json', '-c', full],
       ['mcp', 'list', '--json', '-c', 'features.plugins=false'], ['mcp', 'list', '--json', '-c', 'features.plugins=false', '-c', rest]])
     && r.mcp.every((c) => c.cwd === WORK && c.stdin === 'chardev'), show(r));
  const e = ask(['--family', 'sol', '--effort', 'high'], { env });
  ok('with an effort: the effort first, then plugins off, then the override',
     e.code === 0 && same(e.argv, ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '-m', IDS.sol,
       '-c', 'model_reasoning_effort=high', '-c', 'features.plugins=false', '-c', rest, PROMPT]), show(e));
  const only = ask(['--family', 'sol'], { env: { STUB_MCP_PLUGIN: J(['cua_repl']) } });
  ok('only plugin servers: plugins off and no mcp_servers override',
     only.code === 0 && same(only.argv, ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '-m', IDS.sol, '-c', 'features.plugins=false', PROMPT])
     && same(only.mcp.at(-1)?.argv, ['mcp', 'list', '--json', '-c', 'features.plugins=false']), show(only));
  const sticky = ask(['--family', 'sol'], { env: { ...env, STUB_PLUGINS_STICKY: '1' } });
  ok('a plugin server that stays with plugins off: exit 4, codex never run, codex\'s refusal shown',
     sticky.code === 4 && sticky.calls.length === 0 && /codex mcp list failed: [\s\S]*invalid transport[\s\S]*mcp_servers\.cua_repl[\s\S]* — codex was not run/.test(sticky.err), show(sticky));
  const inv = ask(['--family', 'sol', '--investigate', '--cwd', WORK], { env });
  ok('--investigate gets the same overrides', inv.code === 0 && same(inv.argv, r.argv), show(inv));
}

console.log('\nask-model: model-id --install never writes through a link planted at a temp name');
{
  const home = mk('home-planted');
  const victim = path.join(tmp, 'victim.txt');
  fs.writeFileSync(victim, 'victim bytes\n');
  // The attacker's guess: the old names, <dest>.tmp-<pid>, for model-id's own copy and ask-model's, planted as the process starts.
  const resolverBin = path.join(home, '.agent-config-studio', 'resolver', 'bin');
  const preload = path.join(tmp, 'plant-temp.cjs');
  fs.writeFileSync(preload, `const fs=require('node:fs');fs.mkdirSync(${J(resolverBin)},{recursive:true});` +
    `for(const n of ['model-id.mjs','ask-model.mjs'])fs.symlinkSync(${J(victim)},require('node:path').join(${J(resolverBin)},n)+'.tmp-'+process.pid)`);
  const inst = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'model-id.mjs'), '--install'], { encoding: 'utf8', env: { HOME: home, PATH: SYSTEM.join(':'), NODE_OPTIONS: `--require=${preload}` } });
  ok('the install still succeeds', inst.status === 0, J(inst));
  ok('…and the victim behind the planted links is untouched', fs.readFileSync(victim, 'utf8') === 'victim bytes\n');
  for (const name of ['model-id.mjs', 'ask-model.mjs']) {
    const dest = path.join(resolverBin, name);
    ok(`…and resolver/bin/${name} is a real file, not the planted link`, !fs.lstatSync(dest).isSymbolicLink() && fs.lstatSync(dest).isFile());
  }
}

console.log('\nask-model: claude never loads the repo\'s own settings or hooks');
{
  // A headless claude run in a repo honours its .claude/settings.json and settings.local.json hooks; only
  // --setting-sources user keeps them out (and still reads your login).
  for (const extra of [[], ['--investigate']]) {
    const r = ask(['--family', 'fable', '--cwd', WORK, ...extra]);
    const at = r.argv?.indexOf('--setting-sources') ?? -1;
    ok(`claude${extra.length ? ' --investigate' : ''}: --setting-sources user, given once`,
       at !== -1 && r.argv[at + 1] === 'user' && r.argv.filter((a) => a === '--setting-sources').length === 1, show(r));
  }
}

console.log('\nask-model: grok runs with Claude\'s and Cursor\'s hooks off, and never beside a repo\'s .grok/hooks');
{
  // A grok stub that logs the hook switches it got, answers `inspect --json` from STUB_GROK_INSPECT, and answers a run.
  const bin = mk('stubs-grok-hooks');
  const glog = path.join(tmp, 'grok-hooks-calls.jsonl');
  fs.writeFileSync(path.join(bin, 'grok'), `#!${process.execPath}
const fs = require('node:fs');
const a = process.argv.slice(2);
fs.appendFileSync(${J(glog)}, JSON.stringify({ argv: a, hooksEnv: [process.env.GROK_CLAUDE_HOOKS_ENABLED ?? null, process.env.GROK_CURSOR_HOOKS_ENABLED ?? null] }) + '\\n');
if (a[0] === 'inspect') { process.stdout.write(process.env.STUB_GROK_INSPECT || JSON.stringify({ mcpServers: [], plugins: [], hooks: [] })); process.exit(0); }
process.stdout.write(JSON.stringify({ text: 'grok answer', stopReason: 'end_turn', modelUsage: { [a[a.indexOf('-m') + 1]]: {} } }));
`, { mode: 0o755 });
  const grok = (cwd, env = {}) => {
    fs.writeFileSync(glog, '');
    const r = ask(['--family', 'grok', '--cwd', cwd], { env: { PATH: [bin, ...SYSTEM].join(':'), ...env } });
    return { ...r, grok: fs.readFileSync(glog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) };
  };
  const repo = mk('grok-hooks-repo');
  spawnSync('git', ['init', '-q', repo], { env: { ...process.env, ...GIT_ENV } });
  const sub = mk('grok-hooks-repo', 'sub');
  const ran = (r) => r.grok.some((c) => c.argv[0] === '-p');

  const clean = grok(sub);
  ok('no .grok/hooks: grok runs, and the inspect and the run both get the Claude and Cursor hook switches off',
     clean.code === 0 && ran(clean) && clean.grok.length === 2 && clean.grok.every((c) => same(c.hooksEnv, ['0', '0'])), J(clean));

  fs.mkdirSync(path.join(repo, '.grok', 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.grok', 'hooks', 'session.json'), '{"hooks":{}}');
  for (const [where, cwd] of [['the repo root', repo], ['a subfolder, with the hooks at the repo root', sub]]) {
    const r = grok(cwd);
    ok(`.grok/hooks in ${where}: exit 4, the folder named, grok never run`,
       r.code === 4 && r.err.includes(path.join(fs.realpathSync(repo), '.grok', 'hooks')) && /grok was not run/.test(r.err) && r.grok.length === 0, J(r));
  }
  fs.rmSync(path.join(repo, '.grok'), { recursive: true, force: true });

  const hook = (extra) => ({ event: 'session_start', hookType: 'command', target: 'touch x', source: { type: 'project', path: path.join(repo, '.claude') }, ...extra });
  const listed = grok(repo, { STUB_GROK_INSPECT: J({ mcpServers: [], plugins: [], hooks: [hook({})] }) });
  ok('an enabled project hook in grok inspect: exit 4, named, grok never run', listed.code === 4 && /grok would run this project's hooks/.test(listed.err) && !ran(listed), J(listed));
  const off = grok(repo, { STUB_GROK_INSPECT: J({ mcpServers: [], plugins: [], hooks: [hook({ disabled: true, compatibilityStatus: 'disabled' }), { ...hook({}), source: { type: 'user', path: '/home/.grok/hooks' } }] }) });
  ok('a project hook the switches disabled, and the user\'s own hook: grok runs', off.code === 0 && ran(off), J(off));
}

console.log('\nask-model: a repository at HOME has its .grok/hooks checked like any other');
{
  const bin = mk('stubs-grok-home');
  const glog = path.join(tmp, 'grok-home-calls.jsonl');
  fs.writeFileSync(path.join(bin, 'grok'), `#!${process.execPath}
const fs = require('node:fs');
const a = process.argv.slice(2);
fs.appendFileSync(${J(glog)}, JSON.stringify(a) + '\\n');
if (a[0] === 'inspect') { process.stdout.write(JSON.stringify({ mcpServers: [], plugins: [], hooks: [] })); process.exit(0); }
process.stdout.write(JSON.stringify({ text: 'grok answer', stopReason: 'end_turn', modelUsage: { [a[a.indexOf('-m') + 1]]: {} } }));
`, { mode: 0o755 });
  const grokAt = (home) => {
    fs.writeFileSync(glog, '');
    const r = ask(['--family', 'grok', '--cwd', home], { home, env: { PATH: [bin, ...SYSTEM].join(':') } });
    return { ...r, grok: fs.readFileSync(glog, 'utf8').split('\n').filter(Boolean) };
  };
  const homeRepo = mk('home-is-a-repo');
  spawnSync('git', ['init', '-q', homeRepo], { env: { ...process.env, ...GIT_ENV } });
  fs.mkdirSync(path.join(homeRepo, '.grok', 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(homeRepo, '.grok', 'hooks', 'session.json'), '{"hooks":{}}');
  const repoHome = grokAt(homeRepo);
  ok('HOME is the repository: its .grok/hooks are the checkout\'s, exit 4, grok never run',
     repoHome.code === 4 && repoHome.err.includes(path.join(fs.realpathSync(homeRepo), '.grok', 'hooks')) && repoHome.grok.length === 0, J(repoHome));
  const plainHome = mk('home-not-a-repo');
  fs.mkdirSync(path.join(plainHome, '.grok', 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(plainHome, '.grok', 'hooks', 'mine.json'), '{"hooks":{}}');
  const ownHooks = grokAt(plainHome);
  ok('HOME outside any repository: ~/.grok/hooks are your own, grok runs', ownHooks.code === 0 && ownHooks.grok.some((l) => l.startsWith('["-p"')), J(ownHooks));
}

console.log('\nask-model: --investigate reads the work tree with git from an absolute PATH entry only');
{
  const repo = mk('planted-git-repo');
  const g = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: repo, env: { PATH: SYSTEM.join(':'), HOME, ...GIT_ENV } });
  g('init', '-q'); fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n'); g('add', '.'); g('commit', '-q', '-m', 'base');
  const marker = path.join(tmp, 'planted-git-ran');
  fs.writeFileSync(path.join(repo, 'git'), `#!/bin/sh\n: > '${marker}'\nexit 0\n`, { mode: 0o755 });
  const planted = ask(['--family', 'fable', '--investigate', '--cwd', repo], { cwd: repo, env: { PATH: ['.', '', STUBS, ...SYSTEM].join(':') } });
  ok('PATH=.: with a planted ./git: the planted file never runs, and the call answers', planted.code === 0 && !fs.existsSync(marker), show(planted));
  const noGit = ask(['--family', 'fable', '--investigate', '--cwd', repo], { cwd: repo, env: { PATH: [STUBS, '.'].join(':') } });
  ok('no git on an absolute PATH entry: exit 4, the model never runs, the planted ./git never runs',
     noGit.code === 4 && /git is not on PATH, so changes under --investigate could not be checked — claude was not run/.test(noGit.err) && noGit.calls.length === 0 && !fs.existsSync(marker), show(noGit));
}

// The one real call, and only when asked: this machine's own HOME, PATH and codex, a one-word prompt.
console.log('\nask-model: --second and --effort-from');
{
  // advisor: fable then sol at high, its alt grok at max. builder: its alt terra has no effort of its own, so it
  // takes the role's. investigator: no role effort and an alt with none either, so opus takes its flavor's.
  // reviewer: astra and sol at low, the role at medium. judge has no alt.
  const home = path.dirname(mk('home-c1', '.agent-config-studio'));
  fs.writeFileSync(path.join(home, '.agent-config-studio', 'roles.json'), J({
    version: 1,
    roles: {
      advisor: { use: ['fable', { family: 'sol', effort: 'high' }], alt: { family: 'grok', effort: 'max' } },
      builder: { alt: 'terra' },
      investigator: { effort: null, alt: 'opus' },
      reviewer: { use: ['astra', { family: 'sol', effort: 'low' }], effort: 'medium' },
    },
    flavor: { opus: { effort: 'xhigh' }, terra: { effort: 'low' } },
  }));
  const label = (r, family, effort) => r.code === 0 && r.err === `ask-model: ${family} (${IDS[family]}, effort ${effort}, read-only)\n`;
  const c1 = (args) => ask([...args, '--cwd', WORK], { home });

  const own = c1(['--role', 'advisor', '--second']);
  ok('--second: the role\'s alt at its own effort', label(own, 'grok', 'max') && own.argv?.includes(IDS.grok), show(own));
  ok('--second: an alt with no effort of its own takes the role\'s', label(c1(['--role', 'builder', '--second']), 'terra', 'medium'));
  ok('--second: an alt with no own and no role effort takes its flavor\'s', label(c1(['--role', 'investigator', '--second']), 'opus', 'xhigh'));
  ok('--second: --effort still wins', label(c1(['--role', 'advisor', '--second', '--effort', 'low']), 'grok', 'low'));
  const fresh = ask(['--role', 'advisor', '--second', '--cwd', WORK]);
  ok(`--second on fresh defaults: ${ROLES.roles.advisor.alt} at the role's ${ROLES.roles.advisor.effort}`, label(fresh, ROLES.roles.advisor.alt, ROLES.roles.advisor.effort), show(fresh));
  const noAlt = c1(['--role', 'judge', '--second']);
  ok('--second on a role with no alt: exit 64, no model called, the reason named',
     noAlt.code === 64 && noAlt.calls.length === 0 && /role "judge" has no second opinion \(alt\)/.test(noAlt.err), show(noAlt));
  const fam = c1(['--family', 'fable', '--second']);
  ok('--second with --family: exit 64, a usage error', fam.code === 64 && fam.calls.length === 0 && /--second .* needs --role/.test(fam.err), show(fam));

  ok('--effort-from: a member\'s own effort', label(c1(['--family', 'sol', '--effort-from', 'reviewer']), 'sol', 'low'));
  ok('--effort-from: the first listed role that has the family wins', label(c1(['--family', 'sol', '--effort-from', 'advisor,reviewer']), 'sol', 'high')
     && label(c1(['--family', 'sol', '--effort-from', 'reviewer,advisor']), 'sol', 'low'));
  ok('--effort-from: a role it is not in is skipped', label(c1(['--family', 'astra', '--effort-from', 'advisor,reviewer']), 'astra', 'medium'));
  ok('--effort-from: the alt\'s effort', label(c1(['--family', 'grok', '--effort-from', 'reviewer,advisor']), 'grok', 'max'));
  ok('--effort-from: an alt with no own or role effort takes its flavor\'s', label(c1(['--family', 'opus', '--effort-from', 'investigator']), 'opus', 'xhigh'));
  ok('--effort-from: in no listed role, the flavor effort', label(c1(['--family', 'terra', '--effort-from', 'advisor,reviewer']), 'terra', 'low'));
  const none = c1(['--family', 'haiku', '--effort-from', 'advisor']);
  ok('--effort-from: no effort anywhere passes no effort flag', label(none, 'haiku', 'none') && !none.argv.includes('--effort'), show(none));
  ok('--effort-from: --effort wins', label(c1(['--family', 'sol', '--effort-from', 'reviewer', '--effort', 'max']), 'sol', 'max'));
  for (const [what, args, why] of [
    ['with an unknown role', ['--family', 'sol', '--effort-from', 'reviewer,nobody'], /unknown role "nobody"/],
    ['with an empty role name', ['--family', 'sol', '--effort-from', 'reviewer,'], /role names separated by commas/],
    ['given with --role', ['--role', 'advisor', '--effort-from', 'reviewer'], /--effort-from needs --family/],
  ]) {
    const r = c1(args);
    ok(`--effort-from ${what}: exit 64, no model called`, r.code === 64 && r.calls.length === 0 && why.test(r.err), show(r));
  }
}

console.log('\nask-model: --effort-from looks on past a role that gives the family no effort');
{
  // advisor's effort cleared: its alt astra has none there, so the reviewer role's effort (astra, high) applies.
  const home = path.dirname(mk('home-c1-cleared', '.agent-config-studio'));
  fs.writeFileSync(path.join(home, '.agent-config-studio', 'roles.json'), J({ version: 1, roles: { advisor: { effort: null } } }));
  const r = ask(['--family', 'astra', '--effort-from', 'advisor,reviewer', '--cwd', WORK], { home });
  ok(`a cleared advisor effort: astra takes the reviewer role's ${ROLES.roles.reviewer.effort}`,
     r.code === 0 && r.err === `ask-model: astra (${IDS.astra}, effort ${ROLES.roles.reviewer.effort}, read-only)\n`, show(r));
}

console.log('\nask-model: --schema');
{
  const VERDICT = { type: 'object', additionalProperties: false, required: ['verdict', 'score', 'notes'], properties: {
    verdict: { type: 'string', enum: ['PASS', 'FAIL'] }, score: { type: 'integer', minimum: 1, maximum: 10 },
    notes: { type: 'array', minItems: 1, items: { type: ['string', 'null'] } } } };
  const schemaFile = path.join(tmp, 'verdict.schema.json');
  fs.writeFileSync(schemaFile, J(VERDICT, null, 2));
  const good = { verdict: 'PASS', score: 7, notes: ['fine', null] };
  const sc = (args, env = {}) => ask([...args, '--schema', schemaFile, '--cwd', WORK], { env });

  const c = sc(['--family', 'fable', '--effort', 'high'], { STUB_STRUCTURED: J(good), STUB_ANSWER: 'prose the model also wrote' });
  ok('claude: --json-schema with the schema\'s JSON, after the other flags, MCP still off',
     c.code === 0 && same(c.argv, [...CLAUDE_RO(IDS.fable, 'high').slice(0, 8), '--json-schema', J(VERDICT), ...CLAUDE_RO(IDS.fable, 'high').slice(8)]), show(c));
  ok('claude: stdout is only the structured_output, as JSON', c.out === `${J(good, null, 2)}\n` && JSON.parse(c.out).verdict === 'PASS', show(c));
  const x = sc(['--family', 'sol', '--effort', 'xhigh'], { STUB_ANSWER: J(good) });
  ok('codex: --output-schema with the file\'s absolute path, before the prompt',
     x.code === 0 && same(x.argv, [...CODEX(IDS.sol, 'xhigh').slice(0, -1), '--output-schema', schemaFile, PROMPT]), show(x));
  ok('codex: stdout is only its JSON answer', x.out === `${J(good, null, 2)}\n`, show(x));
  const g = sc(['--family', 'grok', '--effort', 'high'], { STUB_STRUCTURED: J(good) });
  ok('grok: --json-schema with the schema\'s JSON, its read-only tools and MCP denial kept',
     g.code === 0 && same(g.argv, [...GROK_RO(IDS.grok, 'high', WORK), '--json-schema', J(VERDICT)]), show(g));
  ok('grok: stdout is only the structuredOutput, as JSON', g.out === `${J(good, null, 2)}\n`, show(g));
  const rel = ask(['--family', 'sol', '--schema', path.relative(tmp, schemaFile), '--cwd', WORK], { env: { STUB_ANSWER: J(good) } });
  ok('a relative --schema path reaches codex resolved, since codex runs in --cwd', rel.code === 0 && rel.argv.includes(schemaFile), show(rel));
  const plain = ask(['--family', 'sol', '--cwd', WORK]);
  ok('without --schema, no structured-output flag and the answer as before', plain.code === 0 && !plain.argv.includes('--output-schema') && plain.out === `answer from ${IDS.sol}\n`, show(plain));

  for (const [what, args, env, error] of [
    ['codex: an answer that is not JSON', ['--family', 'sol'], { STUB_ANSWER: 'I think it passes.' }, /the answer is not JSON/],
    ['claude: no structured_output and a prose result', ['--family', 'fable'], { STUB_ANSWER: 'PASS, mostly' }, /the answer is not JSON/],
    ['a value outside the enum', ['--family', 'sol'], { STUB_ANSWER: J({ ...good, verdict: 'MAYBE' }) }, /\$\.verdict: "MAYBE" is not one of "PASS", "FAIL"/],
    ['a missing required field', ['--family', 'grok'], { STUB_STRUCTURED: J({ verdict: 'PASS', notes: ['x'] }) }, /\$: "score" is required/],
    ['an extra field', ['--family', 'fable'], { STUB_STRUCTURED: J({ ...good, extra: 1 }) }, /\$: "extra" is not allowed/],
    ['a number above the maximum', ['--family', 'sol'], { STUB_ANSWER: J({ ...good, score: 11 }) }, /\$\.score: 11 is above the maximum 10/],
    ['a float for an integer', ['--family', 'sol'], { STUB_ANSWER: J({ ...good, score: 7.5 }) }, /\$\.score: number where the schema wants integer/],
    ['too few items', ['--family', 'sol'], { STUB_ANSWER: J({ ...good, notes: [] }) }, /\$\.notes: 0 item\(s\) where the schema wants at least 1/],
    ['a wrong item type', ['--family', 'sol'], { STUB_ANSWER: J({ ...good, notes: ['ok', 3] }) }, /\$\.notes\[1\]: integer where the schema wants string or null/],
  ]) {
    const r = sc(args, env);
    ok(`${what}: exit 6, the first error on stderr, nothing on stdout`, r.code === 6 && r.out === '' && error.test(r.err) && r.calls.length === 1, show(r));
  }
  const both = sc(['--family', 'sol'], { STUB_ANSWER: J({ verdict: 'MAYBE', score: 0 }) });
  ok('only the first error is named', both.code === 6 && (both.err.match(/does not match --schema/g) || []).length === 1, show(both));
  const js = sc(['--family', 'sol', '--json'], { STUB_ANSWER: J(good) });
  ok('--json: the matched JSON text is the answer', js.code === 0 && JSON.parse(JSON.parse(js.out).answer).score === 7, show(js));
  const jsBad = sc(['--family', 'sol', '--json'], { STUB_ANSWER: 'nope' });
  ok('--json with a non-JSON answer: exit 6 and the error in the result', jsBad.code === 6 && /not JSON/.test(JSON.parse(jsBad.out).error), show(jsBad));
  const other = sc(['--family', 'fable'], { STUB_MODE: 'downgrade', STUB_STRUCTURED: J(good) });
  ok('another model answering is still exit 2, before any schema check', other.code === 2 && other.out === '', show(other));

  const bad = (name, body) => { const f = path.join(tmp, name); fs.writeFileSync(f, body); return f; };
  for (const [what, file, error] of [
    ['a missing file', path.join(tmp, 'no-such.schema.json'), /--schema .*no-such\.schema\.json: cannot read it \(ENOENT\)/],
    ['a file that is not JSON', bad('not.json', '{ type: object'), /not JSON/],
    ['an unsupported keyword', bad('pattern.json', J({ type: 'object', properties: { id: { type: 'string', pattern: '^x' } } })), /the schema\.properties\.id uses "pattern", which ask-model does not check/],
    ['a nested unsupported keyword', bad('oneof.json', J({ type: 'array', items: { oneOf: [] } })), /the schema\.items uses "oneOf"/],
    ['an unknown type', bad('type.json', J({ type: 'map' })), /the schema\.type must be one of/],
    ['a schema for additionalProperties', bad('ap.json', J({ type: 'object', additionalProperties: { type: 'string' } })), /additionalProperties must be true or false/],
    ['a schema that is not an object', bad('list.json', '[]'), /the schema must be an object/],
  ]) {
    const r = ask(['--family', 'sol', '--schema', file, '--cwd', WORK]);
    ok(`--schema with ${what}: exit 64, no model called`, r.code === 64 && r.calls.length === 0 && error.test(r.err), show(r));
  }
}

console.log('\nask-model: --schema compares enums by value and refuses numbers JSON cannot hold');
{
  const file = (name, doc) => { const f = path.join(tmp, name); fs.writeFileSync(f, J(doc)); return f; };
  const objects = file('object-enum.json', { type: 'object', properties: { pick: { enum: [{ a: 1, b: [1, 2] }, 'none'] } } });
  const sc = (schema, answer) => ask(['--family', 'sol', '--schema', schema, '--cwd', WORK], { env: { STUB_ANSWER: answer } });
  const reordered = sc(objects, '{"pick":{"b":[1,2],"a":1}}');
  ok('an object enum matches with its keys in another order', reordered.code === 0 && JSON.parse(reordered.out).pick.a === 1, show(reordered));
  const swapped = sc(objects, '{"pick":{"a":1,"b":[2,1]}}');
  ok('an array inside it keeps its order: [2,1] is not [1,2]', swapped.code === 6 && /\$\.pick: .* is not one of/.test(swapped.err), show(swapped));
  const extra = sc(objects, '{"pick":{"a":1,"b":[1,2],"c":3}}');
  ok('an extra key is not the same value', extra.code === 6, show(extra));

  const numbers = file('numbers.json', { type: 'object', properties: { x: { type: 'number' }, list: { type: 'array', items: { type: 'number' } } } });
  for (const [what, answer, where] of [['1e400', '{"x":1e400}', /\$\.x/], ['-1e400 in a list', '{"list":[1,-1e400]}', /\$\.list\[1\]/], ['an untyped field', '{"y":1e999}', /\$\.y/]]) {
    const r = sc(numbers, answer);
    ok(`${what}: exit 6, not printed as null`, r.code === 6 && r.out === '' && /not a finite number/.test(r.err) && where.test(r.err), show(r));
  }

  for (const [what, doc, why] of [
    ['a name required twice', { type: 'object', required: ['id', 'id'] }, /required names "id" twice/],
    ['a type listed twice', { type: ['string', 'string'] }, /type names "string" twice/],
  ]) {
    const r = ask(['--family', 'sol', '--schema', file(`dup-${what.length}.json`, doc), '--cwd', WORK]);
    ok(`--schema with ${what}: exit 64, no model called`, r.code === 64 && r.calls.length === 0 && why.test(r.err), show(r));
  }
}

console.log('\nask-model: live');
if (process.env.ACS_LIVE_CHECKS === '1') {
  const live = path.join(tmp, 'live-prompt.txt');
  fs.writeFileSync(live, 'Reply with the single word: ok\n');
  const r = spawnSync(process.execPath, [ASK, '--family', 'sol', '--prompt-file', live, '--cwd', mk('live')], { encoding: 'utf8', env: process.env, timeout: 600_000 });
  ok('ask-model --family sol answers on this machine', r.status === 0 && r.stdout.trim().length > 0, J({ code: r.status, out: r.stdout, err: r.stderr }));
} else {
  console.log('  SKIP ask-model --family sol against the real codex (set ACS_LIVE_CHECKS=1 to run it; it calls the model)');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
