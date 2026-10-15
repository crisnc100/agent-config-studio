/**
 * Browser QA for "Assist finds its own files": a real server on a free port
 * (or PORT), HOME redirected to a temp dir seeded below, and a scripted fake
 * `claude` in that HOME — no model is ever called. Never the live HOME.
 *
 *   node tests/assist-qa-server.mjs            prints the URL and HOME, runs until Ctrl-C
 *
 * The fake answers by what the prompt carries, through the real chat route
 * and its containment gate:
 *   1. no search results yet          → `@@FIND astra`
 *   2. search results, no files yet   → `@@NEED` the two review skills and the plugin skill
 *   3. files pulled in                → edits to all three: two become
 *      proposals (Accept all), the plugin one is refused as read-only.
 * A request with no attachment exercises the chips, the scope line, Accept
 * all and the refusal. The fake reports whichever tool set its argv asked
 * for, so it runs before and after chat goes tool-less.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acs-assist-qa-')));
const put = (f, s, mode) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s, mode ? { mode } : undefined); };
const studio = path.join(home, '.agent-config-studio');
const skill = (dir, desc, body) => put(path.join(dir, 'SKILL.md'), `---\nname: ${path.basename(dir)}\ndescription: ${desc}\n---\n\n${body}\n`);

put(path.join(studio, 'setup.json'), JSON.stringify({ completed: 'done', at: new Date().toISOString() }));
put(path.join(studio, 'roots.json'), JSON.stringify({ version: 1, roots: [] }, null, 2));
put(path.join(home, '.claude', 'CLAUDE.md'), '# Working rules\n\nBe brief.\n');
const S = path.join(home, '.claude', 'skills');
skill(path.join(S, 'review-diff'), 'Review a diff.', 'Send every diff to astra for review.');
skill(path.join(S, 'review-plan'), 'Review a plan.', 'Ask astra to find the hole in the plan.');
skill(path.join(S, 'ship'), 'Ship a branch.', 'Open a PR; never merge.');
const plugin = path.join(home, '.claude', 'plugins', 'cache', 'qa-market', 'qa-plugin', '1.0.0', 'skills', 'plugin-review');
skill(plugin, 'A plugin\'s review skill.', 'This plugin routes reviews to astra.');
put(path.join(home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'qa-plugin@qa-market': true } }, null, 2));

const D = '~/.claude/skills/review-diff/SKILL.md', P = '~/.claude/skills/review-plan/SKILL.md';
const R = '~/.claude/plugins/cache/qa-market/qa-plugin/1.0.0/skills/plugin-review/SKILL.md';
const edit = (f, a, b) => `@@EDIT ${f}\n@@SEARCH\n${a}\n@@REPLACE\n${b}\n@@END`;
const REPLIES = {
  find: '@@FIND astra',
  need: [`@@NEED ${D}`, `@@NEED ${P}`, `@@NEED ${R}`].join('\n'),
  edits: [
    'Three skills send reviews to astra. Here is each moved to opus — the plugin one is read-only, so ACS will refuse it.', '',
    edit(D, 'Send every diff to astra for review.', 'Send every diff to opus for review.'), '',
    edit(P, 'Ask astra to find the hole in the plan.', 'Ask opus to find the hole in the plan.'), '',
    edit(R, 'This plugin routes reviews to astra.', 'This plugin routes reviews to opus.'),
  ].join('\n'),
};
put(path.join(home, '.local', 'bin', 'claude'), `#!${process.execPath}
const a = process.argv.slice(2);
if (a[0] === '--version') { console.log('9.9.9 (assist QA fake)'); process.exit(0); }
const R = ${JSON.stringify(REPLIES)};
let prompt = '';
process.stdin.on('data', (d) => { prompt += d; });
process.stdin.on('end', async () => {
  const toolless = a[a.indexOf('--tools') + 1] === '';
  const out = (e) => process.stdout.write(JSON.stringify(e) + '\\n');
  const session = 'qa-session-1';
  out({ type: 'system', subtype: 'init', session_id: session, tools: toolless ? [] : ['Read'], mcp_servers: [], permissionMode: 'default' });
  const reply = /pulled in by ACS at your request/.test(prompt) ? R.edits : /SEARCH RESULTS for/.test(prompt) ? R.need : R.find;
  for (let i = 0; i < reply.length; i += 24) {
    out({ type: 'stream_event', session_id: session, event: { type: 'content_block_delta', delta: { text: reply.slice(i, i + 24) } } });
    await new Promise((r) => setTimeout(r, 40));
  }
  out({ type: 'result', is_error: false, result: reply, session_id: session, usage: { input_tokens: 1200, output_tokens: 80 }, total_cost_usd: 0 });
});
`, 0o755);

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
console.log(`\n  Assist QA server\n  url   ${base}/#home\n  HOME  ${home}\n  try   open Assist, attach nothing, send "move my review skills from astra to opus"\n  (temp HOME and a scripted fake claude — no model is called; Ctrl-C to stop)\n`);

const stop = () => { child.kill('SIGINT'); fs.rmSync(home, { recursive: true, force: true }); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.on('exit', (code) => { console.log(`server exited (${code})`); process.exit(code ?? 1); });
