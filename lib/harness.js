import { execFile, spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { EFFORTS, ID_RE, loadRegistry, resolveName } from './models.js';
import { loginDirs } from './login-path.js';
import { GROK_ASSIST_ENV, INIT_DEADLINE_MS, createInitGate, grokMcpRefusal, refusalMessage } from './containment.js';

const REQUIRED = [
  'id', 'label', 'detect', 'models', 'defaultModel', 'streams',
  'buildArgs', 'promptDelivery', 'containment', 'resumeFlag', 'decode',
];

const PROMPT_DIR_NAME = 'acs-harness-prompts';

/** harness id → the allowlist built from one registry read (see assistModels). */
const allowlistCache = new Map();

/** Shared streaming decoder — Anthropic messages JSONL (Claude + Grok). `create({harness})` gates on init. */
export const STREAM_DECODE = {
  kind: 'stream',
  create: createStreamDecoder,
};

const CLAUDE_RESUME = { kind: 'flag', flag: '--resume' };
const GROK_RESUME = { kind: 'flag', flag: '-r' };

export const HARNESSES = {
  claude: {
    id: 'claude',
    label: 'Claude',
    // The allowlist comes from the model registry, read per access — see assistModels.
    get models() { return assistModels('claude').models; },
    get defaultModel() { return assistModels('claude').defaultModel; },
    snapshot() { return assistModels('claude'); },
    streams: true,
    promptDelivery: 'stdin',
    // --tools Read strips builtins; --strict-mcp-config drops MCP servers (probed: tools=[Read]).
    containment: ['--tools', 'Read', '--strict-mcp-config'],
    resumeFlag: CLAUDE_RESUME,
    decode: STREAM_DECODE,
    detect() { return detectBinary('claude', claudeCandidates()); },
    buildArgs({ model, sessionId, effort, outputFormat = 'stream-json' }) {
      const args = ['-p', '--model', model, '--output-format', outputFormat];
      if (outputFormat === 'stream-json') args.push('--verbose', '--include-partial-messages');
      if (effort) args.push('--effort', effort);
      if (sessionId) args.push(...resumeArgs(CLAUDE_RESUME, sessionId));
      return args;
    },
  },
  grok: {
    id: 'grok',
    label: 'Grok',
    get models() { return assistModels('grok').models; },
    get defaultModel() { return assistModels('grok').defaultModel; },
    snapshot() { return assistModels('grok'); },
    streams: true,
    // Vanilla stdin starts the TUI (ENXIO). --prompt-file is the working headless path.
    promptDelivery: 'file',
    // grok has no --strict-mcp-config/--no-mcp. Deny MCP meta-tools (probed: tools=[read_file]).
    // That shapes the model's toolset only: MCP servers still start, so a grok
    // with any configured is refused before the spawn (preflight, grok-mcp.md).
    containment: ['--tools', 'read_file', '--disallowed-tools', 'search_tool,use_tool'],
    spawnEnv: GROK_ASSIST_ENV,
    preflight: async ({ binary, cwd, env }) => grokMcpRefusal(await inspectGrok({ binary, cwd, env })),
    resumeFlag: GROK_RESUME,
    decode: STREAM_DECODE,
    detect() { return detectBinary('grok', grokCandidates()); },
    buildArgs({ model, sessionId, effort, systemPrompt, outputFormat = 'streaming-messages-json' }) {
      const args = ['--output-format', outputFormat];
      if (outputFormat === 'streaming-messages-json') args.push('--include-partial-messages');
      args.push('-m', model);
      if (effort) args.push('--reasoning-effort', effort);
      if (sessionId) args.push(...resumeArgs(GROK_RESUME, sessionId));
      if (systemPrompt) args.push('--system-prompt-override', systemPrompt);
      return args;
    },
  },
};

for (const d of Object.values(HARNESSES)) assertDescriptor(d);

sweepPromptFiles();

let lastSpawn = null;
export const getLastSpawn = () => lastSpawn;

export function getHarness(id) {
  const d = HARNESSES[id];
  if (!d) throw Object.assign(new Error(`unknown harness: ${id}`), { status: 400 });
  return d;
}

/**
 * One consistent read of a descriptor's allowlist. Reading `models` and then
 * `defaultModel` separately could straddle a registry edit.
 */
export function modelsFor(d) {
  return typeof d.snapshot === 'function'
    ? d.snapshot()
    : { models: d.models, defaultModel: d.defaultModel, retired: {}, errors: [] };
}

/** Everything wrong with the registry right now, for /api/harnesses and the UI. */
export function registryError() {
  const msgs = [];
  for (const d of Object.values(HARNESSES)) {
    for (const m of modelsFor(d).errors) if (!msgs.includes(m)) msgs.push(m);
  }
  return msgs.length ? msgs.join('\n') : null;
}

export async function detectHarnesses() {
  const out = [];
  for (const d of Object.values(HARNESSES)) {
    const det = d.detect();
    if (!det.installed) continue;
    const snap = modelsFor(d);
    out.push({
      id: d.id,
      label: d.label,
      binary: det.binary,
      version: det.version,
      models: Object.entries(snap.models).map(([id, m]) => ({ id, label: m.label })),
      defaultModel: snap.defaultModel,
      retired: snap.retired,
      streams: d.streams,
    });
  }
  return out;
}

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

/**
 * Picker label from the id: `claude-<family>-<major>-<minor>[-<date>]` → "<Family> <major>.<minor>",
 * `grok-<version>` → "Grok <version>". Anything else is its own label.
 */
export function labelFor(id) {
  let m = id.match(/^claude-([a-z]+)-(\d+(?:-\d+)*)$/);
  if (m) return `${cap(m[1])} ${m[2].split('-').filter((p) => p.length < 8).join('.')}`;
  m = id.match(/^grok-(\d+(?:\.\d+)*)$/);
  if (m) return `Grok ${m[1]}`;
  m = id.match(/^gpt-(\d+(?:\.\d+)?)-([a-z]+)$/);
  if (m) return `GPT-${m[1]} ${cap(m[2])}`;
  return id;
}

/**
 * Build one harness's allowlist from a registry. Every id is shape-checked
 * before it can become an argv element; a bad entry is dropped with a reason
 * rather than failing the whole list.
 */
function buildAllowlist(harness, reg) {
  const errors = [];
  const models = Object.create(null);
  const spec = reg.assist?.[harness];
  if (!spec) return { models, defaultModel: null, retired: {}, errors: [`assist.${harness} is missing`] };

  for (const e of spec.picker || []) {
    const id = resolveName(e.model, reg.models);
    if (id === null) { errors.push(`assist.${harness}: dropped "${e.model}" — not a known family or model id`); continue; }
    if (!ID_RE.test(id)) { errors.push(`assist.${harness}: dropped ${JSON.stringify(id)} — not a valid model id`); continue; }
    if (e.effort !== undefined && !EFFORTS.has(e.effort)) {
      errors.push(`assist.${harness}: dropped ${id} — effort ${JSON.stringify(e.effort)} is not one of ${[...EFFORTS].join('/')}`);
      continue;
    }
    if (models[id]) { errors.push(`assist.${harness}: dropped duplicate ${id}`); continue; }
    const label = e.note ? `${labelFor(id)} · ${e.note}` : labelFor(id);
    models[id] = e.effort ? { label, effort: e.effort } : { label };
  }

  const ids = Object.keys(models);
  let defaultModel = resolveName(spec.default, reg.models);
  if (!ids.length) {
    defaultModel = null;
  } else if (!defaultModel || !Object.hasOwn(models, defaultModel)) {
    errors.push(`assist.${harness}: default "${spec.default}" is not in the picker — using ${ids[0]}`);
    defaultModel = ids[0];
  }

  const retired = {};
  for (const [old, to] of Object.entries(spec.retired || {})) {
    const id = resolveName(to, reg.models);
    if (ID_RE.test(old) && id && Object.hasOwn(models, id)) retired[old] = id;
  }
  return { models, defaultModel, retired, errors };
}

/**
 * The Assist allowlist for a harness, from the registry as it is on disk NOW.
 * Never throws: a broken user file serves the shipped defaults, and a picker
 * with nothing left in it falls back to the shipped picker, with the reason
 * carried in `errors` for the UI to show.
 */
export function assistModels(harness) {
  const loaded = loadRegistry();
  const hit = allowlistCache.get(harness);
  if (hit && hit.loaded === loaded) return hit.value;

  const errors = loaded.error ? [`model registry: ${loaded.error} — using the shipped defaults`] : [];
  let value = buildAllowlist(harness, loaded.registry);
  errors.push(...value.errors);
  if (!Object.keys(value.models).length && loaded.registry !== loaded.defaults) {
    errors.push(`assist.${harness}: no usable model left — using the shipped picker`);
    value = buildAllowlist(harness, loaded.defaults);
    errors.push(...value.errors);
  }
  value = { ...value, errors };
  allowlistCache.set(harness, { loaded, value });
  return value;
}

export function resumeArgs(resumeFlag, sessionId) {
  if (!sessionId) return [];
  if (resumeFlag?.kind === 'flag') return [resumeFlag.flag, sessionId];
  if (resumeFlag?.kind === 'subcommand') return [...resumeFlag.argv, sessionId];
  throw new Error('resumeFlag.kind must be "flag" or "subcommand"');
}

export function argvIncludes(argv, seq) {
  if (!seq.length) return false;
  for (let i = 0; i <= argv.length - seq.length; i++) {
    let ok = true;
    for (let j = 0; j < seq.length; j++) {
      if (argv[i + j] !== seq[j]) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

/**
 * Single chokepoint for spawn argv. Always appends containment so buildArgs
 * cannot drop it, then refuses to return if it is still missing.
 */
export function composeArgv(descriptor, opts = {}) {
  if (!Array.isArray(descriptor.containment) || descriptor.containment.length === 0) {
    throw new Error(`harness ${descriptor.id}: refuse to spawn without containment`);
  }
  const built = descriptor.buildArgs({
    model: opts.model,
    sessionId: opts.sessionId,
    effort: opts.effort,
    systemPrompt: opts.systemPrompt,
    outputFormat: opts.outputFormat,
  }) || [];
  const argv = [...built];
  if (opts.promptFile) {
    argv.push(descriptor.promptFileFlag || '--prompt-file', opts.promptFile);
  }
  argv.push(...descriptor.containment);
  if (!argvIncludes(argv, descriptor.containment)) {
    throw new Error(`harness ${descriptor.id}: containment missing from composed argv`);
  }
  return argv;
}

/** Clearances clearForSpawn issued; spawnContained accepts no other. */
const clearances = new WeakSet();

/**
 * The pre-spawn check a descriptor declares (grok: no MCP servers). The env
 * is built once, here, and carried in the clearance: the check and the spawn
 * run with the same object, so they cannot diverge. Resolves
 * `{ok: true, clearance}` for spawnContained, or `{ok: false, why}`; a
 * descriptor with no preflight is cleared at once.
 *
 * Residual, by design: the CLI's config can change between this check and the
 * spawn. The init gate is the backstop for exactly that window — an init that
 * lists an MCP server ends the turn and kills the process group.
 */
export async function clearForSpawn({ descriptor, binary, cwd }) {
  const env = spawnEnv(descriptor);
  const why = descriptor.preflight ? await descriptor.preflight({ binary, cwd, env }) : null;
  if (why) return { ok: false, why };
  const clearance = { descriptor, binary, cwd, env };
  clearances.add(clearance);
  return { ok: true, clearance };
}

/** A descriptor with no preflight needs no wait: its clearance is synchronous. */
export function clearNow({ descriptor, binary, cwd }) {
  if (descriptor.preflight) throw new Error(`harness ${descriptor.id}: has a preflight; use clearForSpawn`);
  const clearance = { descriptor, binary, cwd, env: spawnEnv(descriptor) };
  clearances.add(clearance);
  return clearance;
}

const spawnEnv = (descriptor) => Object.freeze({ ...process.env, ...(descriptor.spawnEnv || {}) });

/** SIGKILL the child's whole process group (it leads one: spawned detached). */
export function killGroup(child) {
  try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  try { child.kill('SIGKILL'); } catch {}
}

export function spawnContained({ descriptor, binary, opts, prompt, cwd, clearance }) {
  if (!binary || !path.isAbsolute(binary)) {
    throw new Error(`harness ${descriptor.id}: binary must be an absolute path`);
  }
  if (binary.includes('cmux-cli-shims')) {
    throw new Error(`harness ${descriptor.id}: refusing shim binary ${binary}`);
  }
  if (!clearances.has(clearance) || clearance.descriptor !== descriptor || clearance.binary !== binary || clearance.cwd !== cwd) {
    throw new Error(`harness ${descriptor.id}: refuse to spawn without a pre-spawn clearance for this binary and cwd`);
  }
  clearances.delete(clearance);

  let promptFile = null;
  const unlinkPrompt = () => {
    if (!promptFile) return;
    const p = promptFile;
    promptFile = null;
    try { fs.unlinkSync(p); } catch {}
  };

  try {
    if (descriptor.promptDelivery === 'file') {
      promptFile = writePromptFile(prompt);
    }
    const argv = composeArgv(descriptor, { ...opts, promptFile });
    const stdin = descriptor.promptDelivery === 'stdin' ? 'pipe' : 'ignore';
    // Detached: the child leads its own process group, so a refused or
    // cancelled turn takes down whatever the CLI started with it.
    const child = spawn(binary, argv, {
      cwd,
      env: clearance.env,   // the very env the preflight ran with
      stdio: [stdin, 'pipe', 'pipe'],
      detached: true,
    });
    const cleanup = unlinkPrompt;
    child.on('close', cleanup);
    child.on('error', cleanup);
    if (descriptor.promptDelivery === 'stdin') {
      child.stdin.on('error', () => {});
      child.stdin.end(prompt ?? '');
    }
    lastSpawn = {
      binary: child.spawnfile,
      argv: child.spawnargs,
      kill: () => killGroup(child),
    };
    return { child, binary: child.spawnfile, argv: child.spawnargs, cleanup };
  } catch (e) {
    unlinkPrompt();
    throw e;
  }
}

/**
 * One contained run, for chat and the one-shot Assist alike.
 *
 * Containment comes before the spawn: the harness's preflight (grok: no MCP
 * servers) must clear first. A harness with none spawns at once, so `binary`
 * and `argv` are set on return; otherwise `spawned` resolves once it has.
 * After the spawn the init gate sees every event: a refusal, or no init
 * within `initDeadlineMs`, kills the process group and rejects (status 502,
 * `refused: true`) with no text, session id or proposals. A turn longer than
 * `timeoutMs` (if given) is killed and rejected with 504.
 */
export function runContained({ descriptor: desc, binary, opts, prompt, cwd, initDeadlineMs = INIT_DEADLINE_MS, timeoutMs = 0 }, onDelta) {
  // The init gate needs the init-bearing stream; a buffered harness cannot be checked.
  if (desc.decode.kind !== 'stream') {
    throw Object.assign(new Error(`${desc.label}: no init-bearing stream to check containment against — refusing`), { status: 500 });
  }
  const handle = { binary: null, argv: null, done: null, spawned: null, kill: null };
  let child = null;
  let cancelled = false;
  handle.kill = () => { cancelled = true; if (child) killGroup(child); };

  const spawnWith = (clearance) => {
    child = spawnContained({ descriptor: desc, binary, opts, prompt, cwd, clearance }).child;
    handle.binary = child.spawnfile;
    handle.argv = child.spawnargs;
    return child;
  };

  if (desc.preflight) {
    handle.spawned = clearForSpawn({ descriptor: desc, binary, cwd }).then((c) => {
      if (!c.ok) throw Object.assign(new Error(c.why), { status: 409, refused: true });
      if (cancelled) throw Object.assign(new Error('cancelled'), { status: 499 });
      return spawnWith(c.clearance);
    });
  } else {
    handle.spawned = Promise.resolve(spawnWith(clearNow({ descriptor: desc, binary, cwd })));
  }

  handle.done = handle.spawned.then((proc) => new Promise((resolve, reject) => {
    let stderr = '';
    let refusal = null;
    let timedOut = false;
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('error', reject);

    const refuse = (why) => {
      if (refusal) return;
      refusal = why;
      killGroup(proc);
    };
    const deadline = setTimeout(() => refuse(`no init event within ${Math.round(initDeadlineMs / 1000)}s`), initDeadlineMs);
    const timer = timeoutMs ? setTimeout(() => { timedOut = true; killGroup(proc); }, timeoutMs) : null;

    const finish = (code, result) => {
      clearTimeout(deadline);
      clearTimeout(timer);
      if (refusal) {
        const said = stderr.trim().split('\n').slice(-2).join(' ').slice(0, 300);
        return reject(Object.assign(new Error(refusalMessage(desc.label, refusal) + (said ? ` ${desc.label} said: ${said}` : '')), { status: 502, refused: true }));
      }
      if (timedOut) return reject(Object.assign(new Error(`assist timed out after ${Math.round(timeoutMs / 1000)}s`), { status: 504 }));
      const text = result.text || '';
      const err = result.err || stderr;
      if (code !== 0 && !text) {
        return reject(Object.assign(new Error(err.slice(0, 400) || `${desc.id} CLI exited ${code}`), { status: 502 }));
      }
      resolve({
        text,
        sessionId: result.sessionId ?? opts.sessionId ?? null,
        stats: result.stats,
        rateLimit: result.rateLimit,
        init: result.init,
        code,
        // Surfaced so a caller can tell a failed turn from a successful one even
        // when the process exits 0 with text — the server refuses to bind a
        // session id to a turn that reported an error.
        // Protocol failure only. Raw stderr is NOT a failure signal: both CLIs
        // emit MCP transport warnings and update notices on a perfectly good
        // turn, and treating that as an error discarded the reply and the
        // session id on exit 0.
        err: result.err || null,
        stderr: stderr || null,
        is_error: result.is_error === true,
      });
    };

    // No delta before init has passed the gate, and none after a refusal.
    const dec = desc.decode.create({ harness: desc.id, onRefuse: refuse, onInit: () => clearTimeout(deadline) });
    const emit = (piece) => { if (!refusal) onDelta?.(piece); };
    proc.stdout.on('data', (chunk) => dec.push(chunk, emit));
    proc.on('close', (code) => {
      // finish() may report a missing init, which refuses synchronously.
      const result = dec.finish(emit);
      finish(code, result);
    });
  }));

  return handle;
}

export function assertDescriptor(d) {
  const name = d?.id ?? '(unknown)';
  for (const k of REQUIRED) {
    if (d[k] === undefined || d[k] === null) {
      throw new Error(`harness ${name}: missing required field ${k}`);
    }
  }
  if (!Array.isArray(d.containment) || d.containment.length === 0) {
    throw new Error(`harness ${name}: containment must be a non-empty array`);
  }
  if (d.promptDelivery !== 'stdin' && d.promptDelivery !== 'file') {
    throw new Error(`harness ${name}: promptDelivery must be "stdin" or "file"`);
  }
  if (!validResume(d.resumeFlag)) {
    throw new Error(`harness ${name}: resumeFlag must be {kind:"flag",flag} or {kind:"subcommand",argv}`);
  }
  if (!validDecode(d.decode)) {
    throw new Error(`harness ${name}: decode must be {kind:"stream",create} or {kind:"buffered",parse}`);
  }
  if (typeof d.buildArgs !== 'function' || typeof d.detect !== 'function') {
    throw new Error(`harness ${name}: detect and buildArgs must be functions`);
  }
  if (typeof d.streams !== 'boolean') {
    throw new Error(`harness ${name}: streams must be boolean`);
  }
}

/**
 * With `harness`, every event first passes the init gate (lib/containment.js):
 * nothing counts until a valid init, and once the gate refuses, the rest of
 * the stream is dropped — no text, no session id — and `onRefuse(why)` is
 * called once so the caller can kill the child. `onInit` fires when init passes.
 */
export function createStreamDecoder({ harness, onRefuse, onInit } = {}) {
  const gate = harness ? createInitGate(harness) : null;
  const utf8 = new StringDecoder('utf8');
  let buf = '';
  let text = '';
  let session = null;
  let err = '';
  let stats = null;
  let rateLimit = null;
  let init = null;

  function handleLine(line) {
    line = line.trim();
    if (!line) return '';
    let ev;
    try { ev = JSON.parse(line); } catch { return ''; } // noise, e.g. direnv
    if (gate) {
      if (gate.refused) return '';
      const had = gate.init;
      const why = gate.see(ev);
      if (why) {
        text = ''; session = null; stats = null;
        onRefuse?.(why);
        return '';
      }
      if (!had && gate.init) onInit?.(gate.init);
    }
    if (ev.session_id) session = ev.session_id;
    if (ev.type === 'system' && ev.subtype === 'init') init = ev;

    if (ev.type === 'stream_event' && ev.event?.type === 'content_block_delta') {
      const piece = ev.event.delta?.text;
      if (piece) { text += piece; return piece; }
    } else if (ev.type === 'result' || ev.is_error === true) {
      if (ev.is_error) err ||= ev.result || 'assist reported an error';
      if (!text && typeof ev.result === 'string') text = ev.result;
      const u = ev.usage || {};
      stats = {
        contextTokens: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) +
                       (u.cache_creation_input_tokens || 0),
        outputTokens: u.output_tokens || 0,
        costUsd: ev.total_cost_usd ?? null,
        durationMs: ev.duration_ms ?? null,
      };
    } else if (ev.type === 'rate_limit_event' && ev.rate_limit_info) {
      rateLimit = {
        status: ev.rate_limit_info.status,
        resetsAt: ev.rate_limit_info.resetsAt ? ev.rate_limit_info.resetsAt * 1000 : null,
      };
    }
    return '';
  }

  return {
    push(chunk, onDelta) {
      buf += utf8.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const piece = handleLine(line);
        if (piece && onDelta) onDelta(piece);
      }
    },
    finish(onDelta) {
      buf += utf8.end();
      if (buf.trim()) {
        const piece = handleLine(buf);
        if (piece && onDelta) onDelta(piece);
      }
      buf = '';
      if (gate && !gate.refused && gate.end()) onRefuse?.(gate.refused);
      const refused = gate?.refused ?? null;
      return { text, sessionId: session, stats, rateLimit, err, init: gate ? gate.init : init, refused };
    },
  };
}

export { REQUIRED as DESCRIPTOR_FIELDS };

function validResume(r) {
  if (!r || typeof r !== 'object') return false;
  if (r.kind === 'flag') return typeof r.flag === 'string' && r.flag.length > 0;
  if (r.kind === 'subcommand') return Array.isArray(r.argv) && r.argv.length > 0;
  return false;
}

function validDecode(d) {
  if (!d || typeof d !== 'object') return false;
  if (d.kind === 'stream') return typeof d.create === 'function';
  if (d.kind === 'buffered') return typeof d.parse === 'function';
  return false;
}

function claudeCandidates(dirs) {
  const home = os.homedir();
  return [
    path.join(home, '.local', 'bin', 'claude'),
    path.join(home, '.claude', 'local', 'claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
    ...pathCandidates('claude', dirs),
  ];
}

function grokCandidates(dirs) {
  const home = os.homedir();
  return [
    path.join(home, '.grok', 'bin', 'grok'),
    path.join(home, '.local', 'bin', 'grok'),
    ...pathCandidates('grok', dirs),
  ];
}

/** Codex is not a harness here, but setup and sign-in look for it the same way. */
function codexCandidates(dirs) {
  return [...pathCandidates('codex', dirs), '/opt/homebrew/bin/codex', '/usr/local/bin/codex'];
}

/**
 * Where each agent CLI is looked for, in order — the one policy detection,
 * setup and sign-in share. `dirs` adds PATH entries the server's own
 * environment does not have (a login shell's, read again on Recheck).
 */
export const CLI_CANDIDATES = { claude: claudeCandidates, codex: codexCandidates, grok: grokCandidates };

/**
 * The candidate list for any CLI: its policy above, or plain PATH, plus
 * `dirs` — by default the login shell's PATH as last read (lib/login-path.js),
 * so a CLI Recheck found is found everywhere: setup, suggestions, sign-in.
 */
export const candidatesFor = (name, dirs = loginDirs()) => (CLI_CANDIDATES[name] ? CLI_CANDIDATES[name](dirs) : pathCandidates(name, dirs));

function pathCandidates(name, extraDirs = []) {
  const dirs = [...(process.env.PATH || '').split(path.delimiter), ...extraDirs];
  const out = [];
  for (const dir of dirs) {
    if (!dir || dir.includes('cmux-cli-shims')) continue;
    out.push(path.join(dir, name));
  }
  return out;
}

/**
 * Resolve a CLI to its real absolute path, past wrapper shims.
 *
 * Exported for the usage tracker's Codex sign-in, which must spawn a resolved
 * absolute binary rather than a name looked up on PATH at spawn time — the same
 * reason the harness spawns do.
 */
export function findBinary(name, extra = []) {
  return detectBinary(name, [...extra, ...pathCandidates(name)]);
}

/** findBinary without the --version run: just where it is, or not installed. */
export function locateBinary(name, candidates = candidatesFor(name)) {
  const seen = new Set();
  for (const c of candidates) {
    if (seen.has(c)) continue;
    seen.add(c);
    const real = acceptCandidate(c);
    if (real) return { installed: true, binary: real };
  }
  return { installed: false, binary: null };
}

function detectBinary(name, candidates) {
  const found = locateBinary(name, candidates);
  return found.installed ? { ...found, version: readVersion(found.binary) } : { ...found, version: null };
}

function acceptCandidate(candidate) {
  try {
    if (!fs.existsSync(candidate)) return null;
    const st = fs.statSync(candidate);
    if (!st.isFile()) return null;
    if ((st.mode & 0o111) === 0) return null;
    const real = fs.realpathSync(candidate);
    if (isShim(real, candidate)) return null;
    return real;
  } catch {
    return null;
  }
}

function isShim(real, candidate) {
  const hay = `${real}\0${candidate}`;
  if (hay.includes('cmux-cli-shims')) return true;
  if (real.includes(`${path.sep}cmux.app${path.sep}`)) return true;
  let fd;
  try {
    fd = fs.openSync(real, 'r');
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, 4096, 0);
    if (n >= 2 && buf[0] === 0x23 && buf[1] === 0x21) {
      const head = buf.slice(0, n).toString('utf8');
      if (/cmux/i.test(head) && /wrapper|shim/i.test(head)) return true;
    }
  } catch {
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return false;
}

/**
 * `grok inspect --json` in `cwd`: grok's own merged view of the MCP servers a
 * session there would load. The one other way harness.js runs grok, with
 * this argv and no other; it starts no session.
 */
export function inspectGrok({ binary, cwd, env, timeout = 10_000 }) {
  return new Promise((resolve) => {
    execFile(binary, ['inspect', '--json'], { cwd, env, timeout, maxBuffer: 16 << 20 }, (err, stdout) => {
      if (err) return resolve({ error: err.killed ? 'timed out' : String(err.code ?? err.message), stdout: '' });
      resolve({ error: null, stdout });
    });
  });
}

/**
 * The first line `<binary> --version` prints, or null. Synchronous, so a
 * caller that must not hold the event loop runs it off the main thread
 * (lib/version-probe.js).
 */
export function readVersion(binary, timeout = 8000) {
  try {
    const r = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout });
    const out = `${r.stdout || ''}${r.stderr || ''}`.trim().split('\n')[0];
    return out || null;
  } catch {
    return null;
  }
}

function promptDir() {
  const preferred = path.join(os.tmpdir(), PROMPT_DIR_NAME);
  try {
    fs.mkdirSync(preferred, { recursive: true, mode: 0o700 });
    fs.accessSync(preferred, fs.constants.W_OK);
    return preferred;
  } catch {
    const fallback = path.join(process.cwd(), '.tmp', PROMPT_DIR_NAME);
    fs.mkdirSync(fallback, { recursive: true, mode: 0o700 });
    return fallback;
  }
}

function writePromptFile(prompt) {
  const dir = promptDir();
  const file = path.join(dir, `${process.pid}-${Date.now()}-${crypto.randomBytes(8).toString('hex')}.txt`);
  const fd = fs.openSync(file, 'wx', 0o600);
  try {
    fs.writeSync(fd, prompt ?? '');
  } finally {
    fs.closeSync(fd);
  }
  return file;
}

/** A prompt file is an orphan only once the process that wrote it is gone.
 *  Names are `<pid>-<ts>-<rand>.txt`; sweeping the whole directory would delete
 *  a second studio instance's prompt out from under a turn that is still reading
 *  it. Unparseable names are left alone rather than guessed at. */
function ownerIsAlive(name) {
  const pid = Number.parseInt(name.split('-')[0], 10);
  if (!Number.isInteger(pid) || pid <= 0) return true;   // not ours to judge
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM';                       // alive, just not ours
  }
}

function sweepPromptFiles() {
  const errors = [];
  for (const base of [path.join(os.tmpdir(), PROMPT_DIR_NAME), path.join(process.cwd(), '.tmp', PROMPT_DIR_NAME)]) {
    let names;
    try { names = fs.readdirSync(base); } catch { continue; }
    for (const name of names) {
      if (ownerIsAlive(name)) continue;
      const p = path.join(base, name);
      try {
        fs.unlinkSync(p);
      } catch (e) {
        if (e && e.code === 'ENOENT') continue;
        errors.push(`${p}: ${e.message}`);
      }
    }
  }
  if (errors.length) {
    throw new Error(`sweepPromptFiles: failed to remove orphan prompt file(s):\n  ${errors.join('\n  ')}`);
  }
}
