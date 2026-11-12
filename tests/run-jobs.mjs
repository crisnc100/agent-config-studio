/**
 * tests/run.mjs --jobs N, against fixture trees: files run side by side but
 * the log reads as a serial run (each file's output whole, in list order);
 * a failure starts nothing new, lets running files finish and print, names
 * the files not run, and exits with the first failing file's code in list
 * order; a `serial` file runs alone, after the files that share; a bad N is
 * refused before anything runs; and without --jobs (or with --jobs 1) a
 * file's output still reaches the terminal while it runs.
 *
 * Fixture files log start and end times to SUITE_LOG, so overlap is proven
 * from timestamps, not assumed from wall time.
 *
 * Node 20.0.0 runs this in CI: no API newer than that.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './fixtures/cleanup.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(HERE, 'run.mjs');

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

function tree(files) {
  const root = tempDir('acs-run-jobs-');
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
  return root;
}

/** A fixture test: logs its start, prints to stdout and stderr, sleeps, logs its end, exits. */
const FILE = (name, { ms = 0, code = 0, extra = '' } = {}) => `import fs from 'node:fs';
const log = (what) => fs.appendFileSync(process.env.SUITE_LOG, '${name} ' + what + ' ' + Date.now() + '\\n');
log('start');
console.log('${name}: out 1');
console.error('${name}: err');
${extra}
setTimeout(() => { console.log('${name}: out 2'); log('end'); process.exit(${code}); }, ${ms});
`;

function run(suite, files, args) {
  const root = tree({ 'tests/SUITE': suite, ...files });
  const log = path.join(root, 'log.txt');
  const r = spawnSync(process.execPath, [RUNNER, '--root', root, ...args], { encoding: 'utf8', env: { ...process.env, SUITE_LOG: log }, maxBuffer: 64 * 1024 * 1024 });
  const t = {};
  for (const l of (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '').split('\n').filter(Boolean)) {
    const [name, what, ms] = l.split(' ');
    (t[name] ||= {})[what] = Number(ms);
  }
  return { status: r.status, out: r.stdout + r.stderr, stdout: r.stdout, t, started: Object.keys(t) };
}
const overlap = (a, b) => a.start < b.end && b.start < a.end;
/** The runner's lines for one file: its header through its ok/FAIL line. */
const block = (out, f) => {
  const m = out.match(new RegExp(`=== tests/${f}\\.mjs \\(\\d+/\\d+\\)\\n([\\s\\S]*?)=== (ok |FAIL) +tests/${f}\\.mjs`));
  return m ? m[1] : null;
};

console.log('\nrun.mjs --jobs: output in list order');
{
  const suite = ['tests/a.mjs ci:g', 'tests/b.mjs ci:g', 'tests/c.mjs ci:g', ''].join('\n');
  const r = run(suite, { 'tests/a.mjs': FILE('a', { ms: 600 }), 'tests/b.mjs': FILE('b'), 'tests/c.mjs': FILE('c', { ms: 200 }) }, ['g', '--jobs', '3']);
  ok('the files ran at once (b and c started and ended while a ran)', r.status === 0 && r.t.a && r.t.b && r.t.c
    && overlap(r.t.a, r.t.b) && overlap(r.t.a, r.t.c) && r.t.b.end < r.t.a.end, `${r.status} ${JSON.stringify(r.t)}\n${r.out}`);
  const heads = [...r.stdout.matchAll(/=== (tests\/\w\.mjs) \((\d+)\/3\)/g)].map((m) => `${m[1]}:${m[2]}`);
  ok('each file\'s header is printed in list order with its list position', heads.join() === 'tests/a.mjs:1,tests/b.mjs:2,tests/c.mjs:3', heads.join());
  const blocks = ['a', 'b', 'c'].map((f) => block(r.stdout, f));
  ok('each file\'s stdout and stderr is printed whole, inside its own block', blocks.every((b, i) => {
    const n = 'abc'[i];
    return b !== null && b.includes(`${n}: out 1`) && b.includes(`${n}: err`) && b.includes(`${n}: out 2`)
      && !'abc'.replace(n, '').split('').some((o) => b.includes(`${o}: out`));
  }), r.stdout);
  ok('a per-file seconds line for each, and the total', (r.stdout.match(/=== ok {3}tests\/\w\.mjs: \d+\.\d+s/g) || []).length === 3
    && /=== g: 3 file\(s\) passed in \d+\.\d+s/.test(r.stdout), r.stdout);
}
{
  const chatty = `process.stdout.write('x'.repeat(4 * 1024 * 1024) + '\\n');`;
  const suite = ['tests/a.mjs ci:g', 'tests/b.mjs ci:g', ''].join('\n');
  const r = run(suite, { 'tests/a.mjs': FILE('a', { ms: 300 }), 'tests/b.mjs': FILE('b', { extra: chatty }) }, ['g', '--jobs', '2']);
  const b = block(r.stdout, 'b') || '';
  ok('a chatty file\'s output (4 MiB) is printed in full, after the file before it', r.status === 0 && b.includes('x'.repeat(4 * 1024 * 1024))
    && r.stdout.indexOf('a: out 2') < r.stdout.indexOf('b: out 1'), `${r.status} ${r.stdout.length} bytes`);
}

console.log('\nrun.mjs --jobs: the stop rule');
{
  const suite = ['tests/a.mjs ci:g', 'tests/b.mjs ci:g', 'tests/c.mjs ci:g', 'tests/d.mjs ci:g', 'tests/e.mjs ci:g', ''].join('\n');
  const r = run(suite, {
    'tests/a.mjs': FILE('a', { ms: 500 }), 'tests/b.mjs': FILE('b', { code: 5 }), 'tests/c.mjs': FILE('c', { ms: 300 }),
    'tests/d.mjs': FILE('d'), 'tests/e.mjs': FILE('e'),
  }, ['g', '--jobs', '3']);
  ok('a failure starts no new file (d and e never ran)', r.started.sort().join() === 'a,b,c', JSON.stringify(r.t));
  ok('the files already running finish and print', r.t.a?.end && r.t.c?.end && /a: out 2/.test(r.stdout) && /c: out 2/.test(r.stdout)
    && /=== ok {3}tests\/a\.mjs/.test(r.stdout) && /=== ok {3}tests\/c\.mjs/.test(r.stdout), r.out);
  ok('it exits with the failing file\'s code, says so, and names the files not run', r.status === 5 && /FAIL tests\/b\.mjs: exit 5/.test(r.out)
    && /not run: tests\/d\.mjs, tests\/e\.mjs/.test(r.out), `${r.status}\n${r.out}`);
}
{
  const suite = ['tests/a.mjs ci:g', 'tests/b.mjs ci:g', ''].join('\n');
  const r = run(suite, { 'tests/a.mjs': FILE('a', { ms: 500, code: 3 }), 'tests/b.mjs': FILE('b', { code: 4 }) }, ['g', '--jobs', '2']);
  ok('two failures: the exit code is the first failing file in list order, not the first to fail in time', r.status === 3
    && r.t.b?.end < r.t.a?.end && /FAIL tests\/a\.mjs: exit 3/.test(r.out) && /FAIL tests\/b\.mjs: exit 4/.test(r.out), `${r.status} ${JSON.stringify(r.t)}\n${r.out}`);
}

console.log('\nrun.mjs --jobs: serial files');
{
  const suite = ['tests/s.mjs ci:g serial # fixed port', 'tests/a.mjs ci:g', 'tests/t.mjs local serial # wall clock', 'tests/b.mjs ci:g', 'tests/u.mjs ci:g serial # shared name', ''].join('\n');
  const files = { 'tests/s.mjs': FILE('s', { ms: 150 }), 'tests/a.mjs': FILE('a', { ms: 300 }), 'tests/t.mjs': FILE('t'), 'tests/b.mjs': FILE('b', { ms: 300 }), 'tests/u.mjs': FILE('u', { ms: 150 }) };
  const r = run(suite, files, ['g', '--jobs', '4']);
  const { s, a, b, u } = r.t;
  ok('the files that share ran at once', r.status === 0 && a && b && overlap(a, b), `${r.status} ${JSON.stringify(r.t)}\n${r.out}`);
  ok('each serial file ran alone, after the files that share, one after the other', s && u && s.start >= Math.max(a.end, b.end)
    && u.start >= Math.max(a.end, b.end) && !overlap(s, u), JSON.stringify(r.t));
  const heads = [...r.stdout.matchAll(/=== (tests\/\w\.mjs) \(/g)].map((m) => m[1]);
  ok('the log prints the shared files first, then the serial ones, each in list order', heads.join() === 'tests/a.mjs,tests/b.mjs,tests/s.mjs,tests/u.mjs', heads.join());

  const listed = run(suite, files, ['g', '--list', '--jobs', '4']);
  ok('--list keeps list order and runs nothing', listed.status === 0 && listed.started.length === 0
    && listed.stdout.trim().split('\n').join() === 'tests/s.mjs,tests/a.mjs,tests/b.mjs,tests/u.mjs', listed.out);

  const plain = run(suite, files, ['g']);
  ok('without --jobs, serial changes nothing: list order, one at a time', plain.status === 0
    && ['s', 'a', 'b', 'u'].every((n, i, all) => i === 0 || plain.t[n].start >= plain.t[all[i - 1]].end), JSON.stringify(plain.t));
}
{
  const suite = ['tests/a.mjs ci:g', 'tests/s.mjs ci:g serial # port', ''].join('\n');
  const r = run(suite, { 'tests/a.mjs': FILE('a', { code: 6 }), 'tests/s.mjs': FILE('s') }, ['g', '--jobs', '2']);
  ok('a failure among the shared files leaves the serial files not run, and names them', r.status === 6 && !r.t.s
    && /not run: tests\/s\.mjs/.test(r.out), `${r.status}\n${r.out}`);
}
{
  const files = { 'tests/a.mjs': FILE('a') };
  for (const [name, line] of [['a manual line', 'tests/a.mjs manual serial # by hand'], ['a pending-ci line', 'tests/a.mjs pending-ci serial # later'], ['a helper line', 'tests/a.mjs helper serial # module']]) {
    const r = run(`tests/x.mjs ci:g\n${line}\n`, { ...files, 'tests/x.mjs': FILE('x') }, ['g', '--jobs', '2']);
    ok(`serial on ${name} is a malformed list, refused before anything runs`, r.status === 2 && r.started.length === 0
      && /malformed[\s\S]*serial/.test(r.out), `${r.status}\n${r.out}`);
  }
}

console.log('\nrun.mjs --jobs: a bad N');
{
  const suite = 'tests/a.mjs ci:g\n';
  for (const bad of [['0'], ['-1'], ['1.5'], ['two'], ['01'], []]) {
    const r = run(suite, { 'tests/a.mjs': FILE('a') }, ['g', '--jobs', ...bad]);
    ok(`--jobs ${bad[0] ?? '(nothing)'} is refused with exit 2, before anything runs`, r.status === 2 && r.started.length === 0
      && /--jobs needs a positive whole number/.test(r.out), `${r.status}\n${r.out}`);
  }
}

console.log('\nrun.mjs without --jobs: output is live');
/**
 * The fixture prints, then waits for a file the test writes only after it
 * has read that print from the runner's stdout. A runner that held the
 * output until the file ended would deadlock, and the 10 s guard fails it.
 */
async function liveRun(args) {
  const root = tree({
    'tests/SUITE': 'tests/w.mjs ci:g\n',
    'tests/w.mjs': `import fs from 'node:fs';\nconsole.log('w: waiting');\nconst t = setInterval(() => { if (fs.existsSync(process.env.RELEASE)) { clearInterval(t); console.log('w: released'); } }, 20);\n`,
  });
  const release = path.join(root, 'release');
  const child = spawn(process.execPath, [RUNNER, '--root', root, ...args], { env: { ...process.env, RELEASE: release }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; if (out.includes('w: waiting')) fs.writeFileSync(release, ''); });
  child.stderr.on('data', (d) => { out += d; });
  const guard = setTimeout(() => child.kill('SIGKILL'), 10000);
  const code = await new Promise((res) => child.on('close', (c) => res(c)));
  clearTimeout(guard);
  return { code, out };
}
for (const args of [['g'], ['g', '--jobs', '1']]) {
  const r = await liveRun(args);
  ok(`node tests/run.mjs ${args.join(' ')}: a file's output reaches stdout while it runs`, r.code === 0 && /w: released/.test(r.out), `${r.code}\n${r.out}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
