/**
 * Browser QA for the Packs card (builds/skill-packs P3, C13): a real server on
 * a free port (or PORT), HOME redirected to a temp sandbox with stub CLIs
 * (tests/fixtures/packs-sandbox.mjs). Never the live HOME; no model is called.
 *
 *   node tests/skill-packs-qa-server.mjs                 claude + codex stubs
 *   node tests/skill-packs-qa-server.mjs --claude-only   claude stub only (Codex disabled; the reviewer role fix-up)
 *
 * Prints the URL and HOME once its own server answers (never another studio
 * already on PORT; a server that dies first exits non-zero with no URL),
 * runs until Ctrl-C, then removes the sandbox. The
 * seed: setup marked done, and the handoff pack installed for Claude only
 * with its SKILL.md edited — so the card opens with "edited by you" and (with
 * codex) "new harness detected". The codex stub's trust check answers after
 * 3 s, so its progress line stays on screen long enough to see.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { ROOT, sandbox, track } from './fixtures/packs-sandbox.mjs';

const claudeOnly = process.argv.includes('--claude-only');
const sb = sandbox('qa', { clis: claudeOnly ? ['claude'] : ['claude', 'codex'] });
fs.mkdirSync(path.join(sb.home, '.agent-config-studio'), { recursive: true });
fs.writeFileSync(path.join(sb.home, '.agent-config-studio', 'setup.json'), JSON.stringify({ completed: 'done', at: new Date().toISOString() }));
fs.writeFileSync(path.join(sb.home, '.claude', 'CLAUDE.md'), '# my own rules\n\nKeep this line.\n');
const seed = sb.packs(['install', 'handoff', '--harness', 'claude', '--yes']);
if (seed.code !== 0) { console.error(seed.out); process.exit(1); }
fs.appendFileSync(path.join(sb.home, '.claude', 'skills', 'handoff', 'SKILL.md'), '\n<!-- edited in QA -->\n');

const port = process.env.PORT ? Number(process.env.PORT) : await new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});
const child = track(spawn(process.execPath, [path.join(ROOT, 'server.js')], {
  cwd: ROOT, env: { ...sb.env, PORT: String(port), STUB_HOOKS_DELAY_MS: '3000' }, stdio: ['ignore', 'inherit', 'inherit'],
}));
// Watched from the start: a server that dies before it is ready (PORT taken, a crash) ends
// this launcher with an error, never with a URL. Exiting removes the sandbox.
let ready = false;
child.on('error', (e) => { console.error(`\n  The QA server could not start: ${e.message}\n`); process.exit(1); });
child.on('exit', (code, signal) => {
  if (!ready) {
    console.error(`\n  The QA server exited (${signal || code}) before it was ready, so nothing is served. Is port ${port} already in use?\n`);
    process.exit(code || 1);
  }
  console.log(`server exited (${code ?? signal})`);
  process.exit(code ?? 1);
});
const base = `http://localhost:${port}`;
// Ready means THIS child answers: /api/health names its pid, and the nonce the run file in
// the sandbox HOME records. Another studio already on PORT answers with neither.
const runFile = path.join(sb.home, '.agent-config-studio', 'run', `${port}.json`);
const ours = async () => {
  let health, run;
  try { const r = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) }); if (!r.ok) return false; health = await r.json(); } catch { return false; }
  try { run = JSON.parse(fs.readFileSync(runFile, 'utf8')); } catch { return false; }
  return health?.app === 'agent-config-studio' && health.pid === child.pid && run.pid === child.pid && health.nonce === run.nonce;
};
for (const end = Date.now() + 30_000; !(await ours());) {
  if (Date.now() > end) { console.error(`\n  The QA server did not answer as this launcher's own server within 30 s (port ${port}); stopping it.\n`); process.exit(1); }
  await new Promise((r) => setTimeout(r, 100));
}
ready = true;
console.log(`\n  Packs card QA server${claudeOnly ? ' (claude only)' : ''}\n  url   ${base}/#packs\n  HOME  ${sb.home}\n  (temp HOME with stub CLIs — the live one is never touched; Ctrl-C to stop and remove it)\n`);
