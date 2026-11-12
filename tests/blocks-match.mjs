/**
 * Shared rules, make one copy match (builds/shared-rules-ux B3, B4, B5), in-process:
 * preview names the exact lines and a signature and writes nothing; apply replaces
 * only that copy (a marked region, or an unmarked copy's span wrapped in markers),
 * leaves every other byte as it was, saves the old file to the studio's history
 * first, and refuses a stale signature, a pack copy, a file the scan does not list,
 * traversal, a link out of the roots and a hard-linked file. HOME is a temp dir,
 * set before any studio module loads.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { snapshotRealHomes, assertRealHomesUnchanged } from './real-home.mjs';
import { tempDir } from './fixtures/cleanup.mjs';

const realBefore = snapshotRealHomes();
const home = fs.realpathSync(tempDir('acs-bmatch-home-'));
const ext = fs.realpathSync(tempDir('acs-bmatch-ext-'));
process.env.HOME = home;

const B = await import('../lib/blocks.js');
const M = await import('../lib/blocks-match.js');
const history = await import('../lib/history.js');

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${String(detail).slice(0, 1500)}` : ''}`); }
};
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const put = (f, body) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); return f; };
const read = (f) => fs.readFileSync(f, 'utf8');
const refusal = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

const P1 = 'Always run the full test suite before you commit, and say in the report which tests ran and what they printed.';
const P2 = 'Never push a branch whose checks are failing; fix them first, or report each one that is still failing.';
const BODY = `${P1}\n\n${P2}\n`;
const OTHER = 'Keep every animation under three hundred milliseconds and respect the reduced motion setting of the system.\n';
const blocksDir = put(path.join(ext, 'blocks', 'test-rule.md'), `---\nname: Test rule\nsummary: s\n---\n${BODY}`) && path.join(ext, 'blocks');
put(path.join(blocksDir, 'other-rule.md'), `---\nname: Other rule\nsummary: o\n---\n${OTHER}`);
for (const d of ['.claude', '.codex', '.agents']) fs.mkdirSync(path.join(home, d), { recursive: true });

const skills = path.join(home, '.claude', 'skills');
const packsDir = path.join(ext, 'packs');
const claudeMd = path.join(home, '.claude', 'CLAUDE.md');
const where = { dirs: [{ harness: 'claude', dir: skills }], packsDir, instructions: [{ harness: 'claude', file: claudeMd }] };
const marked = (body) => `${B.startMarker('test-rule', BODY)}\n${body}<!-- /block:test-rule -->\n`;
const region = `${B.startMarker('test-rule', BODY)}\n${BODY}<!-- /block:test-rule -->`;
const EDITED = BODY.replace('the full test suite', 'the whole test suite');

const calls = [];
const spy = {
  recordBaseline: async (abs, msg) => { calls.push(['baseline', abs, read(abs)]); return history.recordBaseline(abs, msg); },
  record: async (abs, msg, o) => { calls.push(['record', abs]); return history.record(abs, msg, o); },
};
const matcher = M.createBlocksMatch({ blocksDir, where, hist: spy });
const view = () => B.blocksView({ blocksDir, ...where });
const copyIn = (v, display, id = 'test-rule') => v.blocks.find((b) => b.id === id).copies.find((c) => c.file === display);
const ask = (c, extra = {}) => ({ rule: 'test-rule', file: c.file, line: c.line, endLine: c.endLine, ...extra });

try {
  console.log('\nB3 a marked copy: only its region changes, markers carry the current sha');
  {
    const before = `---\nname: a\n---\n\nIntro, untouched.   \n\n${marked(EDITED)}\nAfter the copy, untouched.\n\n\n`;
    const f = put(path.join(skills, 'a', 'SKILL.md'), before);
    const c = copyIn(view(), '~/.claude/skills/a/SKILL.md');
    ok('the scan lists the copy as drifted and offers to make it match', c?.rating === 'reworded' && c.marked && c.canMatch === true && !c.whyNot, JSON.stringify(c));
    const p = await matcher.preview(ask(c));
    ok('preview names the file and the exact lines it removes and adds', p.file === '~/.claude/skills/a/SKILL.md' && p.line === c.line && p.endLine === c.endLine
      && JSON.stringify(p.removed) === JSON.stringify(marked(EDITED).replace(/\n$/, '').split('\n'))
      && JSON.stringify(p.added) === JSON.stringify(region.split('\n')), JSON.stringify(p));
    ok('…with a line diff where only the changed line is removed and added', p.diff.filter((d) => d.op === '-').length === 1 && p.diff.filter((d) => d.op === '+').length === 1
      && p.diff.find((d) => d.op === '-').line.includes('the whole test suite'), JSON.stringify(p.diff));
    ok('…and a signature; nothing is written by a preview', /^[0-9a-f]{64}$/.test(p.signature) && read(f) === before && calls.length === 0);
    const r = await matcher.apply(ask(c, { signature: p.signature }));
    const after = read(f);
    const want = before.replace(marked(EDITED), `${region}\n`);
    ok('apply: the file is the old one with only that region replaced, byte for byte', after === want, JSON.stringify(after));
    ok('…the start marker carries the sha of the studio\'s text', after.includes(`<!-- block:test-rule sha256:${sha(BODY)} -->`));
    const again = copyIn(view(), '~/.claude/skills/a/SKILL.md');
    ok('…and the copy now rates the same, marked, with nothing to offer', again?.rating === 'same' && again.marked && again.canMatch === false, JSON.stringify(again));
    ok('the old file went to history before the write, and the new one after it', calls[0]?.[0] === 'baseline' && calls[0][2] === before
      && calls.filter((x) => x[0] === 'baseline').every((x) => x[2] === before) && calls.at(-1)?.[0] === 'record', JSON.stringify(calls.map((x) => x[0])));
    const log = await history.logFor(f);
    const versions = await Promise.all(log.map((x) => history.contentAt(f, x.sha)));
    ok('…so history holds the old version and the new one', versions.includes(before) && versions[0] === after, `${log.length} versions`);
    ok('the result names the file and says how to undo', r.saved === true && r.file === '~/.claude/skills/a/SKILL.md' && /History/.test(r.undo) && typeof r.sha === 'string', JSON.stringify(r));
  }

  console.log('\nB3 an unmarked copy: its located span is wrapped in markers');
  {
    const copy = `${P1.replace('before you commit', 'before every commit')}\n\n${P2}\n`;
    const before = `# Rules\n\nFirst, something else entirely about colours and fonts.\n\n${copy}\n- a list item after it\n`;
    const f = put(path.join(skills, 'b', 'SKILL.md'), before);
    const c = copyIn(view(), '~/.claude/skills/b/SKILL.md');
    ok('the unmarked reworded copy is offered', c && !c.marked && c.rating === 'reworded' && c.canMatch === true, JSON.stringify(c));
    const p = await matcher.preview(ask(c));
    ok('preview removes exactly the copy\'s lines', JSON.stringify(p.removed) === JSON.stringify(copy.replace(/\n$/, '').split('\n')), JSON.stringify(p.removed));
    await matcher.apply(ask(c, { signature: p.signature }));
    ok('apply: the span is replaced by the marked text and every other byte is the same', read(f) === before.replace(copy, `${region}\n`), JSON.stringify(read(f)));
  }

  console.log('\nB3 line endings and the end of the file');
  {
    const copy = `${P1.replace('the full', 'the entire')}\n\n${P2}`;
    const before = `Intro line.\n\n${copy}`;
    const f = put(path.join(skills, 'c', 'SKILL.md'), before);
    const c = copyIn(view(), '~/.claude/skills/c/SKILL.md');
    const p = await matcher.preview(ask(c));
    await matcher.apply(ask(c, { signature: p.signature }));
    ok('a copy at the very end with no final newline: replaced, and no newline added after it', read(f) === `Intro line.\n\n${region}`, JSON.stringify(read(f)));
    const crlfBefore = `Intro line.\r\n\r\n${P1.replace('the full', 'the entire')}\r\n\r\n${P2}\r\n\r\nOutro line.\r\n`;
    const g = put(path.join(skills, 'd', 'SKILL.md'), crlfBefore);
    const d = copyIn(view(), '~/.claude/skills/d/SKILL.md');
    const q = await matcher.preview(ask(d));
    await matcher.apply(ask(d, { signature: q.signature }));
    ok('a CRLF file keeps CRLF: the new lines use it, the rest is unchanged', read(g) === `Intro line.\r\n\r\n${region.split('\n').join('\r\n')}\r\n\r\nOutro line.\r\n`, JSON.stringify(read(g)));
    ok('…and the scan reads it back as the same', copyIn(view(), '~/.claude/skills/d/SKILL.md')?.rating === 'same');
  }

  console.log('\nB4 a file that changed after the preview is refused');
  {
    const before = `Top.\n\n${marked(EDITED)}`;
    const f = put(path.join(skills, 'e', 'SKILL.md'), before);
    const c = copyIn(view(), '~/.claude/skills/e/SKILL.md');
    const p = await matcher.preview(ask(c));
    const moved = `${before}\nA line someone added after the preview.\n`;
    fs.writeFileSync(f, moved);
    calls.length = 0;
    const e = await refusal(() => matcher.apply(ask(c, { signature: p.signature })));
    ok('apply answers 409 and asks to preview again', e?.status === 409 && /preview/i.test(e.message), `${e?.status} ${e?.message}`);
    ok('…writes nothing and records nothing', read(f) === moved && calls.length === 0);
    const bad = await refusal(() => matcher.apply(ask(c, { signature: 'nope' })));
    ok('a missing or malformed signature is a 400', bad?.status === 400, `${bad?.status} ${bad?.message}`);
    // The copy moved down a line: the old line no longer names it.
    fs.writeFileSync(f, `Extra.\n${before}`);
    const gone = await refusal(() => matcher.apply(ask(c, { signature: p.signature })));
    const shifted = await refusal(() => matcher.preview(ask(c)));
    ok('QA preview of a copy that moved says to preview again, the button the page offers', shifted?.status === 409 && /Preview it again\.$/.test(shifted.message), shifted?.message);
    ok('a copy no longer at the line the preview named is refused as changed (409)', gone?.status === 409 && read(f) === `Extra.\n${before}`, `${gone?.status} ${gone?.message}`);
  }

  console.log('\nB5 only a copy the scan lists, outside the packs');
  {
    const packFile = put(path.join(packsDir, 'p', 'skills', 'claude', 'p', 'SKILL.md'), marked(EDITED));
    const pc = view().blocks.find((b) => b.id === 'test-rule').copies.find((c) => c.pack);
    ok('a pack copy is listed, drifted, and never offered', pc && pc.rating === 'reworded' && pc.canMatch === false, JSON.stringify(pc));
    for (const [what, fn] of [['preview', () => matcher.preview(ask(pc))], ['apply', () => matcher.apply(ask(pc, { signature: 'a'.repeat(64) }))]]) {
      const e = await refusal(fn);
      ok(`${what} of a pack copy is refused (403), the pack file untouched`, e?.status === 403 && read(packFile) === marked(EDITED), `${e?.status} ${e?.message}`);
    }
    const loose = put(path.join(home, '.claude', 'notes', 'loose.md'), marked(EDITED));
    const e1 = await refusal(() => matcher.preview({ rule: 'test-rule', file: '~/.claude/notes/loose.md', line: 1, endLine: 4 }));
    ok('a file the scan does not list is refused (403), though it holds a copy', e1?.status === 403 && read(loose) === marked(EDITED), `${e1?.status} ${e1?.message}`);
    for (const file of ['~/.claude/skills/a/../../notes/loose.md', '../../etc/passwd', `${home}/.claude/notes/loose.md`, '~/.claude/skills/a/SKILL.md\u0000']) {
      const e = await refusal(() => matcher.preview({ rule: 'test-rule', file, line: 1, endLine: 4 }));
      ok(`traversal or another spelling is refused (403): ${JSON.stringify(file).slice(0, 60)}`, e?.status === 403 || e?.status === 400, `${e?.status} ${e?.message}`);
    }
    // A skill whose file links out of the roots: the scan lists it, the write refuses it.
    const outside = put(path.join(ext, 'outside.md'), marked(EDITED));
    fs.mkdirSync(path.join(skills, 'linked'), { recursive: true });
    fs.symlinkSync(outside, path.join(skills, 'linked', 'SKILL.md'));
    const lc = copyIn(view(), '~/.claude/skills/linked/SKILL.md');
    ok('a copy behind a link out of the roots is listed but not offered, and says why', lc && lc.canMatch === false && typeof lc.whyNot === 'string' && lc.whyNot.length > 10, JSON.stringify(lc));
    const e2 = await refusal(() => matcher.preview(ask(lc)));
    ok('…and preview refuses it (403), the target untouched', e2?.status === 403 && read(outside) === marked(EDITED), `${e2?.status} ${e2?.message}`);
    // A hard-linked file changes under every name: the scan cannot read it, so it is never a copy, and never written.
    const hl = put(path.join(skills, 'hard', 'SKILL.md'), marked(EDITED));
    fs.linkSync(hl, path.join(home, '.claude', 'second-name.md'));
    ok('a hard-linked file is not listed as a copy', !copyIn(view(), '~/.claude/skills/hard/SKILL.md'));
    const e3 = await refusal(() => matcher.preview({ rule: 'test-rule', file: '~/.claude/skills/hard/SKILL.md', line: 1, endLine: 4 }));
    ok('…and preview refuses it (403), the file untouched', e3?.status === 403 && read(hl) === marked(EDITED), `${e3?.status} ${e3?.message}`);
    // A listed file, but the rule named is not there.
    put(path.join(skills, 'none', 'SKILL.md'), 'Nothing shared here at all, only words about other things.\n');
    const e4 = await refusal(() => matcher.preview({ rule: 'test-rule', file: '~/.claude/skills/none/SKILL.md', line: 1, endLine: 1 }));
    ok('a listed file with no copy of that rule is refused (403)', e4?.status === 403, `${e4?.status} ${e4?.message}`);
    const e5 = await refusal(() => matcher.preview({ rule: 'no-such-rule', file: '~/.claude/skills/a/SKILL.md', line: 1, endLine: 1 }));
    ok('a rule the studio does not have is refused (404)', e5?.status === 404, `${e5?.status} ${e5?.message}`);
    const e6 = await refusal(() => matcher.preview({ rule: 'test-rule', file: '~/.claude/skills/a/SKILL.md', line: 'x' }));
    ok('a malformed request is a 400', e6?.status === 400, `${e6?.status} ${e6?.message}`);
  }

  console.log('\nnot offered when the span is not exact; same copies never');
  {
    const buried = `Before anything else, read the plan, the brief and the open questions, then check out the branch named in the brief. ${P1} ${P2} Then hand the result back to the orchestrator with your notes on what changed, why it changed, and which files a reviewer should read first.\n`;
    const f = put(path.join(skills, 'buried', 'SKILL.md'), buried);
    const c = copyIn(view(), '~/.claude/skills/buried/SKILL.md');
    ok('a copy inside a longer paragraph is not offered, with one line saying why', c && c.canMatch === false && /longer paragraph/.test(c.whyNot || ''), JSON.stringify(c));
    const e = await refusal(() => matcher.preview(ask(c)));
    ok('…and preview refuses it (409), writing nothing', e?.status === 409 && read(f) === buried, `${e?.status} ${e?.message}`);
    const same = put(path.join(skills, 'same', 'SKILL.md'), marked(BODY));
    const sc = copyIn(view(), '~/.claude/skills/same/SKILL.md');
    ok('a copy that already matches is not offered', sc?.rating === 'same' && sc.canMatch === false && !sc.whyNot, JSON.stringify(sc));
    const e2 = await refusal(() => matcher.preview(ask(sc)));
    ok('…and preview says it already matches (409)', e2?.status === 409 && read(same) === marked(BODY), `${e2?.status} ${e2?.message}`);
    // Two rules' unmarked copies sharing lines: neither span can be replaced alone.
    const span = B.copySpan({ id: 'a', line: 3, endLine: 6, marked: false, note: null }, [{ id: 'a', line: 3, endLine: 6, marked: false }, { id: 'b', line: 5, endLine: 8, marked: false }]);
    ok('copySpan: an unmarked copy sharing lines with another rule\'s copy has no span, and says why', !('start' in span) && /another shared rule/.test(span.why || ''), JSON.stringify(span));
    const near = { id: 'a', line: 3, endLine: 6, marked: false, note: null, rating: 'reworded' };
    const inside = B.copySpan(near, [near, { id: 'long', line: 4, endLine: 5, marked: false, rating: 'differs' }]);
    ok('copySpan: a close copy holding a loose match of a longer rule wholly inside it keeps its span (rules nest)', inside.start === 2 && inside.end === 5, JSON.stringify(inside));
    const cut = B.copySpan(near, [near, { id: 'long', line: 5, endLine: 8, marked: false, rating: 'differs' }]);
    const real = B.copySpan(near, [near, { id: 'long', line: 4, endLine: 5, marked: false, rating: 'reworded' }]);
    const loose = B.copySpan({ ...near, rating: 'differs' }, [{ ...near, rating: 'differs' }, { id: 'long', line: 4, endLine: 5, marked: false, rating: 'differs' }]);
    ok('…but not one it would cut into, a close copy of another rule, or when both are loose', !('start' in cut) && !('start' in real) && !('start' in loose),
      JSON.stringify([cut, real, loose]));
    const mk = B.copySpan({ id: 'a', line: 3, endLine: 6, marked: true, note: null }, []);
    ok('copySpan: a marked copy\'s span is its markers, 0-based', mk.start === 2 && mk.end === 5, JSON.stringify(mk));
  }

  console.log('\nreview fixes: bytes, the rule text, packs through a link');
  {
    // f1: bytes that are not UTF-8, outside the copy, stay exactly as they were.
    const head = Buffer.concat([Buffer.from('Caf'), Buffer.from([0xe9]), Buffer.from(' line \x96 here.\n\n')]);
    const tailB = Buffer.concat([Buffer.from('\nAfter '), Buffer.from([0xff, 0xfe]), Buffer.from(' end.\n')]);
    const copyB = Buffer.from(marked(EDITED));
    const f = path.join(skills, 'latin', 'SKILL.md');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, Buffer.concat([head, copyB, tailB]));
    const c = copyIn(view(), '~/.claude/skills/latin/SKILL.md');
    const p = await matcher.preview(ask(c));
    await matcher.apply(ask(c, { signature: p.signature }));
    const want = Buffer.concat([head, Buffer.from(`${region}\n`), tailB]);
    ok('f1 a file with bytes that are not UTF-8: only the copy\'s bytes change, every other byte is identical', fs.readFileSync(f).equals(want), fs.readFileSync(f).toString('hex'));

    // f2: the rule's text changing between preview and apply refuses the apply.
    const before = `Top.\n\n${marked(EDITED)}`;
    const g = put(path.join(skills, 'ruletext', 'SKILL.md'), before);
    const rc = copyIn(view(), '~/.claude/skills/ruletext/SKILL.md');
    const rp = await matcher.preview(ask(rc));
    const ruleFile = path.join(blocksDir, 'test-rule.md');
    const ruleBefore = read(ruleFile);
    fs.writeFileSync(ruleFile, `${ruleBefore.replace(/\n$/, '')} One more sentence the person never saw in the preview.\n`);
    const e = await refusal(() => matcher.apply(ask(rc, { signature: rp.signature })));
    fs.writeFileSync(ruleFile, ruleBefore);
    ok('f2 the studio\'s text changed after the preview: apply refuses (409) and writes nothing', e?.status === 409 && /preview/i.test(e.message) && read(g) === before, `${e?.status} ${e?.message}`);

    // s1: a pack file reached through a link in a skill folder is still a pack file. The packs sit inside a
    // safe root (~/.agents) here, as a checkout under an edit folder does, so only the pack check can refuse it.
    const inRoots = path.join(home, '.agents', 'acs-checkout', 'packs');
    const packTarget = put(path.join(inRoots, 'q', 'skills', 'claude', 'q', 'SKILL.md'), marked(EDITED));
    fs.mkdirSync(path.join(skills, 'packlink'), { recursive: true });
    fs.symlinkSync(packTarget, path.join(skills, 'packlink', 'SKILL.md'));
    const where2 = { ...where, packsDir: inRoots };
    const lc = B.blocksView({ blocksDir, ...where2 }).blocks.find((b) => b.id === 'test-rule').copies.find((x) => x.file === '~/.claude/skills/packlink/SKILL.md');
    ok('s1 a pack file behind a link in a skill folder is listed without the button, saying it is a pack file', lc && lc.canMatch === false && /studio's own pack files/.test(lc.whyNot || ''), JSON.stringify(lc));
    const packed = M.createBlocksMatch({ blocksDir, where: where2, hist: spy });
    const e2 = await refusal(() => packed.preview(ask(lc)));
    ok('s1 …and preview refuses it (403) by its real path; the pack file untouched', e2?.status === 403 && /studio's own pack files/.test(e2.message) && read(packTarget) === marked(EDITED), `${e2?.status} ${e2?.message}`);
  }

  console.log('\nB3 the old file is saved first, or nothing is written');
  {
    const before = `Top.\n\n${marked(EDITED)}`;
    const f = put(path.join(skills, 'nohist', 'SKILL.md'), before);
    const broken = M.createBlocksMatch({ blocksDir, where, hist: { recordBaseline: async () => { throw new Error('disk full'); }, record: async () => null } });
    const c = copyIn(view(), '~/.claude/skills/nohist/SKILL.md');
    const p = await broken.preview(ask(c));
    const e = await refusal(() => broken.apply(ask(c, { signature: p.signature })));
    ok('when history cannot take the old file, apply refuses and the file is untouched', e?.status === 500 && /Nothing was written/.test(e.message) && read(f) === before, `${e?.status} ${e?.message}`);
  }
} catch (err) {
  ok(`no test block threw (${err?.message || err})`, false, err?.stack || String(err));
}
assertRealHomesUnchanged(realBefore, ok);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
