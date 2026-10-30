/**
 * Browser QA for the skill wizard: a real server on a free port (or PORT),
 * HOME redirected to a temp dir seeded below, and a scripted fake `claude`
 * (tests/fixtures/wizard-cli.mjs) — no model is ever called. Never the live HOME.
 *
 *   node tests/skill-wizard-qa-server.mjs     prints the URL and HOME, runs until Ctrl-C
 *
 * Both harnesses are installed: the fake claude, and a stub `codex` (it only
 * answers --version) beside it, so the Where step ticks Claude and Codex.
 *
 * Seeded: one edit folder (~/Projects) holding two repos — `web-app` with a
 * .claude/skills folder and `api-server` with no harness folder at all — and
 * a read folder (~/Vendor) whose repo must never be offered; three global
 * skills and one project skill for the overlap list.
 *
 * The fake plays the interview from the prompt: three questions (the second
 * has choices), each answered turn after a short pause so the busy state
 * shows, then done with the name `release-notes`; the draft turn returns a
 * SKILL.md for whatever name Where chose.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { wizardCli } from './fixtures/wizard-cli.mjs';
import { tempDir, track } from './fixtures/cleanup.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = fs.realpathSync(tempDir('acs-wizard-qa-'));
const put = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
const skill = (dir, desc) => put(path.join(dir, 'SKILL.md'), `---\nname: ${path.basename(dir)}\ndescription: ${desc}\n---\n\n# ${path.basename(dir)}\n\nSteps.\n`);
const studio = path.join(home, '.agent-config-studio');

put(path.join(studio, 'setup.json'), JSON.stringify({ completed: 'done', at: new Date().toISOString() }));
put(path.join(studio, 'roots.json'), JSON.stringify({ version: 1, roots: [
  { id: 'projects', label: 'Projects', access: 'edit', path: path.join(home, 'Projects') },
  { id: 'vendor', label: 'Vendor', access: 'read', path: path.join(home, 'Vendor') },
] }, null, 2));
put(path.join(home, '.claude', 'CLAUDE.md'), '# Working rules\n\nBe brief.\n');
skill(path.join(home, '.claude', 'skills', 'ship'), 'Ship a branch: open a PR, never merge. Use when the user says "ship it".');
skill(path.join(home, '.claude', 'skills', 'changelog'), 'Write a CHANGELOG entry from the merged PRs. Use when asked for a changelog.');
skill(path.join(home, '.codex', 'skills', 'review'), 'Review a diff and report findings.');
const web = path.join(home, 'Projects', 'web-app');
const api = path.join(home, 'Projects', 'api-server');
fs.mkdirSync(path.join(web, '.git'), { recursive: true });
skill(path.join(web, '.claude', 'skills', 'deploy-preview'), 'Deploy a preview build of the web app.');
fs.mkdirSync(path.join(api, '.git'), { recursive: true });
put(path.join(api, 'README.md'), '# api-server\n');
fs.mkdirSync(path.join(home, 'Vendor', 'their-lib', '.git'), { recursive: true });

const bin = wizardCli(path.join(home, '.local', 'bin', 'claude'));
fs.writeFileSync(path.join(path.dirname(bin), 'mode.json'), JSON.stringify({
  kind: 'script',
  name: 'release-notes',
  summary: 'Drafts release notes from the merged PRs since the last tag, grouped by area, for the person to review.',
  questions: [
    { question: 'What should make an agent load this skill?', why: 'The trigger decides when the skill loads.', recommended: 'When I ask for release notes or say "write the notes for this release".' },
    { question: 'Where do the notes come from?', why: 'The source decides what the skill reads.', recommended: 'The merged PRs since the last tag.', choices: ['Merged PRs since the last tag', 'Commit messages since the last tag', 'The CHANGELOG draft'] },
    { question: 'What must it never do?', why: 'A hard limit belongs in the skill.', recommended: 'Never publish or tag anything; only draft the notes for me to review.' },
  ],
  draft: '---\nname: {{name}}\ndescription: Drafts release notes from the merged PRs since the last tag. Use when the user asks for release notes or says "write the notes for this release".\n---\n\n# {{name}}\n\n1. Find the last tag.\n2. List the PRs merged since it.\n3. Group them by area and write one line per PR in the person\'s words.\n\nNever publish or tag anything: only draft the notes for review.\n',
}));
fs.writeFileSync(path.join(path.dirname(bin), 'codex'), '#!/bin/sh\necho "codex-cli 0.0.0 (stub)"\n', { mode: 0o755 });
// The fake answers at once; a pause per turn lets the busy state and Cancel be seen.
fs.writeFileSync(path.join(path.dirname(bin), 'claude'), fs.readFileSync(bin, 'utf8').replace("if (step.slow) setTimeout(go, step.slow); else go();", 'setTimeout(go, 1200);'), { mode: 0o755 });

const port = process.env.PORT ? Number(process.env.PORT) : await new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});
const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
  cwd: ROOT,
  env: { HOME: home, PORT: String(port), PATH: `${path.dirname(bin)}:${path.dirname(process.execPath)}:/usr/bin:/bin`, TMPDIR: os.tmpdir(), ACS_SUITE: 'offline' },
  stdio: ['ignore', 'inherit', 'inherit'],
}); track(child);
console.log(`\nskill wizard QA server: http://localhost:${port}/#skills\nHOME: ${home}\n`);
const stop = () => { child.kill('SIGINT'); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.on('exit', (code) => process.exit(code ?? 0));
