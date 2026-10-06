/**
 * Every command the setup screen shows (builds/setup-screen criterion 3, S16):
 *
 *   - builds/setup-screen/commands.md lists each one with a verification
 *     source and the date it was checked, and the server reads it from there;
 *   - every install / sign-in / next-step command a route can hand the page
 *     is one of that file's entries, and no setup source spells one itself;
 *   - the Done step's commands run under `sh` — as `acs …` when acs is on
 *     PATH, and as this checkout's bin/acs when it is not — against a temp
 *     HOME (install-worktree as its --dry-run).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshotRealHomes, assertRealHomesUnchanged } from './real-home.mjs';
import { readCommands, nextSteps, ACS_BIN, COMMANDS_FILE } from '../lib/setup-commands.js';
import { CLI_IDS } from '../lib/setup-clis.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const realBefore = snapshotRealHomes();
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

console.log('\nsetup: commands');
const table = readCommands();
const keys = [...CLI_IDS.flatMap((c) => [`install.${c}`, `signin.${c}`, `docs.${c}`]), 'next.model-id', 'next.worktree'];
ok('3 commands.md is the file the server reads', COMMANDS_FILE === path.join(ROOT, 'builds', 'setup-screen', 'commands.md'));
for (const k of keys) {
  const e = table[k];
  ok(`3 ${k} is listed with a command, a source and a date checked`,
     e && e.command && e.source.length > 10 && /^\d{4}-\d{2}-\d{2}$/.test(e.checked), JSON.stringify(e));
}
ok('3 every source is a help output or a URL', Object.values(table).every((e) => /--help|https:\/\/|bin\/acs/.test(`${e.source} ${e.command}`)));
ok('3 a command written with \\| reads back as a pipe', table['install.claude'].command === 'curl -fsSL https://claude.ai/install.sh | bash', table['install.claude'].command);

// What the routes can hand the page: fix commands come only from the table
// (lib/setup-clis.js fixFor), next steps only from nextSteps().
const shown = new Set([
  ...CLI_IDS.flatMap((c) => [table[`install.${c}`].command, table[`signin.${c}`].command, table[`docs.${c}`].command]),
  ...nextSteps({ acsOnPath: true }).map((s) => s.command),
  ...nextSteps({ acsOnPath: false }).map((s) => s.command),
]);
const listed = new Set(Object.values(table).map((e) => e.command));
ok('3 every command a route can show is a commands.md entry (bin/acs spelled out where acs is not on PATH)',
   [...shown].every((c) => listed.has(c) || listed.has(c.replace(ACS_BIN, 'acs').replace(`'${ACS_BIN}'`, 'acs'))), [...shown].join(' | '));

// No setup source spells a command itself.
const setupSources = [
  ...fs.readdirSync(path.join(ROOT, 'lib')).filter((f) => /^setup-|^version-probe|^login-path/.test(f)).map((f) => path.join(ROOT, 'lib', f)),
  ...fs.readdirSync(path.join(ROOT, 'public')).filter((f) => /setup/.test(f)).map((f) => path.join(ROOT, 'public', f)),
].filter((f) => !f.endsWith('setup-commands.js'));
const hard = [];
for (const f of setupSources) {
  const src = fs.readFileSync(f, 'utf8');
  for (const e of Object.values(table)) if (src.includes(e.command)) hard.push(`${path.relative(ROOT, f)}: ${e.command}`);
}
ok(`3 nothing in the setup sources (${setupSources.length} files) hardcodes a command`, hard.length === 0, hard.join(' | '));

// S16: the shown next steps run.
const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acs-setup-cmd-')));
const home = path.join(sandbox, 'home');
const onPath = path.join(sandbox, 'bin');
fs.mkdirSync(home); fs.mkdirSync(onPath);
// A wrapper, not a link: bin/acs finds its checkout from $0.
fs.writeFileSync(path.join(onPath, 'acs'), `#!/bin/sh\nexec '${ACS_BIN}' "$@"\n`, { mode: 0o755 });
fs.symlinkSync(process.execPath, path.join(onPath, 'node'));
const run = (cmd, PATH) => {
  try { return { code: 0, out: execFileSync('/bin/sh', ['-c', cmd], { env: { HOME: home, PATH, ACS_NO_UPDATE: '1' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }; }
  catch (e) { return { code: e.status, out: `${e.stdout || ''}${e.stderr || ''}` }; }
};
const sysPath = `${path.dirname(process.execPath)}:/usr/bin:/bin`;
for (const acsOnPath of [false, true]) {
  const steps = nextSteps({ acsOnPath });
  const PATH = acsOnPath ? `${onPath}:/usr/bin:/bin` : sysPath;
  ok(`S16 ${acsOnPath ? 'acs on PATH: commands say acs' : 'acs not on PATH: commands name this checkout\'s bin/acs'}`,
     steps.every((s) => (acsOnPath ? s.command.startsWith('acs ') : s.command.startsWith(ACS_BIN) || s.command.startsWith(`'${ACS_BIN}'`))), steps.map((s) => s.command).join(' | '));
  const wt = steps.find((s) => s.key === 'next.worktree');
  ok('S16 the worktree step is marked zsh/macOS only', wt.platforms === 'zsh/macOS only');
  const r1 = run(`${wt.command} --dry-run`, PATH);
  ok(`S16 \`${wt.command} --dry-run\` runs under sh`, r1.code === 0 && !fs.existsSync(path.join(home, '.config', 'worktree')), `${r1.code} ${r1.out.slice(-300)}`);
  const mid = steps.find((s) => s.key === 'next.model-id');
  fs.rmSync(path.join(home, '.agent-config-studio'), { recursive: true, force: true });
  const r2 = run(mid.command, PATH);
  ok(`S16 \`${mid.command}\` runs under sh and installs into the temp HOME`, r2.code === 0 && fs.existsSync(path.join(home, '.agent-config-studio', 'bin', 'model-id')), `${r2.code} ${r2.out.slice(-300)}`);
}

fs.rmSync(sandbox, { recursive: true, force: true });
assertRealHomesUnchanged(realBefore, ok);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
