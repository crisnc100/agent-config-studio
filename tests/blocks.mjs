/**
 * Building blocks (builds/building-blocks-page C1, C2): the blocks in
 * blocks/, how a copy is found and rated — same, reworded, differs; marked
 * and unmarked — where copies are looked for, and the route through a real
 * `node server.js` in a temp HOME: GET only, strict same-origin, real data.
 * Nothing outside temp dirs is written.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshotRealHomes, assertRealHomesUnchanged } from './real-home.mjs';
import { tempDir, track } from './fixtures/cleanup.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const realBefore = snapshotRealHomes();
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${String(detail).slice(0, 1500)}` : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const put = (f, body) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); };

const B = await import('../lib/blocks.js');

/* ── the shipped blocks ─────────────────────────────────────────────── */
console.log('\nblocks/: the shipped blocks');
{
  const blocks = B.loadBlocks();
  const ids = blocks.map((b) => b.id).sort();
  const WANT = ['builders-commit', 'callback-contract', 'changing-tests', 'deferred-findings', 'grader-swap', 'lookup-test',
    'never-weaken-tests', 'no-silent-substitute', 'operator-merges', 'operator-overrides', 'report-format', 'review-policy'];
  ok('the twelve planned blocks are there, one file each', JSON.stringify(ids) === JSON.stringify(WANT), ids.join(', '));
  ok('each has a name, a one-line summary and text', blocks.every((b) => b.name && b.name !== b.id && b.summary && !b.summary.includes('\n') && b.body.trim().length > 20),
    blocks.filter((b) => !(b.name && b.summary)).map((b) => b.id).join(', '));
  ok('each body ends in exactly one newline', blocks.every((b) => b.body.endsWith('\n') && !b.body.endsWith('\n\n')));
  ok('the text is generic: no first names, no home paths', blocks.every((b) => !/\bCris\b|Cristian|\/Users\/|~\/Documents/.test(b.body + b.name + b.summary)));
  ok('the review policy block holds all eleven rules', (blocks.find((b) => b.id === 'review-policy')?.body.match(/^\d+\. /gm) || []).length === 11);
}

/* ── rating: same, reworded, differs ─────────────────────────────────── */
console.log('\nrating a copy');
const P1 = 'Always run the full test suite before you commit, and say in the report which tests ran and what they printed.';
const P2 = 'Never push a branch whose checks are failing; fix them first, or report each one that is still failing.';
const BODY = `${P1}\n\n${P2}\n`;
const blk = B.parseBlock('test-rule', `---\nname: Test rule\nsummary: Run the tests, never push red.\n---\n${BODY}`);
const other = B.parseBlock('other-rule', '---\nname: Other rule\nsummary: Unrelated.\n---\nKeep every animation under three hundred milliseconds and respect the reduced motion setting of the system.\n');
const blocks = [blk, other];
{
  ok('parseBlock: name and summary from the frontmatter, the body after it', blk.name === 'Test rule' && blk.summary === 'Run the tests, never push red.' && blk.body === BODY, JSON.stringify(blk));
  ok('same: the same words, wrapped and marked up differently', B.rate(`**${P1.slice(0, 37)}**\n${P1.slice(38)}\n\n- ${P2}`, BODY) === 'same');
  ok('reworded: one clause swapped', B.rate(`${P1.replace('before you commit', 'before every commit')}\n\n${P2}`, BODY) === 'reworded');
  ok('differs: half the block, plus a rule of its own', B.rate(`${P1}\n\nAlso keep a changelog entry for every user-facing change you make in the branch.`, BODY) === 'differs');
  ok('similarity is 1 for the same words and 0 for none shared', B.similarity(P1, P1) === 1 && B.similarity(P1, 'zebra quokka wombat') === 0);
}

/* ── finding copies in a file ───────────────────────────────────────── */
console.log('\nfinding copies: unmarked by close match, marked by their markers');
{
  const intro = '# A skill\n\nThis skill does a thing that has nothing to do with the rule.\n\n';
  // Unmarked.
  const same = B.scanText(`${intro}${P1}\n\n${P2}\n\n## After\n\nMore unrelated words about colours.\n`, blocks);
  ok('unmarked same: one copy, at its first and last line', same.length === 1 && same[0].id === 'test-rule' && same[0].rating === 'same' && !same[0].marked
    && same[0].line === 5 && same[0].endLine === 7, JSON.stringify(same));
  const rew = B.scanText(`${intro}${P1.replace('the full test suite', 'the whole test suite')}\n${P2.replace('report each one', 'name each one')}\n`, blocks);
  ok('unmarked reworded', rew.length === 1 && rew[0].rating === 'reworded' && rew[0].line === 5 && rew[0].endLine === 6, JSON.stringify(rew));
  const diff = B.scanText(`${intro}- ${P1}\n- Also keep a changelog entry for every user-facing change you make in the branch.\n`, blocks);
  ok('unmarked differs: found by its one matching item, rated against the whole block', diff.length === 1 && diff[0].rating === 'differs' && diff[0].line === 5 && diff[0].endLine === 5, JSON.stringify(diff));
  const inside = B.scanText(`Before anything else, read the plan, the brief and the open questions, then check out the branch named in the brief. ${P1} ${P2} Then hand the result back to the orchestrator with your notes on what changed, why it changed, and which files a reviewer should read first.\n`, blocks);
  ok('…a block buried in a longer paragraph says so', inside.length === 1 && inside[0].rating === 'differs' && inside[0].note === 'the whole block is there, with more added', JSON.stringify(inside));
  ok('unrelated text: no copies', B.scanText(`${intro}Write the PR description in plain words, with how to try it.\n`, blocks).length === 0);
  const two = B.scanText(`${P1}\n\n${P2}\n\nsomething between, unrelated to it\n\n${P1}\n\n${P2}\n`, blocks);
  ok('two copies in one file are two copies', two.length === 2 && two.every((c) => c.rating === 'same') && two[1].line === 7, JSON.stringify(two));

  // Marked.
  const mark = (inner, hashOf = inner) => `${intro}<!-- block:test-rule sha256:${sha(hashOf)} -->\n${inner}<!-- /block:test-rule -->\n\nTail.\n`;
  ok('startMarker: the block id and the sha256 of its body', B.startMarker('test-rule', BODY) === `<!-- block:test-rule sha256:${sha(BODY)} -->`);
  const ms = B.scanText(mark(BODY), blocks);
  ok('marked same: byte-equal body; the copy spans its markers; no note', ms.length === 1 && ms[0].marked && ms[0].rating === 'same' && ms[0].note === null
    && ms[0].line === 5 && ms[0].endLine === 9, JSON.stringify(ms));
  const edited = `${P1.replace('before you commit', 'before every commit')}\n\n${P2}\n`;
  const me = B.scanText(mark(edited, BODY), blocks);
  ok('marked reworded, edited by hand after it was added (hash no longer matches)', me.length === 1 && me[0].marked && me[0].rating === 'reworded' && me[0].note === 'edited after it was added', JSON.stringify(me));
  const older = `${P1}\n\nOnly ever push to your own fork.\n`;
  const mo = B.scanText(mark(older), blocks);
  ok('marked differs, untouched since it was added: an older version of the block', mo.length === 1 && mo[0].marked && mo[0].rating === 'differs' && mo[0].note === 'an older version of the block', JSON.stringify(mo));
  const loose = B.scanText(`${intro}<!-- block:test-rule sha256:${sha(BODY)} -->\n${BODY}\nno end marker here\n`, blocks);
  ok('a start marker without its end is ignored; the text is still found unmarked', loose.length === 1 && !loose[0].marked && loose[0].rating === 'same', JSON.stringify(loose));
  const unknown = B.scanText(`<!-- block:nope sha256:${sha(BODY)} -->\n${BODY}<!-- /block:nope -->\n`, blocks);
  ok('a marker naming no known block is ignored', unknown.length === 1 && !unknown[0].marked && unknown[0].id === 'test-rule', JSON.stringify(unknown));
  ok('CRLF files are read the same', B.scanText(mark(BODY).replace(/\n/g, '\r\n'), blocks)[0]?.rating === 'same');
}

/* ── where copies are looked for ─────────────────────────────────────── */
console.log('\nwhere copies are looked for');
{
  const t = fs.realpathSync(tempDir('acs-blocks-src-'));
  const claude = path.join(t, 'claude-skills'), codex = path.join(t, 'codex-skills'), packs = path.join(t, 'packs');
  put(path.join(claude, 'one', 'SKILL.md'), 'a');
  put(path.join(claude, 'one', 'references', 'more.md'), 'b');
  put(path.join(claude, 'one', 'run.sh'), 'echo');
  put(path.join(codex, 'two', 'SKILL.md'), 'c');
  fs.symlinkSync(path.join(claude, 'one'), path.join(codex, 'one-link'));
  put(path.join(packs, 'p', 'skills', 'claude', 'x', 'SKILL.md'), 'd');
  put(path.join(packs, 'p', 'instructions', 'p.md'), 'e');
  put(path.join(packs, 'p', 'tests', 'fixture.md'), 'f');
  put(path.join(packs, 'p', 'README.md'), 'g');
  const files = B.sourceFiles({ dirs: [{ harness: 'claude', dir: claude }, { harness: 'codex', dir: codex }], packsDir: packs });
  const shown = files.map((f) => f.display.startsWith(t) ? path.relative(t, f.display) : f.display).sort();
  ok('skill .md files (top and one folder down), pack skills and instructions; not pack tests or other files',
    JSON.stringify(shown) === JSON.stringify(['claude-skills/one/SKILL.md', 'claude-skills/one/references/more.md', 'codex-skills/two/SKILL.md', 'packs/p/instructions/p.md', 'packs/p/skills/claude/x/SKILL.md']),
    JSON.stringify(shown));
  ok('a skill linked into a second folder is read once', files.filter((f) => f.abs.endsWith('one/SKILL.md') || f.abs.endsWith('one-link/SKILL.md')).length === 1);
  ok('each file says where it came from', files.find((f) => f.display.endsWith('two/SKILL.md'))?.source === 'codex' && files.find((f) => f.display.endsWith('p.md'))?.source === 'pack');

  // The whole view over that tree, with the test blocks.
  const bdir = path.join(t, 'blocks');
  put(path.join(bdir, 'test-rule.md'), `---\nname: Test rule\nsummary: s\n---\n${BODY}`);
  put(path.join(claude, 'one', 'SKILL.md'), `---\nname: one\n---\n\n${P1}\n\n${P2}\n`);
  put(path.join(packs, 'p', 'instructions', 'p.md'), `<!-- block:test-rule sha256:${sha(BODY)} -->\n${BODY}<!-- /block:test-rule -->\n`);
  const v = B.blocksView({ blocksDir: bdir, dirs: [{ harness: 'claude', dir: claude }, { harness: 'codex', dir: codex }], packsDir: packs });
  const b = v.blocks[0];
  ok('blocksView: the block, its text, its marker line and its counts', v.blocks.length === 1 && b.id === 'test-rule' && b.text === BODY
    && b.marker === `<!-- block:test-rule sha256:${sha(BODY)} -->` && b.counts.same === 2 && b.counts.reworded === 0 && b.counts.differs === 0, JSON.stringify(b));
  ok('…each copy with its file, line and rating, marked or not', b.copies.some((c) => c.file === 'packs/p/instructions/p.md' && c.line === 1 && c.marked)
    && b.copies.some((c) => c.file.endsWith('claude-skills/one/SKILL.md') && c.line === 5 && !c.marked), JSON.stringify(b.copies));
  ok('…and how many files it read', v.scanned.files === 5 && v.scanned.unreadable.length === 0, JSON.stringify(v.scanned));
}

/* ── the route, through a real server ───────────────────────────────── */
console.log('\nGET /api/blocks through the server (temp HOME)');
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
const home = fs.realpathSync(tempDir('acs-blocks-srv-'));
const shipped = B.loadBlocks().find((b) => b.id === 'operator-merges');
put(path.join(home, '.claude', 'skills', 'demo', 'SKILL.md'),
  `---\nname: demo\ndescription: carries a block\n---\n\nIntro line.\n\n${B.startMarker(shipped.id, shipped.body)}\n${shipped.body}<!-- /block:${shipped.id} -->\n`);
put(path.join(home, '.codex', 'skills', 'demo', 'SKILL.md'), `---\nname: demo\ndescription: carries a block\n---\n\n${shipped.body.replace('Only the operator merges.', 'Only the user merges.')}`);
const port = await freePort();
const child = track(spawn(process.execPath, [path.join(ROOT, 'server.js')], {
  cwd: ROOT, env: { HOME: home, PORT: String(port), PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, TMPDIR: os.tmpdir() }, stdio: ['ignore', 'pipe', 'pipe'],
}));
let log = '';
child.stdout.on('data', (d) => { log += d; });
child.stderr.on('data', (d) => { log += d; });
const base = `http://localhost:${port}`;
let up = false;
for (let i = 0; i < 100 && !up; i++) {
  try { up = (await fetch(`${base}/api/health`)).ok; } catch { await sleep(100); }
}
try {
  ok('the server starts', up, log.slice(-500));
  const r = await fetch(`${base}/api/blocks`);
  const body = await r.json();
  const mine = body.blocks?.find((b) => b.id === 'operator-merges');
  ok('GET answers 200 with every shipped block', r.status === 200 && body.blocks.length === B.loadBlocks().length, `${r.status} ${JSON.stringify(body).slice(0, 300)}`);
  const claudeCopy = mine?.copies.find((c) => c.file === '~/.claude/skills/demo/SKILL.md');
  const codexCopy = mine?.copies.find((c) => c.file === '~/.codex/skills/demo/SKILL.md');
  ok('the Claude skill\'s marked copy: same, at its marker line', claudeCopy?.marked && claudeCopy.rating === 'same' && claudeCopy.line === 8, JSON.stringify(mine?.copies));
  ok('the Codex skill\'s unmarked copy with one word changed: reworded', codexCopy && !codexCopy.marked && codexCopy.rating === 'reworded' && codexCopy.line === 6, JSON.stringify(mine?.copies));
  ok('the checkout\'s packs are read too', body.scanned.files > 2 && body.blocks.some((b) => b.copies.some((c) => c.file.startsWith('packs/'))), JSON.stringify(body.scanned));
  ok('no absolute home path in the answer', !JSON.stringify(body).includes(home));
  const cross = await fetch(`${base}/api/blocks`, { headers: { 'sec-fetch-site': 'same-site' } });
  ok('strict same-origin: another localhost page is refused (403)', cross.status === 403, String(cross.status));
  for (const m of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const w = await fetch(`${base}/api/blocks`, { method: m, headers: { 'content-type': 'application/json' }, body: '{}' });
    ok(`${m} /api/blocks: no such endpoint (404)`, w.status === 404, String(w.status));
  }
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const routes = [...src.matchAll(/'(GET|POST|PUT|DELETE|PATCH) (\/api\/blocks[^']*)'/g)].map((m) => `${m[1]} ${m[2]}`);
  ok('server.js declares one blocks route, and it is a GET', JSON.stringify(routes) === JSON.stringify(['GET /api/blocks']), routes.join(', '));
  const lib = fs.readFileSync(path.join(ROOT, 'lib', 'blocks.js'), 'utf8');
  ok('lib/blocks.js has no write call', !/\b(writeFile|appendFile|rename|unlink|rmSync|mkdir|copyFile|symlink|truncate|createWriteStream)\w*\(/.test(lib));
} finally {
  child.kill('SIGKILL');
}
assertRealHomesUnchanged(realBefore, ok);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
