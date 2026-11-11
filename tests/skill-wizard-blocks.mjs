/**
 * Building blocks in the skill wizard (builds/blocks-wizard-step C1–C4), in
 * process against a scripted backend: the picker data, the ids a draft turn
 * takes, what the drafting model is told (block names, never block text, on
 * the first draft and on Regenerate), the refusals, the size check and the
 * section the server appends. HOME is a temp dir set before lib/ loads; no
 * model is called.
 */
import fs from 'node:fs';
import path from 'node:path';
import { snapshotRealHomes, assertRealHomesUnchanged } from './real-home.mjs';
import { tempDir } from './fixtures/cleanup.mjs';

const realBefore = snapshotRealHomes();
const home = fs.realpathSync(tempDir('acs-wizard-blocks-'));
process.env.HOME = home;
process.env.ACS_SUITE = 'offline';
delete process.env.CODEX_HOME;

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${String(detail).slice(0, 1500)}` : ''}`); }
};

const W = await import('../lib/skill-wizard.js');
const B = await import('../lib/blocks.js');

const SHIPPED = B.loadBlocks();
const byId = (id) => SHIPPED.find((b) => b.id === id);
const draftFor = (name, body = 'Do the thing.') => `---\nname: ${name}\ndescription: Releases a build. Use when the user says "cut a release".\n---\n\n${body}\n`;
const section = (blocks) => `\n## Shared rules\n${blocks.map((b) => `\n### ${b.name}\n\n${B.startMarker(b.id, b.body)}\n${b.body}<!-- /block:${b.id} -->\n`).join('')}`;
/** Every non-blank line of a block's body, as it would sit on a line of its own. */
const bodyLines = (b) => b.body.split('\n').map((l) => l.trim()).filter(Boolean);
/** The body lines of `blocks` that appear as a whole line of `text`, or inside it when long. */
const leaked = (text, blocks) => {
  const lines = new Set(text.split('\n').map((l) => l.trim()));
  return blocks.flatMap((b) => bodyLines(b).filter((l) => lines.has(l) || (l.length >= 40 && text.includes(l))).map((l) => `${b.id}: ${l}`));
};

const scripted = (steps) => {
  const calls = [];
  return {
    calls,
    info: () => ({ harness: 'claude', ready: true }),
    start(prompt) {
      const step = steps[Math.min(calls.length, steps.length - 1)];
      calls.push({ prompt });
      return { done: Promise.resolve({ text: step.text ?? '', code: 0, err: null, is_error: false, stderr: null }), kill: () => {} };
    },
  };
};
const wid = (n = 1) => String(n).padStart(16, 'c');
const base = { wizardId: wid(), description: 'Cut a release of my app.', answers: [], kind: 'draft', name: 'release' };

try {
  console.log('\nthe picker data: every block by id, name and summary, from loadBlocks()');
  {
    const wz = W.createSkillWizard({ backend: scripted([{ text: '' }]) });
    const list = wz.info().blocks;
    ok('info() lists every shipped block, in loadBlocks() order', Array.isArray(list) && JSON.stringify(list.map((b) => b.id)) === JSON.stringify(SHIPPED.map((b) => b.id)), JSON.stringify(list));
    ok('…each with exactly id, name and summary: no text, no marker, nothing ticked or suggested',
      (list || []).length > 0 && list.every((b) => Object.keys(b).sort().join() === 'id,name,summary' && b.name === byId(b.id).name && b.summary === byId(b.id).summary), JSON.stringify(list?.[0]));
    const fx = W.createSkillWizard({ backend: scripted([{ text: '' }]), blocks: () => [B.parseBlock('only-one', '---\nname: Only one\nsummary: S.\n---\nText of only one.\n')] });
    ok('createSkillWizard takes a blocks option for fixtures', JSON.stringify(fx.info().blocks) === '[{"id":"only-one","name":"Only one","summary":"S."}]', JSON.stringify(fx.info().blocks));
  }

  console.log('\nC1 the chosen blocks are appended word for word, between valid markers, in loadBlocks() order');
  const chosenIds = ['review-policy', 'operator-merges', 'callback-contract', 'operator-merges'];
  const chosen = SHIPPED.filter((b) => chosenIds.includes(b.id));
  let pasted = null;
  {
    const be = scripted([{ text: draftFor('release') }]);
    const r = await W.createSkillWizard({ backend: be }).turn({ ...base, seq: 1, blocks: chosenIds });
    pasted = r.content;
    ok('the draft, then "## Shared rules", then each block under its ### name, in loadBlocks() order, duplicates dropped',
      r.kind === 'draft' && r.content === draftFor('release') + section(chosen), r.content);
    ok('…the order is loadBlocks()\'s, not the request\'s', chosen.map((b) => b.id).join() === 'callback-contract,operator-merges,review-policy');
    const copies = B.scanText(r.content, SHIPPED);
    ok('lib/blocks.js finds exactly the chosen blocks, each marked and rated same', copies.length === 3
      && JSON.stringify(copies.map((c) => c.id).sort()) === JSON.stringify(chosen.map((b) => b.id).sort())
      && copies.every((c) => c.marked && c.rating === 'same' && c.note === null), JSON.stringify(copies));
    ok('…and the result is a valid SKILL.md for the name', (() => { try { W.validateSkillMd(r.content, 'release'); return true; } catch { return false; } })());
  }
  {
    const all = SHIPPED.map((b) => b.id);
    const r = await W.createSkillWizard({ backend: scripted([{ text: draftFor('release') }]) }).turn({ ...base, seq: 1, blocks: all });
    const copies = B.scanText(r.content, SHIPPED);
    ok('every shipped block at once: each one marked same, nothing else found', copies.length === SHIPPED.length && copies.every((c) => c.marked && c.rating === 'same'), JSON.stringify(copies.filter((c) => !c.marked || c.rating !== 'same')));
  }

  console.log('\nC2 the drafting model is told the names, never the text');
  {
    const be = scripted([{ text: draftFor('release') }]);
    await W.createSkillWizard({ backend: be }).turn({ ...base, seq: 1, blocks: chosenIds });
    const p = be.calls[0].prompt;
    ok('the first-draft prompt holds no body line of any chosen block', leaked(p, chosen).length === 0, leaked(p, chosen).join('\n'));
    ok('…nor of any other block', leaked(p, SHIPPED).length === 0, leaked(p, SHIPPED).join('\n'));
    ok('…it names each chosen block, one per line', chosen.every((b) => p.split('\n').includes(`- ${b.name}`)), p.slice(-1500));
    ok('…says the studio adds them afterwards and the draft must not write, restate or refer to them', /the studio adds these rules/i.test(p) && /do not write, restate or refer to them/i.test(p) && /"Shared rules" heading/.test(p), p.slice(-1500));
    ok('…and carries no marker', !/<!-- \/?block:/.test(p));
  }
  {
    // Regenerate: the person edited their own text and the inside of a block.
    const merges = byId('operator-merges');
    const edited = pasted
      .replace('Do the thing.', 'Do the thing, my way.')
      .replace(merges.body, merges.body.replace('Only the operator merges.', 'Only the person merges.'));
    const be = scripted([{ text: draftFor('release', 'Do the thing, my way, shorter.') }]);
    const r = await W.createSkillWizard({ backend: be }).turn({ ...base, seq: 2, blocks: chosenIds, note: 'shorter', previous: edited });
    const p = be.calls[0].prompt;
    ok('the Regenerate prompt holds no body line of any chosen block', leaked(p, chosen).length === 0, leaked(p, chosen).join('\n'));
    ok('…not the hand-edited block line either, nor any marker or the Shared rules heading', !/Only the person merges/.test(p) && !/<!-- \/?block:/.test(p) && !/^#+\s*Shared rules/im.test(p), p.slice(-2500));
    ok('…but it keeps the person\'s own edit to the draft', /Do the thing, my way\./.test(p));
    ok('the new draft gets the blocks pasted fresh: a hand edit inside a block is reset', r.content === draftFor('release', 'Do the thing, my way, shorter.') + section(chosen), r.content);
  }
  {
    // A closing marker deleted on Review: the unclosed block still never reaches the model.
    const regen = async (previous, blocks = chosenIds) => {
      const be = scripted([{ text: draftFor('release') }]);
      await W.createSkillWizard({ backend: be }).turn({ ...base, seq: 4, blocks, note: 'again', previous });
      return be.calls[0].prompt;
    };
    const mine = pasted.replace('Do the thing.', 'Do the thing, my way.');
    const pMid = await regen(mine.replace('<!-- /block:operator-merges -->\n', ''));
    ok('f1 a block whose end marker was deleted (mid-section): none of its body lines reach the Regenerate prompt', leaked(pMid, chosen).length === 0 && /Do the thing, my way\./.test(pMid), leaked(pMid, chosen).join('\n'));
    const pLast = await regen(`${mine.replace('<!-- /block:review-policy -->\n', '')}\n## My notes\n\nKeep this note.\n`);
    ok('f1 …the last block unclosed: its body stops at the next ## heading, so the person\'s text after it is kept', leaked(pLast, chosen).length === 0 && /Keep this note\./.test(pLast) && /## My notes/.test(pLast), leaked(pLast, chosen).join('\n'));
    const pEof = await regen(mine.replace('<!-- /block:review-policy -->\n', ''), []);
    ok('f1 …and unclosed at the end of the file, with no blocks ticked now', leaked(pEof, chosen).length === 0, leaked(pEof, chosen).join('\n'));
    // A start marker deleted on Review: the end marker alone still bounds the block.
    const noStart = (id) => mine.replace(`${B.startMarker(id, byId(id).body)}\n`, '');
    for (const [where, id] of [['first, right under the heading', 'callback-contract'], ['in the middle', 'operator-merges'], ['last', 'review-policy']]) {
      const pS = await regen(noStart(id));
      ok(`x1 a block whose start marker was deleted (${where}): none of its body lines, its ### name or the studio's heading reach the Regenerate prompt`,
        leaked(pS, chosen).length === 0 && !pS.split('\n').includes(`### ${byId(id).name}`) && !/^## Shared rules$/m.test(pS) && /Do the thing, my way\./.test(pS), leaked(pS, chosen).join('\n') || pS.slice(-1500));
    }
    const pAfter = await regen(`${noStart('review-policy')}\n## My notes\n\nKeep this note.\n`, []);
    ok('x1 …the person\'s own text after a ## heading is kept', leaked(pAfter, chosen).length === 0 && /## My notes\n\nKeep this note\./.test(pAfter), leaked(pAfter, chosen).join('\n'));
  }
  {
    // A draft with no block markers is sent back exactly as the person left it, its own "Shared rules" heading included.
    const own = draftFor('release', 'Do the thing.\n\n## Shared rules\n\nMy own rule.\n\n\n\nSpaced out.');
    ok('f2 withoutSharedRules leaves a block-free draft byte-identical', W.withoutSharedRules(own) === own);
    for (const blocks of [[], ['operator-merges']]) {
      const be = scripted([{ text: draftFor('release') }]);
      await W.createSkillWizard({ backend: be }).turn({ ...base, seq: 5, blocks, note: 'again', previous: own });
      ok(`f2 …and the Regenerate prompt carries it unchanged (${blocks.length ? 'a block ticked' : 'no blocks'})`, be.calls[0].prompt.includes(`\n${own}\n@@ENDDRAFT-`), be.calls[0].prompt.slice(-800));
    }
    const both = `${draftFor('release', 'Do the thing.\n\n## Shared rules\n\nMy own rule.')}${section([byId('operator-merges')])}`;
    const cut = W.withoutSharedRules(both);
    ok('f2 a person\'s own Shared rules heading stays; the studio\'s section and its heading go', cut === draftFor('release', 'Do the thing.\n\n## Shared rules\n\nMy own rule.') && leaked(cut, SHIPPED).length === 0, cut);
  }
  {
    // Unticking every block on Regenerate: the section goes, and the model never sees it.
    const be = scripted([{ text: draftFor('release') }]);
    const r = await W.createSkillWizard({ backend: be }).turn({ ...base, seq: 3, blocks: [], note: 'again', previous: pasted });
    ok('Regenerate with no blocks: the old section is cut from what the model sees', leaked(be.calls[0].prompt, chosen).length === 0 && !/<!-- \/?block:/.test(be.calls[0].prompt));
    ok('…and nothing is appended', r.content === draftFor('release'));
  }

  console.log('\nC3 refusals: markers or the heading in a draft, an unknown id, an oversized result');
  {
    const marker = draftFor('release', `Do it.\n\n${B.startMarker('operator-merges', byId('operator-merges').body)}\n${byId('operator-merges').body}<!-- /block:operator-merges -->`);
    const be = scripted([{ text: marker }, { text: draftFor('release') }]);
    const r = await W.createSkillWizard({ backend: be }).turn({ ...base, seq: 1, blocks: ['operator-merges'] });
    ok('a draft holding a block marker is refused and retried with the reason', be.calls.length === 2 && /your previous reply was refused \([^)]*block marker/.test(be.calls[1].prompt) && r.content === draftFor('release') + section([byId('operator-merges')]), be.calls[1]?.prompt.slice(-600));
    const end = scripted([{ text: draftFor('release', 'Do it.\n<!-- /block:operator-merges -->') }, { text: draftFor('release', 'Do it.\n<!-- /block:operator-merges -->') }]);
    const e = await W.createSkillWizard({ backend: end }).turn({ ...base, seq: 1, blocks: ['operator-merges'] }).catch((x) => x);
    ok('…an end marker alone too, and refused twice is a visible error', e.status === 502 && /refused twice/.test(e.message) && end.calls.length === 2, e.message);
    const head = scripted([{ text: draftFor('release', 'Do it.\n\n## Shared rules\n\nNever merge.') }, { text: draftFor('release') }]);
    await W.createSkillWizard({ backend: head }).turn({ ...base, seq: 1, blocks: ['operator-merges'] });
    ok('a draft with its own "Shared rules" heading is refused and retried', head.calls.length === 2 && /Shared rules/.test(head.calls[1].prompt.split('ACS NOTE:')[1] || ''), head.calls[1]?.prompt.slice(-600));
  }
  {
    const be = scripted([{ text: draftFor('release') }]);
    const e = await W.createSkillWizard({ backend: be }).turn({ ...base, seq: 1, blocks: ['operator-merges', 'no-such-block'] }).catch((x) => x);
    ok('an unknown block id → 400, before any model run', e.status === 400 && /no-such-block/.test(e.message) && be.calls.length === 0, `${e.status} ${e.message}`);
    for (const [what, blocks] of [['not a list', 'operator-merges'], ['a non-string id', [1]], ['an id of the wrong shape', ['../x']]]) {
      const x = await W.createSkillWizard({ backend: be }).turn({ ...base, seq: 1, blocks }).catch((y) => y);
      ok(`blocks ${what} → 400`, x.status === 400 && be.calls.length === 0, `${x.status} ${x.message}`);
    }
  }
  {
    const big = B.parseBlock('big-one', `---\nname: Big one\nsummary: Too big.\n---\n${`${'A long rule line. '.repeat(60).trim()}\n`.repeat(70)}`);
    const be = scripted([{ text: draftFor('release') }]);
    const e = await W.createSkillWizard({ backend: be, blocks: () => [big] }).turn({ ...base, seq: 1, blocks: ['big-one'] }).catch((x) => x);
    ok('a pasted result over 64 KB is refused at the draft turn (413), not only at Create', Buffer.byteLength(big.body) > 64 * 1024 && e.status === 413 && /64 KB/.test(e.message) && be.calls.length === 1, `${e.status} ${e.message}`);
  }

  console.log('\nC4 nothing is preselected; with no blocks the draft is what it is today');
  {
    const args = { description: 'Cut a release.', answers: [], name: 'release', nonce: 'n0nce', facts: null };
    ok('buildDraftPrompt with no blocks is byte-identical to today\'s', W.buildDraftPrompt({ ...args, blocks: [] }) === W.buildDraftPrompt(args));
    ok('…and says nothing about shared rules', !/shared rules/i.test(W.buildDraftPrompt(args)));
    for (const [what, extra] of [['blocks omitted', {}], ['blocks: []', { blocks: [] }], ['blocks: null', { blocks: null }]]) {
      const be = scripted([{ text: draftFor('release') }]);
      const r = await W.createSkillWizard({ backend: be }).turn({ ...base, seq: 1, ...extra });
      ok(`${what}: the reply as parsed, nothing appended, no shared-rules line in the prompt`, r.content === draftFor('release') && !/shared rules/i.test(be.calls[0].prompt), r.content);
    }
  }
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}

assertRealHomesUnchanged(realBefore, ok);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
