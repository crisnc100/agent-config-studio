/** Seat registry. Entirely offline; the registry under test lives in a temp dir. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  VENDORS, slugify, validateSeat, loadSeats, saveSeats, addSeat, removeSeat,
  detectSeats, readSeat, snapshot, createSeat, createCodexHome, uniqueSeatId, seatHomeRoot,
  shellQuote, renderSnapshot, writeSnapshot, snapshotPath, snapshot as takeSnapshot,
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
  ok('grok is not suggested without a sessions dir', !d.some((x) => x.vendor === 'grok'));

  fs.mkdirSync(path.join(home, '.grok', 'sessions'), { recursive: true });
  const withGrok = detectSeats({ home, env: {} });
  ok('grok IS suggested once it has sessions', withGrok.some((x) => x.vendor === 'grok'),
     JSON.stringify(withGrok.map((x) => x.vendor)));
  ok('the suggested grok seat carries its home',
     withGrok.find((x) => x.vendor === 'grok')?.home === path.join(home, '.grok'));
  ok('detection does not write a registry', !fs.existsSync(registryPathIn(home)));
  const bare = detectSeats({ home: path.join(tmp, 'nothing-here'), env: {} });
  ok('a bare machine detects nothing rather than guessing', bare.length === 0);
}
function registryPathIn(h) { return path.join(h, '.agent-config-studio', 'seats.json'); }

// --- reading -----------------------------------------------------------------
{
  // An explicit empty home: without one this reads the real ~/.grok and its
  // live quota, making the result depend on the machine running the tests.
  const bare = path.join(tmp, 'grok-bare');
  fs.mkdirSync(path.join(bare, 'sessions'), { recursive: true });
  const r = await readSeat({ id: 'g', vendor: 'grok', label: 'Grok', home: bare });
  // A seat that is not signed in cannot have a quota, so it must not rank.
  ok('a signed-out grok seat never claims headroom',
     r.ok === false && r.windows.length === 0, r.reason);
  ok('...and says to sign in rather than reading as broken',
     /not signed in/.test(r.reason), r.reason);
  const u = await readSeat({ id: 'u', vendor: 'mystery', label: 'X' });
  ok('unknown vendor reports rather than throwing', u.ok === false && /unknown vendor/.test(u.reason));
  ok('every reading is stamped with its seat', r.seatId === 'g' && r.label === 'Grok');
}

// --- snapshot ----------------------------------------------------------------
{
  const home = path.join(tmp, 'snaphome', '.codex');
  const day = path.join(home, 'sessions', '2026', '09', '07');
  fs.mkdirSync(day, { recursive: true });
  // This seat exists to be a WORKING one, so its window has to still be open.
  // Derived from the clock rather than hardcoded: a fixed resets_at silently
  // turns this into an expired-window test the day real time passes it.
  const openWindow = Math.floor(Date.now() / 1000) + 7 * 86400;
  fs.writeFileSync(path.join(day, 'rollout-2026-09-07T10-00-00-a.jsonl'),
    JSON.stringify({ info: { rate_limits: { primary: { used_percent: 33, window_minutes: 10080, resets_at: openWindow } } } }) + '\n');

  const grokBare = path.join(tmp, 'grok-snap');
  fs.mkdirSync(path.join(grokBare, 'sessions'), { recursive: true });
  const seats = [codexSeat('codex-1', home), { id: 'grok-1', vendor: 'grok', label: 'Grok', home: grokBare }];
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
  ok('a grok seat registers with a note pointing at the login it needs',
     g.seat.vendor === 'grok' && /grok login/.test(g.note || ''), g.note);

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

// --- a reused id must not inherit the old seat's reading --------------------
{
  // Ids come from the label, so removing Claude "Work" and adding Grok "Work"
  // reuses the id. Matching a cached reading by id alone rendered the old
  // Claude quota under the new Grok seat.
  const dir = fs.mkdtempSync(path.join(tmp, 'snapmatch-'));
  const f = path.join(dir, 'seats.json');
  const snapFile = path.join(dir, 'usage-snapshot.json');
  saveSeats([{ id: 'work', vendor: 'grok', label: 'Work', home: path.join(dir, 'grokhome') }], f);
  fs.mkdirSync(path.join(dir, 'grokhome', 'sessions'), { recursive: true });
  writeSnapshot({ takenAt: Date.now(), seats: [
    { seatId: 'work', vendor: 'claude', label: 'Work', ok: true,
      windows: [{ label: 'Weekly (all models)', usedPercent: 77 }] },
  ] }, snapFile);

  const out = await renderSnapshot({ file: f, snapshotFile: snapFile });
  const work = out.seats.find((x) => x.seatId === 'work');
  ok('a reused id does not inherit the previous vendor\'s reading',
     work.vendor === 'grok' && work.windows.every((w) => w.usedPercent !== 77),
     JSON.stringify(work.windows));
  ok('...and the mismatched seat reports rather than showing stale data', work.ok === false);
}
{
  // Removal should also drop the stored reading outright.
  const dir = fs.mkdtempSync(path.join(tmp, 'snapdrop-'));
  const f = path.join(dir, 'seats.json');
  const snapFile = path.join(dir, 'usage-snapshot.json');
  saveSeats([{ id: 'gone', vendor: 'claude', label: 'Gone' }], f);
  writeSnapshot({ takenAt: Date.now(), seats: [{ seatId: 'gone', vendor: 'claude', ok: true, windows: [] }] }, snapFile);
  removeSeat('gone', f, snapFile);
  const after = JSON.parse(fs.readFileSync(snapFile, 'utf8'));
  ok('removing a seat drops its stored reading', !after.seats.some((x) => x.seatId === 'gone'));
}

// --- one Claude account, one Claude seat ------------------------------------
{
  // Every Claude seat resolves the same default credential, so a second one
  // would show the first account's quota under a different label.
  const dir = fs.mkdtempSync(path.join(tmp, 'claudedup-'));
  const f = path.join(dir, 'seats.json');
  createSeat({ vendor: 'claude', label: 'Personal', file: f, home: dir });
  let threw = null;
  try { createSeat({ vendor: 'claude', label: 'Work', file: f, home: dir }); } catch (e) { threw = e; }
  ok('a second credential-less Claude seat is refused', threw !== null && /already tracked/.test(threw.message),
     threw?.message);
  ok('...and the refusal explains what would be needed', threw !== null && /CLAUDE_CONFIG_DIR/.test(threw.message));
  ok('the first Claude seat is untouched', loadSeats(f).seats.length === 1);
}

// --- a bare machine adopts ~/.codex --------------------------------------
{
  // Requiring an existing sessions dir put the FIRST seat in .codex-seats on a
  // fresh machine, so signing in from the panel authenticated a home that a
  // plain `codex` never reads, and the tracked seat stayed empty forever.
  const dir = fs.mkdtempSync(path.join(tmp, 'barehome-'));
  fs.mkdirSync(path.join(dir, '.codex'), { recursive: true });   // logged in, never run
  const f = path.join(dir, 'seats.json');
  const r = createSeat({ vendor: 'codex', label: 'Codex', file: f, home: dir });
  ok('the first codex seat adopts ~/.codex even with no sessions yet',
     r.adopted === true && r.seat.home === path.join(dir, '.codex'), r.seat.home);
  ok('...so no second home is created for it', !fs.existsSync(path.join(seatHomeRoot(dir), r.seat.id)));
}

// --- ~/.codex is never RE-adopted once a seat lives in a private home --------
{
  // The migration trap: moving a subscription out of ~/.codex into a private
  // home, then adding the next seat, used to silently re-adopt ~/.codex —
  // because "no seat currently claims it" was true again. The new seat needs
  // no login, looks fine, and then changes account underneath the user the
  // first time the desktop app or any long-lived process refreshes a token
  // into that shared home. Adopting is only ever right on a fresh machine.
  const dir = fs.mkdtempSync(path.join(tmp, 'readopt-'));
  fs.mkdirSync(path.join(dir, '.codex'), { recursive: true });
  const f = path.join(dir, 'seats.json');

  const first = createSeat({ vendor: 'codex', label: 'Prolite', file: f, home: dir });
  ok('the first seat still adopts ~/.codex on a fresh machine', first.adopted === true);

  // Move it to a private home, the way the migration does.
  const seats = loadSeats(f).seats.map((x) =>
    (x.id === first.seat.id ? { ...x, home: path.join(seatHomeRoot(dir), 'private') } : x));
  fs.mkdirSync(path.join(seatHomeRoot(dir), 'private'), { recursive: true });
  saveSeats(seats, f);

  const second = createSeat({ vendor: 'codex', label: 'Team', file: f, home: dir });
  ok('a later seat does NOT re-adopt the now-unclaimed ~/.codex',
     second.adopted !== true && path.resolve(second.seat.home) !== path.resolve(path.join(dir, '.codex')),
     second.seat.home);
  ok('...it gets its own private home instead',
     second.seat.home.startsWith(seatHomeRoot(dir)), second.seat.home);
  ok('...and comes back with a login to run', typeof second.loginCommand === 'string');
}

// --- snapshot resolves sign-in from the ACCOUNT, not auth.json's mtime ------
{
  // End-to-end wiring of the same bug: a token refresh moves auth.json's mtime
  // with no login, and the reading it invalidates is the only one the seat has.
  const dir = fs.mkdtempSync(path.join(tmp, 'acct-'));
  const home = path.join(dir, 'home');
  const day = path.join(home, 'sessions', '2026', '09', '07');
  fs.mkdirSync(day, { recursive: true });
  fs.writeFileSync(path.join(home, 'auth.json'), '{"tokens":{"account_id":"acct-A"}}');
  fs.writeFileSync(path.join(day, 'rollout-2026-09-07T10-00-00-a.jsonl'),
    JSON.stringify({ timestamp: '2026-09-07T10:05:00.000Z', type: 'turn.completed',
      info: { rate_limits: { primary: { used_percent: 61, window_minutes: 10080,
        resets_at: Math.floor(Date.now() / 1000) + 7 * 86400 } } } }) + '\n');

  // The login predates the rollout, as it must for the reading to be this
  // account's at all. Filenames are LOCAL time and event stamps are UTC, so
  // back-date well clear of both rather than to the boundary.
  const loginAt = Date.parse('2026-09-06T00:00:00.000Z');
  fs.utimesSync(path.join(home, 'auth.json'), loginAt / 1000, loginAt / 1000);

  const seats = [{ id: 'codex-1', vendor: 'codex', label: 'Seat', home }];
  const acctFile = path.join(dir, 'accounts.json');
  const snapFile = path.join(dir, 'snap.json');

  const first = await snapshot({ seats, snapshotFile: snapFile, accountsFile: acctFile });
  ok('the seat reads on first snapshot', first.seats[0].ok === true, first.seats[0].reason || '');
  ok('...and is not reported as an account change', !first.seats[0].accountChanged);

  // The refresh: same account, mtime pushed past the only reading.
  const future = Date.now();
  fs.utimesSync(path.join(home, 'auth.json'), future / 1000, future / 1000);

  const second = await snapshot({ seats, snapshotFile: snapFile, accountsFile: acctFile });
  ok('a token refresh does not blank the seat', second.seats[0].ok === true,
     second.seats[0].reason || '');
  ok('...and still reports the real number', second.seats[0].windows[0]?.usedPercent === 61);
  ok('...and is not flagged as an account change', !second.seats[0].accountChanged);

  // A genuine re-auth to a different account MUST invalidate it.
  fs.writeFileSync(path.join(home, 'auth.json'), '{"tokens":{"account_id":"acct-B"}}');
  const third = await snapshot({ seats, snapshotFile: snapFile, accountsFile: acctFile });
  ok('a real account change invalidates the previous account\'s reading',
     third.seats[0].ok === false, JSON.stringify(third.seats[0].windows));
  ok('...and is flagged so the user can see it happened', third.seats[0].accountChanged === true);
}

// --- a rate limit must not erase the number ---------------------------------
{
  // Pressing Refresh during a 429 overwrote the snapshot with a failure, so the
  // reading vanished and never came back — latching on prior.ok alone is not
  // enough once the bad write has landed.
  const dir = fs.mkdtempSync(path.join(tmp, 'latch-'));
  const snapFile = path.join(dir, 'usage-snapshot.json');
  const seat = { id: 'c', vendor: 'claude', label: 'Claude' };
  let mode = 'ok';
  const fetchImpl = async () => (mode === 'ok'
    ? { ok: true, status: 200, json: async () => ({ limits: [
        { kind: 'session', group: 'session', percent: 42, resets_at: null, is_active: true } ] }) }
    : { ok: false, status: 429, headers: { get: () => null } });
  const take = async () => {
    const snap = await takeSnapshot({ seats: [seat], snapshotFile: snapFile,
                                  sources: [() => ({ token: 't', source: 'stub' })], fetchImpl });
    writeSnapshot(snap, snapFile);
    return snap.seats[0];
  };

  ok('a good reading is recorded', (await take()).windows[0].usedPercent === 42);
  mode = '429';
  const once = await take();
  ok('a rate limit keeps the last good reading', once.ok === true && once.windows[0].usedPercent === 42, once.reason);
  ok('...and says it is held over', /rate limiting/.test(once.staleReason || ''), once.staleReason);
  const twice = await take();
  ok('it survives repeated rate limits', twice.ok === true && twice.windows[0].usedPercent === 42);
  ok('"retry in 0s" is never shown', !/retry in 0s/.test(JSON.stringify(twice)));
}

// --- a seat registered without a home still matches its stored reading ------
{
  // Readers fill `home` in, so a seat added without one produced a stored entry
  // whose home did not match the registry — and the reading was dropped as if
  // it belonged to another account.
  const dir = fs.mkdtempSync(path.join(tmp, 'homematch-'));
  const f = path.join(dir, 'seats.json');
  const snapFile = path.join(dir, 'usage-snapshot.json');
  saveSeats([{ id: 'g', vendor: 'grok', label: 'Grok' }], f);            // no home
  writeSnapshot({ takenAt: Date.now(), seats: [
    { seatId: 'g', vendor: 'grok', label: 'Grok', home: defaultGrokHomePath(), ok: true,
      windows: [{ label: 'Weekly', usedPercent: 3 }] } ] }, snapFile);
  const out = await renderSnapshot({ file: f, snapshotFile: snapFile });
  const g = out.seats.find((x) => x.seatId === 'g');
  ok('a home-less seat still matches its stored reading',
     g.ok === true && g.windows[0]?.usedPercent === 3, g.reason);
}
function defaultGrokHomePath() {
  return process.env.GROK_HOME || path.join(os.homedir(), '.grok');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
