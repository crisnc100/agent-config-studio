/**
 * Criterion 9: the suite never touches the real config trees.
 *
 *   node tests/real-home.mjs save <file>    (first thing verify.sh does)
 *   node tests/real-home.mjs check <file>   (last thing)
 *
 * Hashes every file under the real ~/.agent-config-studio, ~/.claude/skills and
 * ~/.codex/skills (symlinks by target, not followed) and fails on any change.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();
const ROOTS = ['.agent-config-studio', '.claude/skills', '.codex/skills'].map((r) => path.join(HOME, r));

function snapshot() {
  const out = {};
  const walk = (dir) => {
    let names;
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const name of names) {
      const abs = path.join(dir, name);
      const st = fs.lstatSync(abs);
      if (st.isSymbolicLink()) out[abs] = `link:${fs.readlinkSync(abs)}`;
      else if (st.isDirectory()) walk(abs);
      else if (st.isFile()) out[abs] = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
    }
  };
  for (const r of ROOTS) walk(r);
  return out;
}

const [cmd, file] = process.argv.slice(2);
if (cmd === 'save') {
  fs.writeFileSync(file, JSON.stringify(snapshot()));
} else if (cmd === 'check') {
  const before = JSON.parse(fs.readFileSync(file, 'utf8'));
  const after = snapshot();
  const diff = [];
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (before[k] !== after[k]) diff.push(`${before[k] === undefined ? 'added' : after[k] === undefined ? 'removed' : 'changed'} ${k}`);
  }
  console.log('\nreal-home');
  if (diff.length) {
    console.log(`  FAIL the real config trees changed during the run:\n    ${diff.slice(0, 20).join('\n    ')}`);
    console.log('\n0 passed, 1 failed\n');
    process.exit(1);
  }
  console.log(`  ok   ${Object.keys(after).length} files under ~/.agent-config-studio, ~/.claude/skills, ~/.codex/skills are byte-identical`);
  console.log('\n1 passed, 0 failed\n');
} else {
  console.error('usage: real-home.mjs save|check <file>');
  process.exit(2);
}
