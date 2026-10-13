/**
 * A fake `claude` for the Describe tests (tests/roles-routes.mjs). No model
 * is ever called.
 *
 * Per call it reads `mode.json` beside it — `{ kind, reply }` — appends its
 * argv to `calls.jsonl`, saves the prompt it got on stdin to `prompt.txt`,
 * and appends a line to `started.log` (the side effect a refused-before-spawn
 * request must never produce). Its init reports the tools its argv asked
 * for: none for `--tools ""`, as the real CLI does (probed), else [Read].
 *
 *   ok      init, the reply in small deltas, a result
 *   tools   init claims [Read, Bash] whatever argv said, then lingers (writes `pid`)
 *   mcp     init lists an MCP server, then lingers (writes `pid`)
 *   flood   init, then 100 KB of deltas
 *   bigresult  init, then one 100 KB result event and no delta, then lingers
 *   bigtail    init, then one 100 KB result event with no trailing newline, then exits
 *   bigpartial init, then 100 KB of one event that never ends, and lingers
 *   hang    init, then nothing; writes its pid to `pid` for the cancel test
 *   error   init, then a result with is_error
 */
import fs from 'node:fs';
import path from 'node:path';

export function describeCli(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!${process.execPath}
const fs = require('fs');
const path = require('path');
const dir = ${JSON.stringify(path.dirname(file))};
const a = process.argv.slice(2);
if (a[0] === '--version') { console.log('9.9.9 (fake)'); process.exit(0); }
const mode = (() => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'mode.json'), 'utf8')); } catch { return {}; } })();
fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify(a) + '\\n');
fs.appendFileSync(path.join(dir, 'started.log'), 'started\\n');
const out = (ev) => process.stdout.write(JSON.stringify(ev) + '\\n');
// Exit once stdout has drained: a pipe write is async, and exit() would cut it.
const done = () => process.stdout.write('', () => process.exit(0));
const ti = a.indexOf('--tools');
const tools = mode.kind === 'tools' ? ['Read', 'Bash'] : (ti !== -1 && a[ti + 1] === '' ? [] : ['Read']);
let prompt = '';
process.stdin.on('data', (d) => { prompt += d; });
process.stdin.on('end', () => {
  fs.writeFileSync(path.join(dir, 'prompt.txt'), prompt);
  // Before init: a refused turn may be killed the moment init is read.
  fs.writeFileSync(path.join(dir, 'pid'), String(process.pid));
  const mcp = mode.kind === 'mcp' ? [{ name: 'probe', status: 'pending' }] : [];
  out({ type: 'system', subtype: 'init', session_id: 's1', tools, mcp_servers: mcp, permissionMode: 'default' });
  const delta = (text) => out({ type: 'stream_event', session_id: 's1', event: { type: 'content_block_delta', delta: { text } } });
  const reply = mode.reply ?? '{}';
  switch (mode.kind || 'ok') {
    case 'flood':
      for (let i = 0; i < 100; i++) delta('x'.repeat(1024));
      out({ type: 'result', is_error: false, result: '', session_id: 's1' });
      done();
      break;
    case 'bigresult':
      out({ type: 'result', is_error: false, result: '{"x":"' + 'y'.repeat(100 * 1024) + '"}', session_id: 's1' });
      setInterval(() => {}, 1000);
      break;
    case 'bigtail':
      process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: '{"x":"' + 'y'.repeat(100 * 1024) + '"}', session_id: 's1' }));
      done();
      break;
    case 'bigpartial':
      process.stdout.write('{"type":"result","is_error":false,"result":"' + 'y'.repeat(100 * 1024));
      setInterval(() => {}, 1000);
      break;
    case 'tools':
    case 'mcp':
    case 'hang':
      setInterval(() => {}, 1000);
      break;
    case 'error':
      out({ type: 'result', is_error: true, result: 'rate limited (fake)', session_id: 's1' });
      done();
      break;
    default:
      for (let i = 0; i < reply.length; i += 40) delta(reply.slice(i, i + 40));
      out({ type: 'result', is_error: false, result: reply, session_id: 's1' });
      done();
  }
});
`, { mode: 0o755 });
  return file;
}
