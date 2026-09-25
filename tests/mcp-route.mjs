/**
 * GET /api/mcp's note: no ~/.claude.json is the normal state of a fresh
 * machine, not an error to show raw; any other read failure still says so.
 *
 * HOME is redirected to a temp directory before server.js loads.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { snapshotRealHomes, assertRealHomesUnchanged } from './real-home.mjs';

const realBefore = snapshotRealHomes();
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acs-mcp-')));
process.env.HOME = home;
process.env.ACS_SUITE = 'offline';
delete process.env.CODEX_HOME;

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
console.log('\nmcp/route');

const { createApp } = await import('../server.js');
const { server } = createApp();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const get = () => fetch(`http://localhost:${server.address().port}/api/mcp`).then((r) => r.json());
const cfg = path.join(home, '.claude.json');

const absent = await get();
ok('no ~/.claude.json: "No MCP servers configured yet", not a raw ENOENT', absent.note === 'No MCP servers configured yet.' && !/ENOENT/.test(absent.note) && absent.global.length === 0, absent.note);

fs.writeFileSync(cfg, '{ not json');
const bad = await get();
ok('an unparseable ~/.claude.json still reports the real error', /^Could not read ~\/\.claude\.json: /.test(bad.note), bad.note);

if (process.getuid?.() !== 0) {
  fs.writeFileSync(cfg, '{}');
  fs.chmodSync(cfg, 0o000);
  const denied = await get();
  ok('an unreadable ~/.claude.json reports the real error', /^Could not read ~\/\.claude\.json: .*EACCES/.test(denied.note), denied.note);
  fs.chmodSync(cfg, 0o600);
}

fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { a: { command: 'x' } } }));
const good = await get();
ok('a readable one lists its servers with the read-only note', good.global.length === 1 && /read-only/.test(good.note), good.note);

server.close();
assertRealHomesUnchanged(realBefore, ok);
fs.rmSync(home, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
