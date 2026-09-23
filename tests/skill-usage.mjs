/**
 * The skill usage signal: what counts as an invocation, what the cache
 * promises, what the real corpus costs, and what the payload admits to.
 *
 * HOME is redirected to a temp directory BEFORE anything is imported, because
 * lib/paths.js binds HOME at module load — so the fixture corpus, the cache
 * file and the skills the route lists all live under a fake home.
 *
 * The real corpus is the one exception, and it is opened by an EXPLICIT root
 * argument rather than by resolving HOME: this suite has to prove the cost of
 * reading 1.1GB, and a fixture cannot. That read is read-only, and the
 * tripwire at the end of the file is what says so.
 *
 * NEGATIVE fixtures carry the weight here. Positive ones only confirm that the
 * counter agrees with the assumption it was written from; the string
 * `"skill":"handoff"` occurs in this corpus in prose, in a tool_result, in a
 * tool schema echoed inside a prompt snapshot, in an unrelated tool's input and
 * in a plugin's own log — five places where a grep would score a hit and an
 * invocation did not happen.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { snapshotRealHomes, assertRealHomesUnchanged } from './real-home.mjs';

const realHome = os.homedir();

/**
 * Two kinds of real root, checked two different ways — because fingerprinting a
 * LIVE agent home by mtime does not test this suite, it tests whether anything
 * else on the machine happened to tick a file while the suite ran. The live
 * harness homes are therefore compared by their SET OF ENTRY NAMES.
 *
 * ~/.claude/projects is livelier still — a session starting mid-run creates a
 * directory in it — so even names churn there for reasons that are not about
 * this code. It gets the two checks at the bottom of the file instead: nothing
 * may DISAPPEAR from it, and no file of ours may appear anywhere inside it.
 */


const realBefore = snapshotRealHomes();
const REAL_CORPUS = path.join(realHome, '.claude', 'projects');
const corpusBefore = fs.readdirSync(REAL_CORPUS);

const fakeHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acs-usage-')));
process.env.HOME = fakeHome;
process.env.ACS_SUITE = 'offline';
delete process.env.CODEX_HOME;

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'acs-usage-work-'));

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

console.log('\nskill-usage');
ok('HOME is redirected away from the real one', os.homedir() === fakeHome && fakeHome !== realHome, os.homedir());

// --- the fixture corpus ------------------------------------------------------
const H = (...p) => path.join(fakeHome, ...p);
const put = (file, body) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body); };

const CORPUS = H('.claude', 'projects');
const J = (o) => JSON.stringify(o);

/** A real one: an assistant message whose content holds a Skill tool_use block. */
const invocation = (skill, at, id) => J({
  type: 'assistant',
  timestamp: at,
  uuid: `u-${id}`,
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Skill', input: { skill, args: 'go' } }] },
});

// The five near-misses, each one a hit for a naive string match.
const proseMention = J({
  type: 'user',
  timestamp: '2026-09-10T00:00:00.000Z',
  message: { role: 'user', content: [{ type: 'text', text: 'remember that {"skill":"handoff"} is how it looks in the log' }] },
});
const toolResultEcho = J({
  type: 'user',
  timestamp: '2026-09-10T00:00:01.000Z',
  message: {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'tu-echo', content: 'ran {"skill":"handoff"} successfully' }],
  },
});
const promptSnapshot = J({
  type: 'attachment',
  timestamp: '2026-09-10T00:00:02.000Z',
  attachment: {
    type: 'prompt_snapshot',
    tools: [{ name: 'Skill', input_schema: { properties: { skill: { type: 'string' } } } }],
    systemPrompt: ['available skills: handoff, advisor. Invoke with "skill":"handoff".'],
  },
});
const otherToolUse = J({
  type: 'assistant',
  timestamp: '2026-09-10T00:00:03.000Z',
  message: {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'tu-bash', name: 'Bash', input: { command: 'grep \'"skill":"handoff"\' log.jsonl' } }],
  },
});
// A user turn that REPLAYS an assistant tool_use block — structurally identical
// to the real thing except for whose turn it is, which is the whole test.
const echoedInUserTurn = J({
  type: 'user',
  timestamp: '2026-09-10T00:00:04.000Z',
  message: { role: 'user', content: [{ type: 'tool_use', id: 'tu-replay', name: 'Skill', input: { skill: 'handoff' } }] },
});

const NEGATIVES = [proseMention, toolResultEcho, promptSnapshot, otherToolUse, echoedInUserTurn];

const A = path.join(CORPUS, '-Users-cortega-proj-one', 'aaa.jsonl');
put(A, [
  invocation('advisor', '2026-09-11T10:00:00.000Z', 'tu-1'),
  ...NEGATIVES,
  invocation('advisor', '2026-09-12T11:30:00.000Z', 'tu-2'),
  invocation('handoff', '2026-09-13T09:00:00.000Z', 'tu-3'),
  '',
].join('\n'));

// A subagent transcript, one level deeper, invoking a namespaced plugin skill.
const B = path.join(CORPUS, '-Users-cortega-proj-one', 'subagents', 'agent-x.jsonl');
put(B, [
  invocation('anthropic-skills:docx', '2026-09-14T08:00:00.000Z', 'tu-4'),
  invocation('advisor', '2026-09-15T12:00:00.000Z', 'tu-5'),
  '',
].join('\n'));

// A plugin's own log. Same directory, same extension, different schema: it
// names skills without any of them having been invoked by this harness.
put(path.join(CORPUS, '-Users-cortega-proj-two', 'vercel-plugin', 'skill-injections.jsonl'),
  [J({ event: 'skill-injection', toolName: 'Write', matchedSkills: ['handoff'], injectedSkills: ['advisor'] }), ''].join('\n'));

// A single line far past any real record, followed by a genuine invocation:
// the reader must drop the line, not the rest of the file, and not the heap.
const HUGE = path.join(CORPUS, '-Users-cortega-proj-two', 'huge.jsonl');
put(HUGE, [
  'A'.repeat(9 * 1024 * 1024),
  invocation('dumb-down', '2026-09-16T07:00:00.000Z', 'tu-6'),
  '',
].join('\n'));

// --- what counts -------------------------------------------------------------
const { readSkillUsage, attachUsage, lookupUsage, USAGE_CAVEAT } = await import('../lib/skill-usage.js');

const cacheFile = path.join(WORK, 'cache.json');
const full = () => readSkillUsage({ root: CORPUS, cache: false });
const incr = () => readSkillUsage({ root: CORPUS, cacheFile });

{
  const u = await full();
  const n = u.byName;
  ok('advisor is counted exactly three times across two transcripts',
     n.advisor && n.advisor.count === 3, J(n.advisor));
  ok('handoff is counted exactly once — the five near-misses contribute zero',
     n.handoff && n.handoff.count === 1, J(n.handoff));
  ok('…prose, a tool_result, a prompt snapshot, another tool\'s input and a replayed '
     + 'user-turn block are all excluded', n.handoff.count === 1, J(n.handoff));
  ok('a namespaced plugin skill keeps its full token',
     n['anthropic-skills:docx'] && n['anthropic-skills:docx'].count === 1, J(Object.keys(n)));
  ok('a plugin\'s skill-injections log contributes nothing',
     !n['skill-injection'] && n.handoff.count === 1, J(Object.keys(n)));
  ok('an invocation after a 9MB line is still counted', n['dumb-down']?.count === 1, J(n['dumb-down']));
  ok('…and the oversized line is reported as skipped, not silently swallowed',
     u.stats.linesSkipped === 1, String(u.stats.linesSkipped));
  ok('nothing else was counted', Object.keys(n).sort().join(',')
     === 'advisor,anthropic-skills:docx,dumb-down,handoff', Object.keys(n).sort().join(','));
  ok('lastUsedAt is the latest observation, not the first',
     n.advisor.lastUsedAt === '2026-09-15T12:00:00.000Z', n.advisor.lastUsedAt);
  ok('a skill never observed has no entry at all (absent, not zero)',
     !('techdebt' in n) && lookupUsage(n, 'techdebt') === null);
  ok('a namespaced token is findable by its bare directory name',
     lookupUsage(n, 'docx')?.count === 1, J(lookupUsage(n, 'docx')));
  ok('…and says which names it summed, so the guess is visible',
     lookupUsage(n, 'docx').matchedNames.join(',') === 'anthropic-skills:docx');
}

// --- cache semantics ---------------------------------------------------------
const shape = (u) => J(Object.fromEntries(Object.keys(u.byName).sort()
  .map((k) => [k, [u.byName[k].count, u.byName[k].lastUsedAt]])));

{
  const cold = await incr();
  ok('a cold cached run reads every transcript', cold.stats.filesScanned === cold.stats.files
     && cold.stats.filesReused === 0, J(cold.stats));
  ok('…and agrees with a full uncached scan', shape(cold) === shape(await full()));

  const warm = await incr();
  ok('a warm run re-reads nothing', warm.stats.filesScanned === 0
     && warm.stats.filesReused === warm.stats.files, J(warm.stats));
  ok('…and still agrees with a full scan', shape(warm) === shape(await full()));

  // append
  fs.appendFileSync(A, invocation('advisor', '2026-09-17T10:00:00.000Z', 'tu-7') + '\n');
  const appended = await incr();
  ok('an append is picked up and re-reads only the file that changed',
     appended.stats.filesScanned === 1, J(appended.stats));
  ok('…and the incremental result equals a fresh full scan',
     shape(appended) === shape(await full()), shape(appended));
  ok('…with the appended observation counted once', appended.byName.advisor.count === 4);

  // new transcript
  const C = path.join(CORPUS, '-Users-cortega-proj-three', 'ccc.jsonl');
  put(C, invocation('techdebt', '2026-09-18T10:00:00.000Z', 'tu-8') + '\n');
  const added = await incr();
  ok('a new transcript is found', added.byName.techdebt?.count === 1, J(added.byName.techdebt));
  ok('…and the incremental result equals a fresh full scan', shape(added) === shape(await full()));

  // deletion
  fs.rmSync(C);
  const removed = await incr();
  ok('a deleted transcript drops out of the count', !('techdebt' in removed.byName));
  ok('…and the incremental result equals a fresh full scan', shape(removed) === shape(await full()));
  ok('…and its entry is evicted from the cache file',
     !JSON.stringify(JSON.parse(fs.readFileSync(cacheFile, 'utf8')).files).includes('ccc.jsonl'));

  // changed mid-scan: a big transcript is appended to WHILE it is being read.
  // The assertion is not about which answer that race produces — it is that a
  // torn read can never be cached, so the NEXT run still equals a full scan.
  const BIG = path.join(CORPUS, '-Users-cortega-proj-four', 'big.jsonl');
  const filler = J({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'x'.repeat(4000) }] } });
  put(BIG, Array.from({ length: 4000 }, () => filler).join('\n') + '\n'
        + invocation('diagnose', '2026-09-19T10:00:00.000Z', 'tu-9') + '\n');
  await incr();
  const racing = incr();
  fs.appendFileSync(BIG, invocation('diagnose', '2026-09-19T11:00:00.000Z', 'tu-10') + '\n');
  const raced = await racing;
  ok('a scan overlapping a write returns a usable answer',
     raced.byName.diagnose.count >= 1, J(raced.byName.diagnose));
  const after = await incr();
  ok('…and the run after it still equals a fresh full scan', shape(after) === shape(await full()), shape(after));
  ok('…which now sees both observations', after.byName.diagnose.count === 2, J(after.byName.diagnose));
  ok('a corrupt cache file is discarded rather than trusted', await (async () => {
    fs.writeFileSync(cacheFile, '{not json');
    const u = await incr();
    return shape(u) === shape(await full());
  })());
}

// --- the real corpus: cost, not correctness ----------------------------------
{
  const realCache = path.join(WORK, 'real-cache.json');
  const baseRss = process.memoryUsage.rss();
  let peak = baseRss;
  const sampler = setInterval(() => { peak = Math.max(peak, process.memoryUsage.rss()); }, 20);

  const cold = await readSkillUsage({ root: REAL_CORPUS, cacheFile: realCache });
  peak = Math.max(peak, process.memoryUsage.rss());
  const warm = await readSkillUsage({ root: REAL_CORPUS, cacheFile: realCache });
  peak = Math.max(peak, process.memoryUsage.rss());
  clearInterval(sampler);

  const mb = (n) => (n / 1024 / 1024).toFixed(1);
  console.log(`  real corpus: ${cold.stats.files} transcripts, ${mb(cold.stats.bytesRead)}MB read, `
    + `${cold.stats.observations} invocations, ${cold.stats.distinctNames} names`);
  console.log(`  cold ${cold.stats.ms}ms · warm ${warm.stats.ms}ms · `
    + `rss ${mb(baseRss)}MB -> peak ${mb(peak)}MB`);

  ok('the real corpus was found and is the large one', cold.stats.files > 500, String(cold.stats.files));
  ok('…and real invocations were observed in it', cold.stats.observations > 0, String(cold.stats.observations));
  ok('the cold read streams the whole corpus', cold.stats.bytesRead > 500 * 1024 * 1024, mb(cold.stats.bytesRead));
  // 8MB per open file x 8 concurrent is the hard ceiling on buffered line data;
  // 512MB leaves room for V8's heap and still fails loudly if a whole
  // transcript — let alone the corpus — is ever read into memory at once.
  ok('peak RSS stays bounded while reading 1.1GB', peak - baseRss < 512 * 1024 * 1024,
     `${mb(baseRss)} -> ${mb(peak)}`);
  // Not "re-opens nothing": ~/.claude/projects is LIVE, and a Claude Code
  // session running while this suite does appends to its own transcript
  // between the two reads. Re-reading that file is the cache working, so the
  // assertion is the property that matters — the warm read does not re-scan
  // the corpus — with a margin for the handful of files a live machine moves.
  ok('a warm read re-scans only what actually changed',
     warm.stats.filesReused >= warm.stats.files - 5
     && warm.stats.bytesRead < cold.stats.bytesRead / 20,
     J({ reused: warm.stats.filesReused, scanned: warm.stats.filesScanned,
         files: warm.stats.files, bytes: warm.stats.bytesRead }));
  ok('…and is much faster than the cold one', warm.stats.ms * 4 < cold.stats.ms,
     `${cold.stats.ms}ms -> ${warm.stats.ms}ms`);
  // Same reason: an invocation made while the suite runs can only ADD to the
  // warm result. Nothing the cold read saw may vanish or shrink.
  ok('…and agrees with the cold result, which it may only extend',
     Object.keys(cold.byName).every((k) => warm.byName[k]
       && warm.byName[k].count >= cold.byName[k].count
       && warm.byName[k].lastUsedAt >= cold.byName[k].lastUsedAt),
     `${shape(cold)} -> ${shape(warm)}`);
  ok('the cache never lands next to the corpus it describes',
     fs.existsSync(realCache) && realCache.startsWith(WORK));
}

// --- honesty: the payload carries its own limits -----------------------------
const skillMd = (name, desc) => `---\nname: ${name}\ndescription: ${desc}\n---\n\nbody\n`;
put(H('.claude', 'skills', 'advisor', 'SKILL.md'), skillMd('Advisor', 'second brain'));
put(H('.claude', 'skills', 'techdebt', 'SKILL.md'), skillMd('Techdebt', 'never invoked here'));
// Two skills sharing one NAME and differing in content — the distortion the
// caveat exists for: one count covers both and cannot say which ran.
put(H('Documents', 'Projects', 'p1', '.claude', 'skills', 'decision', 'SKILL.md'), skillMd('Decision', 'one'));
put(H('Documents', 'Projects', 'p2', '.claude', 'skills', 'decision', 'SKILL.md'), skillMd('Decision', 'two — differs'));
// P2: a synced skill sits in a folder its author never named; it is invoked
// by its frontmatter name, which the corpus above records once (dumb-down).
put(H('.claude', 'skills', 'synced', '7c1e0a9b-2222-4444-8888-000000000000', 'x7f3', 'SKILL.md'),
    skillMd('dumb-down', 'renamed on sync'));

{
  ok('the caveat names the granularity, the harness and what never-seen means',
     USAGE_CAVEAT.granularity === 'name'
     && USAGE_CAVEAT.harnesses.join(',') === 'claude-code'
     && USAGE_CAVEAT.missingHarnesses.includes('codex') && USAGE_CAVEAT.missingHarnesses.includes('grok')
     && USAGE_CAVEAT.neverSeenMeans === 'unknown'
     && USAGE_CAVEAT.boundedBy === 'retained-claude-code-transcripts', J(USAGE_CAVEAT));

  const { listSkills, toPublic } = await import('../lib/skills.js');
  const rows = attachUsage(listSkills().map(toPublic), await full());
  const row = (name) => rows.filter((r) => r.name === name);

  ok('an observed skill carries its count and last use',
     row('advisor')[0].usage.count === 4 && row('advisor')[0].usage.lastUsedAt === '2026-09-17T10:00:00.000Z',
     J(row('advisor')[0]?.usage));
  ok('an unobserved skill is UNKNOWN, not zero',
     row('techdebt')[0].usage.observed === false && row('techdebt')[0].usage.count === null,
     J(row('techdebt')[0]?.usage));
  ok('every row carries the caveat text', rows.every((r) => r.usage.caveat === USAGE_CAVEAT.text));
  ok('rows sharing a name are marked as sharing one count',
     row('decision').length === 2 && row('decision').every((r) => r.usage.nameShared && r.usage.nameSharedWith === 2),
     J(row('decision').map((r) => r.usage)));
  ok('…and a row with a unique name is not', row('advisor')[0].usage.nameShared === false);

  const synced = row('x7f3')[0];
  ok('P2 a renamed synced dir is matched on its frontmatter name, not its folder',
     synced?.displayName === 'dumb-down' && synced.usage.observed === true && synced.usage.count === 1
       && synced.usage.matchedNames.join(',') === 'dumb-down',
     J(synced && { d: synced.displayName, u: synced.usage }));
  const fallback = attachUsage([{ name: 'advisor', displayName: 'Advisor' }], await full())[0];
  ok('P2 …and a frontmatter name with no observations falls back to the dir name',
     fallback.usage.count === 4 && fallback.usage.matchedNames.join(',') === 'advisor', J(fallback.usage));
}

// --- the route ---------------------------------------------------------------
const { createApp } = await import('../server.js');
const { server } = createApp();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://localhost:${server.address().port}`;

{
  const res = await fetch(`${BASE}/api/skills`);
  const body = await res.json();
  ok('GET /api/skills still answers 200', res.status === 200, String(res.status));
  ok('…with the usage caveat attached to the payload',
     body.usage?.available === true && body.usage.caveat?.granularity === 'name'
     && body.usage.caveat.neverSeenMeans === 'unknown', J(body.usage?.caveat));
  ok('…and the scan stats, so a UI can show how fresh the signal is',
     typeof body.usage.stats?.at === 'string' && body.usage.stats.files > 0, J(body.usage?.stats));

  const row = (name) => body.skills.filter((s) => s.name === name);
  ok('…and every row carries a usage object', body.skills.every((s) => s.usage), '');
  ok('…an observed skill reports count and lastUsedAt over HTTP',
     row('advisor')[0].usage.count === 4 && row('advisor')[0].usage.observed === true,
     J(row('advisor')[0]?.usage));
  ok('…an unobserved skill is reported as never-seen with a null count',
     row('techdebt')[0].usage.observed === false && row('techdebt')[0].usage.count === null,
     J(row('techdebt')[0]?.usage));
  ok('…and same-named rows are flagged over HTTP too',
     row('decision').every((r) => r.usage.nameShared === true), J(row('decision').map((r) => r.usage)));
}

// --- the real directories were never touched ---------------------------------
server.close();
{
  const diff = (before, after) => {
    const b = new Set((before || '').split('|'));
    const a = new Set((after || '').split('|'));
    return [...a].filter((x) => !b.has(x)).concat([...b].filter((x) => !a.has(x))).join(',')
      || 'entries added or removed';
  };
  assertRealHomesUnchanged(realBefore, ok);

  // The corpus itself is too live to compare by entry names — another session
  // creates a project directory whenever one starts, and that is not evidence
  // about this code. What IS evidence: this suite may not remove anything from
  // it, and may not leave a file of its own behind anywhere inside it.
  const corpusNow = new Set(fs.readdirSync(REAL_CORPUS));
  ok('the transcript corpus lost no entry',
     corpusBefore.every((n) => corpusNow.has(n)),
     corpusBefore.filter((n) => !corpusNow.has(n)).join(','));
  const strays = [];
  const hunt = (dir, depth = 0) => {
    if (depth > 8) return;
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      if (d.isSymbolicLink()) continue;
      if (d.isDirectory()) { hunt(path.join(dir, d.name), depth + 1); continue; }
      if (/skill-usage-cache|\.tmp$/.test(d.name)) strays.push(path.join(dir, d.name));
    }
  };
  hunt(REAL_CORPUS);
  ok('…and nothing of ours was written into it', strays.length === 0, strays.join(','));
}

fs.rmSync(fakeHome, { recursive: true, force: true });
fs.rmSync(WORK, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
