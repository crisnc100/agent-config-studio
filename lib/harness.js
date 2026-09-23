import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { EFFORTS, ID_RE, loadRegistry, resolveName } from './models.js';

const REQUIRED = [
  'id', 'label', 'detect', 'models', 'defaultModel', 'streams',
  'buildArgs', 'promptDelivery', 'containment', 'resumeFlag', 'decode',
];

const PROMPT_DIR_NAME = 'acs-harness-prompts';

/** harness id → the allowlist built from one registry read (see assistModels). */
const allowlistCache = new Map();

/** Shared streaming decoder — Anthropic messages JSONL (Claude + Grok). */
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
    containment: ['--tools', 'read_file', '--disallowed-tools', 'search_tool,use_tool'],
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

export function spawnContained({ descriptor, binary, opts, prompt, cwd, env }) {
  if (!binary || !path.isAbsolute(binary)) {
    throw new Error(`harness ${descriptor.id}: binary must be an absolute path`);
  }
  if (binary.includes('cmux-cli-shims')) {
    throw new Error(`harness ${descriptor.id}: refusing shim binary ${binary}`);
  }

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
    const child = spawn(binary, argv, {
      cwd,
      env: { ...process.env, ...env },
      stdio: [stdin, 'pipe', 'pipe'],
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
      kill: () => { try { child.kill('SIGKILL'); } catch {} },
    };
    return { child, binary: child.spawnfile, argv: child.spawnargs, cleanup };
  } catch (e) {
    unlinkPrompt();
    throw e;
  }
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

export function createStreamDecoder() {
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
      return { text, sessionId: session, stats, rateLimit, err, init };
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

function claudeCandidates() {
  const home = os.homedir();
  return [
    path.join(home, '.local', 'bin', 'claude'),
    path.join(home, '.claude', 'local', 'claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
    ...pathCandidates('claude'),
  ];
}

function grokCandidates() {
  const home = os.homedir();
  return [
    path.join(home, '.grok', 'bin', 'grok'),
    path.join(home, '.local', 'bin', 'grok'),
    ...pathCandidates('grok'),
  ];
}

function pathCandidates(name) {
  const dirs = (process.env.PATH || '').split(path.delimiter);
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

function detectBinary(name, candidates) {
  const seen = new Set();
  for (const c of candidates) {
    if (seen.has(c)) continue;
    seen.add(c);
    const real = acceptCandidate(c);
    if (!real) continue;
    return { installed: true, binary: real, version: readVersion(real) };
  }
  return { installed: false, binary: null, version: null };
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

function readVersion(binary) {
  try {
    const r = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 8000 });
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
