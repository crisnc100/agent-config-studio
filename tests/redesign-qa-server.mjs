/**
 * Browser QA for the redesign (criteria 7 and 12): the real server on a
 * seeded temp HOME, so every Home card has something to say. Never the live
 * HOME — the worktree sandbox builds the machine from nothing.
 *
 *   node tests/redesign-qa-server.mjs     port 8797 (QA_PORT=… to change), runs until Ctrl-C
 *
 * What the seed gives each card:
 *  - Accounts & usage: six seats, one per state —
 *      Codex (main)   reading live from its own logs (two windows)
 *      Claude Max     a stored reading (two windows)
 *      Grok           a stored reading that is out of date ("not current")
 *      Codex (work)   never signed in            → Connect
 *      Codex (spare)  signed in, no turn yet      → "signed in · no usage yet"
 *      Claude (work)  the same account as Claude Max → "duplicate account"
 *  - Needs attention: model alerts (update, retiring, vanished), memory
 *    cleanups of every kind, a finished worktree in project "app", and a
 *    drifted CLAUDE.md in Context;
 *  - CLIs: fake claude and grok binaries the harness detection finds, and the
 *    Codex seats above;
 *  - Recent: two trashed skills and the history they left.
 *
 * The auth.json files below are empty placeholders in the temp HOME: Codex
 * signed-in state is the file's existence, and the studio never opens it.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { sandbox, project, pr, requireZsh, ROOT } from './worktree-sandbox.mjs';
import { seedMemoryHome, unlockMemoryHome } from './fixtures/memory-home.mjs';
import { defaultCatalogs, writeClaudeCatalog, writeCodexCatalog, writeGrokCatalog, fakeCli } from './fixtures/models-home.mjs';

requireZsh('redesign QA server');
const HOUR = 3_600_000;
const put = (file, body, mtime) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body, null, 2));
  if (mtime) fs.utimesSync(file, mtime / 1000, mtime / 1000);
};

// ── a machine with one registered project and a finished worktree ─────────
const sb = sandbox('redesign-qa');
const home = sb.home;
const p = project(sb, { cmd: 'app' });
const mk = (name, merge) => {
  sb.zsh(p.trunk, `wnew ${name}`);
  const wt = p.wt(name);
  fs.writeFileSync(path.join(wt, `${name}.txt`), `${name}\n`);
  sb.git(wt, 'add', '.');
  sb.git(wt, 'commit', '-q', '-m', name);
  sb.git(wt, 'push', '-q', 'origin', `${name}:${name}`);
  if (merge) p.squash(name);
  return sb.git(wt, 'rev-parse', 'HEAD');
};
const finishedHead = mk('finished', true);
mk('wip', false);
p.fetch();
sb.gh({ finished: [pr(41, finishedHead)] });

// ── memory cleanups and a drifted context file ────────────────────────────
seedMemoryHome(home);

// ── model alerts, and CLIs for the harness detection to find ──────────────
const cat = defaultCatalogs();
writeClaudeCatalog(home, cat.claude, cat.claudeFetchedAt);
writeCodexCatalog(path.join(home, '.codex'), cat.codex, cat.codexFetchedAt);
writeGrokCatalog(home, cat.grok, cat.grokFetchedAt);
fakeCli(path.join(home, '.local', 'bin', 'claude'), '2.1.300 (Claude Code)');
fakeCli(path.join(home, '.grok', 'bin', 'grok'), '0.9.0');

// ── seats ────────────────────────────────────────────────────────────────
const now = Date.now();
const studio = path.join(home, '.agent-config-studio');
const codexMain = path.join(home, '.codex');
const codexWork = path.join(home, '.codex-seats', 'codex-work');
const codexSpare = path.join(home, '.codex-seats', 'codex-spare');
put(path.join(codexMain, 'auth.json'), '{}', now - 2 * 24 * HOUR);
put(path.join(codexMain, 'config.toml'), 'model = "x"\n');
const d = new Date(now - 60_000);
const two = (n) => String(n).padStart(2, '0');
const stamp = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}-${two(d.getMinutes())}-${two(d.getSeconds())}`;
put(path.join(codexMain, 'sessions', String(d.getFullYear()), two(d.getMonth() + 1), two(d.getDate()), `rollout-${stamp}-qa.jsonl`),
  JSON.stringify({ info: { rate_limits: {
    primary: { used_percent: 18, window_minutes: 300, resets_at: Math.floor(now / 1000) + 3 * 3600 },
    secondary: { used_percent: 41, window_minutes: 10080, resets_at: Math.floor(now / 1000) + 4 * 86400 },
    plan_type: 'pro' } } }) + '\n');
fs.mkdirSync(codexWork, { recursive: true });
put(path.join(codexSpare, 'auth.json'), '{}', now - HOUR);
put(path.join(studio, 'seats.json'), { seats: [
  { id: 'codex-main', vendor: 'codex', label: 'Codex (main)', home: codexMain },
  { id: 'codex-work', vendor: 'codex', label: 'Codex (work)', home: codexWork },
  { id: 'codex-spare', vendor: 'codex', label: 'Codex (spare)', home: codexSpare },
  { id: 'claude-max', vendor: 'claude', label: 'Claude Max' },
  { id: 'claude-work', vendor: 'claude', label: 'Claude (work)' },
  { id: 'grok', vendor: 'grok', label: 'Grok' },
] });
// Claude and Grok render from the reading the acs-usage CLI stores.
put(path.join(studio, 'usage-snapshot.json'), {
  takenAt: now - 5 * 60_000,
  seats: [
    { seatId: 'claude-max', label: 'Claude Max', vendor: 'claude', ok: true, subscriptionType: 'max', observedAt: now - 5 * 60_000,
      windows: [{ label: '5-hour', usedPercent: 63, resetsAt: now + 2 * HOUR }, { label: 'Weekly', usedPercent: 27, resetsAt: now + 3 * 24 * HOUR }] },
    { seatId: 'claude-work', label: 'Claude (work)', vendor: 'claude', ok: false, windows: [], observedAt: null,
      duplicateOf: 'claude-max', reason: 'signed in to the same account as Claude Max' },
    { seatId: 'grok', label: 'Grok', vendor: 'grok', ok: true, stale: true, observedAt: now - 3 * HOUR,
      windows: [{ label: 'Weekly', usedPercent: 52, resetsAt: now + 2 * 24 * HOUR }],
      staleReason: 'the Grok CLI did not answer' },
  ],
});

// ── two trashed skills, for Recent ────────────────────────────────────────
for (const name of ['old-helper', 'scratch-notes']) {
  put(path.join(home, '.claude', 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: QA fixture\n---\n\n${name}\n`);
}

// ── the server ───────────────────────────────────────────────────────────
const free = (port) => new Promise((resolve) => {
  const s = net.createServer();
  s.once('error', () => resolve(null));
  s.listen(port, '127.0.0.1', () => { const q = s.address().port; s.close(() => resolve(q)); });
});
const port = (await free(Number(process.env.QA_PORT || 8797))) ?? (await free(0));
const child = spawn(process.execPath, ['--no-warnings', path.join(ROOT, 'server.js')], {
  cwd: ROOT, env: { ...sb.env, PORT: String(port) }, stdio: ['ignore', 'inherit', 'inherit'],
});
const base = `http://localhost:${port}`;
for (let i = 0; i < 100; i++) {
  try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 100));
}
for (const name of ['old-helper', 'scratch-notes']) {
  await fetch(`${base}/api/delete`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: path.join(home, '.claude', 'skills', name) }),
  }).catch(() => {});
}
console.log(`\n  Redesign QA server\n  home     ${base}/\n  usage    ${base}/#usage\n  HOME     ${home}\n  (temp HOME — the live one is never touched; Ctrl-C to stop)\n`);

const stop = () => {
  child.kill('SIGINT');
  unlockMemoryHome(home);
  sb.cleanup();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.on('exit', (code) => { console.log(`server exited (${code})`); unlockMemoryHome(home); sb.cleanup(); process.exit(code ?? 1); });
