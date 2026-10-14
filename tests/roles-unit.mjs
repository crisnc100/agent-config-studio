/**
 * Roles and flavor in-process (builds/model-roles R3, R8, R9, R10, R12): the
 * write boundary's history and folder cases, availability warnings,
 * where-used through roles, proposal parsing, and the Describe timeout —
 * each needs a seam the server does not expose. HOME is a temp dir, set
 * before any studio module loads; the fake `claude` never calls a model.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { snapshotRealHomes, assertRealHomesUnchanged } from './real-home.mjs';
import { describeCli } from './fixtures/describe-cli.mjs';

const realBefore = snapshotRealHomes();
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acs-roles-unit-')));
process.env.HOME = home;

const { writeRoles, rolesView, hashOf, setRole, setFlavor, _setWriteHook } = await import('../lib/roles-panel.js');
const { parseProposal, normalizeProposal, lineDiff, createDescribe, DESCRIBE_LIMITS } = await import('../lib/describe.js');
const { loadRoles, rolesUserPath } = await import('../lib/roles.js');
const { whereUsed } = await import('../lib/models-panel.js');

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const rejects = async (p) => { try { await p; return null; } catch (e) { return e; } };

console.log('\nroles unit: R3 — history failures are shown, a symlinked folder is refused');
{
  const failing = {
    recordBaseline: async () => { throw new Error('baseline exploded'); },
    record: async () => { throw new Error('history repo is read-only'); },
  };
  const file = rolesUserPath(home);
  const first = await writeRoles({ text: '{"version":1}\n', base: 'absent', message: 'test', home, hist: failing });
  ok('the write lands', first.saved === true && fs.readFileSync(file, 'utf8') === '{"version":1}\n');
  ok('…and the history failure is a warning in the response, not swallowed', first.warnings.some((w) => /not versioned in history: history repo is read-only/.test(w)) && /read-only/.test(first.historyError));
  const second = await writeRoles({ text: '{"version":1,"roles":{}}\n', base: first.base, message: 'test', home, hist: failing });
  ok('a failed baseline is a warning too', second.warnings.some((w) => /not versioned first: baseline exploded/.test(w)), JSON.stringify(second.warnings));
  const bad = await rejects(writeRoles({ text: '{"roles":{"x":{}}}', base: second.base, message: 't', home, hist: failing }));
  ok('A3 an invalid document is refused before anything is touched', bad?.status === 400 && /"use" is required/.test(bad.message) && fs.readFileSync(file, 'utf8') === '{"version":1,"roles":{}}\n');
  ok('no temp file is left behind', fs.readdirSync(path.dirname(file)).every((f) => !f.includes('.tmp-')));

  const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acs-roles-other-')));
  const linkedHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acs-roles-linked-')));
  fs.symlinkSync(other, path.join(linkedHome, '.agent-config-studio'));
  const e = await rejects(writeRoles({ text: '{"version":1}\n', base: 'absent', message: 't', home: linkedHome, hist: failing }));
  ok('a symlinked studio folder is refused', e?.status === 409 && /symlink/.test(e.message), e?.message);
  ok('…and nothing lands at its target', fs.readdirSync(other).length === 0);
  fs.rmSync(other, { recursive: true, force: true });
  fs.rmSync(linkedHome, { recursive: true, force: true });
  fs.rmSync(file);
}

console.log('\nroles unit: grade fixes — serialized writes, a pinned folder, unknown keys');
{
  const file = rolesUserPath(home);
  const quiet = { recordBaseline: async () => null, record: async () => null };
  const w0 = await writeRoles({ text: '{"version":1}\n', base: 'absent', message: 't', home, hist: quiet });
  // A is held inside its compare-and-rename (temp written, not yet renamed); B starts against the same base.
  let release;
  const held = new Promise((r) => { release = r; });
  _setWriteHook(() => { _setWriteHook(null); return held; });
  const A = writeRoles({ text: '{"version":1,"roles":{"judge":{"use":"sol"}}}\n', base: w0.base, message: 'a', home, hist: quiet });
  await new Promise((r) => setTimeout(r, 20));
  const B = writeRoles({ text: '{"version":1,"roles":{"judge":{"use":"astra"}}}\n', base: w0.base, message: 'b', home, hist: quiet });
  await new Promise((r) => setTimeout(r, 20));
  release();
  const [ra, rb] = await Promise.allSettled([A, B]);
  ok('1 two writers against one base: the first saves', ra.status === 'fulfilled' && ra.value.saved === true);
  ok('1 …the second gets 409, never a second saved:true', rb.status === 'rejected' && rb.reason.status === 409, JSON.stringify(rb.value || rb.reason?.message));
  ok('1 …and the first change is the one on disk', JSON.parse(fs.readFileSync(file, 'utf8')).roles.judge.use === 'sol');

  const dir = path.dirname(file);
  const before = fs.readFileSync(file, 'utf8');
  const cur = hashOf(before);
  // Between the folder's pin and the rename: put a different folder in its place.
  _setWriteHook(() => {
    _setWriteHook(null);
    fs.renameSync(dir, `${dir}-moved`);
    fs.mkdirSync(dir);
    fs.writeFileSync(file, before);
  });
  const e = await rejects(writeRoles({ text: '{"version":1,"roles":{"judge":{"use":"opus"}}}\n', base: cur, message: 't', home, hist: quiet }));
  ok('2 a studio folder swapped mid-write is refused', e?.status === 409 && /was replaced during the write/.test(e.message), e?.message);
  ok('2 …the folder now in its place keeps its bytes', fs.readFileSync(file, 'utf8') === before);
  ok('2 …and no temp file is left in it', fs.readdirSync(dir).every((f) => !f.includes('.tmp-')));
  // The temp went with the folder that was moved away: without renameat there is no handle left to remove it by.
  ok('2 …the moved-away folder\'s roles.json is untouched too', fs.readFileSync(path.join(`${dir}-moved`, 'roles.json'), 'utf8') === before);
  fs.rmSync(`${dir}-moved`, { recursive: true, force: true });

  // B (regrade): a history call that never returns holds only its own save.
  const stuck = { recordBaseline: async () => null, record: () => new Promise(() => {}) };
  const t1 = '{"version":1,"roles":{"judge":{"use":"haiku"}}}\n';
  const hung = writeRoles({ text: t1, base: hashOf(before), message: 'hung', home, hist: stuck });
  void hung;
  await new Promise((r) => setTimeout(r, 20));
  ok('B a save whose history record hangs has still written the file', fs.readFileSync(file, 'utf8') === t1);
  const t2 = '{"version":1,"roles":{"judge":{"use":"sonnet"}}}\n';
  const later = await Promise.race([writeRoles({ text: t2, base: hashOf(t1), message: 'later', home, hist: quiet }), new Promise((r) => setTimeout(() => r('stuck'), 3000))]);
  ok('B …and a later save still completes', later?.saved === true, JSON.stringify(later));
  const stale = await Promise.race([rejects(writeRoles({ text: t1, base: hashOf(t1), message: 'stale', home, hist: quiet })), new Promise((r) => setTimeout(() => r('stuck'), 3000))]);
  ok('B …and a stale one still answers 409', stale?.status === 409, JSON.stringify(stale?.message || stale));

  const base = hashOf(fs.readFileSync(file, 'utf8'));
  const k1 = await rejects(setRole({ name: 'judge', fields: { use: ['sol'], model: 'gpt' }, base, home }));
  ok('4 a direct role edit with an unknown key is refused, naming it', k1?.status === 400 && /roles\.judge: unknown key "model" \(allowed: use, effort, alt, note\)/.test(k1.message), k1?.message);
  const k2 = await rejects(setFlavor({ family: 'sol', fields: { brief: 'x', style: 'terse' }, base, home }));
  ok('4 …and a flavor edit too', k2?.status === 400 && /flavor\.sol: unknown key "style"/.test(k2.message), k2?.message);
  ok('4 …with nothing written', hashOf(fs.readFileSync(file, 'utf8')) === base);
  fs.rmSync(file);
}

console.log('\nroles unit: R8 — warnings, never substitution');
{
  fs.mkdirSync(path.join(home, '.agent-config-studio'), { recursive: true });
  fs.writeFileSync(path.join(home, '.agent-config-studio', 'models.json'), JSON.stringify({ models: { sol: 'Not An Id' } }));
  const v = rolesView({ home, modelRows: [
    { family: 'astra', alerts: [{ kind: 'retiring', date: '2026-12-01T00:00:00Z' }] },
    { family: 'fable', alerts: [{ kind: 'vanished' }] },
    { family: 'opus', alerts: [{ kind: 'update', candidate: 'claude-opus-6' }] },
  ] });
  const role = (n) => v.roles.find((r) => r.name === n);
  ok('a role on a retiring family is warned', role('reviewer').warnings.some((w) => /astra .* is retiring on 2026-12-01/.test(w)), JSON.stringify(role('reviewer').warnings));
  ok('a role whose alt has vanished is warned', role('advisor').warnings.some((w) => /fable .* no longer in its CLI's catalog/.test(w)));
  ok('a malformed id in the use list is warned', role('builder').warnings.some((w) => /sol resolves to "Not An Id"/.test(w)));
  ok('an update alert is not a warning (newer is not unavailable)', !role('builder').warnings.some((w) => /opus/.test(w)));
  ok('…and the role still names its own family, nothing substituted', role('reviewer').use[0] === 'astra' && role('builder').use.join() === 'opus,sol');
  fs.rmSync(path.join(home, '.agent-config-studio', 'models.json'));
}

console.log('\nroles unit: R12 — where-used maps `model-id --role` to the role\'s current family');
{
  const skill = path.join(home, '.claude', 'skills', 'demo', 'SKILL.md');
  fs.mkdirSync(path.dirname(skill), { recursive: true });
  fs.writeFileSync(skill, 'eval "$(model-id --role reviewer || true)"\nmodel-id --json --role builder\nmodel-id astra\nmodel-id --role reviewers\n');
  const astra = whereUsed('astra', { home });
  ok('astra: the direct call and the reviewer role call', astra.hits.length === 2 && astra.hits.some((h) => h.role === 'reviewer' && h.line === 1) && astra.hits.some((h) => !h.role && h.line === 3), JSON.stringify(astra.hits));
  ok('…not a longer role name that merely starts the same', !astra.hits.some((h) => h.line === 4));
  ok('opus: the builder role (its first use family)', whereUsed('opus', { home }).hits.map((h) => h.role).join() === 'builder');
  ok('sol: nothing (a later preference is not what --role prints)', whereUsed('sol', { home }).hits.length === 0);
  const r = await setRole({ name: 'reviewer', fields: { use: ['sol'] }, base: 'absent', home });
  ok('after the reviewer role moves to sol, its call moves with it', r.saved && whereUsed('sol', { home }).hits.some((h) => h.role === 'reviewer') && !whereUsed('astra', { home }).hits.some((h) => h.role));
  fs.rmSync(rolesUserPath(home));
  fs.rmSync(path.join(home, '.claude'), { recursive: true, force: true });
}

console.log('\nroles unit: R9 — parsing and normalizing a proposal');
{
  const loaded = loadRoles({ home });
  const p = (raw) => { try { return { text: parseProposal(raw, loaded) }; } catch (e) { return { error: e }; } };
  const norm = normalizeProposal({ roles: { reviewer: { use: ['astra'], effort: 'high', alt: null } }, flavor: { sol: { brief: loaded.defaults.flavor.sol.brief } } }, loaded.defaults);
  ok('fields equal to the default, and nulls that clear nothing, are dropped', JSON.stringify(norm) === '{"version":1}', JSON.stringify(norm));
  ok('`use` compares as a list (["opus"] vs ["opus","sol"] differs)', JSON.stringify(normalizeProposal({ roles: { builder: { use: ['opus'] } } }, loaded.defaults)) === '{"version":1,"roles":{"builder":{"use":["opus"]}}}');
  ok('a null that clears a default is kept', normalizeProposal({ roles: { advisor: { alt: null } } }, loaded.defaults).roles.advisor.alt === null);
  ok('the bytes are pretty JSON with a final newline', p('{"roles":{"judge":{"use":"sol"}}}').text === '{\n  "version": 1,\n  "roles": {\n    "judge": {\n      "use": "sol"\n    }\n  }\n}\n');
  ok('whitespace around the object is fine', !p('\n  {"roles":{}}  \n').error);
  ok('R9 an unlabelled ``` fence is refused (only ```json)', /single ```json fence/.test(p('```\n{}\n```').error?.message));
  ok('…and ```JSON or ```js too', /single ```json fence/.test(p('```js\n{}\n```').error?.message) && /single ```json fence/.test(p('```JSON\n{}\n```').error?.message));
  ok('…while ```json is accepted', !p('```json\n{}\n```').error);
  ok('a fence with prose after it is refused', /single ```json fence/.test(p('```json\n{}\n```\nDone.').error?.message));
  ok('a string holding a brace does not end the object early', !p('{"flavor":{"sol":{"brief":"use } and { freely"}}}').error);
  ok('every refusal is a 422 that says nothing was written', p('nope').error?.status === 422 && /Nothing was written/.test(p('nope').error.message));
  const d = lineDiff('a\nb\nc\n', 'a\nc\nd\n');
  ok('the diff shows every line of both sides', d.map((l) => l.op + l.line).join('|') === ' a|-b| c|+d');
  ok('a diff from nothing is all additions', lineDiff('', 'x\ny\n').every((l) => l.op === '+'));
}

console.log('\nroles unit: R5 — the tool-less containment rule, and the normal one unchanged');
{
  const { containmentHeld, createInitGate } = await import('../lib/containment.js');
  const { HARNESSES, composeArgv } = await import('../lib/harness.js');
  const init = (over) => ({ type: 'system', subtype: 'init', tools: [], mcp_servers: [], ...over });
  const tl = { toolless: true };
  ok('toolless: tools [] with no MCP holds', containmentHeld(init(), 'claude', tl).ok === true);
  const noMcp = init(); delete noMcp.mcp_servers;
  ok('R5 toolless: an init with no mcp_servers field is refused (must be stated, and empty)', containmentHeld(noMcp, 'claude', tl).ok === false && /no mcp_servers list/.test(containmentHeld(noMcp, 'claude', tl).why));
  const noTools = init(); delete noTools.tools;
  ok('R5 toolless: an init with no tools field is refused', containmentHeld(noTools, 'claude', tl).ok === false);
  for (const [what, over] of [['the read tool', { tools: ['Read'] }], ['any tool', { tools: ['Bash'] }], ['an MCP server', { mcp_servers: [{ name: 'x' }] }],
    ['a contradicting toolCount', { toolCount: 3 }], ['a non-list tools', { tools: 'none' }], ['a non-list mcp_servers', { mcp_servers: 'x' }]]) {
    ok(`toolless: ${what} is refused`, containmentHeld(init(over), 'claude', tl).ok === false);
  }
  ok('the normal rule is unchanged: [Read] holds, [] is refused', containmentHeld(init({ tools: ['Read'] }), 'claude').ok === true && containmentHeld(init(), 'claude').ok === false);
  ok('the init gate passes the mode through', createInitGate('claude', tl).see(init({ tools: ['Read'] })) !== null && createInitGate('claude', tl).see(init()) === null);
  const argv = (o) => composeArgv(HARNESSES.claude, { model: 'm', ...o });
  const normal = argv({});
  ok('a normal Assist argv still ends in --tools Read --strict-mcp-config', normal.slice(-3).join(' ') === '--tools Read --strict-mcp-config' && !normal.includes(''));
  const none = argv({ toolless: true });
  ok('a tool-less argv ends in --tools "" --strict-mcp-config, with no Read', JSON.stringify(none.slice(-3)) === '["--tools","","--strict-mcp-config"]' && !none.includes('Read'));
  let threw = null;
  try { composeArgv(HARNESSES.grok, { model: 'm', toolless: true }); } catch (e) { threw = e.message; }
  ok('grok has no tool-less mode: composeArgv refuses', /no tool-less mode/.test(threw || ''), threw);
}

console.log('\nroles unit: R10 — the 120 s timeout, at a test scale');
{
  const bin = describeCli(path.join(home, '.local', 'bin', 'claude'));
  fs.writeFileSync(path.join(path.dirname(bin), 'mode.json'), JSON.stringify({ kind: 'hang' }));
  ok('the shipped limits are the plan\'s', DESCRIBE_LIMITS.description === 4000 && DESCRIBE_LIMITS.outputBytes === 65536 && DESCRIBE_LIMITS.timeoutMs === 120_000);
  const d = createDescribe({ home, limits: { ...DESCRIBE_LIMITS, timeoutMs: 1500 } });
  const t0 = Date.now();
  const e = await rejects(d.describe({ description: 'x' }));
  const pid = Number(fs.readFileSync(path.join(path.dirname(bin), 'pid'), 'utf8'));
  ok('a run past the timeout is killed and refused (504)', e?.status === 504 && /timed out/.test(e.message) && Date.now() - t0 < 10_000, e?.message);
  let alive = true;
  try { process.kill(pid, 0); } catch { alive = false; }
  ok('…its process is gone', !alive);
  ok('…and the slot is free again', d.running === false);
  ok('…and nothing was written', !fs.existsSync(rolesUserPath(home)));
  fs.writeFileSync(path.join(path.dirname(bin), 'mode.json'), JSON.stringify({ kind: 'ok', reply: '{"roles":{"judge":{"use":"sol"}}}' }));
  // At the filesystem, as the failure would come: lib/describe.js calls fs.mkdtempSync on this same module.
  const realMkdtemp = fs.mkdtempSync;
  fs.mkdtempSync = (...a) => { fs.mkdtempSync = realMkdtemp; if (String(a[0]).includes('acs-describe-')) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }); return realMkdtemp(...a); };
  const flaky = createDescribe({ home });
  const e1 = await rejects(flaky.describe({ description: 'x' }));
  ok('5 a setup failure after the slot is taken (mkdtemp ENOSPC) fails that request', /ENOSPC/.test(e1?.message || ''), e1?.message);
  ok('5 …and frees the slot', flaky.running === false);
  const next = await flaky.describe({ description: 'x' }).catch((e) => e);
  ok('5 …so the next request runs, not 409', next?.id && next.status !== 409, JSON.stringify(next?.message || next?.id));
  const ttl = createDescribe({ home, now: (() => { let t = 0; return () => (t += 11 * 60_000); })() });
  fs.writeFileSync(path.join(path.dirname(bin), 'mode.json'), JSON.stringify({ kind: 'ok', reply: '{"roles":{"judge":{"use":"sol"}}}' }));
  const prop = await ttl.describe({ description: 'x' });
  const late = await rejects(ttl.accept({ id: prop.id }));
  ok('R2 a proposal past its TTL cannot be accepted (410)', late?.status === 410, late?.message);
  ok('…and wrote nothing', !fs.existsSync(rolesUserPath(home)));
}

console.log('\nroles unit: A — runContained caps the reply after the stream ends too');
{
  const { HARNESSES, runContained } = await import('../lib/harness.js');
  const bin = path.join(home, '.local', 'bin', 'claude');
  describeCli(bin);
  fs.writeFileSync(path.join(path.dirname(bin), 'mode.json'), JSON.stringify({ kind: 'bigtail' }));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'acs-cap-'));
  const run = runContained({ descriptor: HARNESSES.claude, binary: bin, opts: { model: 'm', toolless: true }, prompt: 'x', cwd, maxTextBytes: 64 * 1024 });
  const r = await run.done.then((v) => ({ resolved: v }), (e) => ({ rejected: e }));
  ok('a 100 KB last event with no newline is refused at the harness, never resolved', r.rejected?.overflow === 'text' && /more than 64 KB/.test(r.rejected.message) && !r.resolved,
     r.resolved ? `resolved with ${r.resolved.text.length} bytes` : r.rejected?.message);
  fs.rmSync(cwd, { recursive: true, force: true });
}

console.log('\nroles unit: B — a hung history git call is stopped (30 s), and the save says so');
{
  const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'acs-fake-git-'));
  fs.writeFileSync(path.join(fakeBin, 'git'), '#!/bin/sh\nexec sleep 120\n', { mode: 0o755 });
  const savedPath = process.env.PATH;
  process.env.PATH = `${fakeBin}:${savedPath}`;
  // A fresh history repo, so the first git call is the one that hangs.
  fs.rmSync(path.join(home, '.agent-config-studio'), { recursive: true, force: true });
  const t0 = Date.now();
  const r = await writeRoles({ text: '{"version":1}\n', base: 'absent', message: 't', home });
  process.env.PATH = savedPath;
  ok('the save completes once git is stopped', r.saved === true && Date.now() - t0 < 45_000, `${Date.now() - t0} ms`);
  ok('…with the timeout as its history warning', r.warnings.some((w) => /not versioned in history: history: git init did not finish within 30s and was stopped/.test(w)), JSON.stringify(r.warnings));
  fs.rmSync(fakeBin, { recursive: true, force: true });
  fs.rmSync(path.join(home, '.agent-config-studio'), { recursive: true, force: true });
}

console.log('\nroles unit: avoid — the conflict table, unknown names, merging');
{
  const { roleConflicts, avoidWarnings, mergeRoles } = await import('../lib/roles.js');
  const { newConflicts } = await import('../lib/describe.js');
  const roles = {
    builder: { use: ['opus', 'grok'] },
    reviewer: { use: ['astra'], alt: 'fable' },
    judge: { use: ['fable'] },
  };
  const table = [
    ['a family in use avoids the role', { grok: { avoid: ['builder'] } }, [{ role: 'builder', family: 'grok', slot: 'use' }]],
    ['the alt family avoids the role', { fable: { avoid: ['reviewer'] } }, [{ role: 'reviewer', family: 'fable', slot: 'alt' }]],
    ['no conflict: the avoided role does not use the family', { sol: { avoid: ['builder'] }, grok: { avoid: ['judge'] } }, []],
    ['an unknown role in avoid is no conflict', { grok: { avoid: ['nobody'] } }, []],
    ['several, in role order', { fable: { avoid: ['judge', 'reviewer'] }, opus: { avoid: ['builder'] } },
      [{ role: 'builder', family: 'opus', slot: 'use' }, { role: 'judge', family: 'fable', slot: 'use' }, { role: 'reviewer', family: 'fable', slot: 'alt' }]],
  ];
  for (const [what, flavor, want] of table) {
    const got = roleConflicts({ roles, flavor });
    ok(`conflicts: ${what}`, JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got));
  }
  const loaded = { roles, flavor: { grok: { avoid: ['builder', 'nobody'] } }, families: ['opus', 'grok', 'astra', 'fable'] };
  ok('an unknown role in avoid is a warning naming it', JSON.stringify(avoidWarnings(loaded)) === JSON.stringify(['flavor.grok.avoid names "nobody", which is not a role.']));
  ok('…and none when every name is a role', avoidWarnings({ ...loaded, flavor: { grok: { avoid: ['builder'] } } }).length === 0);

  const defaults = { roles: { builder: { use: ['opus', 'grok'] } }, flavor: { grok: { avoid: ['judge'] } } };
  const m = mergeRoles(defaults, { flavor: { grok: { avoid: ['builder'] } } });
  ok('a user avoid list replaces the default one, never concatenates', JSON.stringify(m.flavor.grok.avoid) === '["builder"]' && m.provenance.flavor.grok.avoid === 'user');
  const c = mergeRoles(defaults, { flavor: { grok: { avoid: null } } });
  ok('null clears it', c.flavor.grok.avoid === undefined && c.provenance.flavor.grok.avoid === 'cleared');

  const cur = { ...mergeRoles(defaults, { flavor: { grok: { avoid: ['builder'] } } }), defaults, error: null };
  const proposed = JSON.stringify({ version: 1, flavor: { grok: { avoid: ['builder'] }, opus: { avoid: ['builder'] } } });
  ok('a proposal reports only the conflicts it adds', JSON.stringify(newConflicts(cur, proposed)) === JSON.stringify([{ role: 'builder', family: 'opus', slot: 'use' }]));
}

assertRealHomesUnchanged(realBefore, ok);
fs.rmSync(home, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
