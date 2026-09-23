/**
 * Which live-change events the page treats as its own writes
 * (public/own-writes.js). The page script is loaded into a VM context, as the
 * browser loads it, so the logic tested is the logic shipped.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ctx = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(ROOT, 'public', 'own-writes.js'), 'utf8'), ctx);

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
console.log('\nown writes');

let t = 1_000;
const own = ctx.createOwnWrites(() => t);

// The grader's repro: a bulk empty-slug trash where one slug was skipped, and
// someone else drops OUTSIDE.md under that skipped slug meanwhile.
const accepted = {
  steps: [{ type: 'trash', path: '~/.claude/projects/-a-empty-one', done: true }],
  skipped: ['~/.claude/projects/-a-empty-two/: memory/ now holds 1 file'],
};
own.expect(ctx.appliedPaths(accepted));
ok('the trashed slug itself is recognised as our own change', own.has('~/.claude/projects/-a-empty-one')
   && own.has('~/.claude/projects/-a-empty-one/'));
ok('a file OUTSIDE.md dropped under the SKIPPED slug is still announced', !own.has('~/.claude/projects/-a-empty-two/memory/OUTSIDE.md'));
ok('…and so is one under the trashed slug: exact paths only, no descendants', !own.has('~/.claude/projects/-a-empty-one/memory/OUTSIDE.md'));

const factTrash = { steps: [
  { type: 'trash', path: '~/p/memory/fact.md', done: true },
  { type: 'edit-index', path: '~/p/memory/MEMORY.md', done: false },
] };
const own2 = ctx.createOwnWrites(() => t);
own2.expect(ctx.appliedPaths(factTrash));
ok('Accept registers only the steps that ran to done', own2.has('~/p/memory/fact.md') && !own2.has('~/p/memory/MEMORY.md'));

const restored = { steps: [
  { type: 'trash', path: '~/p/memory/fact.md', done: true, restored: true, undone: true },
  { type: 'edit-index', path: '~/p/memory/MEMORY.md', done: true, restored: true, undone: false },
] };
const own3 = ctx.createOwnWrites(() => t);
own3.expect(ctx.undonePaths(restored));
ok('Restore registers only the steps it actually undid', own3.has('~/p/memory/fact.md') && !own3.has('~/p/memory/MEMORY.md'));
ok('a refused or empty response registers nothing', ctx.appliedPaths(undefined).length === 0 && ctx.undonePaths({}).length === 0);

own.expect(['~/x.md'], 5_000);
t += 4_999;
ok('a registration holds for its window', own.has('~/x.md'));
t += 2;
ok('…and lapses after it', !own.has('~/x.md'));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
