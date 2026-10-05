/**
 * Static guards for the setup screen (builds/setup-screen S8, criterion 2).
 * Kept apart from tests/guards.mjs, which this build leaves byte-identical.
 *
 *   seam   createApp's usage-collector seam is set only in-process: server.js
 *          names it once, as `opts.usageCollector`; startStudio hands createApp
 *          only what its caller passed; launched directly, startStudio gets
 *          nothing. No environment variable or request field reaches it.
 *   creds  the setup modules never open a credential file: every mention of
 *          auth.json or .credentials.json is the argument of a stat, and no
 *          read API appears beside one.
 *   pins   the two spawns this build added to tests/guards.mjs's allow table
 *          (lib/login-path.js, and lsof's /usr/bin location) are pinned: run
 *          against a copy of the tree with each variant planted, guards.mjs
 *          fails; against the unmodified copy, it passes.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}\n  ${detail}`); }
};

/** Comments removed, strings kept: what the code says, not what its notes say. */
function code(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, '')).replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

console.log('setup guards\n');

/* ── the usage-collector seam ─────────────────────────────────────────── */
{
  const src = code(fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8'));
  const uses = [...src.matchAll(/usageCollector/g)].map((m) => src.slice(Math.max(0, m.index - 5), m.index + 14));
  ok('seam: server.js names usageCollector exactly once, as opts.usageCollector',
     uses.length === 1 && uses[0] === 'opts.usageCollector', JSON.stringify(uses));
  const create = src.match(/export function createApp\(opts = \{\}\)/);
  ok('seam: createApp takes it from its own argument only', Boolean(create));
  ok('seam: startStudio passes createApp only what its caller handed it', /const \{ server, models \} = createApp\(app\);/.test(src)
     && /export async function startStudio\(\{ port = PORT, app = \{\} \} = \{\}\)/.test(src));
  ok('seam: launched directly, startStudio gets no arguments', /if \(launchedDirectly\(\)\) await startStudio\(\);/.test(src));
  ok('seam: no environment variable names it', !/process\.env\.[A-Z_]*(COLLECTOR|USAGE_SEAM|FIXTURE)/i.test(src));
  ok('seam: createApp is called nowhere else in server.js', [...src.matchAll(/createApp\(/g)].length === 2);
  const lib = fs.readdirSync(path.join(ROOT, 'lib'), { recursive: true }).filter((f) => /\.js$/.test(f));
  const leaks = lib.filter((f) => /usageCollector/.test(fs.readFileSync(path.join(ROOT, 'lib', f), 'utf8')));
  ok('seam: no library module can set it', leaks.length === 0, leaks.join(', '));
}

/* ── the setup modules never open a credential ────────────────────────── */
{
  const files = ['lib/setup-clis.js', 'lib/setup-scan.js', 'lib/setup-state.js', 'lib/setup-commands.js', 'lib/version-probe.js', 'lib/login-path.js', 'lib/walk-budget.js'];
  const CRED = /auth\.json|\.credentials\.json/g;
  const READ = /\b(readFileSync|readFile|openSync|open|createReadStream|readSync)\s*\(/;
  for (const f of files) {
    const src = code(fs.readFileSync(path.join(ROOT, f), 'utf8'));
    const bad = [];
    for (const m of src.matchAll(CRED)) {
      const line = src.slice(src.lastIndexOf('\n', m.index) + 1, src.indexOf('\n', m.index));
      if (READ.test(line) || !/statSync\(|nonEmpty\(/.test(line)) bad.push(line.trim());
    }
    ok(`creds: ${f} only ever stats a credential file`, bad.length === 0, bad.join(' | '));
  }
  // nonEmpty is the stat helper the line test above accepts; prove it is one.
  const clis = code(fs.readFileSync(path.join(ROOT, 'lib/setup-clis.js'), 'utf8'));
  const helper = clis.match(/const nonEmpty = \(file\) => \{([^\n]*)\};/);
  ok('creds: setup-clis.js nonEmpty() is a statSync and nothing else', helper && /fs\.statSync\(file\)/.test(helper[1]) && !/read|open/i.test(helper[1]), helper?.[0]);
  // The seat suggestions are new code in an old file: their spans, likewise.
  const seats = code(fs.readFileSync(path.join(ROOT, 'lib/usage/seats.js'), 'utf8'));
  const span = (name) => { const i = seats.indexOf(`export function ${name}(`); return i < 0 ? '' : seats.slice(i, seats.indexOf('\n}\n', i)); };
  for (const fn of ['detectSeats', 'suggestSeats', 'addSuggestedSeat']) {
    const body = span(fn);
    const lines = body.split('\n').filter((l) => CRED.test(l) && (CRED.lastIndex = 0, true));
    ok(`creds: seats.js ${fn}() only stats credential files`, body && lines.every((l) => /statSync\(/.test(l) && !READ.test(l)), lines.join(' | ') || (body ? '' : 'not found'));
  }
}

/* ── the new guard-b pins reject their variants ───────────────────────── */
{
  const copy = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acs-guard-pins-')));
  for (const p of ['lib', 'bin', 'server.js', 'models.default.json', 'package.json']) fs.cpSync(path.join(ROOT, p), path.join(copy, p), { recursive: true });
  fs.mkdirSync(path.join(copy, 'tests'));
  fs.copyFileSync(path.join(ROOT, 'tests', 'guards.mjs'), path.join(copy, 'tests', 'guards.mjs'));
  const guards = () => spawnSync(process.execPath, [path.join(copy, 'tests', 'guards.mjs')], { encoding: 'utf8' });
  const lp = path.join(copy, 'lib', 'login-path.js');
  const pr = path.join(copy, 'lib', 'usage', 'processes.js');
  const origLp = fs.readFileSync(lp, 'utf8');
  const origPr = fs.readFileSync(pr, 'utf8');
  const control = guards();
  ok('pins: guards.mjs passes on the unmodified copy (control)', control.status === 0, control.stderr.slice(-400));
  const variants = [
    ['login-path: a caller-supplied argument after the script', lp, origLp, (t) => t.replace("execFile(shell, ['-lc', LOGIN_PATH_SCRIPT]", "execFile(shell, ['-lc', LOGIN_PATH_SCRIPT, env.SHELL]")],
    ['login-path: a non-literal script', lp, origLp, (t) => t.replace("execFile(shell, ['-lc', LOGIN_PATH_SCRIPT]", "execFile(shell, ['-lc', `${LOGIN_PATH_SCRIPT}; ${env.X}`]")],
    ['login-path: the script built from a template', lp, origLp, (t) => t.replace(/const LOGIN_PATH_SCRIPT = '[^']*';/, 'const LOGIN_PATH_SCRIPT = `printf %s ${process.env.X}`;')],
    ['login-path: the script reassigned', lp, origLp, (t) => t.replace('const TIMEOUT_MS', "let LOGIN_PATH_SCRIPT2 = 1; LOGIN_PATH_SCRIPT = 'x';\nconst TIMEOUT_MS")],
    ['login-path: a different flag', lp, origLp, (t) => t.replace("execFile(shell, ['-lc', LOGIN_PATH_SCRIPT]", "execFile(shell, ['-ilc', LOGIN_PATH_SCRIPT]")],
    ['lsof: a third location', pr, origPr, (t) => t.replace("execFile('/usr/bin/lsof', ['-F', 'pcn', '-w', '+d'", "execFile('/usr/local/bin/lsof', ['-F', 'pcn', '-w', '+d'")],
    ['lsof: a PATH name', pr, origPr, (t) => t.replace("execFile('/usr/bin/lsof', ['-F', 'pcn', '-w', '+D'", "execFile('lsof', ['-F', 'pcn', '-w', '+D'")],
  ];
  for (const [what, file, orig, plant] of variants) {
    const planted = plant(orig);
    fs.writeFileSync(file, planted);
    const r = guards();
    fs.writeFileSync(file, orig);
    ok(`pins: guards.mjs rejects ${what}`, planted !== orig && r.status !== 0 && /FAIL\s+guard b/.test(r.stderr), planted === orig ? 'the variant did not apply' : r.stderr.slice(-300));
  }
  fs.rmSync(copy, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
