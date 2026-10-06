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

/* ── one read chokepoint: content reads go through lib/paths.js ───────── */
{
  // The threat model: any read whose bytes — or any excerpt of them — reach
  // an HTTP response, the history repo, or a file ACS writes goes through
  // lib/paths.js openUserFile / readUserText. Everything else that reads a
  // file in lib/, bin/ or server.js is listed here by its EXACT call text
  // (receiver included, whitespace normalised), once per occurrence, with
  // why it is allowed: the studio's own files, this checkout, the system,
  // reads that only derive counts or metadata and never return or persist
  // the bytes, and the usage CLI child's credential readers (a separate
  // process by design). Anything new fails until it is routed or listed.
  const ALLOW = {
    'lib/roots.js': [
      ['readFile(home)', 'not a file read: roots.js\'s own function of that name (its definition and two calls)'],
      ['readFile(home)', 'not a file read: roots.js\'s own function of that name (its definition and two calls)'],
      ['readFile(home)', 'not a file read: roots.js\'s own function of that name (its definition and two calls)'],
      ["fs.readFileSync(file, 'utf8')", 'roots.json, the studio\'s own folder registry'],
    ],
    'lib/setup-state.js': [["fs.readFileSync(file, 'utf8')", 'setup.json, the studio\'s own first-run marker']],
    'lib/setup-commands.js': [["fs.readFileSync(file, 'utf8')", 'builds/setup-screen/commands.md, in this checkout']],
    'lib/login-path.js': [["fs.readFileSync('/etc/shells', 'utf8')", '/etc/shells, the system list of login shells']],
    'lib/history.js': [["fs.readFileSync(mirrored, 'utf8')", 'the history mirror, the studio\'s own copy (the live side is openUserFile)']],
    'lib/usage/seats.js': [
      ["fs.readFileSync(file, 'utf8')", 'seats.json, the studio\'s own seat registry'],
      ["fs.readFileSync(file, 'utf8')", 'usage-snapshot.json, the studio\'s own stored reading'],
    ],
    'lib/usage/accounts.js': [["fs.readFileSync(file, 'utf8')", 'accounts.json, the studio\'s own account state']],
    'lib/usage/shell.js': [["fs.readFileSync(file, 'utf8')", 'shortcuts.json, the studio\'s own shortcut config (~/.zshenv is readUserText)']],
    'lib/usage/claude.js': [["fs.readFileSync(file, 'utf8')", 'the Claude credential, read only inside the acs-usage CLI child (lib/usage/refresh.js), a separate process by design']],
    'lib/usage/identity.js': [
      ["fs.readFileSync(path.join(codexHome, 'auth.json'), 'utf8')", 'account identity, computed only inside the acs-usage CLI child; never returned'],
      ["fs.readFileSync(path.join(grokHome, 'auth.json'), 'utf8')", 'account identity for Grok, computed only inside the acs-usage CLI child'],
    ],
    'lib/usage/codex.js': [['fs.readSync(fd, buf, 0, buf.length, start)', 'Codex rollout tails: only token counts and rate-limit numbers are derived; no bytes are returned or kept']],
    'lib/memory-ops.js': [
      ["fs.readFileSync(REVIEW_FILE, 'utf8')", 'the studio\'s own review state'],
      ["fs.readFileSync(opFile(id), 'utf8')", 'the studio\'s own operation records'],
      ['fs.readFileSync(tmp)', 'a temp file this module just wrote, read back to verify it'],
    ],
    'lib/memory-index.js': [
      ["fs.readFileSync(file, 'utf8')", 'its own writes cache, in the studio folder'],
      ['fh.read(buf, 0, CHUNK_BYTES, pos)', 'transcripts: only which memory files were written, and when, is derived; no bytes are returned or kept'],
    ],
    'lib/skill-usage.js': [
      ["fs.readFileSync(file, 'utf8')", 'its own usage cache, in the studio folder'],
      ['fh.read(buf, 0, CHUNK_BYTES, pos)', 'transcripts: only skill-use counts and times are derived; no bytes are returned or kept'],
    ],
    'lib/gitmeta.js': [['fs.readSync(fd, buf, 0, st.size, 0)', 'git metadata (HEAD, gitdir pointers): only branch and repo identity are derived']],
    'lib/harness.js': [['fs.readSync(fd, buf, 0, 4096, 0)', 'an executable\'s first 4 KB, inspected for a wrapper-shim shebang; nothing is returned']],
    'lib/registry.js': [['handle.readSync()', 'Dir.readSync: the next directory entry, not file bytes']],
    'lib/skills.js': [['io.readSync(fd, buf, 0, want, total)', 'readInSkill, the descriptor reader for skills, Context and Memory: same checks as openUserFile, on its own fd']],
    'lib/models-panel.js': [
      ["fs.readFileSync(userPath(home), 'utf8')", 'models.json, the studio\'s own model registry file'],
      ["fs.readFileSync(dismissedPath(home), 'utf8')", 'the studio\'s own dismissed alerts'],
      ["fs.readFileSync(file, 'utf8')", 'models.json again (file = userPath(home)), before setModel rewrites it'],
      ["fs.readFileSync(file, 'utf8')", 'models.json again (file = userPath(home)), before resetModel rewrites it'],
    ],
    'lib/models.js': [
      ["fs.readFileSync(file, 'utf8')", 'the model registry: models.default.json in this checkout and the studio\'s models.json'],
      ['fs.readFileSync(file)', 'model-id lint, a terminal CLI only, never behind a route; models.js is copied standalone into the resolver and imports nothing of the studio'],
      ["fs.readFileSync(settings, 'utf8')", 'model-id sidecars, the terminal CLI only, same reason'],
      ["fs.readFileSync(toml, 'utf8')", 'model-id sidecars, the terminal CLI only, same reason'],
      ["fs.readFileSync(path.join(home, '.agent-config-studio', 'roots.json'), 'utf8')", 'roots.json, the studio\'s own folder registry, read here because bin/model-id --install copies models.js standalone (review-config discovery, B11)'],
    ],
    'lib/models-catalog.js': [["io.readFileSync(file, 'utf8')", 'the injected test io only; with the real fs the read is readUserText']],
    'lib/mutate.js': [
      ["fsp.readFile(path.join(dir, file), 'utf8')", 'trash metadata, the studio\'s own'],
      ["fs.readFileSync(path.join(dir, file), 'utf8')", 'trash metadata, the studio\'s own'],
      ['fs.readFileSync(p)', 'sha256Of: a payload inside the studio\'s own trash (contained by containedPayload); the hash only tags the studio\'s write'],
    ],
    'server.js': [['fsp.readFile(file)', 'the page\'s static assets, from this checkout\'s public/']],
    'bin/install-worktree.mjs': [
      ['fs.readFileSync(path.join(SRC, name))', 'this checkout\'s tools/worktree, the files being installed'],
      ['fs.readFileSync(out)', 'the backup this installer just wrote, read back to verify it (the user\'s side is openUserFile)'],
    ],
    'bin/model-id': [
      ["fs.readFileSync(path.join(src, 'bin', 'model-id'))", 'this checkout\'s resolver script, copied out by --install'],
      ["fs.readFileSync(path.join(src, 'lib', 'models.js'))", 'this checkout\'s models.js, copied out by --install'],
      ['fs.readFileSync(DEFAULTS_PATH)', 'this checkout\'s models.default.json, copied out by --install'],
    ],
    // The same file: bin/model-id is a symlink to it (Node 20.0 loads ESM only by extension).
    'bin/model-id.mjs': [
      ["fs.readFileSync(path.join(src, 'bin', 'model-id'))", 'this checkout\'s resolver script, copied out by --install'],
      ["fs.readFileSync(path.join(src, 'lib', 'models.js'))", 'this checkout\'s models.js, copied out by --install'],
      ['fs.readFileSync(DEFAULTS_PATH)', 'this checkout\'s models.default.json, copied out by --install'],
    ],
  };
  /** Every file-read call in `src`: receiver.name(args), args by balanced parens, whitespace normalised. */
  const readCalls = (src) => {
    const out = [];
    const re = /(?:([\w$]+)\s*\.\s*)?(?<![\w$])(readFileSync|readFile|createReadStream|readSync|read)\s*\(/g;
    for (let m; (m = re.exec(src));) {
      if (m[2] === 'read' && !m[1]) continue;   // a bare read( is a local function, not a handle read
      let i = src.indexOf('(', m.index), depth = 0, j = i;
      for (; j < src.length; j++) { if (src[j] === '(') depth++; else if (src[j] === ')' && --depth === 0) break; }
      out.push(`${m[1] ? `${m[1]}.` : ''}${m[2]}${src.slice(i, j + 1)}`.replace(/\s+/g, ' '));
    }
    return out;
  };
  /** Calls in `f` beyond what ALLOW lists for it, exact text, each entry used once. */
  const offending = (f, src) => {
    const left = (ALLOW[f] || []).map(([t]) => t);
    const bad = [];
    for (const c of readCalls(code(src))) {
      const k = left.indexOf(c);
      if (k === -1) bad.push(`${f}: ${c.slice(0, 80)}`); else left.splice(k, 1);
    }
    return bad;
  };
  const files = [
    ...fs.readdirSync(path.join(ROOT, 'lib'), { recursive: true }).filter((f) => /\.js$/.test(f)).map((f) => `lib/${f}`),
    'server.js', ...fs.readdirSync(path.join(ROOT, 'bin')).map((f) => `bin/${f}`),
  ].filter((f) => f !== 'lib/paths.js');
  const real = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  const bad = files.flatMap((f) => offending(f, real(f)));
  ok('reads: every read outside lib/paths.js is an exact, listed, reasoned call', bad.length === 0, bad.join(' | '));
  ok('reads: every entry carries its reason', Object.values(ALLOW).every((l) => l.every(([, why]) => why.length > 20)));
  const planted = (f, line) => offending(f, `${real(f)}\n${line}\n`).length > 0;
  for (const [what, f, line] of [
    ['a read in an installer (no wildcard any more)', 'bin/install-worktree.mjs', "fs.readFileSync(path.join(HOME, '.zshrc'))"],
    ['an argument merely starting like an allowed one (no prefixes)', 'lib/models.js', "fs.readFileSync(fileOfUser, 'utf8')"],
    ['the test-io call text with the real fs in production code', 'lib/models-catalog.js', "fs.readFileSync(file, 'utf8')"],
    ['a live-file read for a byte comparison (sameBytes)', 'lib/mutate.js', 'fs.readFileSync(abs)'],
    ['a descriptor read (readSync)', 'lib/registry.js', 'fs.readSync(fd, buf, 0, 10, 0)'],
    ['a FileHandle read', 'lib/context-map.js', 'await handle.read(buf, 0, 64, 0)'],
    ['a FileHandle readFile', 'server.js', 'await fh.readFile()'],
    ['a stream', 'lib/registry.js', 'fs.createReadStream(abs)'],
    ['one more of an allowed call than is listed', 'lib/setup-state.js', "fs.readFileSync(file, 'utf8')"],
    ['a read in a new module', 'lib/new-thing.js', 'fs.readFileSync(p)'],
  ]) ok(`reads: the check catches ${what}`, f === 'lib/new-thing.js' ? offending(f, line).length > 0 : planted(f, line));
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
  const hj = path.join(copy, 'lib', 'harness.js');
  const origHj = fs.readFileSync(hj, 'utf8');
  const control = guards();
  ok('pins: guards.mjs passes on the unmodified copy (control)', control.status === 0, control.stderr.slice(-400));
  const variants = [
    ['login-path: a caller-supplied argument after the script', lp, origLp, (t) => t.replace("execFile(shell, ['-lc', LOGIN_PATH_SCRIPT]", "execFile(shell, ['-lc', LOGIN_PATH_SCRIPT, env.SHELL]")],
    ['login-path: a non-literal script', lp, origLp, (t) => t.replace("execFile(shell, ['-lc', LOGIN_PATH_SCRIPT]", "execFile(shell, ['-lc', `${LOGIN_PATH_SCRIPT}; ${env.X}`]")],
    ['login-path: the script built from a template', lp, origLp, (t) => t.replace(/const LOGIN_PATH_SCRIPT = '[^']*';/, 'const LOGIN_PATH_SCRIPT = `printf %s ${process.env.X}`;')],
    ['login-path: the script reassigned', lp, origLp, (t) => t.replace('export const LOGIN_READ_MS', "let LOGIN_PATH_SCRIPT2 = 1; LOGIN_PATH_SCRIPT = 'x';\nexport const LOGIN_READ_MS")],
    ['login-path: a different flag', lp, origLp, (t) => t.replace("execFile(shell, ['-lc', LOGIN_PATH_SCRIPT]", "execFile(shell, ['-ilc', LOGIN_PATH_SCRIPT]")],
    ['login-path: a different literal', lp, origLp, (t) => t.replace(`const LOGIN_PATH_SCRIPT = 'printf "__ACS_PATH__%s__ACS_END__" "$PATH"';`, `const LOGIN_PATH_SCRIPT = 'printf "__ACS_PATH__%s__ACS_END__" "$HOME"';`)],
    ['login-path: `codex exec …` as the literal', lp, origLp, (t) => t.replace(`const LOGIN_PATH_SCRIPT = 'printf "__ACS_PATH__%s__ACS_END__" "$PATH"';`, "const LOGIN_PATH_SCRIPT = 'codex exec arbitrary-prompt';")],
    ['login-path: shell = process.env.SHELL', lp, origLp, (t) => t.replace('const shell = loginShell(env);', 'const shell = process.env.SHELL;')],
    ['login-path: a second assignment to shell', lp, origLp, (t) => t.replace('const shell = loginShell(env);', 'let shell = loginShell(env); shell = env.SHELL;')],
    ['login-path: the /etc/shells check removed from loginShell', lp, origLp, (t) => t.replace("return listed.includes(want) && fs.existsSync(want) ? want : '/bin/sh';", 'return want;')],
    ['lsof: a third location', pr, origPr, (t) => t.replace("execFile('/usr/bin/lsof', ['-F', 'pcn', '-w', '+d'", "execFile('/usr/local/bin/lsof', ['-F', 'pcn', '-w', '+d'")],
    ['inspectGrok: a different argv (a session prompt)', hj, origHj, (t) => t.replace("execFile(binary, ['inspect', '--json']", "execFile(binary, ['-p', 'hello']")],
    ['inspectGrok: the same execFile outside inspectGrok', hj, origHj, (t) => t.replace('export function inspectGrok(', "export const inspectAgain = (binary) => execFile(binary, ['inspect', '--json'], {}, () => {});\nexport function inspectGrok(")],
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
