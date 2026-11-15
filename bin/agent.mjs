#!/usr/bin/env node
import { context, openWorker, waitWorker, sendWorker, answerWorker, closeWorker, listWorkers } from '../lib/agent.js';
const usage = 'usage: agent open <family> [--effort e] [--cwd d] [--role r] [--mcp] (--prompt-file f | "task") [--json]\n       agent wait <id> [--timeout seconds] [--stall-after seconds] [--command-after seconds] [--json]\n       agent send <id> "text" | answer <id> | close <id> | list [--json]';
const argv = process.argv.slice(2);
async function main() {
  if (argv.includes('--help') || argv.includes('-h')) { console.log(usage); return 0; }
  const json = argv.includes('--json');
  const args = argv.filter(a => a !== '--json');
  const cmd = args.shift();
  const opts = {}, pos = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const flag = args[i];
      if (cmd === 'open' && flag === '--mcp') { opts.mcp = true; continue; }
      const allowed = cmd === 'open' ? ['--effort', '--cwd', '--role', '--prompt-file'] : cmd === 'wait' ? ['--timeout', '--stall-after', '--command-after'] : [];
      if (!allowed.includes(flag) || args[i + 1] === undefined) throw Object.assign(new Error(usage), { exitCode: 2 });
      opts[flag === '--prompt-file' ? 'promptFile' : flag.slice(2)] = args[++i];
    } else pos.push(args[i]);
  }
  const ctx = context();
  if (cmd === 'open' && (pos.length === 2 && !opts.promptFile || pos.length === 1 && opts.promptFile)) {
    const w = await openWorker(pos[0], { ...opts, prompt: pos[1] }, ctx);
    console.log(json ? JSON.stringify(w) : w.id); return 0;
  }
  if (cmd === 'wait' && pos.length === 1) {
    const timeout = opts.timeout === undefined ? 600 : Number(opts.timeout);
    if (!Number.isFinite(timeout) || timeout < 0) throw Object.assign(new Error('invalid timeout'), { exitCode: 2 });
    const stallAfter = opts['stall-after'] === undefined ? 300 : Number(opts['stall-after']);
    if (!Number.isFinite(stallAfter) || stallAfter < 0) throw Object.assign(new Error('invalid stall-after'), { exitCode: 2 });
    const commandAfter = opts['command-after'] === undefined ? 600 : Number(opts['command-after']);
    if (!Number.isFinite(commandAfter) || commandAfter < 0) throw Object.assign(new Error('invalid command-after'), { exitCode: 2 });
    const r = await waitWorker(pos[0], timeout, ctx, { stallAfter, commandAfter });
    const details = r.prompt || r.input || r.text || r.command || r.steps?.join('\n');
    console.log(json ? JSON.stringify(r) : r.state + (details ? `\n${details}` : ''));
    return { done: 0, stuck: 3, timeout: 4, unsent: 5, no_start: 6, stalled: 7, closed: 8, long_command: 9 }[r.state];
  }
  if (cmd === 'send' && pos.length === 2) {
    const r = await sendWorker(pos[0], pos[1], ctx);
    console.log(json ? JSON.stringify(r) : 'sent'); return 0;
  }
  if (cmd === 'answer' && pos.length === 1) {
    const answer = answerWorker(pos[0], ctx);
    process.stdout.write(json ? JSON.stringify({ id: pos[0], answer }) + '\n' : answer); return 0;
  }
  if (cmd === 'close' && pos.length === 1) {
    const w = closeWorker(pos[0], ctx);
    console.log(json ? JSON.stringify(w) : 'closed'); return 0;
  }
  if (cmd === 'list' && !pos.length) {
    const workers = listWorkers(ctx);
    console.log(json ? JSON.stringify(workers) : workers.map(w => `${w.id} ${w.family} ${w.status}`).join('\n')); return 0;
  }
  throw Object.assign(new Error(usage), { exitCode: 2 });
}
try { process.exitCode = await main(); }
catch (e) { process.stderr.write(`${e.message}\n`); process.exitCode = e.exitCode || 1; }
