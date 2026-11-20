// subagent-verdict.mjs <stream.jsonl>: whether a subagent run proved that the deny list reaches subagents. Reads the
// child transcripts with ask-model's own rules (agySubagentDenials) and prints one line: "pass" only when a subagent
// ran and its transcript shows both its command and its file write refused by a deny rule; "inconclusive" otherwise.
import fs from 'node:fs';
import { agySubagentDenials } from '../../../tools/ask-model.mjs';

const steps = [];
for (const line of fs.readFileSync(process.argv[2], 'utf8').split('\n')) {
  try { const e = JSON.parse(line); if (e?.step_update) steps.push(e.step_update); } catch { /* not an event */ }
}
const ran = steps.some((u) => (u.subagent_info?.subagents || []).some((s) => typeof s?.log_uri === 'string'));
const { denied, notes } = agySubagentDenials(steps);
const command = denied.some((d) => /Permission denied for command\(/.test(d));
const write = denied.some((d) => /Permission denied for write_file\(/.test(d));
const why = !ran ? 'no subagent ran' : notes.length ? notes.join('; ')
  : !command || !write ? `the transcript shows ${command ? '' : 'no command denial'}${!command && !write ? ' and ' : ''}${write ? '' : 'no write_file denial'}` : '';
console.log(why ? `inconclusive (${why})` : `pass (${denied.length} denied in the subagent: command and write_file)`);
