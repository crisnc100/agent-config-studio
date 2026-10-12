/**
 * Browser QA for the Memory and Context views (criterion 13): a real server,
 * HOME redirected to a temp dir seeded from tests/fixtures/memory-home.mjs.
 * Never the live HOME.
 *
 *   node tests/memory-qa-server.mjs          port 8795 (QA_PORT=… to change), runs until Ctrl-C
 *
 * What the seed gives each QA scenario:
 *  - both views: #memory and #context;
 *  - review queue: every live fact is queued; Keep one, then edit it in the
 *    editor (Open) and save — it comes back, marked "changed since kept";
 *  - empty-folder bulk trash: Cleanups → Empty project folders (empty-one,
 *    empty-two and a temp probe), then Operations → Restore;
 *  - index repair: Cleanups → Index links to missing files (alpha's MEMORY.md,
 *    one line of 13 links with 5 dangling, plus an _archive retarget), then
 *    Operations → Restore;
 *  - orphan side by side: Orphans → "Old/alpha" (project folder not found) →
 *    Compare with alpha → Trash… one file → Accept → Operations → Restore;
 *  - Context: alpha collapses its worktree copies and flags apps/web/CLAUDE.md
 *    as drifted, with a diff.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedMemoryHome, unlockMemoryHome } from './fixtures/memory-home.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acs-memory-qa-')));
seedMemoryHome(home);

const free = (port) => new Promise((resolve) => {
  const s = net.createServer();
  s.once('error', () => resolve(null));
  s.listen(port, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});
const port = (await free(Number(process.env.QA_PORT || 8795))) ?? (await free(0));

const child = spawn(process.execPath, ['--no-warnings', path.join(ROOT, 'server.js')], {
  cwd: ROOT,
  env: { HOME: home, PORT: String(port), PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, TMPDIR: os.tmpdir() },
  stdio: ['ignore', 'inherit', 'inherit'],
});

const base = `http://localhost:${port}`;
for (let i = 0; i < 100; i++) {
  try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 100));
}
console.log(`\n  Memory & Context QA server\n  memory   ${base}/#memory\n  context  ${base}/#context\n  HOME     ${home}\n  (temp HOME — the live one is never touched; Ctrl-C to stop)\n`);

const stop = () => { child.kill('SIGINT'); unlockMemoryHome(home); fs.rmSync(home, { recursive: true, force: true }); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.on('exit', (code) => { console.log(`server exited (${code})`); unlockMemoryHome(home); process.exit(code ?? 1); });
