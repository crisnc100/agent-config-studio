// Fake `ps`, `lsof` and `cmux` for tests/agent-watch.mjs, chosen by argv[2]. State lives in $HOME:
// fake-ps.json is the process table, fake-lsof.json maps a pid to its open files, and every cmux call
// is appended to fake-cmux-calls.jsonl.
import fs from 'node:fs';
import path from 'node:path';
const home = process.env.HOME;
const [tool, ...args] = process.argv.slice(2);
const read = (name, fallback) => { try { return JSON.parse(fs.readFileSync(path.join(home, name), 'utf8')); } catch { return fallback; } };
if (tool === 'ps') {
  const rows = read('fake-ps.json', []);
  process.stdout.write('  PID  PPID COMMAND\n' + rows.map(r => `${String(r.pid).padStart(5)} ${String(r.ppid).padStart(5)} ${r.command}\n`).join(''));
} else if (tool === 'lsof') {
  const files = read('fake-lsof.json', {});
  fs.appendFileSync(path.join(home, 'fake-lsof-calls.jsonl'), JSON.stringify(args) + '\n');
  const pids = (args[args.indexOf('-p') + 1] || '').split(',');
  let out = '';
  for (const pid of pids) {
    if (!files[pid]) continue;
    out += `p${pid}\n`;
    for (const f of files[pid]) out += `f${f.fd}\na${f.mode}\nn${f.name}\n`;
  }
  process.stdout.write(out);
} else if (tool === 'cmux') {
  fs.appendFileSync(path.join(home, 'fake-cmux-calls.jsonl'), JSON.stringify(args) + '\n');
  if (process.env.FAKE_CMUX_FAIL) { console.error('socket unreachable'); process.exit(1); }
  if (args.includes('new-pane')) console.log(JSON.stringify({ ok: true, result: { surface_ref: 'surface:77', pane_ref: 'pane:77' } }));
  else if (args.includes('new-surface')) {
    // Each tab gets the next ref after the pane's own surface:77.
    const n = read('fake-cmux-surfaces.json', 77) + 1;
    fs.writeFileSync(path.join(home, 'fake-cmux-surfaces.json'), JSON.stringify(n));
    console.log(JSON.stringify({ ok: true, result: { surface_ref: `surface:${n}`, pane_ref: args[args.indexOf('--pane') + 1] } }));
  } else console.log('OK');
}
