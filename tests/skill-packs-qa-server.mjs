/**
 * Browser QA for the Packs card (builds/skill-packs P3, C13): a real server on
 * a free port (or PORT), HOME redirected to a temp sandbox with stub CLIs
 * (tests/fixtures/packs-sandbox.mjs). Never the live HOME; no model is called.
 *
 *   node tests/skill-packs-qa-server.mjs                 claude + codex stubs
 *   node tests/skill-packs-qa-server.mjs --claude-only   claude stub only (Codex disabled; the reviewer role fix-up)
 *
 * Prints the URL and HOME, runs until Ctrl-C, then removes the sandbox. The
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
const base = `http://localhost:${port}`;
for (let i = 0; i < 150; i++) {
  try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 100));
}
console.log(`\n  Packs card QA server${claudeOnly ? ' (claude only)' : ''}\n  url   ${base}/#packs\n  HOME  ${sb.home}\n  (temp HOME with stub CLIs — the live one is never touched; Ctrl-C to stop and remove it)\n`);
child.on('exit', (code) => { console.log(`server exited (${code})`); process.exit(code ?? 1); });
