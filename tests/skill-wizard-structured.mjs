/**
 * The skill wizard's structured turns: the init gate's structured mode, the
 * argv it spawns with, the reply read from `structured_output`, a refused
 * reply carried back capped, and the text fallback for a claude without
 * --json-schema. In-process, HOME a temp dir holding a fake `claude`
 * (tests/fixtures/wizard-cli.mjs); no model is called.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { snapshotRealHomes, assertRealHomesUnchanged } from './real-home.mjs';
import { wizardCli } from './fixtures/wizard-cli.mjs';

const realBefore = snapshotRealHomes();
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acs-wizard-structured-')));
process.env.HOME = home;

const { containmentHeld, createInitGate } = await import('../lib/containment.js');
const { HARNESSES, composeArgv, argvIncludes, runContained, createStreamDecoder } = await import('../lib/harness.js');
const W = await import('../lib/skill-wizard.js');

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const rejects = async (p) => { try { await p; return null; } catch (e) { return e; } };
const throwsWith = (fn) => { try { fn(); return null; } catch (e) { return e; } };

const init = (over = {}) => ({ type: 'system', subtype: 'init', tools: ['StructuredOutput'], mcp_servers: [], permissionMode: 'default', ...over });
const ST = { structured: true };
const TL = { toolless: true };

console.log('\nthe init gate: structured mode');
{
  ok('tools [StructuredOutput], no MCP → holds', containmentHeld(init(), 'claude', ST).ok === true);
  for (const [what, over] of [
    ['tools [] (the CLI dropped the schema)', { tools: [] }],
    ['tools [StructuredOutput, Read]', { tools: ['StructuredOutput', 'Read'] }],
    ['tools [Read]', { tools: ['Read'] }],
    ['tools [Bash]', { tools: ['Bash'] }],
    ['an MCP server', { mcp_servers: [{ name: 'gmail', status: 'connected' }] }],
    ['no mcp_servers list', { mcp_servers: undefined }],
    ['toolCount 2', { toolCount: 2 }],
    ['no tools list', { tools: undefined }],
  ]) {
    const held = containmentHeld(init(over), 'claude', ST);
    ok(`refused: ${what}`, held.ok === false, held.why);
  }
  ok('grok has no structured mode → refused', containmentHeld(init(), 'grok', ST).ok === false);
  ok('tool-less and structured at once → refused', containmentHeld(init({ tools: [] }), 'claude', { toolless: true, structured: true }).ok === false);
  ok('plain tool-less still wants tools []: [StructuredOutput] is refused', containmentHeld(init(), 'claude', TL).ok === false);
  ok('…and tools [] still holds for it', containmentHeld(init({ tools: [] }), 'claude', TL).ok === true);
  const gate = createInitGate('claude', ST);
  ok('the gate lets a structured init through', gate.see(init()) === null && gate.init);
  const bad = createInitGate('claude', ST);
  ok('…and stops one that lists Read beside it', /want only StructuredOutput/.test(bad.see(init({ tools: ['StructuredOutput', 'Read'] })) || ''));
}

console.log('\nargv: the structured turn');
{
  const schema = W.interviewSchema();
  const argv = composeArgv(HARNESSES.claude, { model: 'm', structured: schema });
  const at = argv.indexOf('--json-schema');
  ok('--json-schema carries the schema as JSON', at !== -1 && JSON.stringify(JSON.parse(argv[at + 1])) === JSON.stringify(schema));
  ok('…with the structured containment: no builtins, strict MCP', argvIncludes(argv, HARNESSES.claude.structured.containment) && argv[argv.indexOf('--tools') + 1] === '' && argv.includes('--strict-mcp-config'));
  ok('a tool-less turn never gets the flag', !composeArgv(HARNESSES.claude, { model: 'm', toolless: true }).includes('--json-schema'));
  ok('grok has no structured mode: composeArgv refuses', /no structured mode/.test(throwsWith(() => composeArgv(HARNESSES.grok, { model: 'm', structured: schema }))?.message || ''));
  ok('tool-less and structured at once: refused', /not both/.test(throwsWith(() => composeArgv(HARNESSES.claude, { model: 'm', structured: schema, toolless: true }))?.message || ''));
  ok('a schema that is not an object: refused', /as an object/.test(throwsWith(() => composeArgv(HARNESSES.claude, { model: 'm', structured: '{}' }))?.message || ''));
}

console.log('\nthe decoder reads structured_output, and drops it on a refusal');
{
  const lines = (evs) => evs.map((e) => JSON.stringify(e) + '\n').join('');
  const reply = { reply: { done: false, question: 'Keep "house style" and {braces}?', recommended: 'Yes' } };
  const d = createStreamDecoder({ harness: 'claude', structured: true });
  d.push(lines([init(), { type: 'result', result: JSON.stringify(reply), structured_output: reply }]));
  const r = d.finish();
  ok('structured is the result event\'s structured_output', JSON.stringify(r.structured) === JSON.stringify(reply) && !r.refused);
  let why = null;
  const d2 = createStreamDecoder({ harness: 'claude', structured: true, onRefuse: (w) => { why = w; } });
  d2.push(lines([init({ tools: [] }), { type: 'result', result: '{}', structured_output: reply }]));
  const r2 = d2.finish();
  ok('an init with tools [] refuses, and nothing structured survives', why && r2.structured === null && r2.text === '');
}

const bin = wizardCli(path.join(home, '.local', 'bin', 'claude'));
const binDir = path.dirname(bin);
const setMode = (mode) => {
  fs.writeFileSync(path.join(binDir, 'mode.json'), JSON.stringify(mode));
  fs.rmSync(path.join(binDir, 'calls.jsonl'), { force: true });
};
const calls = () => { try { return fs.readFileSync(path.join(binDir, 'calls.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const GOOD = { done: false, question: 'Should it keep "house style" and {placeholders} like {"a": 1} untouched?', why: 'It decides "what" changes.', recommended: 'Keep them: say "untouched" }', choices: ['Keep "as is"', 'Rewrite {x}'] };
const draftFor = (name) => `---\nname: ${name}\ndescription: "Formats SQL. Use when the user says \\"pretty SQL\\"."\n---\n\nKeep {placeholders} and "quoted" names as they are.\n`;

console.log('\nrunContained against the fake claude, structured');
{
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'acs-structured-run-'));
  const run = (step) => {
    setMode({ kind: 'seq', replies: [step] });
    return runContained({ descriptor: HARNESSES.claude, binary: bin, opts: { model: 'm', structured: W.interviewSchema() }, prompt: 'x', cwd, maxTextBytes: 192 * 1024 }).done;
  };
  const r = await run({ text: JSON.stringify(GOOD) });
  ok('init [StructuredOutput] proceeds; the reply is the structured object', r.structured?.reply?.question === GOOD.question && r.init?.tools?.join() === 'StructuredOutput');
  ok('…spawned with --json-schema', calls()[0].includes('--json-schema'));
  for (const [what, step] of [
    ['init []', { text: JSON.stringify(GOOD), initTools: [] }],
    ['init [StructuredOutput, Read]', { text: JSON.stringify(GOOD), initTools: ['StructuredOutput', 'Read'] }],
    ['an MCP server in init', { text: JSON.stringify(GOOD), mcp: [{ name: 'gmail', status: 'connected' }] }],
  ]) {
    const e = await rejects(run(step));
    ok(`${what} → refused before the reply is used`, e?.refused === true && e.status === 502, e?.message);
  }
  fs.rmSync(cwd, { recursive: true, force: true });
}

console.log('\nthe wizard, default backend: structured turns');
const desc = 'Format SQL the way I like it.';
const base = { wizardId: 'c'.repeat(16), description: desc, answers: [] };
const logged = [];
const realError = console.error;
console.error = (...a) => { logged.push(a.join(' ')); };
try {
  {
    setMode({ kind: 'seq', replies: [{ text: JSON.stringify(GOOD) }] });
    const r = await W.createSkillWizard().turn({ ...base, seq: 1, kind: 'question' });
    ok('a reply whose strings hold quotes and braces parses (the original bug class)', r.kind === 'question' && r.question === GOOD.question && r.recommended === GOOD.recommended && r.choices[0] === 'Keep "as is"', JSON.stringify(r));
    const argv = calls()[0];
    ok('the wizard spawned with --json-schema and the structured containment', argv.includes('--json-schema') && argv[argv.indexOf('--tools') + 1] === '' && argv.includes('--strict-mcp-config'));
    ok('…the interview schema, under "reply"', JSON.parse(argv[argv.indexOf('--json-schema') + 1]).required.join() === 'reply');
  }
  {
    setMode({ kind: 'seq', replies: [{ structured: { reply: { done: true, name: 'pretty-sql', summary: 'Formats "pretty SQL" {x}.' } } }] });
    const r = await W.createSkillWizard().turn({ ...base, seq: 2, kind: 'question' });
    ok('done comes back from the structured reply', r.kind === 'done' && r.name === 'pretty-sql' && r.summary === 'Formats "pretty SQL" {x}.');
  }
  {
    setMode({ kind: 'seq', replies: [{ text: draftFor('pretty-sql') }] });
    const r = await W.createSkillWizard().turn({ ...base, seq: 3, kind: 'draft', name: 'pretty-sql' });
    ok('a draft comes back from {skill_md}, validated as before', r.kind === 'draft' && r.content === draftFor('pretty-sql'), JSON.stringify(r).slice(0, 200));
    ok('…spawned with the draft schema', JSON.parse(calls()[0][calls()[0].indexOf('--json-schema') + 1]).required.join() === 'skill_md');
  }
  {
    setMode({ kind: 'seq', replies: [{ structured: { reply: { ...GOOD, path: '~/.ssh' } } }, { structured: { reply: GOOD } }] });
    const r = await W.createSkillWizard().turn({ ...base, seq: 4, kind: 'question' });
    ok('the parser still checks the structured object: an extra key is refused, then retried once', r.kind === 'question' && calls().length === 2);
  }
  {
    setMode({ kind: 'seq', replies: [{ structured: { skill_md: draftFor('other-name') } }] });
    const e = await rejects(W.createSkillWizard().turn({ ...base, seq: 5, kind: 'draft', name: 'pretty-sql' }));
    ok('a structured draft naming another skill is refused twice', e?.status === 502 && /refused twice/.test(e.message) && calls().length === 2);
    ok('…and the error carries the raw reply', typeof e.payload?.reply === 'string' && e.payload.reply.includes('other-name') && e.payload.replyCut === false);
  }
  {
    logged.length = 0;
    const long = { reply: { ...GOOD, question: `${'q'.repeat(5000)}?` } };
    setMode({ kind: 'seq', replies: [{ structured: long }] });
    const e = await rejects(W.createSkillWizard().turn({ ...base, seq: 6, kind: 'question' }));
    ok('a refused reply comes back capped at 4 KB, marked cut', e?.payload?.refused === true && Buffer.byteLength(e.payload.reply) <= 4096 && e.payload.replyCut === true && e.payload.reply.startsWith('{'));
    ok('…and each refusal is one stderr line with the reason, no prompt', logged.length === 2 && logged.every((l) => /^skill wizard: question reply refused \(attempt [12] of 2, structured\): "question" is longer than 300/.test(l) && !l.includes(desc)), JSON.stringify(logged));
  }
  {
    setMode({ kind: 'seq', replies: [{ text: 'I cannot call the tool' }] });
    const e = await rejects(W.createSkillWizard().turn({ ...base, seq: 7, kind: 'question' }));
    ok('no structured_output at all → refused twice, the text kept as the reply', /no structured reply/.test(e?.message || '') && e.payload.reply === 'I cannot call the tool');
  }

  console.log('\nthe fallback: a claude without --json-schema');
  {
    logged.length = 0;
    setMode({ kind: 'seq', noSchema: true, replies: [{ text: JSON.stringify(GOOD) }] });
    const r = await W.createSkillWizard().turn({ ...base, seq: 8, kind: 'question' });
    const c = calls();
    ok('the flag is refused by the CLI, and the turn reruns as text', r.kind === 'question' && r.question === GOOD.question && c.length === 2 && c[0].includes('--json-schema') && !c[1].includes('--json-schema'));
    ok('…tool-less, as before', c[1][c[1].indexOf('--tools') + 1] === '');
    ok('…and says so on stderr', logged.some((l) => /does not take --json-schema/.test(l)));
    setMode({ kind: 'seq', noSchema: true, replies: [{ text: JSON.stringify(GOOD) }] });
    await W.createSkillWizard().turn({ ...base, seq: 9, kind: 'question' });
    ok('the answer is remembered: the next turn goes straight to text', calls().length === 1 && !calls()[0].includes('--json-schema'));
  }
  {
    const broken = '{"question": "Should it keep "house style" untouched?", "recommended": "Yes", "done": false}';
    setMode({ kind: 'seq', noSchema: true, replies: [{ text: broken }, { text: JSON.stringify(GOOD) }] });
    const r = await W.createSkillWizard().turn({ ...base, seq: 10, kind: 'question' });
    const retry = fs.readFileSync(path.join(binDir, 'prompt.txt'), 'utf8');
    ok('text: an unescaped quote is refused, and the retry says to escape quotes', r.kind === 'question' && /refused \(it is not valid JSON \(.*; a double quote inside a string must be escaped as \\"\)\)/.test(retry) && /every double quote inside a string escaped as \\"/.test(retry), retry.split('\n').find((l) => l.startsWith('ACS NOTE')));
    ok('…the refusal does not quote the reply back', !/ACS NOTE[^\n]*house style/.test(retry));
  }
  {
    setMode({ kind: 'seq', noSchema: true, replies: [{ text: '```json\n' + JSON.stringify(GOOD) + '\n```' }] });
    const r = await W.createSkillWizard().turn({ ...base, seq: 11, kind: 'question' });
    ok('text: a valid reply (one ```json fence) passes', r.kind === 'question' && r.why === GOOD.why);
  }
  {
    const e = W.parseQuestion.bind(null);
    const unescaped = throwsWith(() => e('{"question": "Say "hi" now?", "recommended": "x"}'));
    ok('parseQuestion: an unescaped quote names the escape', unescaped?.refusal === true && /must be escaped as \\"/.test(unescaped.message), unescaped?.message);
    const truncated = throwsWith(() => e('{"question": "Cut off'));
    ok('parseQuestion: a truncated reply is refused as invalid JSON', truncated?.refusal === true && /not valid JSON/.test(truncated.message));
    const trailing = throwsWith(() => e(JSON.stringify(GOOD) + ' and more'));
    ok('parseQuestion: text after a whole object is still "text outside"', /text outside/.test(trailing?.message || ''));
    ok('parseQuestion: JSON.parse decides — braces and escaped quotes in strings pass', e(JSON.stringify(GOOD)).question === GOOD.question);
  }
} finally {
  console.error = realError;
  fs.rmSync(home, { recursive: true, force: true });
}

assertRealHomesUnchanged(realBefore, ok);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
