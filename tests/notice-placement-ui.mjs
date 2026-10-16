/**
 * Notices never cover the Assist drawer's controls. They float top-right —
 * where the open drawer keeps its session row — so a sticky one sat over "+"
 * and "New session" seemed not to work. The real public/ scripts in a node VM
 * against stubbed routes (tests/fixtures/shell-page.mjs); the VM has no
 * layout engine, so the placement is asserted from the DOM order and the
 * stylesheet rule that floats the slot there.
 */
import fs from 'node:fs';
import path from 'node:path';
import { bootPage, routesFor, PUB } from './fixtures/shell-page.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const settle = (ms = 0) => new Promise((r) => setTimeout(r, ms));
console.log('\nnotice placement');

const css = fs.readFileSync(path.join(PUB, 'styles.css'), 'utf8');
const rule = (sel) => (css.match(new RegExp(`(?:^|\\n)${sel.replace(/[.#>]/g, '\\$&').replace(/ /g, '\\s*')}\\s*\\{([^}]*)\\}`)) || [])[1] || '';
const inDrawer = rule('.drawer > #notice-slot');
ok('in the drawer the slot floats in the flow: positioned, no height of its own',
   /position:\s*relative/.test(inDrawer) && /height:\s*0/.test(inDrawer) && /overflow:\s*visible/.test(inDrawer) && /top:\s*auto/.test(inDrawer) && /right:\s*auto/.test(inDrawer), inDrawer);
ok('…above the conversation it overlays', /z-index:\s*\d/.test(inDrawer));
ok('the page-level slot is still the fixed top-right overlay', /position:\s*fixed/.test(rule('#notice-slot')) && /right:\s*16px/.test(rule('#notice-slot')));

const p = await bootPage({ routes: routesFor() });
await settle(20);
p.eval(`C.sessions = [{ id: 'sa', title: 'First', mentions: [], loaded: [], blocked: [], createdAt: 0, updatedAt: 0, messages: [{ role: 'user', text: 'hi' }], slots: {} }]; C.activeId = 'sa';`);
const slot = p.$('notice-slot');
const main = slot.parentNode;
const elems = (n) => n.childNodes.filter((c) => c.nodeType === 1);
const beforeContent = () => slot.parentNode === main && elems(main).indexOf(slot) === elems(main).indexOf(p.$('content')) - 1;
ok('closed, the slot sits in the page, before the content', main === p.$('content').parentNode && beforeContent());

p.$('btn-assist').click();
await settle(5);
p.eval(`notice('ok', '5 removed outside the studio — ~/a/CLAUDE.md, ~/b/CLAUDE.md, ~/c/CLAUDE.md…', null, true)`);
const d = p.$('drawer');
const kids = elems(d);
const at = (e) => kids.indexOf(e);
ok('open, the slot moves into the drawer', slot.parentNode === d);
ok('…below the head and the session row, above the conversation',
   at(slot) > at(d.querySelector('.drawer-head')) && at(slot) > at(p.$('session-bar')) && at(slot) === at(p.$('drawer-body')) - 1,
   kids.map((k) => k.id || k.className).join(' | '));
ok('…so the session row (select, +, ×) holds none of it', !p.$('session-bar').contains(slot) && !slot.contains(p.$('session-bar')));
ok('the notice is showing', /5 removed outside the studio/.test(p.text(slot)));

const plus = p.$('session-bar').querySelectorAll('button').find((b) => p.text(b) === '+');
ok('"+" is in the session row', !!plus);
plus.click();
await settle(5);
const ids = p.eval('JSON.stringify(C.sessions.map((s) => s.id))');
ok('clicking "+" with a notice showing creates a new session…', JSON.parse(ids).length === 2, ids);
ok('…and makes it the active one', p.eval('C.activeId') !== 'sa' && p.eval('C.activeId') === JSON.parse(ids)[0] && p.eval('active().messages.length') === 0);
ok('…which the switcher shows selected', p.$('session-bar').querySelector('select').childNodes.find((o) => o.selected)?.value === p.eval('C.activeId'));
ok('the notice is still in the drawer slot, not over the row', slot.parentNode === d && /5 removed/.test(p.text(slot)));

p.$('drawer-close').click();
await settle(5);
ok('closed again, the slot goes back to the page, notice and all',
   beforeContent() && /5 removed/.test(p.text(slot)));
ok('no page errors', p.errors.length === 0, p.errors.join(' | '));
p.done();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
