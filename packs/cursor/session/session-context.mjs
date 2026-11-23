import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// O_NONBLOCK and the regular-file check keep a FIFO or device at either path from hanging session start.
function readText(file, localNote = false) {
  const flags = fs.constants.O_RDONLY | fs.constants.O_NONBLOCK;
  const fd = fs.openSync(file, localNote ? flags | fs.constants.O_NOFOLLOW : flags);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || (localNote && stat.nlink !== 1)) throw new Error('expected a regular file');
    return fs.readFileSync(fd, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
}

// Any failure leaves {}: the session starts without the agreement instead of failing.
let output = {};
try {
  for await (const chunk of process.stdin) { /* Cursor expects the hook to wait for EOF. */ }
  const agreement = readText(path.join(os.homedir(), '.claude', 'CLAUDE.md'));
  let note;
  try { note = readText(path.join(os.homedir(), '.cursor', 'acs-note.md'), true); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    note = readText(new URL('cursor-note.md', import.meta.url));
  }
  output = { additional_context: `${agreement}\n\n${note}` };
} catch {}
console.log(JSON.stringify(output));
