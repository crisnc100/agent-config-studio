/**
 * Browser QA for the Models panel (criterion 10): a real server on a free
 * port, HOME redirected to a temp dir seeded from the fixtures. Never the
 * live HOME.
 *
 *   node tests/models-qa-server.mjs            prints the URL and HOME, runs until Ctrl-C
 *
 * The seed has one alert of every kind (opus update, sonnet update that needs
 * a newer Claude Code, terra retiring, haiku vanished), a user file with an
 * `astra` override and an `assist` override that must survive edits, and a
 * settings.json / config.toml for the sidecar strip.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedHome } from './fixtures/models-home.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const home = seedHome({ prefix: 'acs-models-qa-' });
fs.mkdirSync(path.join(home, '.agent-config-studio'), { recursive: true });
fs.writeFileSync(path.join(home, '.agent-config-studio', 'models.json'),
  '{\n  "models": {\n    "astra": "gpt-6-astra"\n  },\n  "assist": {\n    "claude": { "default": "opus" }\n  }\n}\n');

const port = await new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});

const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
  cwd: ROOT,
  env: { HOME: home, PORT: String(port), PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, TMPDIR: os.tmpdir() },
  stdio: ['ignore', 'inherit', 'inherit'],
});

const base = `http://localhost:${port}`;
for (let i = 0; i < 100; i++) {
  try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 100));
}
console.log(`\n  Models panel QA server\n  url   ${base}/#models\n  HOME  ${home}\n  (temp HOME — the live one is never touched; Ctrl-C to stop)\n`);

const stop = () => { child.kill('SIGINT'); fs.rmSync(home, { recursive: true, force: true }); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.on('exit', (code) => { console.log(`server exited (${code})`); process.exit(code ?? 1); });
