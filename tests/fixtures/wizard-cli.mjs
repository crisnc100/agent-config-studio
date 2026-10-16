/**
 * A fake `claude` for the skill wizard (tests/skill-wizard-routes.mjs and the
 * QA server). No model is ever called.
 *
 * Per call it reads `mode.json` beside it, appends its argv to `calls.jsonl`,
 * saves the prompt to `prompt-<n>.txt` (n counts from 1) and `prompt.txt`,
 * and appends to `started.log`. Its init reports the tools argv asked for:
 * none for `--tools ""`, as the real CLI does — and with `--json-schema`,
 * exactly [StructuredOutput], the reply then coming back as the result
 * event's `structured_output` (probed 2026-10-16). In that mode a text reply
 * that is a JSON object becomes `{ reply: <it> }`, a draft `{ skill_md: <it> }`;
 * other text gives no structured_output.
 *
 *   script  the interview, played from the prompt: a draft turn ("TASK:
 *           DRAFT") answers `draft` with {{name}} filled in; otherwise the
 *           number of questions already asked picks `questions[n]`, and past
 *           the end a done reply naming `name`
 *   seq     `replies[n - 1]` for call n (the last one repeats): each
 *           { text, structured, initTools, mcp, code, isError, hang, tools, slow }
 *
 * `mode.noSchema` plays a claude without --json-schema: given the flag it
 * exits 1 before init, as commander does.
 *   tools   init claims [Read, Bash] whatever argv said, then lingers
 *   hang    init, then nothing (writes `pid`)
 */
import fs from 'node:fs';
import path from 'node:path';

export function wizardCli(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!${process.execPath}
const fs = require('fs');
const path = require('path');
const dir = ${JSON.stringify(path.dirname(file))};
const a = process.argv.slice(2);
if (a[0] === '--version') { console.log('9.9.9 (fake)'); process.exit(0); }
const mode = (() => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'mode.json'), 'utf8')); } catch { return {}; } })();
fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify(a) + '\\n');
const n = fs.readFileSync(path.join(dir, 'calls.jsonl'), 'utf8').split('\\n').filter(Boolean).length;
fs.appendFileSync(path.join(dir, 'started.log'), 'started\\n');
const out = (ev) => process.stdout.write(JSON.stringify(ev) + '\\n');
const exit = (code) => process.stdout.write('', () => process.exit(code));
const ti = a.indexOf('--tools');
const si = a.indexOf('--json-schema');
const schema = si !== -1 ? a[si + 1] : null;
if (schema !== null && mode.noSchema) { process.stderr.write("error: unknown option '--json-schema'\\n"); process.exit(1); }
let prompt = '';
process.stdin.on('data', (d) => { prompt += d; });
process.stdin.on('end', () => {
  fs.writeFileSync(path.join(dir, 'prompt.txt'), prompt);
  fs.writeFileSync(path.join(dir, 'prompt-' + n + '.txt'), prompt);
  fs.writeFileSync(path.join(dir, 'pid'), String(process.pid));
  let step = { text: '{}' };
  if (mode.kind === 'seq') {
    const list = mode.replies || [];
    step = list[Math.min(n - 1, list.length - 1)] || step;
  } else if (mode.kind === 'script') {
    if (/TASK: DRAFT/.test(prompt)) {
      const name = (prompt.match(/the skill named "([a-z0-9-]+)"/) || [])[1] || 'skill';
      step = { text: String(mode.draft || '').split('{{name}}').join(name) };
    } else {
      const asked = Number((prompt.match(/(\\d+) questions? ha(?:s|ve) been asked/) || [])[1] || 0);
      const q = (mode.questions || [])[asked];
      step = { text: q ? JSON.stringify({ ...q, done: false }) : JSON.stringify({ done: true, name: mode.name || 'new-skill', summary: mode.summary || 'A skill.' }) };
    }
  } else if (mode.kind === 'tools' || mode.kind === 'hang') {
    step = { [mode.kind]: true };
  }
  const tools = step.initTools || (step.tools ? ['Read', 'Bash'] : schema !== null ? ['StructuredOutput'] : (ti !== -1 && a[ti + 1] === '' ? [] : ['Read']));
  out({ type: 'system', subtype: 'init', session_id: 's1', tools, mcp_servers: step.mcp || [], permissionMode: 'default' });
  if (step.tools || step.hang) { setInterval(() => {}, 1000); return; }
  let text = String(step.text ?? '');
  let structured;
  if (schema !== null) {
    if (step.structured !== undefined) structured = step.structured;
    else if (schema.includes('skill_md')) structured = { skill_md: text };
    else { try { const o = JSON.parse(text); if (o && typeof o === 'object' && !Array.isArray(o)) structured = { reply: o }; } catch {} }
    if (structured !== undefined) text = JSON.stringify(structured);
  }
  const go = () => {
    const delta = (piece) => (schema !== null ? { type: 'input_json_delta', partial_json: piece } : { text: piece });
    for (let i = 0; i < text.length; i += 40) out({ type: 'stream_event', session_id: 's1', event: { type: 'content_block_delta', delta: delta(text.slice(i, i + 40)) } });
    out({ type: 'result', is_error: step.isError === true, result: text, ...(structured !== undefined ? { structured_output: structured } : {}), session_id: 's1' });
    exit(step.code ?? 0);
  };
  if (step.slow) setTimeout(go, step.slow); else go();
});
`, { mode: 0o755 });
  return file;
}
