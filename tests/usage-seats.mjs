/** Seat registry. Entirely offline; the registry under test lives in a temp dir. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  VENDORS, slugify, validateSeat, loadSeats, saveSeats, addSeat, removeSeat,
  detectSeats, readSeat, snapshot, createSeat, createCodexHome, uniqueSeatId, seatHomeRoot,
  shellQuote,
} from '../lib/usage/seats.js';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acs-seats-'));
const reg = () => path.join(fs.mkdtempSync(path.join(tmp, 'r-')), 'seats.json');
const codexSeat = (id, home) => ({ id, vendor: 'codex', label: id, home: home || path.join(tmp, id) });

console.log('\nusage/seats');

// --- slugs & validation ------------------------------------------------------
ok('slugify normalises', slugify('Codex — Work Account!') === 'codex-work-account', slugify('Codex — Work Account!'));
ok('slugify falls back rather than returning empty', slugify('!!!') === 'seat');
ok('valid seat validates', validateSeat({ id: 'codex-1', vendor: 'codex', label: 'A', home: '/x' }).length === 0);
ok('unknown vendor rejected', validateSeat({ id: 'a', vendor: 'openai', label: 'A' }).some((p) => /vendor/.test(p)));
ok('bad id rejected', validateSeat({ id: 'Bad Id', vendor: 'claude', label: 'A' }).some((p) => /id must/.test(p)));
ok('missing label rejected', validateSeat({ id: 'a', vendor: 'claude' }).some((p) => /label/.test(p)));
ok('codex seat without a home rejected',
   validateSeat({ id: 'a', vendor: 'codex', label: 'A' }).some((p) => /needs a home/.test(p)));
ok('claude seat needs no home', validateSeat({ id: 'a', vendor: 'claude', label: 'A' }).length === 0);
ok('duplicate id rejected',
   validateSeat({ id: 'a', vendor: 'claude', label: 'A' }, [{ id: 'a', vendor: 'claude', label: 'A' }])
     .some((p) => /already registered/.test(p)));

// Two codex seats sharing a home are one seat counted twice — the failure would
// be silent double-reporting of the same subscription as two.
ok('two codex seats cannot share a home',
   validateSeat(codexSeat('codex-2', '/same'), [codexSeat('codex-1', '/same')])
     .some((p) => /already used/.test(p)));
ok('the same path written differently still collides',
   validateSeat(codexSeat('codex-2', '/a/b/../b'), [codexSeat('codex-1', '/a/b')])
     .some((p) => /already used/.test(p)));

// --- persistence -------------------------------------------------------------
{
  const f = reg();
  const empty = loadSeats(f);
  ok('a missing registry is empty, not an error', empty.seats.length === 0 && empty.exists === false);
  ok('zero seats is a legal state', Array.isArray(empty.seats));

  addSeat({ id: 'claude-1', vendor: 'claude', label: 'Claude Max' }, f);
  addSeat(codexSeat('codex-1'), f);
  addSeat(codexSeat('codex-2'), f);
  const r = loadSeats(f);
  ok('three seats persist', r.seats.length === 3, String(r.seats.length));
  ok('two codex seats coexist', r.seats.filter((s) => s.vendor === 'codex').length === 2);
  ok('order is preserved', r.seats[0].id === 'claude-1' && r.seats[2].id === 'codex-2');
  ok('registry is written 0600', (fs.statSync(f).mode & 0o777) === 0o600, (fs.statSync(f).mode & 0o777).toString(8));

  let threw = null;
  try { addSeat(codexSeat('codex-1'), f); } catch (e) { threw = e; }
  ok('adding a duplicate throws rather than corrupting', threw !== null && /already/.test(threw.message));
  ok('the failed add did not change the registry', loadSeats(f).seats.length === 3);

  removeSeat('codex-2', f);
  ok('remove works', loadSeats(f).seats.length === 2 && !loadSeats(f).seats.some((s) => s.id === 'codex-2'));
  let t2 = null;
  try { removeSeat('nope', f); } catch (e) { t2 = e; }
  ok('removing an unknown id throws', t2 !== null);

  // The temp+rename write means an interrupted save cannot truncate the file.
  ok('no temp files left behind',
     fs.readdirSync(path.dirname(f)).filter((n) => n.includes('.tmp-')).length === 0);
}
{
  const f = reg();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, '{ not json');
  ok('a corrupt registry reads as empty, does not throw', loadSeats(f).seats.length === 0);
  const f2 = reg();
  fs.writeFileSync(f2, JSON.stringify({ seats: [{ id: 'ok-1', vendor: 'claude', label: 'A' }, { junk: true }] }));
  ok('invalid entries are dropped, valid ones kept', loadSeats(f2).seats.length === 1);
}

// --- detection is a suggestion ----------------------------------------------
{
  const home = path.join(tmp, 'fakehome');
  fs.mkdirSync(path.join(home, '.codex', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const d = detectSeats({ home, env: {} });
  ok('detects a codex and a claude seat', d.length === 2 && d.some((s) => s.vendor === 'codex'));
  ok('detected codex seat carries its home', d.find((s) => s.vendor === 'codex').home === path.join(home, '.codex'));
  ok('grok is never suggested — it has no usage ledger', !d.some((s) => s.vendor === 'grok'));
  ok('detection does not write a registry', !fs.existsSync(registryPathIn(home)));
  const bare = detectSeats({ home: path.join(tmp, 'nothing-here'), env: {} });
  ok('a bare machine detects nothing rather than guessing', bare.length === 0);
}
function registryPathIn(h) { return path.join(h, '.agent-config-studio', 'seats.json'); }

// --- reading -----------------------------------------------------------------
{
  const r = await readSeat({ id: 'g', vendor: 'grok', label: 'Grok' });
  ok('grok seat reports honestly, never a fake zero',
     r.ok === false && /no local usage ledger/.test(r.reason) && r.windows.length === 0, r.reason);
  const u = await readSeat({ id: 'u', vendor: 'mystery', label: 'X' });
  ok('unknown vendor reports rather than throwing', u.ok === false && /unknown vendor/.test(u.reason));
  ok('every reading is stamped with its seat', r.seatId === 'g' && r.label === 'Grok');
}

// --- snapshot ----------------------------------------------------------------
{
  const home = path.join(tmp, 'snaphome', '.codex');
  const day = path.join(home, 'sessions', '2026', '09', '07');
  fs.mkdirSync(day, { recursive: true });
  fs.writeFileSync(path.join(day, 'rollout-2026-09-07T10-00-00-a.jsonl'),
    JSON.stringify({ info: { rate_limits: { primary: { used_percent: 33, window_minutes: 10080, resets_at: 1789047414 } } } }) + '\n');

  const seats = [codexSeat('codex-1', home), { id: 'grok-1', vendor: 'grok', label: 'Grok' }];
  const snap = await snapshot({ seats });
  ok('snapshot covers every seat', snap.seats.length === 2);
  ok('snapshot is stamped', typeof snap.takenAt === 'number');
  const cx = snap.seats.find((s) => s.seatId === 'codex-1');
  ok('a working seat reports its window', cx.ok === true && cx.windows[0].usedPercent === 33, cx.reason || '');
  ok('a seat with no data does not break the snapshot',
     snap.seats.find((s) => s.seatId === 'grok-1').ok === false);

  // The failure that matters: a dead Claude endpoint must not hide Codex.
  const withThrower = await snapshot({
    seats: [...seats, { id: 'boom', vendor: 'claude', label: 'Claude' }],
    fetchImpl: async () => { throw new Error('network down'); },
  });
  ok('one failing reader never fails the snapshot', withThrower.seats.length === 3);
  ok('the healthy seat still reports through another seat failing',
     withThrower.seats.find((s) => s.seatId === 'codex-1').ok === true);
  ok('the failing seat carries its reason',
     withThrower.seats.find((s) => s.seatId === 'boom').ok === false);

  ok('an empty registry snapshots to zero seats, not an error', (await snapshot({ seats: [] })).seats.length === 0);
}

ok('vendor list is the three harnesses', VENDORS.join(',') === 'claude,codex,grok');

// --- creating seats from the UI ---------------------------------------------
{
  const home = path.join(tmp, 'createhome');
  const primary = path.join(home, '.codex');
  fs.mkdirSync(path.join(primary, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(primary, 'config.toml'), 'model = "x"\n');
  fs.writeFileSync(path.join(primary, 'AGENTS.md'), '# agents\n');
  const f = reg();

  // The first codex seat adopts ~/.codex rather than demanding a second login
  // the user does not need.
  const first = createSeat({ vendor: 'codex', label: 'Codex (main)', file: f, home });
  ok('first codex seat adopts the existing home', first.adopted === true && first.seat.home === primary, first.seat.home);
  ok('adopting asks for no login', first.loginCommand === null);

  const second = createSeat({ vendor: 'codex', label: 'Codex (work)', file: f, home });
  ok('second codex seat gets its own home',
     second.seat.home === path.join(seatHomeRoot(home), 'codex-work'), second.seat.home);
  ok('second seat comes back with its login command', /codex login$/.test(second.loginCommand || ''));
  ok('config is shared by symlink, not copied',
     second.linked.includes('config.toml') && fs.lstatSync(path.join(second.seat.home, 'config.toml')).isSymbolicLink());
  ok('the symlink resolves to the primary config',
     fs.readFileSync(path.join(second.seat.home, 'config.toml'), 'utf8') === 'model = "x"\n');
  // auth.json and sessions are what make it a separate seat.
  ok('auth.json is NOT shared', !fs.existsSync(path.join(second.seat.home, 'auth.json')));
  ok('sessions are NOT shared', !fs.existsSync(path.join(second.seat.home, 'sessions')));

  const both = loadSeats(f).seats;
  ok('both codex seats are registered with different homes',
     both.length === 2 && both[0].home !== both[1].home);

  // A caller-supplied path must never become a directory-creation primitive.
  const sneaky = createSeat({ vendor: 'codex', label: '../../escape', file: f, home });
  ok('a traversal label cannot escape the seat root',
     sneaky.seat.home.startsWith(seatHomeRoot(home)) && !sneaky.seat.home.includes('..'), sneaky.seat.home);

  let threw = null;
  try { createSeat({ vendor: 'evil', label: 'x', file: f, home }); } catch (e) { threw = e; }
  ok('an unknown vendor is refused', threw !== null && /vendor must be/.test(threw.message));
  threw = null;
  try { createSeat({ vendor: 'grok', label: '   ', file: f, home }); } catch (e) { threw = e; }
  ok('a blank label is refused', threw !== null && /label is required/.test(threw.message));

  const g = createSeat({ vendor: 'grok', label: 'Grok', file: f, home });
  ok('a grok seat registers but says it can never report',
     g.seat.vendor === 'grok' && /never|not connected/.test(g.note || ''), g.note);

  const long = createSeat({ vendor: 'grok', label: 'x'.repeat(200), file: f, home });
  ok('an overlong label is truncated, not stored whole', long.seat.label.length <= 60);

  ok('ids never collide', uniqueSeatId('codex-work', f) !== 'codex-work');
}

// --- a removed seat must be addable again -----------------------------------
{
  const home = path.join(tmp, 'readd');
  const primary = path.join(home, '.codex');
  fs.mkdirSync(path.join(primary, 'sessions'), { recursive: true });
  const f = reg();

  createSeat({ vendor: 'codex', label: 'Main', file: f, home });          // adopts ~/.codex
  const extra = createSeat({ vendor: 'codex', label: 'Work', file: f, home });
  const dir = extra.seat.home;
  removeSeat(extra.seat.id, f);
  // Removal preserves the home on purpose — it holds a real login.
  ok('the removed seat home is preserved', fs.existsSync(dir));

  // The bug: uniqueSeatId considered only the registry, handed back the same
  // id, and createCodexHome threw because the directory was still there — so a
  // removed seat could never be added again under its own name.
  let threw = null, again = null;
  try { again = createSeat({ vendor: 'codex', label: 'Work', file: f, home }); } catch (e) { threw = e; }
  ok('the same label can be added again after removal', threw === null, threw?.message);
  ok('it gets a fresh home rather than colliding', again && again.seat.home !== dir, again?.seat?.home);
  ok('the preserved login is left untouched', fs.existsSync(dir));
}

// --- shell quoting ----------------------------------------------------------
{
  // A home under "/Users/Alex Smith" split on the space, so the command handed
  // to the user could not run.
  ok('a path with a space is quoted', shellQuote('/Users/Alex Smith/.codex') === `'/Users/Alex Smith/.codex'`);
  ok("a path with a quote is escaped", shellQuote("/tmp/o'brien").includes(`'\\''`), shellQuote("/tmp/o'brien"));

  const home = path.join(tmp, 'Alex Smith');
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  const f = reg();
  const r = createCodexHome({ label: 'Spaced', file: f, home });
  ok('the generated login command quotes the home',
     /CODEX_HOME='[^']*Alex Smith[^']*' codex login/.test(r.loginCommand), r.loginCommand);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
