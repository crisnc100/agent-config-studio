import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function readText(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error('expected a regular file');
    return fs.readFileSync(fd, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
}

let output = {};
try {
  for await (const chunk of process.stdin) { /* Cursor expects the hook to wait for EOF. */ }
  const agreement = readText(path.join(os.homedir(), '.claude', 'CLAUDE.md'));
  const note = readText(new URL('cursor-note.md', import.meta.url));
  output = { additional_context: `${agreement}\n\n${note}` };
} catch {}
console.log(JSON.stringify(output));
