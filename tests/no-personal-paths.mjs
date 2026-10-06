/**
 * Nothing that ships assumes one person's machine (builds/ready-for-strangers
 * item 3, B11): no source file outside tests/ and the migration names
 * `Documents/Projects`, `Garman`, `cortega`, `/Users/`, or the maintainer's
 * own projects — and none ASSEMBLES `Documents` + `Projects` into a path
 * (path.join / path.resolve, an array joined into a path, string
 * concatenation), which a literal search alone would miss.
 *
 * Scope: every file of the checkout except .git, tests/, builds/ (the build
 * records; builds/setup-screen/commands.md is read at runtime, so it is in),
 * and public/vendor. The allowlist names each exception and why.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

const BANNED = [
  [/Documents[\\/]+Projects/, 'Documents/Projects'],
  [/garman/i, 'Garman'],
  [/cortega/i, 'cortega'],
  [/\/Users\//, '/Users/'],
  [/airflo|kylie|stellanew|dealer-portal/i, 'a maintainer project name'],
  [/\bCris\b|crisnc/i, 'the maintainer\'s name'],
];

/** Each exception: the file, what the line must contain, and why. */
const ALLOW = [
  ['lib/roots.js', "{ id: 'projects', path: path.join(home, 'Documents', 'Projects'), label: 'Projects', access: 'edit' },", 'migration: the folders ACS hardcoded before roots.json, seeded only on a machine that used it before'],
  ['lib/roots.js', "{ id: 'garman-homes', path: path.join(home, 'Documents', 'Garman-Homes'), label: 'Garman Homes', access: 'read' },", 'migration (same)'],
  ['lib/roots.js', ' * own choice; a first-time user who merely has ~/Documents/Projects has', 'the migration rule\'s own explanation'],
  ['README.md', 'git clone https://github.com/crisnc100/agent-config-studio.git', 'the repository\'s own address, which a clone needs'],
];

const SKIP_DIRS = new Set(['.git', 'node_modules', 'tests', '.tmp', '.handoffs', '.claude']);
function files(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const abs = path.join(dir, name);
    const rel = path.relative(ROOT, abs);
    const st = fs.lstatSync(abs);
    if (name === '.git') continue;   // a directory in a clone, a file in a worktree
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(name) || rel === path.join('public', 'vendor')) continue;
      if (rel === 'builds') { const c = path.join(abs, 'setup-screen', 'commands.md'); if (fs.existsSync(c)) out.push(c); continue; }
      files(abs, out);
    } else if (st.isFile()) out.push(abs);
  }
  return out;
}

/** Spans of `path.join(…)`, `path.resolve(…)`, `[…].join(…)` and `a + b` chains, as source text. */
function constructions(src) {
  const spans = [];
  const paren = (start) => {
    let depth = 0;
    for (let i = start; i < src.length; i++) {
      if (src[i] === '(' || src[i] === '[') depth++;
      else if ((src[i] === ')' || src[i] === ']') && --depth === 0) return src.slice(start, i + 1);
    }
    return src.slice(start);
  };
  for (const m of src.matchAll(/\bpath\.(?:posix\.|win32\.)?(?:join|resolve|normalize)\s*\(/g)) spans.push(paren(m.index + m[0].length - 1));
  for (const m of src.matchAll(/\[[^\]\n]*\]\s*\.join\s*\(/g)) spans.push(m[0]);
  for (const m of src.matchAll(/(['"`])[^'"`\n]*\1(?:\s*\+\s*(?:(['"`])[^'"`\n]*\2|[\w.]+))+/g)) spans.push(m[0]);
  return spans;
}
const assembles = (span) => /(['"`])Documents\1/.test(span) && /(['"`])Projects\1/.test(span)
  || /(['"`])Documents[\\/]?\1/.test(span) && /(['"`])[\\/]?Projects/.test(span);

// The detector, on planted cases first: a blind sweep would pass vacuously.
const PLANTED = [
  ["path.join(home, 'Documents', 'Projects')", true],
  ["path.resolve(os.homedir(), \"Documents\", 'Projects', 'x')", true],
  ["['Documents', 'Projects'].join(path.sep)", true],
  ["home + '/' + 'Documents' + '/' + 'Projects'", true],
  ["'Documents/' + 'Projects'", true],
  ["const CANDIDATES = ['Documents', 'Projects', 'code'];", false],
  ["path.join(home, 'Documents')", false],
];
for (const [code, want] of PLANTED) {
  ok(`the detector ${want ? 'catches' : 'lets through'} ${code}`, constructions(code).some(assembles) === want);
}
ok('the detector catches the literal', BANNED[0][0].test('~/Documents/Projects/x'));

const hits = [];
const all = files(ROOT);
for (const abs of all) {
  const rel = path.relative(ROOT, abs);
  const buf = fs.readFileSync(abs);
  if (buf.includes(0)) continue;
  const src = buf.toString('utf8');
  const allowed = (line) => ALLOW.some(([f, text]) => f === rel && line.includes(text));
  src.split('\n').forEach((line, i) => {
    if (allowed(line)) return;
    for (const [re, what] of BANNED) if (re.test(line)) hits.push(`${rel}:${i + 1} names ${what}: ${line.trim().slice(0, 120)}`);
  });
  for (const span of constructions(src)) {
    if (!assembles(span)) continue;
    if (ALLOW.some(([f, text]) => f === rel && text.includes(span))) continue;
    const line = src.slice(0, src.indexOf(span)).split('\n').length;
    hits.push(`${rel}:${line} assembles Documents + Projects: ${span.slice(0, 120)}`);
  }
}
ok(`${all.length} shipped files: no personal path, name or folder assembled from Documents + Projects`, hits.length === 0, `\n    ${hits.join('\n    ')}`);
ok('the README is in scope', all.some((f) => path.relative(ROOT, f) === 'README.md'));
ok('every allowlist entry still matches a line (no stale exceptions)',
   ALLOW.every(([f, text]) => fs.readFileSync(path.join(ROOT, f), 'utf8').includes(text)));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
