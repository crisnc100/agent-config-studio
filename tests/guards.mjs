import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(new URL('.', import.meta.url)));
const LIB = path.join(ROOT, 'lib');
const SERVER = path.join(ROOT, 'server.js');
const HARNESS = path.join(LIB, 'harness.js');
const BIN = path.join(ROOT, 'bin');

const WHY = {
  a: [
    'Detection resolves an absolute real binary, then a login-shell spawn',
    '(`zsh -lc \'claude "$@"\'`) re-resolves via PATH and can pick the cmux',
    'shim we just rejected. Harness spawns must exec the resolved absolute',
    'path. Do not delete this guard to "fix" a shell-string spawn — revert',
    'the spawn.',
  ].join(' '),
  b: [
    'composeArgv + spawnContained is the only place that may spawn a harness',
    'binary for a turn. A second spawn in chat.js / assist.js / server.js is',
    'an uncontained door beside a contained one. Do not delete this guard to',
    'add a "simpler" spawn — route it through spawnContained.',
  ].join(' '),
  c: [
    'A descriptor with empty containment is not shippable: composeArgv',
    'refuses to spawn, and assertDescriptor throws at load. An empty array',
    'is how a future harness gets added without a proven allowlist. Do not',
    'delete this guard to land a descriptor "temporarily" — fill containment',
    'with `--tools <read-only>` first.',
  ].join(' '),
  e: [
    'Pinning argv alone does not pin the boundary. `grok agent stdio` opens a',
    'JSON-RPC endpoint: with the same argv, sending `session/new` and a prompt',
    'runs an uncontained model turn. And lib/usage/refresh.js spawns',
    'process.execPath, so whatever script it points at runs with no',
    'containment at all. This guard pins the RPC methods that module may send',
    'and the script that one may execute. Do not widen either list to add a',
    '"quick" call — a new method is a new door.',
  ].join(' '),
  d: [
    'Containment is an ALLOWLIST (`--tools`). Measured leaks: Claude wrote',
    'via Workflow despite `--disallowedTools` naming every write builtin;',
    '`--allowedTools Read` did not strip write tools at all; grok wrote via',
    'spawn_subagent despite `--disallowed-tools` naming every write builtin;',
    'grok ignored `--permission-mode plan` entirely. The only flag that held',
    'is `--tools`. `--disallowed-tools` may appear only as a companion to',
    '`--tools` to strip MCP meta-tools (search_tool, use_tool), never as the',
    'write denylist. Do not delete this guard to restore a denylist — it leaked.',
  ].join(' '),
};

const WRITEISH = new Set([
  'write', 'search_replace', 'run_terminal_command', 'run_terminal_cmd',
  'Edit', 'Write', 'Bash', 'NotebookEdit', 'Task',
]);

let failed = 0;
let passed = 0;

function ok(name) {
  passed++;
  console.log(`PASS  ${name}`);
}
function fail(name, detail, why) {
  failed++;
  console.error(`FAIL  ${name}`);
  console.error(`  ${String(detail).replace(/\n/g, '\n  ')}`);
  console.error(`  WHY: ${why}`);
}
function assert(cond, name, detail, why) {
  if (cond) ok(name);
  else fail(name, detail, why);
}

function listJs(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const abs = path.join(dir, name);
    const st = fs.statSync(abs);
    if (st.isDirectory()) out.push(...listJs(abs));
    else if (/\.(js|mjs)$/.test(name)) out.push(abs);
  }
  return out;
}

function rel(abs) {
  return path.relative(ROOT, abs);
}

function lineAt(src, index) {
  return src.slice(0, index).split('\n').length;
}

/** Strip comments; keep string contents so a spawn command in a string still matches. */
function stripComments(src) {
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      if (i < src.length) out += '\n';
      continue;
    }
    if (c === '/' && n === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') out += '\n';
        i++;
      }
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      out += c;
      i++;
      while (i < src.length && src[i] !== q) {
        if (src[i] === '\\') { out += src[i]; i++; if (i < src.length) { out += src[i]; i++; } continue; }
        out += src[i];
        i++;
      }
      if (i < src.length) out += src[i];
      continue;
    }
    out += c;
  }
  return out;
}

function skipString(src, i) {
  const q = src[i];
  i++;
  while (i < src.length && src[i] !== q) {
    if (src[i] === '\\') i++;
    i++;
  }
  return i;
}

function functionSpan(src, name) {
  const needle = `function ${name}`;
  const start = src.indexOf(needle);
  if (start === -1) return null;
  let i = start + needle.length;
  while (i < src.length && src[i] !== '(') i++;
  if (src[i] !== '(') return null;
  let depth = 0;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') { i = skipString(src, i); continue; }
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) { i++; break; }
    }
  }
  while (i < src.length && src[i] !== '{') i++;
  if (src[i] !== '{') return null;
  depth = 0;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') { i = skipString(src, i); continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return { start, end: i + 1 };
    }
  }
  return null;
}

function inSpan(index, span) {
  return span && index >= span.start && index < span.end;
}

const CALL_RE = /(?<![\w.])(spawnSync|execFile|exec|spawn)\s*\(/g;

function childCalls(src) {
  const out = [];
  CALL_RE.lastIndex = 0;
  let m;
  while ((m = CALL_RE.exec(src))) {
    out.push({ fn: m[1], index: m.index, line: lineAt(src, m.index) });
  }
  return out;
}

function calleeLiteral(src, call) {
  const slice = src.slice(call.index);
  const head = slice.match(/^(?:spawnSync|execFile|exec|spawn)\s*\(\s*/);
  if (!head) return { kind: 'unknown', value: '' };
  const after = slice.slice(head[0].length);
  const lit = after.match(/^(['"`])([^'"`]+)\1/);
  if (lit) return { kind: 'literal', value: lit[2] };
  const id = after.match(/^([A-Za-z_$][\w$]*)/);
  if (id) return { kind: 'ident', value: id[1] };
  return { kind: 'other', value: after.slice(0, 48).replace(/\s+/g, ' ') };
}

function readStripped(abs) {
  return stripComments(fs.readFileSync(abs, 'utf8'));
}

/**
 * Files the spawn guards read.
 *
 * bin/ is included: it is shipped code that the studio itself executes through
 * lib/usage/refresh.js, so a spawn added there is exactly as reachable as one
 * in lib/ — and it was previously unscanned.
 */
function scanTargets() {
  return [...listJs(LIB), ...listJs(BIN), SERVER];
}

function guardA() {
  const hits = [];
  for (const abs of scanTargets()) {
    const src = readStripped(abs);
    const file = rel(abs);
    for (const pat of [
      /zsh\s+-lc/,
      /bash\s+-lc/,
      /(?:^|[^\w])sh\s+-lc/,
      /['"`]zsh['"`]\s*,\s*\[\s*['"`]-lc['"`]/,
      /['"`]bash['"`]\s*,\s*\[\s*['"`]-lc['"`]/,
    ]) {
      const m = src.match(pat);
      if (m) hits.push(`${file}:${lineAt(src, m.index)} ${m[0]}`);
    }
    if (/\bchild_process\.exec\s*\(/.test(src)) {
      hits.push(`${file} uses child_process.exec (shell-string spawn)`);
    }
    if (/import\s*\{[^}]*\bexec\b[^}]*\}\s*from\s*['"]node:child_process['"]/.test(src)) {
      hits.push(`${file} imports exec from node:child_process (shell-string API)`);
    }
    for (const call of childCalls(src)) {
      const cal = calleeLiteral(src, call);
      if (cal.kind === 'literal' && /^(claude|grok|codex)$/.test(cal.value)) {
        hits.push(`${file}:${call.line} ${call.fn}('${cal.value}') — PATH name, not the resolved absolute binary`);
      }
    }
  }
  assert(
    hits.length === 0,
    'guard a: no shell-string / login-shell harness spawn',
    hits.join('\n') || 'ok',
    WHY.a,
  );
}

function guardB() {
  const hits = [];
  for (const abs of scanTargets()) {
    const src = readStripped(abs);
    const file = rel(abs);
    const calls = childCalls(src);

    if (abs === HARNESS) {
      const contained = functionSpan(src, 'spawnContained');
      const version = functionSpan(src, 'readVersion');
      if (!contained) {
        hits.push(`${file}: spawnContained is missing — the chokepoint is gone`);
        continue;
      }
      for (const call of calls) {
        if (call.fn === 'spawn') {
          if (!inSpan(call.index, contained)) {
            hits.push(`${file}:${call.line} spawn() outside spawnContained`);
          } else {
            const cal = calleeLiteral(src, call);
            if (!(cal.kind === 'ident' && cal.value === 'binary')) {
              hits.push(`${file}:${call.line} spawnContained must spawn(binary, …), got spawn(${cal.value})`);
            }
          }
        } else if (call.fn === 'spawnSync') {
          if (!inSpan(call.index, version)) {
            hits.push(`${file}:${call.line} spawnSync() outside readVersion (only --version probes belong there)`);
          }
        } else {
          hits.push(`${file}:${call.line} ${call.fn}() — harness.js may spawn only via spawnContained / readVersion`);
        }
      }
      continue;
    }

    const allowed = {
      'lib/history.js': { fns: new Set(['exec', 'execFile']), bins: new Set(['git']) },
      'lib/worktree.js': { fns: new Set(['exec', 'execFile']), bins: new Set(['git', 'zsh']) },
      // The usage refresh runs our own CLI so a credential never enters the
      // studio process. Held to a STRICTER rule than the entries above: the
      // executable must be process.execPath literally, so it can never resolve
      // a name on PATH and can never become a harness spawn.
      'lib/usage/refresh.js': { fns: new Set(['spawn']), execPathOnly: true },
      // Codex sign-in. This one DOES spawn a harness binary, which guard b
      // otherwise bans — so it is pinned to the login subcommand. A login
      // cannot run a model turn or touch a file, which is the property guard b
      // exists to protect. argv must be a literal ['login'] / ['login','status']
      // with no prompt, no exec, and nothing caller-supplied.
      'lib/usage/connect.js': { fns: new Set(['spawn']), loginOnly: true },
      // Grok's weekly quota, read over the agent protocol. Also a harness
      // binary, also pinned: ['agent','stdio'] starts a JSON-RPC endpoint, and
      // this module only ever writes `initialize` and `_x.ai/billing`. No
      // session is created and no prompt is sent, so no model turn can run.
      'lib/usage/grok-billing.js': { fns: new Set(['spawn']), agentStdioOnly: true },
      // Seat-conflict detection: which processes hold a seat's home open, so a
      // sign-in is not silently undone by one that is still running. This is
      // NOT a harness binary — it is an absolute system inspector, read-only,
      // with argv fixed in source. Pinned anyway, because the reason guard b
      // is strict is that any second spawn site is a door: an lsof call whose
      // path or argv could drift is one edit away from being something else.
      'lib/usage/processes.js': { fns: new Set(['execFile']), lsofOnly: true },
      // A Codex seat's live quota, read over the app-server protocol. Same
      // argument as grok-billing above, and pinned the same way: ['app-server']
      // starts a JSON-RPC endpoint, and this module only ever writes
      // `initialize` and `account/rateLimits/read`. No thread is started and no
      // prompt is sent, so no model turn can run. The alternative considered and
      // rejected was spawning `codex exec` with a throwaway prompt to make a
      // turn record quota — that IS a model turn, it would have needed this
      // guard widened to permit a prompt, and it spent the user's subscription
      // on every refresh.
      'lib/usage/codex-limits.js': { fns: new Set(['spawn']), appServerOnly: true },
    }[file];

    for (const call of calls) {
      if (!allowed) {
        hits.push(`${file}:${call.line} ${call.fn}() — harness binaries spawn only in lib/harness.js spawnContained`);
        continue;
      }
      if (!allowed.fns.has(call.fn)) {
        hits.push(`${file}:${call.line} ${call.fn}() is not allowed here`);
        continue;
      }
      const cal = calleeLiteral(src, call);
      if (allowed.agentStdioOnly) {
        const text = (callArgsText(src, call) || '').replace(/\s+/g, ' ').trim();
        if (!/^found\.binary\s*,/.test(text)) {
          hits.push(`${file}:${call.line} ${call.fn}(${text.slice(0, 50)}…) — must spawn the detected ` +
                    `absolute binary (found.binary), never a PATH name`);
        }
        const am = /^[^,]+,\s*(\[[^\]]*\])/.exec(text);
        const argv = am ? am[1].replace(/\s+/g, '') : null;
        if (!argv || argv !== "['agent','stdio']") {
          hits.push(`${file}:${call.line} argv must be the literal ['agent','stdio'], got ` +
                    `${argv ?? 'nothing parseable'} — a prompt or model flag here would be an ` +
                    `uncontained model turn`);
        }
        continue;
      }
      if (allowed.appServerOnly) {
        const text = (callArgsText(src, call) || '').replace(/\s+/g, ' ').trim();
        if (!/^found\.binary\s*,/.test(text)) {
          hits.push(`${file}:${call.line} ${call.fn}(${text.slice(0, 50)}…) — must spawn the detected ` +
                    `absolute binary (found.binary), never a PATH name`);
        }
        const am = /^[^,]+,\s*(\[[^\]]*\])/.exec(text);
        const argv = am ? am[1].replace(/\s+/g, '') : null;
        if (!argv || argv !== "['app-server']") {
          hits.push(`${file}:${call.line} argv must be the literal ['app-server'], got ` +
                    `${argv ?? 'nothing parseable'} — an exec subcommand or prompt here would be ` +
                    `an uncontained model turn`);
        }
        continue;
      }
      if (allowed.loginOnly) {
        const text = (callArgsText(src, call) || '').replace(/\s+/g, ' ').trim();
        // The binary must come from detection, never a bare name or a string.
        if (!/^found\.binary\s*,/.test(text)) {
          hits.push(`${file}:${call.line} ${call.fn}(${text.slice(0, 50)}…) — must spawn the detected ` +
                    `absolute binary (found.binary), never a PATH name`);
        }
        const argvMatch = /^[^,]+,\s*(\[[^\]]*\])/.exec(text);
        const argv = argvMatch ? argvMatch[1].replace(/\s+/g, '') : null;
        if (!argv || !/^\['(login'(,'status')?|logout')\]$/.test(argv)) {
          hits.push(`${file}:${call.line} argv must be a literal ['login'], ['login','status'] ` +
                    `or ['logout'], ` +
                    `got ${argv ?? 'nothing parseable'} — a prompt or exec here would be an ` +
                    `uncontained model turn`);
        }
        continue;
      }
      if (allowed.lsofOnly) {
        const text = (callArgsText(src, call) || '').replace(/\s+/g, ' ').trim();
        // Absolute path, so no PATH entry can substitute a different program.
        if (!/^'\/usr\/sbin\/lsof'\s*,/.test(text)) {
          hits.push(`${file}:${call.line} ${call.fn}(${text.slice(0, 60)}…) — must be the absolute ` +
                    `'/usr/sbin/lsof', never a PATH name`);
        }
        // Every argv element literal except the home being inspected. lsof has
        // no flag that executes anything, but a caller-supplied FLAG (rather
        // than a caller-supplied path) is how that would change.
        const am = /^[^,]+,\s*\[([^\]]*)\]/.exec(text);
        const argv = am ? am[1].split(',').map((x) => x.trim()).filter(Boolean) : null;
        if (!argv || !argv.slice(0, -1).every((a) => /^'[^']*'$/.test(a))) {
          hits.push(`${file}:${call.line} every lsof flag must be a string literal, got ` +
                    `${argv ? argv.join(' ') : 'nothing parseable'} — a computed flag here is how ` +
                    `a read-only inspector stops being read-only`);
        }
        if (argv && !argv.slice(0, -1).some((a) => a === "'+D'" || a === "'+d'")) {
          hits.push(`${file}:${call.line} lsof must be scoped with +d/+D to one directory`);
        }
        continue;
      }
      if (allowed.execPathOnly) {
        // Must be the running node binary itself, with a fixed argv built from
        // a module-local constant — never a name resolved on PATH, and never
        // anything an HTTP request could influence.
        const text = (callArgsText(src, call) || '').replace(/\s+/g, ' ').trim();
        if (!/^process\.execPath\s*,\s*\[\s*CLI\s*,\s*'--json'\s*\]/.test(text)) {
          hits.push(`${file}:${call.line} ${call.fn}(${text.slice(0, 60)}…) — this file may spawn only ` +
                    `process.execPath with the fixed argv [CLI, '--json']`);
        }
        continue;
      }
      if (cal.kind === 'literal' && !allowed.bins.has(cal.value)) {
        hits.push(`${file}:${call.line} ${call.fn}('${cal.value}') — not an allowed binary for this file`);
      }
      if (cal.kind === 'literal' && /^(claude|grok|codex)$/.test(cal.value)) {
        hits.push(`${file}:${call.line} ${call.fn}('${cal.value}') — harness spawn outside the chokepoint`);
      }
    }
  }
  assert(
    hits.length === 0,
    'guard b: spawnContained is the only harness-binary spawn site',
    hits.join('\n') || 'ok',
    WHY.b,
  );
}

/** Full source text of a call's argument list, brackets and quotes respected. */
function callArgsText(src, call) {
  let i = src.indexOf('(', call.index);
  if (i === -1) return null;
  const start = i + 1;
  let depth = 0;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      const q = c; i++;
      while (i < src.length && src[i] !== q) { if (src[i] === '\\') i++; i++; }
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { depth--; if (depth === 0) return src.slice(start, i); }
  }
  return null;
}

function parseContainmentArrays(src) {
  const out = [];
  const re = /\bcontainment\s*:\s*\[/g;
  let m;
  while ((m = re.exec(src))) {
    const start = m.index + m[0].length - 1;
    let depth = 0;
    let i = start;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === '"' || c === "'" || c === '`') {
        const q = c;
        i++;
        while (i < src.length && src[i] !== q) {
          if (src[i] === '\\') i++;
          i++;
        }
        continue;
      }
      if (c === '[') depth++;
      else if (c === ']') {
        depth--;
        if (depth === 0) break;
      }
    }
    const raw = src.slice(start, i + 1);
    const items = [];
    const itemRe = /(['"`])([^'"`]*)\1/g;
    let im;
    while ((im = itemRe.exec(raw))) items.push(im[2]);
    out.push({ line: lineAt(src, m.index), raw, items });
  }
  return out;
}

function guardC() {
  const hits = [];
  const src = readStripped(HARNESS);
  const arrays = parseContainmentArrays(src);
  if (arrays.length === 0) {
    hits.push('lib/harness.js has no containment: [...] arrays');
  }
  for (const a of arrays) {
    if (a.items.length === 0) {
      hits.push(`lib/harness.js:${a.line} empty containment array ${a.raw}`);
    }
  }

  assert(
    hits.length === 0,
    'guard c: every descriptor containment is a non-empty array (source)',
    hits.join('\n') || 'ok',
    WHY.c,
  );
}

async function guardCRuntime() {
  const hits = [];
  let harnesses;
  try {
    ({ HARNESSES: harnesses } = await import('../lib/harness.js'));
  } catch (e) {
    fail(
      'guard c: descriptors load with non-empty containment',
      e && e.message ? e.message : e,
      WHY.c,
    );
    return null;
  }
  for (const d of Object.values(harnesses)) {
    if (!Array.isArray(d.containment) || d.containment.length === 0) {
      hits.push(`${d.id}: containment is ${JSON.stringify(d.containment)}`);
    }
  }
  assert(
    hits.length === 0,
    'guard c: every descriptor containment is a non-empty array (runtime)',
    hits.join('\n') || 'ok',
    WHY.c,
  );
  return harnesses;
}

function leakyAsContainment(items, id) {
  const hits = [];
  if (items.length === 0) return hits; // empty is guard c
  const flags = new Set(items);
  if (!flags.has('--tools')) {
    hits.push(`${id}: containment has no --tools allowlist: ${JSON.stringify(items)}`);
  }
  for (const leak of ['--allowedTools', '--disallowedTools', '--permission-mode']) {
    if (flags.has(leak)) {
      hits.push(`${id}: ${leak} used as containment (measured leak)`);
    }
  }
  const di = items.indexOf('--disallowed-tools');
  if (di !== -1) {
    const denied = String(items[di + 1] || '').split(',').map((s) => s.trim()).filter(Boolean);
    const writeish = denied.filter((t) => WRITEISH.has(t));
    if (writeish.length) {
      hits.push(`${id}: --disallowed-tools names write tools ${JSON.stringify(writeish)} — that denylist leaked via leftovers`);
    }
    if (!flags.has('--tools')) {
      hits.push(`${id}: --disallowed-tools without --tools is a denylist, not containment`);
    }
  }
  return hits;
}

async function guardD(harnesses) {
  const hits = [];
  const src = readStripped(HARNESS);
  for (const a of parseContainmentArrays(src)) {
    hits.push(...leakyAsContainment(a.items, `lib/harness.js:${a.line}`));
  }
  if (harnesses) {
    for (const d of Object.values(harnesses)) {
      hits.push(...leakyAsContainment(d.containment, d.id));
    }
  }
  const uniq = [...new Set(hits)];
  assert(
    uniq.length === 0,
    'guard d: containment is --tools allowlist, not a measured-leaky denylist',
    uniq.join('\n') || 'ok',
    WHY.d,
  );
}

/**
 * Guard e — pin what the pinned-argv spawns are allowed to DO.
 *
 * Guard b proves lib/usage/{connect,grok-billing,refresh}.js spawn the right
 * binary with the right argv. That is not sufficient on its own:
 *   - `grok agent stdio` is a JSON-RPC endpoint. Same argv, different requests,
 *     and `session/new` + a prompt is an uncontained turn.
 *   - refresh.js spawns node itself; the containment lives entirely in WHICH
 *     script it runs, which guard b never looked at.
 */
function guardE() {
  const hits = [];

  // --- grok-billing.js: only these two JSON-RPC methods may ever be sent ----
  const BILLING_METHODS = new Set(['initialize', '_x.ai/billing']);
  const billingPath = path.join(LIB, 'usage', 'grok-billing.js');
  let billing = '';
  try { billing = fs.readFileSync(billingPath, 'utf8'); } catch {
    hits.push('lib/usage/grok-billing.js is missing — guard e cannot verify it');
  }
  for (const m of billing.matchAll(/\bmethod\s*:\s*(['"`])([^'"`]*)\1/g)) {
    if (!BILLING_METHODS.has(m[2])) {
      hits.push(`lib/usage/grok-billing.js sends JSON-RPC method '${m[2]}' — only ` +
                `${[...BILLING_METHODS].join(', ')} are allowed; a session or prompt method ` +
                `here is an uncontained model turn`);
    }
  }
  // A computed method name would slip past the literal scan above.
  for (const m of billing.matchAll(/\bmethod\s*:\s*([A-Za-z_$][\w$.]*)/g)) {
    hits.push(`lib/usage/grok-billing.js builds a JSON-RPC method from the variable ` +
              `'${m[1]}' — the method list must be literal`);
  }

  // --- codex-limits.js: only these two JSON-RPC methods may ever be sent ---
  // `codex app-server` is a full agent endpoint: with the very same argv, a
  // thread/start plus a prompt is an uncontained model turn that can write
  // files. Pinning argv is therefore not enough — the method list is the real
  // boundary, exactly as it is for grok-billing.
  const LIMIT_METHODS = new Set(['initialize', 'account/rateLimits/read']);
  const limitsPath = path.join(LIB, 'usage', 'codex-limits.js');
  let limits = '';
  try { limits = fs.readFileSync(limitsPath, 'utf8'); } catch {
    hits.push('lib/usage/codex-limits.js is missing — guard e cannot verify it');
  }
  for (const m of limits.matchAll(/\bmethod\s*:\s*(['"`])([^'"`]*)\1/g)) {
    if (!LIMIT_METHODS.has(m[2])) {
      hits.push(`lib/usage/codex-limits.js sends JSON-RPC method '${m[2]}' — only ` +
                `${[...LIMIT_METHODS].join(', ')} are allowed; a thread or prompt method ` +
                `here is an uncontained model turn`);
    }
  }
  // A computed method name would slip past the literal scan above.
  for (const m of limits.matchAll(/\bmethod\s*:\s*([A-Za-z_$][\w$.]*)/g)) {
    hits.push(`lib/usage/codex-limits.js builds a JSON-RPC method from the variable ` +
              `'${m[1]}' — the method list must be literal`);
  }
  // An exec/prompt token anywhere in this module means the spawn has stopped
  // being a quota read, the same way it would in a login.
  const limitsCode = limits.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');
  for (const m of limitsCode.matchAll(/(['"`])(exec|-p|--prompt|--print)\1/g)) {
    hits.push(`lib/usage/codex-limits.js contains the argv token '${m[2]}' — a quota read must ` +
              `never carry a prompt or an exec subcommand`);
  }

  // --- refresh.js: the script it runs must be the repo's own CLI -----------
  const refreshPath = path.join(LIB, 'usage', 'refresh.js');
  let refresh = '';
  try { refresh = fs.readFileSync(refreshPath, 'utf8'); } catch {
    hits.push('lib/usage/refresh.js is missing — guard e cannot verify it');
  }
  const cliDef = /const\s+CLI\s*=\s*path\.join\(\s*HERE\s*,\s*'\.\.'\s*,\s*'\.\.'\s*,\s*'bin'\s*,\s*'usage\.mjs'\s*\)/;
  if (refresh && !cliDef.test(refresh)) {
    hits.push("lib/usage/refresh.js must define CLI as path.join(HERE, '..', '..', 'bin', " +
              "'usage.mjs') — a computed or reassigned target means it can execute anything");
  }
  if (/\bCLI\s*=/.test(refresh.replace(cliDef, ''))) {
    hits.push('lib/usage/refresh.js reassigns CLI — the spawn target must be fixed at module load');
  }
  if (refresh && !/const\s+HERE\s*=\s*path\.dirname\(fileURLToPath\(import\.meta\.url\)\)/.test(refresh)) {
    hits.push('lib/usage/refresh.js must derive HERE from import.meta.url');
  }

  // --- connect.js: a login must never gain a prompt ------------------------
  const connectPath = path.join(LIB, 'usage', 'connect.js');
  let connect = '';
  try { connect = fs.readFileSync(connectPath, 'utf8'); } catch {
    hits.push('lib/usage/connect.js is missing — guard e cannot verify it');
  }
  // Only quoted argv-shaped tokens matter; `URL_RE.exec(...)` is not a spawn.
  const connectCode = connect.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');
  for (const m of connectCode.matchAll(/(['"`])(exec|-p|--prompt|--print)\1/g)) {
    hits.push(`lib/usage/connect.js contains the argv token '${m[2]}' — a login spawn must never ` +
              `carry a prompt or an exec subcommand`);
  }

  assert(hits.length === 0, 'guard e: pinned-argv spawns are pinned in what they may do',
         hits.join('\n') || 'ok', WHY.e);
}

async function main() {
  console.log('guards — static security properties this branch established\n');
  guardA();
  guardB();
  guardC();
  guardE();
  const harnesses = await guardCRuntime();
  await guardD(harnesses);
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
