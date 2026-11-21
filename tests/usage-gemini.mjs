/** Gemini quota reader (agy /usage). A fake agy in a temp dir; never the real one. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { shapeUsage, shapeModels, readGeminiSeat, readGeminiModels, parseVersion, versionAtLeast } from '../lib/usage/gemini.js';
import { vendorOf } from '../lib/models.js';
import { tempDir } from './fixtures/cleanup.mjs';
import { vendorReset } from '../lib/pause.js';

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n}${d ? ` — ${d}` : ''}`); } };

const here = path.dirname(fileURLToPath(import.meta.url));
const REAL = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'agy-usage', 'usage-1.5.13.json'), 'utf8'));
const clone = () => JSON.parse(JSON.stringify(REAL));
const MODELS = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'agy-models', 'models-1.5.13.json'), 'utf8'));
const cloneModels = () => JSON.parse(JSON.stringify(MODELS));
const nonGemini = () => { const j = cloneModels(); j.command.data.models = j.command.data.models.filter((m) => !m.id.startsWith('gemini-')); return j; };

console.log('\nusage/gemini');

// --- shaping the real reply ---------------------------------------------------
{
  const r = shapeUsage(clone());
  ok('the real reply reads', r.ok === true, r.reason);
  ok('windows are the Gemini Models pool only: 5h and weekly', r.windows.length === 2
    && r.windows[0].windowMinutes === 300 && r.windows[1].windowMinutes === 10080, JSON.stringify(r.windows));
  ok('remaining 0.9283… → 7.17% used, exactly (1 − fraction) × 100', Math.abs(r.windows[1].usedPercent - (1 - 0.9283005595207214) * 100) < 1e-9
     && Math.round(r.windows[1].usedPercent * 10) / 10 === 7.2, String(r.windows[1].usedPercent));
  ok('remaining 0.9429… → 5.71% used, exactly (1 − fraction) × 100', Math.abs(r.windows[0].usedPercent - (1 - 0.9429367184638977) * 100) < 1e-9
     && Math.round(r.windows[0].usedPercent * 10) / 10 === 5.7, String(r.windows[0].usedPercent));
  ok('reset is epoch ms', r.windows[1].resetsAt === Date.parse('2026-11-27T15:07:18Z'));
  ok('labels', r.windows[0].label === '5-hour' && r.windows[1].label === 'Weekly');
  ok('Argon weekly rides separately', r.extraWindows.length === 1 && r.extraWindows[0].usedPercent === 0
    && r.extraWindows[0].windowMinutes === 10080 && /Argon/.test(r.extraWindows[0].label), JSON.stringify(r.extraWindows));
  ok('the Claude and GPT group is not read', !JSON.stringify(r).includes('2026-11-21T03:32:38')
    && ![...r.windows, ...r.extraWindows].some((w) => w.resetsAt === Date.parse('2026-11-21T03:32:38Z')));
}

// --- Argon is found by family name, whatever version agy puts in it ----------------
{
  const r = shapeUsage(clone());
  ok('the Argon line is labelled without a model version', r.extraWindows[0]?.label === 'Argon weekly', JSON.stringify(r.extraWindows));
  const later = clone();
  later.command.data.groups.find((g) => /Argon/.test(g.name)).name = 'Gemini 5 Argon';
  later.command.data.groups.find((g) => /Argon/.test(g.name)).buckets[0].remaining_fraction = 0.6;
  const rl = shapeUsage(later);
  ok('...so a renamed Argon group still reads', rl.extraWindows.length === 1 && Math.round(rl.extraWindows[0].usedPercent) === 40, JSON.stringify(rl.extraWindows));
  const none = clone();
  none.command.data.groups = none.command.data.groups.filter((g) => !/Argon/.test(g.name));
  ok('...and no Argon group means no Argon line', shapeUsage(none).extraWindows.length === 0);
}

// --- Pause's reset choice sees the real difference ----------------------------
{
  // 7.048% and 7.042% used both round to 7.0; the weekly window is still the tighter one.
  const near = clone();
  const [weekly, fiveH] = near.command.data.groups[0].buckets;
  weekly.remaining_fraction = 0.92952; fiveH.remaining_fraction = 0.92958;
  weekly.reset_time = new Date(Date.now() + 100 * 3600_000).toISOString();
  fiveH.reset_time = new Date(Date.now() + 3 * 3600_000).toISOString();
  const r = shapeUsage(near);
  ok('usedPercent is stored unrounded', r.windows.every((w) => !Number.isInteger(w.usedPercent * 10)), JSON.stringify(r.windows.map((w) => w.usedPercent)));
  ok('Pause times from the tighter window even when both round alike',
     vendorReset([{ vendor: 'gemini', ok: true, windows: r.windows }], 'gemini') === Date.parse(weekly.reset_time));
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

// --- shaping the real models reply --------------------------------------------
console.log('\nusage/gemini: models');
{
  const r = shapeModels(cloneModels());
  const ids = r.models?.map((m) => m.id) ?? [];
  ok('the real models reply reads', r.ok === true, r.reason);
  ok('one entry per base model: the 16 Gemini ids are 6 models', JSON.stringify([...ids].sort()) === JSON.stringify([
    'gemini-3.8-flash', 'gemini-4-argon', 'gemini-4-hydrogen', 'gemini-4-neon', 'gemini-pro-orchestrator-g1-pro', 'gemini-pro-orchestrator-neon',
  ]), JSON.stringify(ids));
  ok('no Claude or GPT id survives', ids.every((id) => vendorOf(id) === 'agy') && !JSON.stringify(r).match(/claude-|gpt-|Claude|GPT/), JSON.stringify(ids));
  const neon = r.models.find((m) => m.id === 'gemini-4-neon');
  ok('neon keeps its name without the effort', neon?.displayName === 'Gemini 4 Neon', JSON.stringify(neon));
  ok('neon\'s efforts, in effort order whatever order agy lists them in', JSON.stringify(neon?.efforts) === JSON.stringify(['low', 'medium', 'high', 'xhigh']), JSON.stringify(neon));
  const orch = r.models.find((m) => m.id === 'gemini-pro-orchestrator-neon');
  ok('an orchestrator is kept whole: its label is not an effort', orch?.displayName === 'Orchestrator (Neon)' && orch.efforts.length === 0, JSON.stringify(orch));
  ok('entries carry only id, displayName and efforts', r.models.every((m) => JSON.stringify(Object.keys(m)) === '["id","displayName","efforts"]'));
}
{
  const j = cloneModels();
  j.command.data.models = [
    { id: 'gemini-9-test-high', label: 'Test (Preview)' },
    { id: 'gemini-high', label: 'Bare (High)' },
    { id: 'Gemini-9-Upper', label: 'Upper' },
    { id: 'gemini-9 spaced', label: 'Spaced' },
    { id: 42, label: 'Number' },
    { label: 'No id' },
    null,
  ];
  const r = shapeModels(j);
  ok('a parenthesis that is not the id\'s effort stays in the name', r.models?.[0]?.displayName === 'Test (Preview)' && r.models[0].efforts.join() === 'high', JSON.stringify(r));
  ok('ids that are no Gemini model id are dropped', r.models?.length === 1, JSON.stringify(r.models));
}
{
  const j = cloneModels();
  j.command.data.models = Array.from({ length: 300 }, (_, i) => ({ id: `gemini-${i}-m`, label: `M${i}` }));
  ok('the list is capped', shapeModels(j).models?.length === 200);
}
{
  const turned = cloneModels(); turned.num_turns = 1;
  ok('a models reply that ran a turn is refused', shapeModels(turned).ok === false && /model turn/.test(shapeModels(turned).reason));
  const noTurns = cloneModels(); delete noTurns.num_turns;
  ok('a models reply that does not say zero turns is refused', shapeModels(noTurns).ok === false);
  const other = cloneModels(); other.command.name = 'model';
  ok('another command (/model) is refused', shapeModels(other).ok === false);
  const prompt = cloneModels(); delete prompt.command;
  ok('a prompt answer (no command) is refused', shapeModels(prompt).ok === false);
  const noList = cloneModels(); noList.command.data.models = {};
  ok('no model list is refused', shapeModels(noList).ok === false && /no model list/.test(shapeModels(noList).reason));
  ok('a list with no Gemini model is refused, not an empty catalog', shapeModels(nonGemini()).ok === false && /no Gemini models/.test(shapeModels(nonGemini()).reason));
  ok('null is refused', shapeModels(null).ok === false);
}

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
else if (process.argv[2] === '--version') { process.stdout.write(mode === 'old' ? '1.1.10\\n' : mode === 'v1111' ? '1.1.11\\n' : mode === 'noversion' ? 'agy\\n' : '1.5.13\\n'); process.exit(0); }
else if (mode === 'apikey') process.exit(2);
else if (mode === 'signedout') process.exit(1);
else if (mode === 'hang' || mode === 'slowversion') setTimeout(() => {}, 60000);
else if (mode === 'notjson') process.stdout.write('hello');
else if (process.argv[4] === 'models' && mode === 'turn') process.stdout.write(${JSON.stringify(JSON.stringify({ ...MODELS, num_turns: 1 }))});
else if (process.argv[4] === 'models' && mode === 'failed') process.stdout.write(${JSON.stringify(JSON.stringify({ ...MODELS, status: 'ERROR' }))});
else if (process.argv[4] === 'models' && mode === 'nogemini') process.stdout.write(${JSON.stringify(JSON.stringify(nonGemini()))});
else if (process.argv[4] === 'models') process.stdout.write(${JSON.stringify(JSON.stringify(MODELS))});
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

// --- the models spawn, against the same fake agy ---------------------------------
const runModels = async (mode, extra = {}) => {
  fs.rmSync(LOG, { force: true });
  process.env.FAKE_AGY_MODE = mode;
  try { return await readGeminiModels({ found, ...extra }); } finally { delete process.env.FAKE_AGY_MODE; }
};
{
  const r = await runModels('ok');
  ok('models read through agy', r.ok === true && r.models.length === 6, r.reason);
  ok('models record the agy version', r.agyVersion === '1.5.13', String(r.agyVersion));
  const c = calls();
  ok('two calls: --version then the pinned models argv', c.length === 2 && c[0].argv.join(' ') === '--version'
    && c[1].argv.join(' ') === '--output-format json models', JSON.stringify(c.map((x) => x.argv)));
  ok('each models call runs in its own empty folder, removed afterwards', c.every((x) => x.entries.length === 0 && !fs.existsSync(x.cwd)) && c[0].cwd !== c[1].cwd);
  ok('cmux agy hooks are off for the models call', c.every((x) => x.hooksOff === '1'));
}
{
  const r = await runModels('v1111');
  ok('agy 1.1.11 is refused for models (JSON from 1.1.12)', r.ok === false && /older than 1\.1\.12/.test(r.reason), r.reason);
  ok('...and models is never run on it', calls().length === 1);
  ok('...and its version is still recorded', r.agyVersion === '1.1.11');
  const seat = await run('v1111');
  ok('...while /usage still reads on 1.1.11', seat.ok === true, seat.reason);
}
{
  const r = await runModels('old');
  ok('an agy below 1.1.11 is refused for models too', r.ok === false && /older than 1\.1\.12/.test(r.reason) && calls().length === 1, r.reason);
}
{
  const r = await runModels('noversion');
  ok('an unreadable version is refused for models', r.ok === false && calls().length === 1, r.reason);
}
{
  const r = await runModels('signedout');
  ok('models exit 1 → a sign-in hint', r.ok === false && /models exited 1/.test(r.reason) && /sign in/.test(r.reason), r.reason);
}
{
  const r = await runModels('notjson');
  ok('models non-JSON → a reason', r.ok === false && /models did not print JSON/.test(r.reason), r.reason);
}
{
  const r = await runModels('turn');
  ok('a models reply that ran a turn is refused from the binary', r.ok === false && /model turn/.test(r.reason), r.reason);
}
{
  const r = await runModels('failed');
  ok('a models reply with a failed status is refused', r.ok === false && /models reported ERROR/.test(r.reason), r.reason);
}
{
  const r = await runModels('nogemini');
  ok('a models reply with no Gemini model is refused', r.ok === false && /no Gemini models/.test(r.reason), r.reason);
}
{
  const t0 = Date.now();
  const r = await runModels('hang', { timeoutMs: 800 });
  ok('a hanging models call is cut at the deadline', r.ok === false && /did not answer/.test(r.reason) && Date.now() - t0 < 5000, r.reason);
  ok('...and its folder is removed', calls().every((x) => !fs.existsSync(x.cwd)));
}
{
  const r = await readGeminiModels({ found: { installed: false } });
  ok('models: not installed → a reason, no spawn', r.ok === false && /not installed/.test(r.reason) && r.models.length === 0);
}

// --- the refresh worker finds the agy Setup found --------------------------------
{
  // Setup looks in the login shell's PATH (lib/login-path.js); the refresh worker is another process. The fake agy
  // sits only in a "login" directory: not on PATH, not in HOME. The variable is removed after import, so the worker
  // can only learn the directory from refresh.js handing loginDirs() on.
  const sandbox = tempDir('acs-gemini-refresh-');
  const loginBin = path.join(sandbox, 'login-bin');
  const fakeHome = path.join(sandbox, 'home');
  fs.mkdirSync(loginBin, { recursive: true });
  fs.mkdirSync(path.join(fakeHome, '.agent-config-studio'), { recursive: true });
  fs.copyFileSync(fake, path.join(loginBin, 'agy'));
  fs.chmodSync(path.join(loginBin, 'agy'), 0o755);
  fs.writeFileSync(path.join(fakeHome, '.agent-config-studio', 'seats.json'),
    JSON.stringify({ version: 1, seats: [{ id: 'gemini', vendor: 'gemini', harness: 'agy', label: 'Gemini' }] }));
  const root = path.join(here, '..');
  const script = `
    const { refreshSnapshot } = await import(${JSON.stringify(path.join(root, 'lib', 'usage', 'refresh.js'))});
    delete process.env.ACS_LOGIN_PATH_DIRS;
    const r = await refreshSnapshot({ timeoutMs: 25000 });
    const g = r.seats.find((s) => s.seatId === 'gemini');
    console.log(JSON.stringify({ fresh: r.fresh, ok: g?.ok, reason: g?.reason, version: g?.agyVersion }));`;
  const { spawnSync } = await import('node:child_process');
  const out = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', timeout: 60_000,
    env: { HOME: fakeHome, PATH: '/usr/bin:/bin', ACS_LOGIN_PATH_DIRS: loginBin, FAKE_AGY_MODE: 'ok' },
  });
  let res = null;
  try { res = JSON.parse(out.stdout.trim().split('\n').pop()); } catch {}
  ok('the refresh worker reads Gemini through the agy found in the login PATH', res?.fresh === true && res.ok === true && res.version === '1.5.13',
     `${out.stdout.slice(-300)} ${out.stderr.slice(-300)}`);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
