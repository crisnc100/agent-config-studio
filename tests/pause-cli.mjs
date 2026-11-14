/**
 * `acs pause` / `acs resume` and the one writer behind them, lib/pause.js
 * (builds/pause-account R1, R6, R9): run through bin/acs against temp HOMEs.
 * A stale installed resolver refuses a pause before anything is written.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './fixtures/cleanup.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ACS = path.join(ROOT, 'bin', 'acs');
const J = JSON.stringify;
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

const tmp = fs.realpathSync(tempDir('acs-pause-cli-'));
const write = (file, body) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body); };
let n = 0;
function home({ roles = { version: 2, roles: { reviewer: { use: ['fable', 'sol'] }, builder: { use: ['opus', 'sol'] }, advisor: { use: 'fable' } } }, snapshot } = {}) {
  const h = path.join(tmp, `home-${++n}`);
  write(path.join(h, '.agent-config-studio', 'roles.json'), J(roles));
  if (snapshot) write(path.join(h, '.agent-config-studio', 'usage-snapshot.json'), J(snapshot));
  return h;
}
const pausedFile = (h) => path.join(h, '.agent-config-studio', 'paused.json');
const readPausedFile = (h) => { try { return JSON.parse(fs.readFileSync(pausedFile(h), 'utf8')); } catch { return null; } };
const acs = (h, ...args) => {
  const r = spawnSync('/bin/sh', [ACS, ...args], { encoding: 'utf8', env: { HOME: h, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, NO_COLOR: '1', ACS_NO_UPDATE: '1', ACS_NO_OPEN: '1' } });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const HOUR = 3600_000;

console.log('\npause cli: R9 — pause, list, resume');
{
  const h = home();
  const empty = acs(h, 'pause');
  ok('acs pause with nothing paused: says so, exit 0, writes nothing', empty.code === 0 && empty.out === 'Nothing is paused.\n' && !fs.existsSync(pausedFile(h)), J(empty));

  const p = acs(h, 'pause', 'claude', '--until-resume');
  ok('acs pause claude --until-resume: exit 0, says until you resume', p.code === 0 && p.out === 'claude paused until you resume.\n', J(p));
  ok('…paused.json holds one entry with no until', J(readPausedFile(h)) === J({ version: 1, paused: [{ name: 'claude' }] }), J(readPausedFile(h)));
  const roles = fs.readFileSync(path.join(h, '.agent-config-studio', 'roles.json'), 'utf8');

  const l = acs(h, 'pause');
  ok('acs pause lists it and what each role answers now', l.code === 0 && /^claude paused until you resume$/m.test(l.out)
    && /^ {2}reviewer → sol \(skipped fable\)$/m.test(l.out) && /^ {2}builder → sol \(skipped opus\)$/m.test(l.out) && /^ {2}advisor: refuses — every model for it is paused$/m.test(l.out), l.out);
  ok('…and the same-vendor note when builder and reviewer now share one', /builder and reviewer both run on codex now, so codex checks its own work\./.test(l.out), l.out);

  const at = new Date(Date.now() + 2 * HOUR).toISOString();
  const f = acs(h, 'pause', 'fable', '--until', at);
  ok('acs pause fable --until <time>: exit 0, stored as given', f.code === 0 && J(readPausedFile(h).paused) === J([{ name: 'claude' }, { name: 'fable', until: at }]), J({ f, file: readPausedFile(h) }));

  const r = acs(h, 'resume', 'claude');
  ok('acs resume claude: exit 0, its entry gone, the other kept', r.code === 0 && r.out === 'claude resumed.\n' && J(readPausedFile(h).paused) === J([{ name: 'fable', until: at }]), J({ r, file: readPausedFile(h) }));
  ok('roles.json was never written', fs.readFileSync(path.join(h, '.agent-config-studio', 'roles.json'), 'utf8') === roles);

  const again = acs(h, 'resume', 'claude');
  ok('resuming what is not paused: exit 1, says so', again.code === 1 && /claude is not paused/.test(again.err), J(again));
  const unknown = acs(h, 'pause', 'opuss', '--until-resume');
  ok('an unknown name: exit 2, lists what can be paused', unknown.code === 2 && /"opuss" is not an account \(claude, codex, grok\) or a model family/.test(unknown.err), J(unknown));
  const past = acs(h, 'pause', 'codex', '--until', new Date(Date.now() - HOUR).toISOString());
  ok('a time already passed: exit 2, nothing written', past.code === 2 && /has already passed/.test(past.err) && !readPausedFile(h).paused.some((e) => e.name === 'codex'), J(past));
  const junk = acs(h, 'pause', 'codex', '--until', 'soonish');
  ok('a time that is not one: exit 2', junk.code === 2 && /is not a date and time/.test(junk.err), J(junk));
  const usage = acs(h, 'pause', 'codex', '--bogus');
  ok('an unknown flag: exit 2 with the usage line', usage.code === 2 && /usage: acs pause/.test(usage.err), J(usage));
}

console.log('\npause cli: with no flag, a pause ends at the account\'s reset when a reading has one');
{
  const reset = Date.now() + 3 * HOUR;
  const h = home({ snapshot: { takenAt: Date.now(), seats: [
    { seatId: 'c1', vendor: 'claude', ok: true, windows: [{ label: '5h', usedPercent: 40, resetsAt: Date.now() + HOUR }, { label: 'week', usedPercent: 97, resetsAt: reset }] },
    { seatId: 'x1', vendor: 'codex', ok: true, windows: [{ label: 'week', usedPercent: 99, resetsAt: Date.now() + 9 * HOUR }] },
  ] } });
  const p = acs(h, 'pause', 'claude');
  ok('acs pause claude: until the tightest claude window resets', p.code === 0 && readPausedFile(h).paused[0].until === new Date(reset).toISOString(), J({ p, file: readPausedFile(h) }));
  const fam = acs(h, 'pause', 'opus');
  ok('a family takes its vendor\'s reset', fam.code === 0 && readPausedFile(h).paused[1].until === new Date(reset).toISOString(), J(readPausedFile(h)));
  const g = acs(h, 'pause', 'grok');
  ok('no reading for that vendor: until you resume, and it says how to end it', g.code === 0 && !('until' in readPausedFile(h).paused[2]) && /run acs resume when it has room again/.test(g.out), J(g));
}

console.log('\npause cli: an invalid paused.json is reported, never rewritten');
{
  const h = home();
  write(pausedFile(h), '{ nope');
  const l = acs(h, 'pause');
  ok('acs pause: exit 1, names the file and that nothing is paused', l.code === 1 && /paused\.json: not valid JSON/.test(l.err) && /Nothing is paused until it is fixed or deleted/.test(l.err), J(l));
  const p = acs(h, 'pause', 'claude', '--until-resume');
  ok('pausing refuses, and the file keeps its bytes', p.code === 1 && /paused\.json is invalid/.test(p.err) && fs.readFileSync(pausedFile(h), 'utf8') === '{ nope', J(p));
}

console.log('\npause cli: R6 — a stale installed resolver refuses the pause');
{
  const h = home();
  const installed = path.join(h, '.agent-config-studio', 'resolver', 'lib', 'roles.js');
  write(installed, '// an older roles.js, from before paused.json\n');
  const p = acs(h, 'pause', 'claude', '--until-resume');
  ok('refused, with the re-install fix', p.code === 1 && p.err.includes('Your installed model-id is older than this version of ACS and would ignore a pause. Run: acs install-model-id, then pause again.'), J(p));
  ok('…and nothing is written', !fs.existsSync(pausedFile(h)));
  fs.copyFileSync(path.join(ROOT, 'lib', 'roles.js'), installed);
  const same = acs(h, 'pause', 'claude', '--until-resume');
  ok('an installed copy identical to this one: the pause goes through', same.code === 0 && readPausedFile(h)?.paused?.[0]?.name === 'claude', J(same));
  write(installed, '// stale again\n');
  const r = acs(h, 'resume', 'claude');
  ok('resuming is never refused for a stale resolver (an old one ignores pauses anyway)', r.code === 0 && J(readPausedFile(h).paused) === '[]', J(r));
}

console.log('\npause cli: two writers at once — neither change is lost');
{
  const { pause, resume, _setBeforeRename } = await import('../lib/pause.js');
  const h = home();
  // A second writer (a real acs process) lands between this writer's read and its rename.
  const other = (...args) => _setBeforeRename(() => { _setBeforeRename(null); const r = acs(h, ...args); if (r.code !== 0) throw new Error(J(r)); });
  other('pause', 'codex', '--until-resume');
  pause({ name: 'claude', until: null, home: h });
  ok('a pause racing another pause: both are kept', J(readPausedFile(h).paused.map((e) => e.name).sort()) === J(['claude', 'codex']), J(readPausedFile(h)));
  other('resume', 'codex');
  pause({ name: 'grok', until: null, home: h });
  ok('a pause racing a resume: the resume holds, the pause is added', J(readPausedFile(h).paused.map((e) => e.name).sort()) === J(['claude', 'grok']), J(readPausedFile(h)));
  other('pause', 'sol', '--until-resume');
  resume({ name: 'claude', home: h });
  ok('a resume racing a pause: the pause is kept, the resume holds', J(readPausedFile(h).paused.map((e) => e.name).sort()) === J(['grok', 'sol']), J(readPausedFile(h)));
  let n = 0;
  _setBeforeRename(() => { n++; fs.appendFileSync(pausedFile(h), ' '); });
  let err = null;
  try { pause({ name: 'codex', until: null, home: h }); } catch (e) { err = e; }
  _setBeforeRename(null);
  ok('a file that keeps changing under every try: refused with 409, never overwritten', err?.status === 409 && /changed while it was being saved/.test(err.message) && n === 3 && !readPausedFile(h)?.paused?.some?.((e) => e.name === 'codex'), J({ err: err?.message, n }));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
