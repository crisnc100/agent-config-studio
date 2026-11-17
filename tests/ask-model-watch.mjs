/**
 * ask-model inside cmux starts one detached `acs-agent watch` for its own model call, the way the review gate does,
 * and nothing else about the call changes. A stub claude answers; a stub acs-agent records how it was called and the
 * run files present when it started. Temp HOME; no real model, watcher or cmux.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './fixtures/cleanup.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASK = path.join(ROOT, 'tools', 'ask-model.mjs');
const J = JSON.stringify;
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const settle = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const tmp = fs.realpathSync(tempDir('acs-ask-watch-'));
const mk = (...p) => { const d = path.join(tmp, ...p); fs.mkdirSync(d, { recursive: true }); return d; };
const STUBS = mk('stubs'), AGENT = mk('agent-bin'), HOME = mk('home');
const AGENT_LOG = path.join(tmp, 'agent.jsonl'), MODEL_LOG = path.join(tmp, 'model.jsonl');
fs.mkdirSync(path.join(HOME, '.agent-config-studio'));
fs.writeFileSync(path.join(HOME, '.agent-config-studio', 'roles.json'), J({ version: 1 }));
fs.writeFileSync(path.join(STUBS, 'claude'), `#!${process.execPath}
const a = process.argv.slice(2), model = a[a.indexOf('--model') + 1];
require('node:fs').appendFileSync(${J(MODEL_LOG)}, JSON.stringify({ argv: a }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'answer from ' + model, modelUsage: { [model]: { inputTokens: 1 } } }));
`, { mode: 0o755 });
fs.writeFileSync(path.join(AGENT, 'acs-agent'), `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const a = process.argv.slice(2), runs = path.join(process.env.HOME, '.agent-config-studio', 'runs');
let files = [];
try { files = fs.readdirSync(runs).map((name) => ({ name, body: JSON.parse(fs.readFileSync(path.join(runs, name), 'utf8')) })); } catch {}
fs.appendFileSync(${J(AGENT_LOG)}, JSON.stringify({ argv: a, ppid: process.ppid, runs: files }) + '\\n');
if (process.env.STUB_AGENT_OLD) { console.error('usage: acs-agent open <family>'); process.exit(2); }
if (a[0] === 'watch' && a[1] === '--version') console.log('acs-agent watch ' + (process.env.STUB_AGENT_VERSION || '1'));
`, { mode: 0o755 });
const CMUX_LOG = path.join(tmp, 'cmux.jsonl');
fs.writeFileSync(path.join(AGENT, 'cmux'), `#!${process.execPath}
require('node:fs').appendFileSync(${J(CMUX_LOG)}, JSON.stringify(process.argv.slice(2)) + '\\n');
`, { mode: 0o755 });
const PF = path.join(tmp, 'prompt.txt');
fs.writeFileSync(PF, 'Say hello.\n');
const CMUX = { CMUX_SOCKET_PATH: path.join(tmp, 'cmux.sock'), CMUX_WORKSPACE_ID: 'workspace:4' };

const log = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
function ask(args, env = {}, { paths = [STUBS, AGENT, '/usr/bin', '/bin'] } = {}) {
  for (const f of [AGENT_LOG, MODEL_LOG]) fs.rmSync(f, { force: true });
  fs.rmSync(path.join(HOME, '.agent-config-studio', 'runs'), { recursive: true, force: true });
  const t = Date.now();
  const r = spawnSync(process.execPath, [ASK, '--prompt-file', PF, ...args], { cwd: tmp, encoding: 'utf8', env: { HOME, PATH: paths.join(':'), ...env } });
  const ms = Date.now() - t;
  return { code: r.status, out: r.stdout, err: r.stderr, ms };
}
const watches = (wait) => {
  const end = Date.now() + (wait ? 10000 : 0);
  const pick = () => log(AGENT_LOG).filter((c) => c.argv[0] === 'watch' && c.argv[1] !== '--version');
  while (Date.now() < end && !pick().length) settle(25);
  settle(wait ? 300 : 600);
  return pick();
};
const probes = () => log(AGENT_LOG).filter((c) => c.argv[1] === '--version');

const off = ask(['--role', 'advisor'], { ...CMUX, REVIEW_WATCH: 'off' });
const offArgv = log(MODEL_LOG).map((c) => c.argv);
ok('watch off: the call runs, no acs-agent call at all', off.code === 0 && watches(false).length === 0 && log(AGENT_LOG).length === 0, J(off));

const on = ask(['--role', 'advisor'], CMUX);
const onArgv = log(MODEL_LOG).map((c) => c.argv);
const [w, ...more] = watches(true);
ok('inside cmux: one probe and one watcher', !!w && !more.length && probes().length === 1, J(log(AGENT_LOG)));
const pid = w?.argv[2];
ok('…for its own pid, kind = its role, its workspace, sidebar by default',
  J(w?.argv) === J(['watch', '--pid', pid, '--kind', 'advisor', '--workspace', 'workspace:4']) && String(w?.ppid) === pid, J(w));
const file = w?.runs.find((f) => f.body.pid === Number(pid));
ok('…with its run file written first (version, pid, kind, workspace, branch, started)',
  !!file && J(Object.keys(file.body).sort()) === J(['branch', 'kind', 'pid', 'started', 'version', 'workspace']) && file.body.version === 1
  && file.body.branch === path.basename(tmp)
  && file.body.kind === 'advisor' && file.body.workspace === 'workspace:4' && Number.isFinite(Date.parse(file.body.started)), J(w?.runs));
ok('output unchanged: the same stdout and stderr as with watch off, within 2s',
  on.code === off.code && on.out === off.out && on.err === off.err && Math.abs(on.ms - off.ms) < 2000, J({ on, off }));
ok('the model CLI argv is unchanged', onArgv.length === 1 && J(onArgv) === J(offArgv), J({ onArgv, offArgv }));

ask(['--family', 'opus'], CMUX);
ok('--family: kind ask', watches(true)[0]?.argv[4] === 'ask', J(log(AGENT_LOG)));

fs.mkdirSync(path.join(HOME, '.agent-config-studio', 'review-gate'), { recursive: true });
const config = path.join(HOME, '.agent-config-studio', 'review-gate', 'config.json');
fs.writeFileSync(config, J({ watch: 'pane' }));
ask(['--role', 'advisor'], CMUX);
ok('home config watch: pane adds --pane', watches(true)[0]?.argv.at(-1) === '--pane', J(log(AGENT_LOG)));
fs.writeFileSync(config, J({ watch: 'off' }));
ask(['--role', 'advisor'], CMUX);
ok('home config watch: off starts nothing', watches(false).length === 0 && log(AGENT_LOG).length === 0, J(log(AGENT_LOG)));
fs.rmSync(config);
// A repository's config is never read for it: only the env and the review gate's home config.
fs.mkdirSync(path.join(tmp, '.claude'), { recursive: true });
fs.writeFileSync(path.join(tmp, '.claude', 'review-config.json'), J({ watch: 'pane' }));
ask(['--role', 'advisor'], CMUX);
ok('a repo config cannot set it', J(watches(true)[0]?.argv.slice(-2)) === J(['--workspace', 'workspace:4']), J(log(AGENT_LOG)));
fs.rmSync(path.join(tmp, '.claude'), { recursive: true });

ask(['--role', 'advisor'], { ...CMUX, REVIEW_WATCH_CHILD: '1' });
ok('a child of a watched run (REVIEW_WATCH_CHILD=1) starts nothing', log(AGENT_LOG).length === 0 && watches(false).length === 0);
const runsLeft = () => { try { return fs.readdirSync(path.join(HOME, '.agent-config-studio', 'runs')); } catch { return []; } };
ask(['--role', 'advisor']);
ok('outside cmux, an acs-agent at watch 1: probed once, no watcher, no run file left',
  probes().length === 1 && watches(false).length === 0 && runsLeft().length === 0, J({ calls: log(AGENT_LOG), runs: runsLeft() }));
for (const [name, outside] of [['outside cmux', {}], ['a cmux shell without a workspace', { CMUX_SOCKET_PATH: CMUX.CMUX_SOCKET_PATH }]]) {
  ask(['--role', 'advisor'], { ...outside, STUB_AGENT_VERSION: '2' });
  const [lo, ...loMore] = watches(true);
  const loPid = lo?.argv[2];
  const loFile = lo?.runs.find((f) => f.body.pid === Number(loPid));
  ok(`${name}, watch 2: one --log-only watcher for its own pid, its run file without a workspace`,
    !!lo && !loMore.length && probes().length === 1 && J(lo.argv) === J(['watch', '--pid', loPid, '--kind', 'advisor', '--log-only'])
    && String(lo.ppid) === loPid && !!loFile && J(Object.keys(loFile.body).sort()) === J(['branch', 'kind', 'pid', 'started', 'version']), J(log(AGENT_LOG)));
}
ask(['--role', 'advisor'], { REVIEW_WATCH: 'off', STUB_AGENT_VERSION: '2' });
ok('outside cmux, watch off: no probe, no watcher, no run file', log(AGENT_LOG).length === 0 && watches(false).length === 0 && runsLeft().length === 0, J(log(AGENT_LOG)));
ok('outside cmux: never a cmux call', log(CMUX_LOG).length === 0, J(log(CMUX_LOG)));
const old = ask(['--role', 'advisor'], { ...CMUX, STUB_AGENT_OLD: '1' });
ok('an old acs-agent: probed once, no watcher, no run file left, the call still answers',
  old.code === 0 && old.out === off.out && probes().length === 1 && watches(false).length === 0 && runsLeft().length === 0, J({ calls: log(AGENT_LOG), runs: runsLeft() }));
const missing = ask(['--role', 'advisor'], CMUX, { paths: [STUBS, '/usr/bin', '/bin'] });
ok('acs-agent missing: the call answers as before', missing.code === 0 && missing.out === off.out && missing.err === off.err, J(missing));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
