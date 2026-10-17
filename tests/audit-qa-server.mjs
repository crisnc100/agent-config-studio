/**
 * Browser QA for the Audit view: a real server on a free port (or PORT),
 * HOME redirected to a temp dir seeded below, plus one temp read folder.
 * Never the live HOME.
 *
 *   node tests/audit-qa-server.mjs            prints the URL and HOME, runs until Ctrl-C
 *
 * The seed has a finding of every rule in every class: a user skill with a
 * fixable stale -m, a bare $(model-id …), an effort no role uses and a JSON
 * model key; a synced skill; an enabled plugin skill; a vendor skill; a read
 * folder; a global CLAUDE.md with a hand-written lanes section beside the
 * generated guide; an AGENTS.md table row; and two identical project copies.
 * For builds/audit-tuning (C1–C9): a "Routing: …" heading that is not a lanes
 * section, a preset-label JSON key, the investigate line with a code and a
 * prose copy of one id, second-opinion's written-out names, name notes to
 * fold, and ~/Projects/app as a real git repo with two linked worktrees.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acs-audit-qa-')));
const ext = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acs-audit-qa-client-')));
const put = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
const studio = path.join(home, '.agent-config-studio');
const fence = (...l) => ['```bash', ...l, '```'].join('\n');
const skill = (dir, body) => put(path.join(dir, 'SKILL.md'), `---\nname: ${path.basename(dir)}\ndescription: QA fixture\n---\n\n${body}\n`);

put(path.join(studio, 'setup.json'), JSON.stringify({ completed: 'done', at: new Date().toISOString() }));
put(path.join(studio, 'models.json'), JSON.stringify({ version: 1, models: { sol: 'gpt-6.1-sol', sonnet: 'claude-sonnet-5-5' } }, null, 2));
put(path.join(studio, 'roots.json'), JSON.stringify({ version: 1, roots: [
  { id: 'projects', label: 'Projects', access: 'edit', path: path.join(home, 'Projects') },
  { id: 'client', label: 'Client', access: 'read', path: ext },
] }, null, 2));

process.env.HOME = home;
const { guideText, loadRoles } = await import('../lib/roles.js');
const { renderBlock } = await import('../lib/model-guide.js');
put(path.join(home, '.claude', 'CLAUDE.md'), `# Working rules\n\nBe brief.\n\n## Model lanes\n\nBuilds go to claude-opus-5-5; reviews to gpt-6-astra.\n\n## Routing: build here or dispatch to Atlas\n\nDefault is build here.\n\n${renderBlock(guideText(loadRoles({ home })), 1)}\n`);
put(path.join(home, '.codex', 'AGENTS.md'), [
  '# Codex', '', '| Lane | Command |', '|---|---|',
  '| Build | `codex exec -m gpt-6-sol -c model_reasoning_effort=medium` |',
  '| Review | `codex exec -m gpt-6-astra -c model_reasoning_effort=high` |', '',
  'Run `codex exec -m gpt-6-sol "task"` for a quick build.', '',
].join('\n'));
put(path.join(home, '.grok', 'AGENTS.md'), '# Grok\n\nNo model ids here.\n');

const S = path.join(home, '.claude', 'skills');
skill(path.join(S, 'reviewer'), [
  'Run the review:', '',
  fence('codex exec -m gpt-6-sol -c model_reasoning_effort=xhigh "review the diff"', 'BUILDER=$(model-id --role builder)'),
  '', 'Then ask claude-fable-5-1 for a second opinion: `claude -p --model claude-fable-5-1 "judge"`.',
].join('\n'));
put(path.join(S, 'reviewer', 'scripts', 'run.sh'), '#!/bin/sh\r\ncodex exec -m gpt-6-sol "$@"\r\nM=$(model-id sol)\r\n');
put(path.join(S, 'reviewer', 'config.json'), '{\n  "model": "gpt-6-sol",\n  "effort": "high"\n}\n');
skill(path.join(S, 'synced', 'team-uuid', 'shared-review'), fence('codex exec -m gpt-6-sol "x"'));
skill(path.join(home, '.agents', 'skills', 'helper'), 'Uses claude-opus-5-5 in prose only.');
skill(path.join(home, '.codex', 'skills', '.system', 'vendor-docs'), fence('codex -m gpt-5 "vendor example"'));
const FX = path.join(ROOT, 'tests', 'fixtures', 'audit-tuning');
const fx = (n) => fs.readFileSync(path.join(FX, n), 'utf8');
skill(path.join(S, 'second-opinion'), `| Family | Notes |\n|---|---|\n${fx('second-opinion-lines.md')}\nOlder notes: Opus 5 was fine, GPT-6 too, and Haiku 4 before that.`);
skill(path.join(S, 'investigate'), `| Method | Who | Flips to |\n|---|---|---|\n${fx('investigate-line64.md')}`);
put(path.join(S, 'code-review', 'SKILL.md'), '---\nname: code-review\ndescription: QA fixture\n---\n\nReview the diff.\n');
put(path.join(S, 'code-review', 'review-config.example.json'), `{\n  "_presets": {\n${fx('review-config-line4.json')}  }\n}\n`);
const plugin = path.join(home, '.claude', 'plugins', 'cache', 'qa-market', 'qa-plugin', '1.2.0', 'skills', 'plugin-skill');
skill(plugin, fence('claude --model claude-opus-4-1 "plugin example"'));
put(path.join(home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'qa-plugin@qa-market': true } }, null, 2));

put(path.join(home, 'Projects', 'app', 'CLAUDE.md'), '# App\n\nBuild with claude-opus-5-5.\n');
put(path.join(home, 'Projects', 'app-wt', 'feature', 'CLAUDE.md'), '# App\n\nBuild with claude-opus-5-5.\n');
fs.symlinkSync('CLAUDE.md', path.join(home, 'Projects', 'app', 'AGENTS.md'));
skill(path.join(home, 'Projects', 'app', '.claude', 'skills', 'deploy'), fence('grok -m grok-4.5 "deploy"'));
// ~/Projects/app as a real repository with two linked worktrees, each changed a little.
const gitEnv = { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig-none'), GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'qa', GIT_AUTHOR_EMAIL: 'qa@example.invalid', GIT_COMMITTER_NAME: 'qa', GIT_COMMITTER_EMAIL: 'qa@example.invalid' };
const git = (cwd, ...a) => { const r = spawnSync('git', ['-c', 'init.defaultBranch=main', ...a], { cwd, env: gitEnv, encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr); };
const appDir = path.join(home, 'Projects', 'app');
git(appDir, 'init', '-q'); git(appDir, 'add', '-A'); git(appDir, 'commit', '-qm', 'init');
for (const name of ['one', 'two']) {
  const wt = path.join(home, 'Projects', 'app-trees', name);
  git(appDir, 'worktree', 'add', '-q', wt);
  put(path.join(wt, 'CLAUDE.md'), `# App (${name})\n\nBuild with claude-opus-5-5, then gpt-6-sol.\n`);
}
put(path.join(ext, 'CLAUDE.md'), '# Client\n\nUse gpt-6-sol for builds.\n');

const port = process.env.PORT ? Number(process.env.PORT) : await new Promise((resolve, reject) => {
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
console.log(`\n  Audit QA server\n  url   ${base}/#audit\n  HOME  ${home}\n  read  ${ext}\n  (temp HOME — the live one is never touched; Ctrl-C to stop)\n`);

const stop = () => { child.kill('SIGINT'); fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(ext, { recursive: true, force: true }); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.on('exit', (code) => { console.log(`server exited (${code})`); process.exit(code ?? 1); });
