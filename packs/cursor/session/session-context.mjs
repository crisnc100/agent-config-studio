import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ACS reads the next line to tell an installed hook that serves ~/.cursor/acs-note.md from an older one; keep it.
// acs:cursor-local-note

// O_NONBLOCK and the regular-file check keep a FIFO or device at either path from hanging session start.
function readText(file, localNote = false) {
  const flags = fs.constants.O_RDONLY | fs.constants.O_NONBLOCK;
  const fd = fs.openSync(file, localNote ? flags | fs.constants.O_NOFOLLOW : flags);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error('the path is not a regular file');
    if (localNote && stat.nlink !== 1) throw new Error('the file has hard links');
    return fs.readFileSync(fd, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function refusalReason(error) {
  if (error.code === 'ELOOP' || error.code === 'EMLINK') return 'the path is a symbolic link';
  if (error.code === 'EACCES' || error.code === 'EPERM') return 'permission denied';
  return error.code ? `the file could not be read (${error.code})` : error.message.replace(/\s+/g, ' ');
}

// Any failure leaves {}: the session starts without the agreement instead of failing.
let output = {};
try {
  for await (const chunk of process.stdin) { /* Cursor expects the hook to wait for EOF. */ }
  const agreement = readText(path.join(os.homedir(), '.claude', 'CLAUDE.md'));
  // ~/.cursor/acs-note.md replaces the installed note when it is there. One that is refused (a link, not a
  // regular file, a hard link, unreadable) is skipped with a line saying so; the agreement is still served.
  let note;
  let skipped;
  try { note = readText(path.join(os.homedir(), '.cursor', 'acs-note.md'), true); }
  catch (error) {
    if (error.code !== 'ENOENT') skipped = `Local session note skipped because ${refusalReason(error)}.`;
    try { note = readText(new URL('cursor-note.md', import.meta.url)); }
    catch (fallbackError) { if (!skipped) throw fallbackError; }
  }
  let context = note === undefined ? agreement : `${agreement}\n\n${note}`;
  if (skipped) context += `${context.endsWith('\n') ? '' : '\n'}${skipped}\n`;
  output = { additional_context: context };
} catch {}
console.log(JSON.stringify(output));
