/**
 * The `node --check` step of ci.yml's syntax job, taken from ci.yml itself
 * and run with bash against fixture trees. It must fail on a syntax error in
 * any file, not only the first one `node --check` is handed (given several
 * files it checks the first and passes the rest to it as arguments), and it
 * must fail when it finds nothing to check.
 *
 * Node 20.0.0 runs this in CI: no API newer than that.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './fixtures/cleanup.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CI = path.join(ROOT, '.github', 'workflows', 'ci.yml');

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

/** The `run: |` block of the step named `name`, dedented; null when ci.yml has no such step. */
export function stepScript(text, name) {
  const lines = text.split('\n');
  const at = lines.findIndex((l) => l.trim() === `- name: ${name}`);
  if (at === -1) return null;
  const stepIndent = lines[at].indexOf('-');
  for (let i = at + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() && (l.search(/\S/) <= stepIndent)) return null;
    const m = l.match(/^(\s*)run:\s*\|\s*$/);
    if (!m) continue;
    const body = [];
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() && lines[j].search(/\S/) <= m[1].length) break;
      body.push(lines[j]);
    }
    const indent = Math.min(...body.filter((b) => b.trim()).map((b) => b.search(/\S/)));
    return body.map((b) => b.slice(indent)).join('\n').trimEnd() + '\n';
  }
  return null;
}

const script = stepScript(fs.readFileSync(CI, 'utf8'), 'node --check');
console.log('\nci.yml syntax step');
ok('ci.yml has a `node --check` step with a run block that checks server.js and the source folders', !!script
  && /node --check server\.js/.test(script) && /\bfind\b/.test(script), script || 'no step');

const DIRS = ['lib', 'tests', 'public', 'bin', 'packs', 'tools'];
function tree({ bad = null, files = true } = {}) {
  const root = tempDir('acs-syntax-');
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}\n');
  fs.writeFileSync(path.join(root, 'server.js'), 'export const ok = 1;\n');
  for (const d of DIRS) {
    fs.mkdirSync(path.join(root, d, 'sub'), { recursive: true });
    if (!files) continue;
    for (let i = 0; i < 2; i++) {
      fs.writeFileSync(path.join(root, d, `f${i}.mjs`), `export const v${i} = ${i};\n`);
      fs.writeFileSync(path.join(root, d, 'sub', `g${i}.js`), `module.exports = ${i};\n`);
    }
  }
  if (bad) fs.writeFileSync(path.join(root, bad), 'export const = ;\n');
  return root;
}
const run = (root) => {
  const r = spawnSync('bash', ['-c', script], {
    cwd: root, encoding: 'utf8',
    env: { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}` },
  });
  return { status: r.status, out: (r.stdout + r.stderr).trim() };
};

if (script) {
  const good = run(tree());
  ok('it passes a tree where every file parses', good.status === 0, `exit ${good.status}: ${good.out}`);
  // The last folder find walks, deepest, among many good files: never the first file of a batch.
  for (const bad of ['tools/sub/zz.js', 'packs/zz.mjs', 'tools/sub/g1.js']) {
    const r = run(tree({ bad }));
    ok(`it fails on a syntax error in ${bad}, not the first file checked`, r.status !== 0 && r.status !== null && r.out.includes(path.basename(bad)), `exit ${r.status}: ${r.out}`);
  }
  const empty = run(tree({ files: false }));
  ok('it fails when it finds no file to check', empty.status !== 0 && empty.status !== null, `exit ${empty.status}: ${empty.out}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
