/**
 * Shared rules, add a rule where it is missing (builds/shared-rules-ux PR B2: D1–D5),
 * in-process: the scan lists the files a rule can be added to; preview shows per file
 * the lines added and where, and writes nothing; apply checks every file's signature
 * before writing any, saves each old file to the studio's history first, appends only
 * (the wizard's layout, the file's line endings, every existing byte kept), and refuses
 * pack files (by real path too), files the scan does not list, typed paths, traversal,
 * links out of the roots and files that already hold the rule. HOME is a temp dir, set
 * before any studio module loads.
 */
import fs from 'node:fs';
import path from 'node:path';
import { snapshotRealHomes, assertRealHomesUnchanged } from './real-home.mjs';
import { tempDir } from './fixtures/cleanup.mjs';

const realBefore = snapshotRealHomes();
const home = fs.realpathSync(tempDir('acs-badd-home-'));
const ext = fs.realpathSync(tempDir('acs-badd-ext-'));
process.env.HOME = home;

const B = await import('../lib/blocks.js');
const A = await import('../lib/blocks-add.js');
const W = await import('../lib/skill-wizard.js');
const history = await import('../lib/history.js');

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${String(detail).slice(0, 1500)}` : ''}`); }
};
const put = (f, body) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); return f; };
const read = (f) => fs.readFileSync(f, 'utf8');
const refusal = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

const P1 = 'Always run the full test suite before you commit, and say in the report which tests ran and what they printed.';
const P2 = 'Never push a branch whose checks are failing; fix them first, or report each one that is still failing.';
const BODY = `${P1}\n\n${P2}\n`;
const OTHER = 'Keep every animation under three hundred milliseconds and respect the reduced motion setting of the system.\n';
const blocksDir = path.join(ext, 'blocks');
put(path.join(blocksDir, 'test-rule.md'), `---\nname: Test rule\nsummary: s\n---\n${BODY}`);
put(path.join(blocksDir, 'other-rule.md'), `---\nname: Other rule\nsummary: o\n---\n${OTHER}`);
for (const d of ['.claude', '.codex', '.agents']) fs.mkdirSync(path.join(home, d), { recursive: true });

const skills = path.join(home, '.claude', 'skills');
const packsDir = path.join(ext, 'packs');
const claudeMd = path.join(home, '.claude', 'CLAUDE.md');
const agentsMd = path.join(home, '.codex', 'AGENTS.md');
const where = { dirs: [{ harness: 'claude', dir: skills }], packsDir, instructions: [{ harness: 'claude', file: claudeMd }, { harness: 'codex', file: agentsMd }] };
const loaded = () => B.loadBlocks(blocksDir);
const rule = (id = 'test-rule') => loaded().find((b) => b.id === id);
/** What the skill wizard writes for these blocks after `content`: the layout an added rule must have. */
const wizard = (content, ids) => W.pasteBlocks(content, ids.map((id) => rule(id)));

const calls = [];
const spy = {
  recordBaseline: async (abs, msg) => { calls.push(['baseline', abs, fs.readFileSync(abs)]); return history.recordBaseline(abs, msg); },
  record: async (abs, msg, o) => { calls.push(['record', abs]); return history.record(abs, msg, o); },
};
const adder = A.createBlocksAdd({ blocksDir, where, hist: spy });
const view = () => B.blocksView({ blocksDir, ...where });
const copyIn = (v, display, id = 'test-rule') => v.blocks.find((b) => b.id === id).copies.find((c) => c.file === display);
const display = (abs) => `~/${path.relative(home, abs)}`;
const addBoth = async (files, a = adder) => {
  const p = await a.preview({ rule: 'test-rule', files });
  return { p, r: await a.apply({ rule: 'test-rule', files: p.files.map((x) => ({ file: x.file, signature: x.signature })) }) };
};

try {
  console.log('\nD1 the files a rule can be added to');
  {
    put(claudeMd, '# My rules\n\nBe brief.\n');
    put(path.join(skills, 'plain', 'SKILL.md'), '---\nname: plain\ndescription: d\n---\n\nDo the thing.\n');
    put(path.join(skills, 'plain', 'reference.md'), 'A reference file inside the skill.\n');
    put(path.join(skills, 'has', 'SKILL.md'), `---\nname: has\ndescription: d\n---\n\n${P1}\n\n${P2}\n`);
    put(path.join(packsDir, 'p', 'skills', 'claude', 'p', 'SKILL.md'), '---\nname: p\ndescription: d\n---\n\nA pack skill.\n');
    const v = view();
    const files = (v.targets || []).map((t) => t.file);
    ok('the view lists the files a rule can be added to', Array.isArray(v.targets) && files.includes('~/.claude/CLAUDE.md') && files.includes('~/.claude/skills/plain/SKILL.md'), JSON.stringify(v.targets));
    ok('…each with its kind, source and skill, as copies carry them', v.targets.find((t) => t.file === '~/.claude/CLAUDE.md')?.kind === 'instructions'
      && JSON.stringify(v.targets.find((t) => t.file === '~/.claude/skills/plain/SKILL.md')) === JSON.stringify({ file: '~/.claude/skills/plain/SKILL.md', source: 'claude', kind: 'skill', skill: 'plain', project: null }),
    JSON.stringify(v.targets));
    ok('…never a pack file, nor a skill\'s other .md files', !files.some((f) => f.startsWith('packs/')) && !files.includes('~/.claude/skills/plain/reference.md'), files.join(', '));
    ok('…nor an instruction file that does not exist', !files.includes('~/.codex/AGENTS.md'), files.join(', '));
    ok('a file holding a copy of a rule is a target for other rules; the page leaves it out for that one', files.includes('~/.claude/skills/has/SKILL.md') && !!copyIn(v, '~/.claude/skills/has/SKILL.md'), files.join(', '));
  }

  console.log('\nD2 layout: a new "## Shared rules" section, the wizard\'s');
  {
    const before = '---\nname: plain\ndescription: d\n---\n\nDo the thing.\n';
    const f = path.join(skills, 'plain', 'SKILL.md');
    calls.length = 0;
    const p = await adder.preview({ rule: 'test-rule', files: ['~/.claude/skills/plain/SKILL.md'] });
    const one = p.files?.[0];
    ok('preview names the file, says a new heading is added at the end, and writes nothing', p.rule === 'test-rule' && p.files.length === 1 && one.file === '~/.claude/skills/plain/SKILL.md'
      && one.heading === 'new' && one.newline === false && read(f) === before && calls.length === 0, JSON.stringify(p));
    const want = wizard(before, ['test-rule']);
    const added = want.slice(before.length).replace(/\n$/, '').split('\n');
    ok('…the exact lines added, numbered from where they land', JSON.stringify(one.added) === JSON.stringify(added) && one.line === before.split('\n').length, JSON.stringify(one));
    ok('…with the file\'s last line before them as context', one.diff[0]?.op === ' ' && one.diff[0].line === 'Do the thing.' && one.from === one.line - 1
      && one.diff.slice(1).every((d) => d.op === '+') && JSON.stringify(one.diff.slice(1).map((d) => d.line)) === JSON.stringify(added), JSON.stringify(one.diff));
    ok('…and a signature', /^[0-9a-f]{64}$/.test(one.signature));
    const r = await adder.apply({ rule: 'test-rule', files: [{ file: one.file, signature: one.signature }] });
    ok('apply: the file is the old one with the wizard\'s section appended, byte for byte', read(f) === want, JSON.stringify(read(f)));
    ok('…the old bytes are untouched, only added to', read(f).startsWith(before));
    const c = copyIn(view(), '~/.claude/skills/plain/SKILL.md');
    ok('D5 checked again, the file has the rule, marked and matching', c?.marked && c.rating === 'same', JSON.stringify(c));
    ok('D5 the result lists each file and how to restore it from History', r.saved === true && r.rule === 'test-rule' && r.files.length === 1 && r.files[0].file === '~/.claude/skills/plain/SKILL.md'
      && /History/.test(r.files[0].undo) && r.files[0].undo.includes('~/.claude/skills/plain/SKILL.md'), JSON.stringify(r));
    ok('D3 the old file went to history before the write, the new one after', calls[0]?.[0] === 'baseline' && calls[0][2].toString('utf8') === before && calls.at(-1)?.[0] === 'record',
      JSON.stringify(calls.map((x) => x[0])));
    const versions = await Promise.all((await history.logFor(f)).map((x) => history.contentAt(f, x.sha)));
    ok('…so history holds the old version and the new one', versions.includes(before) && versions[0] === want, `${versions.length} versions`);
    const again = view().targets.map((t) => t.file);
    ok('the file is still a target (for other rules)', again.includes('~/.claude/skills/plain/SKILL.md'));
    const dup = await refusal(() => adder.preview({ rule: 'test-rule', files: ['~/.claude/skills/plain/SKILL.md'] }));
    ok('a file that already has the rule is refused (409), unchanged', dup?.status === 409 && /already/.test(dup.message) && read(f) === want, `${dup?.status} ${dup?.message}`);
  }

  console.log('\nD2 an existing "## Shared rules" heading is reused');
  {
    const content = '---\nname: two\ndescription: d\n---\n\nDo two things.\n';
    const before = wizard(content, ['other-rule']);
    const f = put(path.join(skills, 'two', 'SKILL.md'), before);
    const { p } = await addBoth(['~/.claude/skills/two/SKILL.md']);
    ok('preview says the rule goes under the file\'s heading', p.files[0].heading === 'existing', JSON.stringify(p.files[0]));
    ok('apply: the rule follows the last one under it, as the wizard would have written both', read(f) === wizard(content, ['other-rule', 'test-rule']), JSON.stringify(read(f)));
    ok('…and the other rule\'s copy still matches', copyIn(view(), '~/.claude/skills/two/SKILL.md', 'other-rule')?.rating === 'same');

    const later = '\n## Later\n\nA section the person added after the shared rules.\n';
    const mid = `${wizard(content, ['other-rule'])}${later}`;
    const g = put(path.join(skills, 'mid', 'SKILL.md'), mid);
    const { p: q } = await addBoth(['~/.claude/skills/mid/SKILL.md']);
    ok('a heading with a later section: the rule goes after the last block under the heading, the later section untouched',
      read(g) === `${wizard(content, ['other-rule', 'test-rule'])}${later}`, JSON.stringify(read(g)));
    ok('…and preview shows the line after it as context', q.files[0].diff.at(-1)?.op === ' ' && q.files[0].diff.at(-1).line === '', JSON.stringify(q.files[0].diff));
  }

  console.log('\nD3 line endings, and a file with no final newline');
  {
    const crlfBefore = '---\r\nname: crlf\r\ndescription: d\r\n---\r\n\r\nDo it.\r\n';
    const f = put(path.join(skills, 'crlf', 'SKILL.md'), crlfBefore);
    await addBoth(['~/.claude/skills/crlf/SKILL.md']);
    const lf = wizard(crlfBefore.replace(/\r\n/g, '\n'), ['test-rule']);
    ok('a CRLF file keeps CRLF: the added lines use it, the old bytes are the same', read(f) === lf.replace(/\n/g, '\r\n') && read(f).startsWith(crlfBefore), JSON.stringify(read(f)));
    ok('…and the scan reads it as the rule, matching', copyIn(view(), '~/.claude/skills/crlf/SKILL.md')?.rating === 'same');

    const bare = '---\nname: bare\ndescription: d\n---\n\nNo newline at the end.';
    const g = put(path.join(skills, 'bare', 'SKILL.md'), bare);
    const { p } = await addBoth(['~/.claude/skills/bare/SKILL.md']);
    ok('a file without a final newline: preview says one is added first', p.files[0].newline === true, JSON.stringify(p.files[0]));
    ok('…it gets one, then the section as the wizard writes it', read(g) === wizard(`${bare}\n`, ['test-rule']) && read(g).startsWith(bare), JSON.stringify(read(g)));
  }

  console.log('\nD3 bytes that are not UTF-8 are kept exactly');
  {
    const before = Buffer.concat([Buffer.from('---\nname: latin\ndescription: d\n---\n\nCaf'), Buffer.from([0xe9]), Buffer.from(' line \x96 here, '), Buffer.from([0xff, 0xfe]), Buffer.from(' end.\n')]);
    const f = path.join(skills, 'latin', 'SKILL.md');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, before);
    await addBoth(['~/.claude/skills/latin/SKILL.md']);
    const after = fs.readFileSync(f);
    const tail = Buffer.from(wizard('x\n', ['test-rule']).slice(2));
    ok('every existing byte is unchanged and only the section is added', after.subarray(0, before.length).equals(before) && after.subarray(before.length).equals(tail), after.toString('hex'));
  }

  console.log('\nD3 all or nothing: one changed file stops every write');
  {
    const a = put(path.join(skills, 'all-a', 'SKILL.md'), '---\nname: all-a\ndescription: d\n---\n\nA.\n');
    const b = put(path.join(skills, 'all-b', 'SKILL.md'), '---\nname: all-b\ndescription: d\n---\n\nB.\n');
    const p = await adder.preview({ rule: 'test-rule', files: ['~/.claude/skills/all-a/SKILL.md', '~/.claude/skills/all-b/SKILL.md'] });
    ok('preview covers both files, each with its own signature', p.files.length === 2 && p.files[0].signature !== p.files[1].signature);
    fs.appendFileSync(b, 'A line someone added after the preview.\n');
    const aBefore = read(a), bBefore = read(b);
    calls.length = 0;
    const e = await refusal(() => adder.apply({ rule: 'test-rule', files: p.files.map((x) => ({ file: x.file, signature: x.signature })) }));
    ok('apply answers 409, names the changed file and asks to preview again', e?.status === 409 && /preview/i.test(e.message) && e.message.includes('~/.claude/skills/all-b/SKILL.md'), `${e?.status} ${e?.message}`);
    ok('…writes neither file and saves nothing to history', read(a) === aBefore && read(b) === bBefore && calls.length === 0, JSON.stringify(calls.map((x) => x[0])));

    // The rule's text changing between preview and apply is a change too: the signature covers the text to write.
    const p2 = await adder.preview({ rule: 'test-rule', files: ['~/.claude/skills/all-a/SKILL.md'] });
    const ruleFile = path.join(blocksDir, 'test-rule.md');
    const ruleBefore = read(ruleFile);
    fs.writeFileSync(ruleFile, `${ruleBefore.replace(/\n$/, '')} One more sentence the person never saw.\n`);
    const e2 = await refusal(() => adder.apply({ rule: 'test-rule', files: [{ file: p2.files[0].file, signature: p2.files[0].signature }] }));
    fs.writeFileSync(ruleFile, ruleBefore);
    ok('the rule\'s text changed after the preview: 409, nothing written', e2?.status === 409 && read(a) === aBefore, `${e2?.status} ${e2?.message}`);

    const bad = await refusal(() => adder.apply({ rule: 'test-rule', files: [{ file: '~/.claude/skills/all-a/SKILL.md', signature: 'nope' }] }));
    ok('a malformed signature is a 400', bad?.status === 400, `${bad?.status} ${bad?.message}`);
  }

  console.log('\nD3 every old file is saved first, or nothing is written');
  {
    const a = put(path.join(skills, 'nh-a', 'SKILL.md'), 'A.\n');
    const b = put(path.join(skills, 'nh-b', 'SKILL.md'), 'B.\n');
    let n = 0;
    const flaky = A.createBlocksAdd({ blocksDir, where, hist: { recordBaseline: async (abs, m) => { if (++n === 2) throw new Error('disk full'); return history.recordBaseline(abs, m); }, record: async () => null } });
    const p = await flaky.preview({ rule: 'test-rule', files: ['~/.claude/skills/nh-a/SKILL.md', '~/.claude/skills/nh-b/SKILL.md'] });
    const e = await refusal(() => flaky.apply({ rule: 'test-rule', files: p.files.map((x) => ({ file: x.file, signature: x.signature })) }));
    ok('when history cannot take the second old file, nothing is written, the first included', e?.status === 500 && /Nothing was written/.test(e.message) && read(a) === 'A.\n' && read(b) === 'B.\n', `${e?.status} ${e?.message}`);
  }

  console.log('\nD3 a write that fails midway says which files were written');
  {
    const a = put(path.join(skills, 'mw-a', 'SKILL.md'), 'A.\n');
    const b = put(path.join(skills, 'mw-b', 'SKILL.md'), 'B.\n');
    const c = put(path.join(skills, 'mw-c', 'SKILL.md'), 'C.\n');
    let writes = 0;
    const io = { ...fs, writeSync: (...args) => { if (++writes === 2) throw new Error('device lost'); return fs.writeSync(...args); } };
    const shaky = A.createBlocksAdd({ blocksDir, where, hist: history, io });
    const p = await shaky.preview({ rule: 'test-rule', files: ['~/.claude/skills/mw-a/SKILL.md', '~/.claude/skills/mw-b/SKILL.md', '~/.claude/skills/mw-c/SKILL.md'] });
    const e = await refusal(() => shaky.apply({ rule: 'test-rule', files: p.files.map((x) => ({ file: x.file, signature: x.signature })) }));
    ok('the error names the file written and the files not written', e?.status >= 400 && /mw-a/.test(e.message) && /mw-b/.test(e.message) && /mw-c/.test(e.message) && /History/.test(e.message), `${e?.status} ${e?.message}`);
    ok('…and carries them as lists', JSON.stringify(e?.payload?.written) === JSON.stringify(['~/.claude/skills/mw-a/SKILL.md'])
      && JSON.stringify(e?.payload?.notWritten) === JSON.stringify(['~/.claude/skills/mw-b/SKILL.md', '~/.claude/skills/mw-c/SKILL.md']), JSON.stringify(e?.payload));
    ok('…the first file has the rule, the others are as they were', read(a) === wizard('A.\n', ['test-rule']) && read(b) === 'B.\n' && read(c) === 'C.\n', JSON.stringify([read(a), read(b), read(c)]));
    const versions = await Promise.all((await history.logFor(a)).map((x) => history.contentAt(a, x.sha)));
    ok('…and the written file\'s old version is in history', versions.includes('A.\n'));
  }

  console.log('\nD4 only files the scan lists as targets, outside the packs');
  {
    const packFile = path.join(packsDir, 'p', 'skills', 'claude', 'p', 'SKILL.md');
    const packBefore = read(packFile);
    const e1 = await refusal(() => adder.preview({ rule: 'test-rule', files: ['packs/p/skills/claude/p/SKILL.md'] }));
    ok('a pack file is refused (403), untouched', e1?.status === 403 && read(packFile) === packBefore, `${e1?.status} ${e1?.message}`);
    const e1b = await refusal(() => adder.apply({ rule: 'test-rule', files: [{ file: 'packs/p/skills/claude/p/SKILL.md', signature: 'a'.repeat(64) }] }));
    ok('…by apply too', e1b?.status === 403 && read(packFile) === packBefore, `${e1b?.status} ${e1b?.message}`);
    const ref = path.join(skills, 'plain', 'reference.md');
    const e2 = await refusal(() => adder.preview({ rule: 'test-rule', files: ['~/.claude/skills/plain/reference.md'] }));
    ok('a skill\'s other .md file is refused (403)', e2?.status === 403 && read(ref) === 'A reference file inside the skill.\n', `${e2?.status} ${e2?.message}`);
    const loose = put(path.join(home, '.claude', 'notes', 'loose.md'), 'Loose notes.\n');
    for (const file of ['~/.claude/notes/loose.md', '~/.claude/skills/plain/../../notes/loose.md', `${home}/.claude/notes/loose.md`, '../../etc/passwd', '/etc/hosts', '~/.claude/skills/plain/SKILL.md\u0000']) {
      const e = await refusal(() => adder.preview({ rule: 'test-rule', files: [file] }));
      ok(`a typed path, traversal or another spelling is refused: ${JSON.stringify(file).slice(0, 60)}`, (e?.status === 403 || e?.status === 400) && read(loose) === 'Loose notes.\n', `${e?.status} ${e?.message}`);
    }
    const fresh = put(path.join(skills, 'fresh', 'SKILL.md'), 'Fresh.\n');
    const e3 = await refusal(() => adder.preview({ rule: 'test-rule', files: ['~/.claude/skills/fresh/SKILL.md', '~/.claude/notes/loose.md'] }));
    ok('one refused file refuses the whole request', e3?.status === 403 && read(fresh) === 'Fresh.\n', `${e3?.status} ${e3?.message}`);

    // A skill file linking out of the roots: listed by the scan, never a target, refused.
    const outside = put(path.join(ext, 'outside.md'), 'Outside the roots.\n');
    fs.mkdirSync(path.join(skills, 'linked'), { recursive: true });
    fs.symlinkSync(outside, path.join(skills, 'linked', 'SKILL.md'));
    ok('a file behind a link out of the roots is not a target', !view().targets.some((t) => t.file === '~/.claude/skills/linked/SKILL.md'));
    const e4 = await refusal(() => adder.preview({ rule: 'test-rule', files: ['~/.claude/skills/linked/SKILL.md'] }));
    ok('…and is refused (403), the target untouched', e4?.status === 403 && read(outside) === 'Outside the roots.\n', `${e4?.status} ${e4?.message}`);

    // A pack file reached through a link in a skill folder is a pack file, judged by its real path. The packs sit
    // inside a safe root (~/.agents) here, as a checkout under an edit folder does, so only the pack check can refuse it.
    const inRoots = path.join(home, '.agents', 'acs-checkout', 'packs');
    const packTarget = put(path.join(inRoots, 'q', 'skills', 'claude', 'q', 'SKILL.md'), 'A pack skill in the roots.\n');
    fs.mkdirSync(path.join(skills, 'packlink'), { recursive: true });
    fs.symlinkSync(packTarget, path.join(skills, 'packlink', 'SKILL.md'));
    const where2 = { ...where, packsDir: inRoots };
    ok('a pack file behind a link in a skill folder is not a target', !B.blocksView({ blocksDir, ...where2 }).targets.some((t) => t.file === '~/.claude/skills/packlink/SKILL.md'));
    const packed = A.createBlocksAdd({ blocksDir, where: where2, hist: spy });
    const e5 = await refusal(() => packed.preview({ rule: 'test-rule', files: ['~/.claude/skills/packlink/SKILL.md'] }));
    ok('…and preview refuses it (403) by its real path, the pack file untouched', e5?.status === 403 && /pack files/.test(e5.message) && read(packTarget) === 'A pack skill in the roots.\n', `${e5?.status} ${e5?.message}`);

    // A hard-linked file changes under every name: the scan cannot read it, so it is never a target.
    const hl = put(path.join(skills, 'hard', 'SKILL.md'), 'Hard.\n');
    fs.linkSync(hl, path.join(home, '.claude', 'second-name.md'));
    ok('a hard-linked file is not a target', !view().targets.some((t) => t.file === '~/.claude/skills/hard/SKILL.md'));
    const e6 = await refusal(() => adder.preview({ rule: 'test-rule', files: ['~/.claude/skills/hard/SKILL.md'] }));
    ok('…and is refused (403), untouched', e6?.status === 403 && read(hl) === 'Hard.\n', `${e6?.status} ${e6?.message}`);

    const e7 = await refusal(() => adder.preview({ rule: 'no-such-rule', files: ['~/.claude/skills/two/SKILL.md'] }));
    ok('a rule the studio does not have is refused (404)', e7?.status === 404, `${e7?.status} ${e7?.message}`);
    for (const [what, body] of [
      ['an unknown field', { rule: 'test-rule', files: ['~/.claude/CLAUDE.md'], extra: 1 }],
      ['an unknown field on a file', { rule: 'test-rule', files: [{ file: '~/.claude/CLAUDE.md', signature: 'a'.repeat(64), extra: 1 }] }],
      ['no files', { rule: 'test-rule', files: [] }],
      ['the same file twice', { rule: 'test-rule', files: ['~/.claude/CLAUDE.md', '~/.claude/CLAUDE.md'] }],
      ['files not a list', { rule: 'test-rule', files: '~/.claude/CLAUDE.md' }],
    ]) {
      const e = await refusal(() => (what === 'an unknown field on a file' ? adder.apply(body) : adder.preview(body)));
      ok(`${what} is a 400`, e?.status === 400, `${e?.status} ${e?.message}`);
    }
  }

  console.log('\nD2 an instruction file');
  {
    const before = read(claudeMd);
    const { r } = await addBoth(['~/.claude/CLAUDE.md']);
    ok('the global CLAUDE.md takes the section like a skill does', read(claudeMd) === wizard(before, ['test-rule']) && r.files[0].file === '~/.claude/CLAUDE.md', JSON.stringify(read(claudeMd)));
  }
} catch (err) {
  ok(`no test block threw (${err?.message || err})`, false, err?.stack || String(err));
}
assertRealHomesUnchanged(realBefore, ok);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
