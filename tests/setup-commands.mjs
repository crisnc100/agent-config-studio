/**
 * Every command the setup screen shows (builds/setup-screen criterion 3, S16):
 *
 *   - builds/setup-screen/commands.md lists each one with a verification
 *     source and the date it was checked, and the server reads it from there;
 *   - the commands the real page renders — every CLI missing, then every CLI
 *     signed out, then the Done step — are exactly that file's entries, and
 *     no setup source spells one itself;
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
import { startServer } from './fixtures/roots-home.mjs';
import { bootPage, settle } from './fixtures/shell-page.mjs';
import { fakeCli, isolatedPath } from './fixtures/setup-home.mjs';
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

// What the page actually renders. Two real servers — every CLI missing, then
// every CLI installed and signed out — and the real front end in the test VM
// on #setup; the commands read off the screen are compared with commands.md,
// parsed here on its own (not through readCommands, the code under test).
const md = Object.fromEntries([...fs.readFileSync(COMMANDS_FILE, 'utf8').matchAll(/^\| ((?:install|signin|docs|next)\.[a-z-]+) \| (.+?) \| .+ \| \d{4}-\d{2}-\d{2} \|$/gm)]
  .map((m) => [m[1], m[2].replace(/\\\|/g, '|').replace(/^`|`$/g, '')]));
ok('3 commands.md parses on its own to every key', keys.every((k) => md[k]), Object.keys(md).join());

async function rendered(tag, makeBin) {
  const sb = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `acs-setup-cmd-${tag}-`)));
  const home = path.join(sb, 'home');
  fs.mkdirSync(home);
  const PATH = isolatedPath(path.join(sb, 'bin'));
  makeBin(path.join(sb, 'bin'));
  const srv = await startServer(home, { root: ROOT, env: { PATH } });
  const proxy = async (method, p, body, u) => {
    const r = await fetch(`${srv.base}${p}${u?.search || ''}`, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw { status: r.status, body: data };
    return data;
  };
  const page = await bootPage({ routes: proxy, hash: '#setup&step=clis' });
  const t0 = Date.now();
  while (!page.$('content').querySelector('.setup-cli') && Date.now() - t0 < 8000) await settle(50);
  const cards = Object.fromEntries(page.$('content').querySelectorAll('.setup-cli').map((c) => [c.dataset.cli, c.querySelectorAll('code').map((x) => x.textContent)]));
  page.eval("setupGo('done')");
  while (!page.$('content').querySelector('.setup-next') && Date.now() - t0 < 8000) await settle(50);
  const next = page.$('content').querySelectorAll('.setup-next code').map((x) => x.textContent);
  const errors = page.errors.slice();
  page.done();
  await srv.stop();
  fs.rmSync(sb, { recursive: true, force: true });
  return { cards, next, errors };
}
const missing = await rendered('missing', () => {});
ok('3 every CLI missing: each card renders exactly commands.md\'s install command',
   CLI_IDS.every((c) => JSON.stringify(missing.cards[c]) === JSON.stringify([md[`install.${c}`]])), JSON.stringify(missing.cards));
const signedOut = await rendered('signed-out', (b) => { for (const c of CLI_IDS) fakeCli(b, c); });
ok('3 every CLI installed and not signed in: each card renders exactly commands.md\'s sign-in command',
   CLI_IDS.every((c) => JSON.stringify(signedOut.cards[c]) === JSON.stringify([md[`signin.${c}`]])), JSON.stringify(signedOut.cards));
const nextMd = ['next.model-id', 'next.worktree'].map((k) => md[k].replace(/^acs(?= )/, ACS_BIN));
ok('S16 the Done step renders commands.md\'s next steps, with this checkout\'s bin/acs (acs is not on PATH)',
   JSON.stringify(missing.next) === JSON.stringify(nextMd) && JSON.stringify(signedOut.next) === JSON.stringify(nextMd), JSON.stringify(missing.next));
ok('3 …with no page errors', !missing.errors.length && !signedOut.errors.length, [...missing.errors, ...signedOut.errors].join(' | '));

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
