/** Gemini quota reader (agy /usage). A fake agy in a temp dir; never the real one. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { shapeUsage, readGeminiSeat, parseVersion, versionAtLeast } from '../lib/usage/gemini.js';
import { tempDir } from './fixtures/cleanup.mjs';

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n}${d ? ` — ${d}` : ''}`); } };

const here = path.dirname(fileURLToPath(import.meta.url));
const REAL = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'agy-usage', 'usage-1.5.13.json'), 'utf8'));
const clone = () => JSON.parse(JSON.stringify(REAL));

console.log('\nusage/gemini');

// --- shaping the real reply ---------------------------------------------------
{
  const r = shapeUsage(clone());
  ok('the real reply reads', r.ok === true, r.reason);
  ok('windows are the Gemini Models pool only: 5h and weekly', r.windows.length === 2
    && r.windows[0].windowMinutes === 300 && r.windows[1].windowMinutes === 10080, JSON.stringify(r.windows));
  ok('remaining 0.9283 → 7.2% used', r.windows[1].usedPercent === 7.2, String(r.windows[1].usedPercent));
  ok('remaining 0.9429 → 5.7% used', r.windows[0].usedPercent === 5.7, String(r.windows[0].usedPercent));
  ok('reset is epoch ms', r.windows[1].resetsAt === Date.parse('2026-11-27T15:07:18Z'));
  ok('labels', r.windows[0].label === '5-hour' && r.windows[1].label === 'Weekly');
  ok('Argon weekly rides separately', r.extraWindows.length === 1 && r.extraWindows[0].usedPercent === 0
    && r.extraWindows[0].windowMinutes === 10080 && /Argon/.test(r.extraWindows[0].label), JSON.stringify(r.extraWindows));
  ok('the Claude and GPT group is not read', !JSON.stringify(r).includes('2026-11-21T03:32:38')
    && ![...r.windows, ...r.extraWindows].some((w) => w.resetsAt === Date.parse('2026-11-21T03:32:38Z')));
}

// --- replies that must never become a reading ----------------------------------
{
  const turned = clone(); turned.num_turns = 1;
  ok('a reply that ran a turn is refused', shapeUsage(turned).ok === false && /model turn/.test(shapeUsage(turned).reason));
  const noTurns = clone(); delete noTurns.num_turns;
  ok('a reply that does not say zero turns is refused', shapeUsage(noTurns).ok === false);
  const other = clone(); other.command.name = 'credits';
  ok('another command is refused', shapeUsage(other).ok === false);
  const prompt = clone(); delete prompt.command;
  ok('a prompt answer (no command) is refused', shapeUsage(prompt).ok === false);
  const noGemini = clone(); noGemini.command.data.groups = noGemini.command.data.groups.filter((g) => g.name !== 'Gemini Models');
  ok('no Gemini Models group → no reading, even with the other groups present', shapeUsage(noGemini).ok === false);
  const bad = clone(); bad.command.data.groups[0].buckets.forEach((b) => { b.remaining_fraction = ''; });
  ok('a blank fraction is not 0% used', shapeUsage(bad).ok === false);
  const over = clone(); over.command.data.groups[0].buckets.forEach((b) => { b.remaining_fraction = 1.5; });
  ok('a fraction above 1 is refused', shapeUsage(over).ok === false);
  ok('null is refused', shapeUsage(null).ok === false);
}

// --- versions -----------------------------------------------------------------
ok('parses a bare version', JSON.stringify(parseVersion('1.5.13')) === '[1,5,13]');
ok('no version → null', parseVersion('agy') === null);
ok('1.1.11 is enough', versionAtLeast([1, 1, 11]) === true);
ok('1.1.10 is not', versionAtLeast([1, 1, 10]) === false);
ok('1.0.99 is not', versionAtLeast([1, 0, 99]) === false);
ok('2.0.0 is', versionAtLeast([2, 0, 0]) === true);
ok('null is not', versionAtLeast(null) === false);

// --- the spawn, against a fake agy ----------------------------------------------
const tmp = tempDir('acs-gemini-');
const LOG = path.join(tmp, 'calls.jsonl');
const fake = path.join(tmp, 'agy');
fs.writeFileSync(fake, `#!${process.execPath}
const fs = require('fs');
const mode = process.env.FAKE_AGY_MODE || 'ok';
const cwd = process.cwd();
fs.appendFileSync(${JSON.stringify(LOG)}, JSON.stringify({ argv: process.argv.slice(2), cwd, entries: fs.readdirSync(cwd), hooksOff: process.env.CMUX_ANTIGRAVITY_HOOKS_DISABLED }) + '\\n');
if (process.argv[2] === '--version' && mode === 'slowversion') { setTimeout(() => { process.stdout.write('1.5.13\\n'); process.exit(0); }, 700); }
else if (process.argv[2] === '--version') { process.stdout.write(mode === 'old' ? '1.1.10\\n' : mode === 'noversion' ? 'agy\\n' : '1.5.13\\n'); process.exit(0); }
else if (mode === 'apikey') process.exit(2);
else if (mode === 'signedout') process.exit(1);
else if (mode === 'hang' || mode === 'slowversion') setTimeout(() => {}, 60000);
else if (mode === 'notjson') process.stdout.write('hello');
else if (mode === 'turn') process.stdout.write(${JSON.stringify(JSON.stringify({ ...REAL, num_turns: 1 }))});
else process.stdout.write(fs.readFileSync(${JSON.stringify(path.join(here, 'fixtures', 'agy-usage', 'usage-1.5.13.json'))}, 'utf8'));
`, { mode: 0o755 });
const found = { installed: true, binary: fake };
const calls = () => { try { return fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const run = async (mode, extra = {}) => {
  fs.rmSync(LOG, { force: true });
  process.env.FAKE_AGY_MODE = mode;
  try { return await readGeminiSeat({ found, now: () => 1234, ...extra }); } finally { delete process.env.FAKE_AGY_MODE; }
};

{
  const r = await run('ok');
  ok('reads through agy', r.ok === true && r.windows.length === 2, r.reason);
  ok('records the agy version', r.agyVersion === '1.5.13', String(r.agyVersion));
  ok('stamps observedAt', r.observedAt === 1234);
  ok('vendor gemini, harness agy', r.vendor === 'gemini' && r.harness === 'agy');
  const c = calls();
  ok('two calls: --version then the pinned /usage argv', c.length === 2 && c[0].argv.join(' ') === '--version'
    && c[1].argv.join(' ') === '-p /usage --output-format json', JSON.stringify(c.map((x) => x.argv)));
  ok('each call runs in its own empty folder', c.every((x) => x.entries.length === 0) && c[0].cwd !== c[1].cwd);
  ok('the folders are removed afterwards', c.every((x) => !fs.existsSync(x.cwd)));
  ok('cmux agy hooks are switched off', c.every((x) => x.hooksOff === '1'));
  ok('the process cwd is not used', c.every((x) => path.resolve(x.cwd) !== path.resolve(process.cwd())));
}
{
  const r = await run('old');
  ok('an agy below 1.1.11 is refused', r.ok === false && /older than 1\.1\.11/.test(r.reason), r.reason);
  ok('...and /usage is never run on it', calls().length === 1);
  ok('...and its version is still recorded', r.agyVersion === '1.1.10');
}
{
  const r = await run('noversion');
  ok('an unreadable version is refused', r.ok === false && calls().length === 1, r.reason);
}
{
  const r = await run('apikey');
  ok('exit 2 → the API-key reason', r.ok === false && /API key, which has no subscription quota/.test(r.reason), r.reason);
}
{
  const r = await run('signedout');
  ok('another non-zero exit → a sign-in hint', r.ok === false && /exited 1/.test(r.reason) && /sign in/.test(r.reason), r.reason);
}
{
  const r = await run('notjson');
  ok('non-JSON → a reason', r.ok === false && /JSON/.test(r.reason), r.reason);
}
{
  const r = await run('turn');
  ok('a turn reply from the binary is refused', r.ok === false && /model turn/.test(r.reason), r.reason);
}
{
  const t0 = Date.now();
  const r = await run('hang', { timeoutMs: 800 });
  ok('a hang is cut at the deadline', r.ok === false && /did not answer/.test(r.reason) && Date.now() - t0 < 5000, r.reason);
  ok('...and its folder is removed', calls().every((x) => !fs.existsSync(x.cwd)));
}
{
  const t0 = Date.now();
  const r = await run('slowversion', { timeoutMs: 1200 });
  const took = Date.now() - t0;
  ok('one deadline covers both calls: a slow --version leaves /usage only what is left', r.ok === false && /did not answer/.test(r.reason) && took < 2000, `${took}ms ${r.reason}`);
}
{
  const r = await readGeminiSeat({ found: { installed: false } });
  ok('not installed → a reason, no spawn', r.ok === false && /not installed/.test(r.reason));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
