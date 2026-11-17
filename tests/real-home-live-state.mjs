/**
 * The real-home tripwire ignores exactly ~/.agent-config-studio/runs and
 * ~/.agent-config-studio/agents, the live state acs-agent writes for every
 * session on the machine, and still fails on any other write under
 * ~/.agent-config-studio — including a runs/ or agents/ folder somewhere
 * else, or a link standing where either folder should be. Run against a
 * scratch HOME, never the real one. Each must-fail write goes into a folder
 * already in the baseline, so only the exemption could hide it.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './fixtures/cleanup.mjs';

const TRIP = path.join(path.dirname(fileURLToPath(import.meta.url)), 'real-home.mjs');

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

const T = fs.realpathSync(tempDir('acs-trip-live-'));
const snap = `${T}.snap`;
const put = (rel, body = 'x\n') => { const f = path.join(T, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); return f; };
const run = (cmd) => spawnSync(process.execPath, [TRIP, cmd, snap], { env: { ...process.env, HOME: T }, encoding: 'utf8' });
const scenario = (label, mutate, wantFail) => {
  run('save');
  mutate();
  const r = run('check');
  ok(`tripwire ${wantFail ? 'FAILS' : 'passes'} on ${label}`, (r.status !== 0) === wantFail, (r.stdout || '').trim().split('\n').slice(1, 4).join(' | '));
};

console.log('\nreal-home tripwire, live acs-agent state');

const ACS = '.agent-config-studio';
put(`${ACS}/roles.json`, '{"version":1}\n');
put(`${ACS}/runs/r1-aaaa.json`, '{}\n');
put(`${ACS}/runs/r1-aaaa.1.log`, 'log\n');
put(`${ACS}/agents/w1.json`, '{}\n');
for (const d of ['review-gate/runs', 'review-gate/agents', 'runs-backup', 'agents.old', 'history']) put(`${ACS}/${d}/keep`);
put('.claude/skills/agents/keep');

scenario('an untouched tree', () => {}, false);
scenario('a run appearing in runs/ (.json, .log, .<n>.log, .watch.json)', () => {
  for (const f of ['r2-bbbb.json', 'r2-bbbb.log', 'r2-bbbb.1.log', 'r2-bbbb.watch.json']) put(`${ACS}/runs/${f}`);
}, false);
scenario('a run pruned from runs/', () => {
  fs.rmSync(path.join(T, ACS, 'runs', 'r1-aaaa.json'));
  fs.rmSync(path.join(T, ACS, 'runs', 'r1-aaaa.1.log'));
}, false);
scenario('runs/ removed and agents/ rewritten', () => {
  fs.rmSync(path.join(T, ACS, 'runs'), { recursive: true });
  put(`${ACS}/agents/w1.json`, '{"done":true}\n');
  put(`${ACS}/agents/w2.prompt`, 'p\n');
}, false);
scenario('runs/ created when absent', () => put(`${ACS}/runs/r3-cccc.json`), false);

scenario('a new file in another folder under ~/.agent-config-studio', () => put(`${ACS}/history/leak.tmpfile`), true);
scenario('a new file at the top of ~/.agent-config-studio', () => put(`${ACS}/leak.json`), true);
scenario('an edit to a file beside runs/', () => put(`${ACS}/roles.json`, '{"version":2}\n'), true);
scenario('a new file in an existing runs/ nested elsewhere under ~/.agent-config-studio', () => put(`${ACS}/review-gate/runs/r.json`), true);
scenario('a new file in an existing agents/ nested elsewhere under ~/.agent-config-studio', () => put(`${ACS}/review-gate/agents/w.json`), true);
scenario('a new file in an existing sibling runs-backup/', () => put(`${ACS}/runs-backup/r.json`), true);
scenario('a new file in an existing sibling agents.old/', () => put(`${ACS}/agents.old/w.json`), true);
scenario('a new file in an existing agents/ under another guarded tree', () => put('.claude/skills/agents/x.md'), true);

const elsewhere = path.join(T, 'elsewhere');
fs.mkdirSync(elsewhere);
for (const d of ['runs', 'agents']) {
  scenario(`~/.agent-config-studio/${d} replaced by a link`, () => {
    fs.rmSync(path.join(T, ACS, d), { recursive: true, force: true });
    fs.symlinkSync(elsewhere, path.join(T, ACS, d));
  }, true);
  scenario(`~/.agent-config-studio/${d} as a link, re-pointed`, () => {
    fs.unlinkSync(path.join(T, ACS, d));
    fs.symlinkSync(path.join(T, ACS, 'history'), path.join(T, ACS, d));
  }, true);
  scenario(`~/.agent-config-studio/${d} replaced by a plain file`, () => {
    fs.unlinkSync(path.join(T, ACS, d));
    put(`${ACS}/${d}`, 'a\n');
  }, true);
}

fs.rmSync(snap, { force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
