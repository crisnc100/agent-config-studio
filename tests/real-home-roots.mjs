/**
 * B14: the real-home tripwire follows roots.json (builds/configurable-roots/plan.md).
 * Run against scratch HOMEs, the way tests/skills.mjs's C14 runs it: each
 * scenario saves a snapshot, makes one change that keeps size and mtime, and
 * the check must fail. Covered: an in-place edit of a .mcp.json, a
 * .worktrees.conf and a CLAUDE.md under a custom root; the same under a root
 * whose path is a symlink; an edit to the TARGET of a symlinked instruction
 * file; and, with no roots.json, the legacy folders still being checked.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TRIP = path.join(path.dirname(fileURLToPath(import.meta.url)), 'real-home.mjs');

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const sameShape = (f, body) => {
  const st = fs.statSync(f, { bigint: true });
  fs.writeFileSync(f, body);
  fs.utimesSync(f, Number(st.atimeNs) / 1e9, Number(st.mtimeNs) / 1e9);
};

function scratch(tag) {
  const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `acs-trip-roots-${tag}-`)));
  const put = (rel, body) => { const f = path.join(T, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); return f; };
  const snap = `${T}.snap`;
  const run = (cmd) => spawnSync(process.execPath, [TRIP, cmd, snap], { env: { ...process.env, HOME: T }, encoding: 'utf8' });
  const scenario = (label, mutate, wantFail, undo) => {
    run('save');
    mutate();
    const r = run('check');
    ok(`B14 tripwire ${wantFail ? 'FAILS' : 'passes'} on ${label}`, (r.status !== 0) === wantFail, (r.stdout || '').trim().split('\n').slice(1, 4).join(' | '));
    undo?.();
    return r;
  };
  const cleanup = () => { fs.rmSync(T, { recursive: true, force: true }); fs.rmSync(snap, { force: true }); };
  return { T, put, scenario, cleanup };
}

console.log('\nreal-home tripwire, following roots.json');

// A custom edit root, a read root reached through a symlink, and an
// instruction file that is itself a link out to a notes folder.
{
  const { T, put, scenario, cleanup } = scratch('custom');
  const mcp = put('code/work/app/.mcp.json', '{"mcpServers":{"a":{}}}\n');
  const wt = put('code/work/app/.worktrees.conf', 'TRUNK=/x\n');
  const claude = put('code/work/app/CLAUDE.md', '# app AAAA\n');
  const target = put('notes/shared-rules.md', '# rules AAAA\n');
  fs.symlinkSync(target, path.join(T, 'code', 'work', 'app', 'AGENTS.md'));
  const realShared = path.join(T, 'volumes', 'shared');
  const sharedMcp = put('volumes/shared/client/.mcp.json', '{"mcpServers":{"b":{}}}\n');
  const sharedClaude = put('volumes/shared/client/CLAUDE.md', '# client AAAA\n');
  const sharedWt = put('volumes/shared/client/.worktrees.conf', 'TRUNK=/s\n');
  fs.symlinkSync(realShared, path.join(T, 'shared-link'));
  put('.agent-config-studio/roots.json', JSON.stringify({ version: 1, roots: [
    { id: 'work', path: path.join(T, 'code', 'work'), label: 'Work', access: 'edit' },
    { id: 'shared', path: path.join(T, 'shared-link'), label: 'Shared', access: 'read' },
  ] }));

  const clean = scenario('an untouched tree with custom roots', () => {}, false);
  ok('B14 …and its passing line names the custom roots it checked', clean.stdout.includes('~/code/work') && clean.stdout.includes('~/shared-link'), clean.stdout);
  scenario('an in-place edit of a .mcp.json under a custom root', () => sameShape(mcp, '{"mcpServers":{"z":{}}}\n'), true, () => sameShape(mcp, '{"mcpServers":{"a":{}}}\n'));
  scenario('an in-place edit of a .worktrees.conf under a custom root', () => sameShape(wt, 'TRUNK=/y\n'), true, () => sameShape(wt, 'TRUNK=/x\n'));
  scenario('an in-place edit of a CLAUDE.md under a custom root', () => sameShape(claude, '# app ZZZZ\n'), true, () => sameShape(claude, '# app AAAA\n'));
  scenario('an edit to the target of a symlinked instruction file', () => sameShape(target, '# rules ZZZZ\n'), true, () => sameShape(target, '# rules AAAA\n'));
  scenario('an in-place edit of a .mcp.json under a root whose path is a symlink', () => sameShape(sharedMcp, '{"mcpServers":{"z":{}}}\n'), true, () => sameShape(sharedMcp, '{"mcpServers":{"b":{}}}\n'));
  scenario('an in-place edit of a .worktrees.conf under a root whose path is a symlink', () => sameShape(sharedWt, 'TRUNK=/t\n'), true, () => sameShape(sharedWt, 'TRUNK=/s\n'));
  scenario('an in-place edit of a CLAUDE.md under a root whose path is a symlink', () => sameShape(sharedClaude, '# client ZZZZ\n'), true, () => sameShape(sharedClaude, '# client AAAA\n'));
  scenario('a new .worktrees.conf appearing under a custom root', () => put('code/work/other/.worktrees.conf', 'x\n'), true, () => fs.rmSync(path.join(T, 'code', 'work', 'other'), { recursive: true }));
  cleanup();
}

// No roots.json: the two legacy folders are still checked, config files included.
{
  const { put, scenario, cleanup } = scratch('legacy');
  const mcp = put('Documents/Projects/app/.mcp.json', '{"mcpServers":{"a":{}}}\n');
  const gconf = put('Documents/Garman-Homes/g/.worktrees.conf', 'TRUNK=/x\n');
  scenario('an untouched legacy tree', () => {}, false);
  scenario('an in-place .mcp.json edit under ~/Documents/Projects with no roots.json', () => sameShape(mcp, '{"mcpServers":{"z":{}}}\n'), true, () => sameShape(mcp, '{"mcpServers":{"a":{}}}\n'));
  scenario('an in-place .worktrees.conf edit under ~/Documents/Garman-Homes with no roots.json', () => sameShape(gconf, 'TRUNK=/y\n'), true, () => sameShape(gconf, 'TRUNK=/x\n'));
  cleanup();
}

// A roots.json that lists other folders still leaves the legacy ones covered,
// and an entry naming HOME itself is not walked (it would be the whole home).
{
  const { T, put, scenario, cleanup } = scratch('mixed');
  put('code/w/CLAUDE.md', '# w\n');
  const legacy = put('Documents/Projects/app/CLAUDE.md', '# legacy AAAA\n');
  put('.agent-config-studio/roots.json', JSON.stringify({ version: 1, roots: [
    { id: 'w', path: path.join(T, 'code', 'w'), label: 'W', access: 'edit' },
    { id: 'home', path: T, label: 'Home', access: 'read' },
    { id: 'rel', path: 'relative/path', label: 'Rel', access: 'read' },
  ] }));
  const clean = scenario('a roots.json with a HOME entry and a relative one (both skipped)', () => {}, false);
  ok('B14 …which are not listed as checked roots', !/under ~,|under ~ |, ~,|relative\/path/.test(clean.stdout), clean.stdout);
  scenario('an edit under a legacy folder that roots.json does not list', () => sameShape(legacy, '# legacy ZZZZ\n'), true, () => sameShape(legacy, '# legacy AAAA\n'));
  cleanup();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
