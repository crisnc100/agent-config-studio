/**
 * Assist finds its own files: one user message, end to end
 * (builds/assist-auto-files B3, B4, F6, F8–F11, F13, F14). A stubbed
 * backend scripted per round — no model, no CLI — against a temp HOME:
 * lib/assist-turn.js in process, then the real /api/chat handler over HTTP
 * for the origin check, cancellation and Accept.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { snapshotRealHomes, assertRealHomesUnchanged } from './real-home.mjs';

const realBefore = snapshotRealHomes();
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acs-at-home-')));
process.env.HOME = home;
const put = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); return f; };
const studio = path.join(home, '.agent-config-studio');
const S = path.join(home, '.claude', 'skills');
const skill = (name, body, dir = path.join(S, name)) => put(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: The ${name} skill.\n---\n${body}`);
put(path.join(studio, 'roots.json'), JSON.stringify({ version: 1, roots: [] }));
put(path.join(home, '.claude', 'CLAUDE.md'), '# global\n');
put(path.join(home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'plug@mkt': true } }));
skill('alpha', 'Use astra here.\n');
skill('beta', 'Reviews go to astra.\n');
skill('p1', 'plugin text\n', path.join(home, '.claude', 'plugins', 'cache', 'mkt', 'plug', '1.0.0', 'skills', 'p1'));
for (let i = 0; i < 30; i++) skill(`bulk-${String(i).padStart(2, '0')}`, i === 27 ? 'the ZEBRA-QUOKKA rule\n' : 'nothing\n');
for (let i = 0; i < 4; i++) skill(`big-${i}`, `${'x'.repeat(200 * 1024)}\n`);
const A = '~/.claude/skills/alpha/SKILL.md', B = '~/.claude/skills/beta/SKILL.md', PLUG = '~/.claude/plugins/cache/mkt/plug/1.0.0/skills/p1/SKILL.md';
const fileOf = (d) => path.join(home, d.slice(2));

const { runChatTurn } = await import('../lib/assist-turn.js');
const { createAssistFiles } = await import('../lib/assist-files.js');
const { createChatProposals } = await import('../lib/chat-proposals.js');
const { createApp } = await import('../server.js');

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A backend that answers round i with script[i]: a result, a function of the call, or an Error. */
function backend(script) {
  const calls = [];
  let kills = 0;
  const fn = (opts, onDelta) => {
    const i = calls.length;
    calls.push(opts);
    const step = script[i] ?? { text: 'Done.' };
    const r = typeof step === 'function' ? step(opts, i) : step;
    if (r === 'hang') return { done: new Promise(() => {}), kill() { kills++; } };
    if (r instanceof Error) return { done: Promise.reject(r), kill() { kills++; } };
    for (let k = 0; k < (r.text || '').length; k += 5) onDelta(r.text.slice(k, k + 5));
    return { done: Promise.resolve({ code: 0, sessionId: 'sess-1', stats: { contextTokens: 10, outputTokens: 1, costUsd: 0.01 }, ...r }), kill() { kills++; } };
  };
  fn.calls = calls;
  fn.kills = () => kills;
  return fn;
}
const succeeded = (r) => r && r.code === 0 && !r.err && r.is_error !== true && (r.text || '').trim().length > 0;
const quiet = { recordBaseline: async () => null, record: async () => 'abc1234' };
const proposals = createChatProposals({ hist: quiet });
const files = createAssistFiles();

async function turn(script, over = {}) {
  const events = [];
  const fn = backend(script);
  await runChatTurn({
    message: 'change astra to opus in my review skills', mentions: [], sessionId: null, seed: null,
    harness: 'claude', model: 'm', cwd: home, carried: [], blocked: [],
    streamTurnFn: fn, assistFiles: files, proposals, send: (e) => events.push(e),
    isClosed: () => false, setActive: () => {}, succeeded, remember: () => {},
    ...over,
  });
  const done = events.find((e) => e.t === 'done');
  return { events, calls: fn.calls, fn, done, kinds: events.map((e) => e.t) };
}
const editBlock = (d, from, to) => `@@EDIT ${d}\n@@SEARCH\n${from}\n@@REPLACE\n${to}\n@@END\n`;

try {
  console.log('\nassist turn: B3 — no attachment, @@NEED two files, edits to both');
  {
    const t = await turn([{ text: `@@NEED ${A}\n@@NEED ${B}\n` }, { text: `Both changed.\n${editBlock(A, 'Use astra here.', 'Use opus here.')}${editBlock(B, 'Reviews go to astra.', 'Reviews go to opus.')}` }]);
    ok('B3 the server ran a continuation on the same session', t.calls.length === 2 && t.calls[1].sessionId === 'sess-1', JSON.stringify(t.calls.map((c) => c.sessionId)));
    const loaded = t.events.find((e) => e.t === 'loaded');
    ok('B3 the client got a loaded event listing both', loaded && loaded.files.map((f) => f.display).join() === `${A},${B}`, JSON.stringify(loaded));
    ok('B3 …after a finding status, and a round reset before the final round', t.kinds.indexOf('status') < t.kinds.indexOf('loaded') && t.kinds.indexOf('loaded') < t.kinds.indexOf('round'));
    ok('B3 proposals for both arrive, each with an id, labelled pulled in by Assist',
       t.done?.ok && t.done.proposals.length === 2 && t.done.proposals.every((p) => /^[0-9a-f]{32}$/.test(p.id) && p.originLabel === 'pulled in by Assist'), JSON.stringify(t.done?.proposals.map((p) => [p.display, p.error])));
    ok('B3 nothing was written before Accept', fs.readFileSync(fileOf(A), 'utf8').includes('Use astra here.'));
    ok('F10 the request round streamed nothing; only the final round did', t.events.filter((e) => e.t === 'delta').map((e) => e.text).join('').startsWith('Both changed.') &&
       !t.events.some((e) => e.t === 'delta' && /@@NEED/.test(e.text)));
    ok('F9 round 0 carried the manifest; the continuation carried it again, with both files', /\n@@MANIFEST-[0-9a-f]{16}\n/.test(t.calls[0].prompt) && /\n@@MANIFEST-[0-9a-f]{16}\n/.test(t.calls[1].prompt) &&
       t.calls[1].prompt.includes('Use astra here.') && t.calls[1].prompt.includes('Reviews go to astra.') && /\(editable; pulled in by ACS at your request\)/.test(t.calls[1].prompt));
    ok('F13 every round carries FACTS', t.calls.every((c) => /^FACTS \(read by Agent Config Studio/m.test(c.prompt)));
    ok('F8 the scope line is ACS\'s: "Loaded 2"', t.done.scope?.line === 'Loaded 2', JSON.stringify(t.done.scope));
    ok('B3 done carries the loaded list for the chips', t.done.loaded.map((f) => f.display).join() === `${A},${B}`);
  }

  console.log('\nassist turn: B3 — prose mixed with a request (documented: the request wins)');
  {
    const t = await turn([{ text: `Let me look.\n@@NEED ${A}\n${editBlock(B, 'Reviews go to astra.', 'x')}` }, { text: 'Here is the answer.' }]);
    ok('B3 a mixed reply is a request: it continued, and its prose and edits were discarded',
       t.calls.length === 2 && t.done.text === 'Here is the answer.' && t.done.proposals.length === 0, JSON.stringify(t.done));
    ok('B3 …the client was told to drop what it streamed (a round event)', t.kinds.includes('round'));
  }

  console.log('\nassist turn: F9 — an attached-file session discovering more');
  {
    const t = await turn([{ text: `@@NEED ${B}` }, { text: editBlock(B, 'Reviews go to astra.', 'Reviews go to opus.') }], { mentions: [fileOf(A)] });
    ok('F9 the manifest is sent on the first turn even with an attachment', /\n@@MANIFEST-[0-9a-f]{16}\n/.test(t.calls[0].prompt) && /\(editable; attached by the user\)/.test(t.calls[0].prompt));
    ok('F9 …and the extra file it asked for is proposed against', t.done.proposals.length === 1 && t.done.proposals[0].id && t.done.proposals[0].display === B);
    const later = await turn([{ text: 'ok' }], { sessionId: 'sess-1', mentions: [fileOf(A)] });
    ok('F9 a resumed turn with no request sends no manifest', !/\n@@MANIFEST-[0-9a-f]{16}\n/.test(later.calls[0].prompt));
  }

  console.log('\nassist turn: F10 — the lifecycle');
  {
    const t1 = await turn([{ text: `@@NEED ${A}` }, new Error('round two blew up')]);
    const err = t1.events.find((e) => e.t === 'error');
    ok('F10 a failed round stops with a visible error and keeps the loaded list', err && /round two blew up/.test(err.message) && err.loaded.map((f) => f.display).join() === A && !t1.done);
    const t2 = await turn([{ text: `@@NEED ${A}`, is_error: true, err: 'model error' }]);
    ok('F10 a failed result\'s @@ lines are ignored: no continuation, done not ok', t2.calls.length === 1 && t2.done?.ok === false && t2.done.sessionId === null);
    const t3 = await turn([{ text: `@@NEED ${A}`, sessionId: null }]);
    ok('F10 a missing session id stops the loop with an error', t3.calls.length === 1 && /no session/.test(t3.events.find((e) => e.t === 'error')?.message || ''));
    let closed = false;
    const t4 = await turn([(o) => { closed = true; return { text: `@@NEED ${A}` }; }], { isClosed: () => closed });
    ok('F10 a closed request runs no further round and sends nothing more', t4.calls.length === 1 && !t4.done && !t4.kinds.includes('loaded'));
    const t5 = await turn([{ text: '@@NE' }]);
    ok('F10 a short final reply is still delivered whole (held, then flushed)', t5.done.text === '@@NE' && t5.events.filter((e) => e.t === 'delta').map((e) => e.text).join('') === '@@NE');
  }

  console.log('\nassist turn: F11 — budgets');
  {
    const many = Array.from({ length: 21 }, (_, i) => `@@NEED ~/.claude/skills/bulk-${String(i).padStart(2, '0')}/SKILL.md`).join('\n');
    const t1 = await turn([{ text: `${many}\n${many}` }, { text: 'ok' }]);
    const l = t1.events.find((e) => e.t === 'loaded');
    ok('F11 at most 20 files per message; duplicates de-duplicated; the 21st refused with a note',
       l.files.length === 20 && l.refused.length === 1 && /20-file limit/.test(l.refused[0].reason) && /Not loaded: .*bulk-20.*20-file limit/.test(t1.calls[1].prompt), JSON.stringify(l.refused));
    const bigs = Array.from({ length: 4 }, (_, i) => `@@NEED ~/.claude/skills/big-${i}/SKILL.md`).join('\n');
    const t2 = await turn([{ text: bigs }, { text: 'ok' }]);
    const l2 = t2.events.find((e) => e.t === 'loaded');
    ok('F11 512 KB per message, counted on bytes read: two 200 KB files load, the rest refused',
       l2.files.length === 2 && l2.refused.length === 2 && l2.refused.every((r) => /512 KB loading limit/.test(r.reason)), JSON.stringify(l2));
    const t3 = await turn([{ text: `@@NEED ${A}` }, { text: `Alpha is loaded already.\n@@NEED ${A}` }, { text: 'never asked' }]);
    ok('F11 a round that adds nothing new ends the loop: no third call, its reply (requests removed) is the answer',
       t3.calls.length === 2 && t3.done.text === 'Alpha is loaded already.' && /asked for nothing new/.test(t3.done.note || ''), JSON.stringify([t3.calls.length, t3.done.text, t3.done.note]));
    const t3b = await turn([{ text: `@@NEED ${A}` }, { text: `@@NEED ${A}` }]);
    ok('F11 …a pure request that adds nothing says so in a short note', t3b.calls.length === 2 && t3b.done.text === '' && /asked for nothing new and gave no answer/.test(t3b.done.note || ''));
    const t4 = await turn([{ text: `@@NEED ${A}` }, { text: `@@NEED ${B}` }, { text: `@@NEED ${PLUG}` }]);
    ok('F11 at most 2 request rounds: the third reply\'s request is ignored and said so',
       t4.calls.length === 3 && t4.done.ok && t4.done.loaded.length === 2 && /after its limit/.test(t4.done.note || ''), JSON.stringify(t4.done));
    const carried = [0, 1, 2, 3].map((i) => `~/.claude/skills/big-${i}/SKILL.md`);
    const t5 = await turn([{ text: 'ok' }], { carried });
    ok('F11 per turn ≤ 768 KB of files: the oldest pulled-in files are dropped, with a note',
       t5.done.loaded.length === 3 && t5.done.loaded[0].display.includes('big-1') && /big-0.*dropped from context/.test(t5.done.dropped.join()) && /big-0\/SKILL\.md was dropped/.test(t5.calls[0].prompt), JSON.stringify(t5.done.dropped));
  }

  console.log('\nassist turn: F8 — @@FIND');
  {
    const t = await turn([{ text: '@@FIND zebra-quokka' }, { text: '@@NEED ~/.claude/skills/bulk-27/SKILL.md' }, { text: 'It is in bulk-27.' }]);
    const s = t.events.find((e) => e.t === 'searched');
    ok('F8 a match beyond the first 20 files is found', s && s.matched === 1 && s.searched >= 30 && /bulk-27\/SKILL\.md — 1 matching line\n  5: the ZEBRA-QUOKKA rule/.test(t.calls[1].prompt), JSON.stringify(s));
    ok('F8 search results are framed as data with the round\'s nonce', /\n@@FOUND-[0-9a-f]{16}\n/.test(t.calls[1].prompt));
    ok('F8 the scope line: "Searched N files · loaded 1"', new RegExp(`^Searched ${s.searched} files · loaded 1$`).test(t.done.scope?.line || ''), JSON.stringify(t.done.scope));
    const p = await turn([{ text: '@@FIND name:' }, { text: 'many' }], { limits: { ...(await import('../lib/assist-files.js')).ASSIST_LIMITS, searchFiles: 3 } });
    ok('F8 a capped search marks the scope partial, with the reason', /· partial \(\d+ more matching files not listed\)$/.test(p.done.scope?.line || '') && /PARTIAL/.test(p.calls[1].prompt), p.done.scope?.line);
  }

  console.log('\nassist turn: B4, F2, F6 — what may be edited');
  {
    const t = await turn([{ text: `@@NEED ${PLUG}` }, { text: `${editBlock(PLUG, 'plugin text', 'mine')}${editBlock('~/.claude/CLAUDE.md', '# global', '# x')}` }]);
    const byD = Object.fromEntries(t.done.proposals.map((p) => [p.display, p]));
    ok('B4 an edit to a loaded plugin file is refused with a reason', byD[PLUG]?.refused === true && /read-only/.test(byD[PLUG].error) && !byD[PLUG].id);
    ok('B4 an edit to a file neither attached nor loaded is refused', /did not point at/.test(byD['~/.claude/CLAUDE.md']?.error || ''));
    const q = await turn([{ text: `It says astra.\n${editBlock(A, 'Use astra here.', 'Use opus here.')}` }], { message: 'what does alpha say?', mentions: [fileOf(A)] });
    ok('F2 a question-only request with edit blocks only ever proposes', q.done.proposals.length === 1 && q.done.proposals[0].id && fs.readFileSync(fileOf(A), 'utf8').includes('Use astra here.'));
    const b = await turn([{ text: `@@NEED ${A}` }, { text: 'ok' }], { blocked: [A] });
    ok('F6 a removed file cannot be pulled back in by @@NEED', /removed this file/.test(b.events.find((e) => e.t === 'loaded')?.refused[0]?.reason || '') && b.done.loaded.length === 0);
    const c = await turn([{ text: 'ok' }], { carried: [A, B], blocked: [A] });
    ok('F6 …and is not sent again in context', c.done.loaded.map((f) => f.display).join() === B && !c.calls[0].prompt.includes('Use astra here.'));
  }

  console.log('\nassist turn: B5/F13 — facts follow roles within one session');
  {
    const t1 = await turn([{ text: 'ok' }]);
    put(path.join(studio, 'roles.json'), JSON.stringify({ version: 1, roles: { reviewer: { use: 'opus', effort: 'max' } } }));
    const t2 = await turn([{ text: 'ok' }], { sessionId: 'sess-1' });
    ok('F13 between two turns of one session, the second prompt has the new roles', /reviewer: astra@high/.test(t1.calls[0].prompt) && /reviewer: opus@max/.test(t2.calls[0].prompt));
    fs.rmSync(path.join(studio, 'roles.json'));
  }

  console.log('\nassist turn: grade fixes — removals, budgets, buffering, disconnects');
  {
    // 2. A removed attachment, named by its absolute path, is out of NEED, FIND and context alike.
    const t = await turn([{ text: '@@FIND use astra here' }, { text: `@@NEED ${A}` }, { text: 'ok' }], { blocked: [fileOf(A)] });
    const s = t.events.find((e) => e.t === 'searched');
    ok('G2 a removed attachment (blocked by its path) is not searched: @@FIND that matches only it finds nothing',
       s && s.matched === 0 && !t.calls[1].prompt.includes('alpha/SKILL.md —'), JSON.stringify(s));
    ok('G2 …nor pulled back in by @@NEED of its display path', /removed this file/.test(t.events.filter((e) => e.t === 'loaded')[1]?.refused[0]?.reason || ''));
    const c = await turn([{ text: 'ok' }], { carried: [A], blocked: [fileOf(A)] });
    ok('G2 …nor carried into context', c.done.loaded.length === 0 && !c.calls[0].prompt.includes('Use astra here.'));
    const m = await turn([{ text: 'ok' }], { mentions: [fileOf(A)], blocked: [A] });
    ok('G2 one key either way: an attachment blocked by its display path is left out too', !m.calls[0].prompt.includes('Use astra here.'));
  }
  {
    // 3. Removed while the turn runs: the live set the server adds to.
    const live = new Set();
    const t = await turn([{ text: `@@NEED ${A}\n@@NEED ${B}` }, () => { live.add(A); return { text: `${editBlock(A, 'Use astra here.', 'x')}${editBlock(B, 'Reviews go to astra.', 'y')}` }; }], { blocked: live });
    const byD = Object.fromEntries(t.done.proposals.map((p) => [p.display, p]));
    ok('G3 a file removed mid-turn gets no proposal from that turn, and says why', !byD[A]?.id && /You removed this file/.test(byD[A]?.error || '') && byD[B]?.id, JSON.stringify(t.done.proposals.map((p) => [p.display, p.error])));
    ok('G3 …and is not in the loaded list the turn reports back', t.done.loaded.map((f) => f.display).join() === B);
  }
  {
    // 4. Every byte read counts; a pulled-in file is re-read only up to what was counted.
    const grow = fileOf(A);
    const before = fs.readFileSync(grow, 'utf8');
    const sizeA = Buffer.byteLength(before), sizeB = fs.statSync(fileOf(B)).size;
    const t = await turn([{ text: `@@NEED ${A}` }, () => { fs.appendFileSync(grow, 'grown\n'); return { text: `@@NEED ${B}` }; },
      { text: editBlock(A, 'Use astra here.', 'Use opus here.') }]);
    fs.writeFileSync(grow, before);
    ok('G4 a pulled-in file that grew past what was counted is refused on re-read, not re-counted',
       /alpha\/SKILL\.md was not sent: it grew since it was loaded/.test(t.calls[2].prompt) && !t.calls[2].prompt.includes('grown'), t.calls[2].prompt.split('ACS NOTES:')[1]?.slice(0, 300));
    ok('G4 …so an edit to it proposes nothing', /could not read/.test(t.done.proposals[0]?.error || ''), JSON.stringify(t.done.proposals));
    ok('G4 bytes read are counted once per read across rounds (A and B on load; no blind re-reads)', t.done.readBytes === sizeA + sizeB, `${t.done.readBytes} vs ${sizeA + sizeB}`);
    const big0 = fileOf('~/.claude/skills/big-0/SKILL.md');
    fs.chmodSync(big0, 0o000);
    const d = await turn([{ text: 'ok' }], { carried: [0, 1, 2, 3].map((i) => `~/.claude/skills/big-${i}/SKILL.md`) });
    fs.chmodSync(big0, 0o644);
    ok('G4 sizes are checked before reading: the file dropped by the per-turn cap is never read (it is unreadable, and no read error appears)',
       /big-0\/SKILL\.md was dropped from context/.test(d.done.dropped.join()) && !/not sent/.test(d.done.dropped.join()) && d.done.readBytes === 3 * fs.statSync(fileOf('~/.claude/skills/big-1/SKILL.md')).size, `${d.done.dropped.join(' | ')} ${d.done.readBytes}`);
  }
  {
    // 6. No intermediate prose reaches the client.
    const t = await turn([{ text: `Let me look at the review skills first.\n@@NEED ${A}` }, { text: 'Final answer.' }]);
    const deltas = t.events.filter((e) => e.t === 'delta').map((e) => e.text).join('');
    ok('G6 prose before a request line never reaches the client; only the final round\'s text does', deltas === 'Final answer.' && !t.events.some((e) => JSON.stringify(e).includes('Let me look')), deltas);
    ok('G6 …while held, the client sees progress, not text', t.events.some((e) => e.t === 'progress' && e.chars > 0) && t.events.filter((e) => e.t === 'progress').every((e) => Object.keys(e).join() === 't,chars'));
    const last = await turn([{ text: `@@NEED ${A}` }, { text: `@@NEED ${B}` }, { text: 'Streams live.' }]);
    ok('G6 the last round, which cannot ask, streams as it arrives', last.events.filter((e) => e.t === 'delta').length > 1);
  }
  {
    // 7. A disconnect before the first spawn.
    let closed = false;
    const slow = { async manifest() { const m = await files.manifest(); closed = true; return m; } };
    const t = await turn([{ text: 'never' }], { assistFiles: slow, isClosed: () => closed });
    ok('G7 a client gone while the manifest builds: no spawn, nothing sent', t.calls.length === 0 && t.events.length === 0);
    const t2 = await turn([{ text: 'never' }], { isClosed: () => true });
    ok('G7 …and one gone before it started: no spawn either', t2.calls.length === 0);
  }

  console.log('\nassist turn: F14, cancellation and Accept through the server');
  {
    const detected = async () => [{ id: 'claude', label: 'Claude', models: [], defaultModel: null, streams: true }];
    let script = [];
    const calls = [];
    let kills = 0;
    const streamTurn = (opts, onDelta) => {
      calls.push(opts);
      const step = script[calls.length - 1] ?? { text: 'ok' };
      if (step === 'hang') return { done: new Promise(() => {}), kill() { kills++; } };
      for (let k = 0; k < step.text.length; k += 5) onDelta(step.text.slice(k, k + 5));
      return { done: Promise.resolve({ code: 0, sessionId: 'srv-1', ...step }), kill() { kills++; } };
    };
    const { server } = createApp({ streamTurn, detectHarnesses: detected });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://localhost:${server.address().port}`;
    const post = (p, body, headers = {}, signal) => fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal });
    try {
      for (const [what, headers] of [
        ['no Origin and Sec-Fetch-Site: same-site', { 'sec-fetch-site': 'same-site' }],
        ['another localhost port', { origin: 'http://localhost:5173', 'sec-fetch-site': 'same-site' }],
        ['a foreign origin', { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }],
      ]) {
        const r = await post('/api/chat', { message: 'hi' }, headers);
        ok(`F14 /api/chat refuses ${what} → 403`, r.status === 403);
      }
      ok('F14 …and nothing was spawned', calls.length === 0);
      const same = await post('/api/chat', { message: 'hi' }, { origin: base, 'sec-fetch-site': 'same-origin' });
      ok('F14 this page\'s own request still works', same.status === 200 && (await same.text()).includes('"t":"done"'));

      calls.length = 0;
      script = [{ text: `@@NEED ${A}` }, 'hang'];
      const ac = new AbortController();
      const r = await post('/api/chat', { message: 'go' }, {}, ac.signal);
      const reader = r.body.getReader();
      let seen = '';
      while (!seen.includes('"t":"round"')) { const { value, done } = await reader.read(); if (done) break; seen += new TextDecoder().decode(value); }
      ac.abort();
      await sleep(150);
      ok('F10 cancelling mid-loop kills the active round and starts no other', kills === 1 && calls.length === 2, `kills=${kills} calls=${calls.length}`);

      calls.length = 0;
      script = ['hang'];
      const ac2 = new AbortController();
      // Not awaited: a round that never answers sends no bytes, so no headers arrive.
      const r2 = post('/api/chat', { message: 'go', turnId: 'turn-abc12345' }, {}, ac2.signal).catch(() => null);
      await sleep(100);
      const blk = await (await post('/api/chat/block', { turnId: 'turn-abc12345', paths: [A] })).json();
      ok('G3 a removal reaches the running turn by its id', blk.live === true);
      ac2.abort();
      await r2;
      await sleep(100);
      ok('G3 …and a finished turn is no longer reachable', (await (await post('/api/chat/block', { turnId: 'turn-abc12345', paths: [A] })).json()).live === false);
      ok('G3 /api/chat/block is strict same-origin', (await post('/api/chat/block', { turnId: 'x', paths: [] }, { 'sec-fetch-site': 'same-site' })).status === 403);

      calls.length = 0;
      script = [{ text: `@@NEED ${B}` }, { text: editBlock(B, 'Reviews go to astra.', 'Reviews go to opus.') }];
      const lines = (await (await post('/api/chat', { message: 'go' })).text()).split('\n').filter(Boolean).map((l) => JSON.parse(l));
      const prop = lines.find((l) => l.t === 'done').proposals[0];
      const cross = await post('/api/chat/accept', { id: prop.id }, { 'sec-fetch-site': 'same-site' });
      ok('F4 /api/chat/accept is strict same-origin', cross.status === 403 && fs.readFileSync(fileOf(B), 'utf8').includes('astra'));
      const acc = await (await post('/api/chat/accept', { id: prop.id })).json();
      ok('F4 Accept through the route writes the reviewed bytes', acc.saved === true && fs.readFileSync(fileOf(B), 'utf8').includes('Reviews go to opus.'), JSON.stringify(acc));
      const again = await post('/api/chat/accept-all', { ids: [prop.id] });
      ok('F12 accept-all over an applied id reports it gone', (await again.json()).results[0].outcome === 'gone');
      const gen = await fetch(`${base}/api/file?path=${encodeURIComponent(fileOf(B))}`);
      ok('the generic file route still serves the file', gen.status === 200);
      const page = await fetch(`${base}/`);
      const PAGE_CSP = "default-src 'self'; img-src 'self' data:; media-src 'self'; font-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
      ok('G9 the served page carries exactly the CSP', page.headers.get('content-security-policy') === PAGE_CSP, page.headers.get('content-security-policy'));
      const html = await page.text();
      const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
      ok('G9 the page boots under it: no inline script, no inline handler, every script same-origin',
         scripts.length > 0 && scripts.every((m) => /\bsrc="\/[^/]/.test(m[1]) && !m[2].trim()) && !/\son[a-z]+=/i.test(html));
      const served = await Promise.all(scripts.map((m) => fetch(`${base}${m[1].match(/src="([^"]+)"/)[1]}`)));
      ok('G9 …each script is served from this origin', served.every((r) => r.status === 200 && /javascript/.test(r.headers.get('content-type') || '')));
      const appSrc = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'public', 'app.js'), 'utf8');
      ok('G9 …and the app never needs unsafe-eval', !/\beval\(|new Function\(/.test(appSrc));
      ok('G9 the JSON routes carry no page policy (it is the page\'s)', !(await fetch(`${base}/api/health`)).headers.get('content-security-policy'));
    } finally {
      server.close();
      server.closeAllConnections?.();
    }
  }
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}
assertRealHomesUnchanged(realBefore, ok);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
