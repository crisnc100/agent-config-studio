/**
 * A fake `claude` or `grok` for the containment suite (tests/assist-containment.mjs).
 *
 * What it prints is read, per call, from `mode.json` beside it, so one running
 * server can be driven through every case. Every call is appended to
 * `calls.jsonl` (argv and the GROK_*_MCPS_ENABLED env), and a session start —
 * anything but `--version` and `inspect` — appends to `started.log`: the
 * observable side effect a refused-before-spawn turn must never produce.
 *
 * After a bad init the fake starts a grandchild that would write `leaked.log`
 * after 1.5 s, then itself waits 1.5 s before sending a reply carrying an
 * @@EDIT block. A turn the gate refuses kills the process group first, so
 * neither ever lands.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export function containedCli(file, harness) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!${process.execPath}
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');
const HARNESS = ${JSON.stringify(harness)};
const dir = ${JSON.stringify(path.dirname(file))};
const a = process.argv.slice(2);
const mode = (() => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'mode.json'), 'utf8')); } catch { return {}; } })();
fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify({ harness: HARNESS, argv: a, env: {
  GROK_CLAUDE_MCPS_ENABLED: process.env.GROK_CLAUDE_MCPS_ENABLED ?? null,
  GROK_CURSOR_MCPS_ENABLED: process.env.GROK_CURSOR_MCPS_ENABLED ?? null,
}, envHash: crypto.createHash('sha256').update(JSON.stringify(Object.entries(process.env).sort())).digest('hex') }) + '\\n');
if (a[0] === '--version') { console.log('9.9.9 (fake)'); process.exit(0); }
if (a[0] === 'inspect') {
  const i = mode.inspect ?? { mcpServers: [], plugins: [] };
  if (i === 'fail') { console.error('inspect failed'); process.exit(1); }
  if (i === 'hang') { setTimeout(() => {}, 60000); return; }
  if (i === 'ignore-term') {
    fs.writeFileSync(path.join(dir, 'inspect.pid'), String(process.pid));
    // A descendant holding the pipe, as a real inspect's helper might.
    const kid = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: ['ignore', 'inherit', 'inherit'] });
    fs.writeFileSync(path.join(dir, 'inspect-child.pid'), String(kid.pid));
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
    return;
  }
  process.stdout.write(i === 'garbage' ? 'not json' : JSON.stringify(i));
  process.exit(0);
}
fs.appendFileSync(path.join(dir, 'started.log'), JSON.stringify(a) + '\\n');

const READ = HARNESS === 'grok' ? 'read_file' : 'Read';
const session = mode.session || 'sess-1';
const init = (over = {}) => ({ type: 'system', subtype: 'init', session_id: session, tools: [READ], mcp_servers: [], permissionMode: 'default', ...over });
const reply = mode.reply || 'ok reply';
const out = (ev) => process.stdout.write(JSON.stringify(ev) + '\\n');
const replyEvents = () => {
  out({ type: 'stream_event', session_id: session, event: { type: 'content_block_delta', delta: { text: reply } } });
  out({ type: 'result', is_error: false, result: reply, session_id: session, usage: {} });
};
const later = () => {
  spawn(process.execPath, ['-e', 'setTimeout(() => require("fs").writeFileSync(process.argv[1], "leaked\\\\n"), 1500)', path.join(dir, 'leaked.log')], { stdio: 'ignore' });
  setTimeout(() => { replyEvents(); process.exit(0); }, 1500);
};

const run = () => {
  const resumed = a.includes('--resume') || a.includes('-r');
  const kind = resumed && mode.resumeKind ? mode.resumeKind : (mode.kind || 'ok');
  switch (kind) {
    case 'ok': out(init()); replyEvents(); process.exit(0); break;
    case 'extra': out(init({ tools: [READ, 'Bash', 'Write'] })); later(); break;
    case 'count': out(init({ toolCount: 134 })); later(); break;
    case 'mcp': out(init({ mcp_servers: [{ name: 'probe', status: 'pending' }] })); later(); break;
    case 'malformed': out(init({ tools: 'Read' })); later(); break;
    case 'repeat': out(init()); out(init()); later(); break;
    case 'before': out({ type: 'stream_event', session_id: session, event: { type: 'content_block_delta', delta: { text: 'early ' } } }); out(init()); later(); break;
    case 'after-partial': out(init()); out({ type: 'stream_event', session_id: session, event: { type: 'content_block_delta', delta: { text: 'partial ' } } }); out(init({ tools: [READ, 'Bash'] })); later(); break;
    case 'missing': process.exit(0); break;
    case 'silent': spawn(process.execPath, ['-e', 'setTimeout(() => require("fs").writeFileSync(process.argv[1], "leaked\\\\n"), 3000)', path.join(dir, 'leaked.log')], { stdio: 'ignore' }); setTimeout(() => {}, 60000); break;
    default: out(init()); replyEvents(); process.exit(0);
  }
};
if (a.includes('--prompt-file')) run(); else { process.stdin.resume(); process.stdin.on('data', () => {}); process.stdin.on('end', run); }
`, { mode: 0o755 });
  return file;
}
