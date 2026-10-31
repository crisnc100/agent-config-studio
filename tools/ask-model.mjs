#!/usr/bin/env node
/**
 * ask-model — ask another model, read-only, and print its answer.
 *
 *   ask-model (--role <role> | --family <family>) [--effort <e>] --prompt-file <path>
 *             [--investigate] [--json] [--cwd <dir>]
 *
 * The mechanical half of "ask model X", in one place instead of in every
 * skill: the family, id and effort from the resolver (lib/models.js and
 * lib/roles.js, the code model-id runs), the CLI from the id's prefix, that
 * CLI's read-only and no-MCP flags, and proof that the model asked for is the
 * one that answered. An empty effort passes no effort flag at all: codex
 * rejects `model_reasoning_effort=` with nothing after it.
 *
 * --investigate adds a shell (claude's Bash, grok's run_terminal_cmd; codex's
 * read-only sandbox already runs commands) and compares the git work tree
 * before and after the call. Anything that changed is named on stderr and the
 * exit is 5. Nothing is ever reverted.
 *
 * Exit: 0 answered · 2 another model answered · 3 the CLI (or node) is not
 * installed · 4 the call failed or returned an error · 5 files changed under
 * --investigate · 64 a usage error, or a role or family that does not
 * resolve to a model a known CLI runs.
 *
 * It lives in tools/, not bin/: it runs model CLIs, which nothing under bin/
 * or lib/ may do (tests/guards.mjs). `model-id --install` copies it beside the
 * resolver as bin/ask-model.mjs, so `../lib/` resolves in both places.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EFFORTS, loadRegistry, resolveModel } from '../lib/models.js';
import { resolveFlavor, resolveRole } from '../lib/roles.js';

const SELF = fileURLToPath(import.meta.url);
const USAGE = 'usage: ask-model (--role <role> | --family <family>) [--effort <e>] --prompt-file <path> [--investigate] [--json] [--cwd <dir>]';
const VALUE_FLAGS = { '--role': 'role', '--family': 'family', '--effort': 'effort', '--prompt-file': 'promptFile', '--cwd': 'cwd' };

// What each CLI may use. Claude and grok are read-only by these allowlists alone
// (their plan modes and denylists were observed to still write); codex by its sandbox.
const TOOLS = {
  claude: { 'read-only': 'Read,Grep,Glob', investigate: 'Read,Grep,Glob,Bash' },
  grok: { 'read-only': 'read_file,list_dir,grep', investigate: 'read_file,list_dir,grep,run_terminal_cmd' },
};
// The review runtime's grok turn cap (packs/review-gate/runtime/review.mjs).
const GROK_MAX_TURNS = '40';

/** Which CLI runs an id: its prefix, the rule ACS and the review runtime use. */
function vendorOf(id) {
  if (id.startsWith('claude-')) return 'claude';
  if (id.startsWith('gpt-')) return 'codex';
  if (id.startsWith('grok-')) return 'grok';
  return null;
}

/** The argv for one call. */
function argvFor(vendor, { id, effort, prompt, cwd, mode }) {
  if (vendor === 'claude') {
    return ['-p', prompt, '--model', id, ...(effort ? ['--effort', effort] : []), '--output-format', 'json',
      // --tools decides which tools exist, so skipping the prompts is safe; --strict-mcp-config with
      // no --mcp-config loads no MCP server. Without the skip, a deny rule or hook blocks a read silently.
      '--dangerously-skip-permissions', '--tools', TOOLS.claude[mode], '--strict-mcp-config'];
  }
  if (vendor === 'codex') {
    return ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '-m', id,
      ...(effort ? ['-c', `model_reasoning_effort=${effort}`] : []), prompt];
  }
  // --disallowed-tools and --deny MCPTool keep configured MCP servers out of reach (grok has no strict-MCP flag).
  return ['-p', prompt, '-m', id, ...(effort ? ['--reasoning-effort', effort] : []), '--cwd', cwd,
    '--tools', TOOLS.grok[mode], '--disallowed-tools', 'search_tool,use_tool', '--deny', 'MCPTool',
    '--disable-web-search', '--no-subagents', '--max-turns', GROK_MAX_TURNS, '--output-format', 'json'];
}

function parse(argv) {
  const o = { investigate: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') return { help: true };
    if (a === '--investigate' || a === '--json') { o[a.slice(2)] = true; continue; }
    const key = VALUE_FLAGS[a];
    if (!key) return { error: `unexpected argument ${JSON.stringify(a)}` };
    const v = argv[++i];
    // An empty effort is allowed and means none; any other value must be there and not a flag.
    if (v === undefined || v.startsWith('-') || (v === '' && key !== 'effort')) return { error: `${a} needs a value` };
    if (o[key] !== undefined) return { error: `${a} given twice` };
    o[key] = v;
  }
  if ((o.role === undefined) === (o.family === undefined)) return { error: 'name exactly one of --role and --family' };
  if (o.promptFile === undefined) return { error: '--prompt-file is required' };
  if (o.effort && !EFFORTS.has(o.effort)) return { error: `--effort ${JSON.stringify(o.effort)} is not one of ${[...EFFORTS].join('/')} (or empty for none)` };
  return o;
}

/** family, id and effort ('' = none), or why not. A flag effort wins over the role's and the flavor's. */
function resolve(o) {
  if (o.role !== undefined) {
    const r = resolveRole(o.role);
    if (r.error) return { error: r.error };
    return { family: r.family, id: r.id, effort: o.effort ?? r.effort ?? '' };
  }
  const { registry, error } = loadRegistry();
  if (error) return { error: `model registry is invalid — ${error}` };
  // A family, never a raw id: the registry is where ids live.
  if (!Object.hasOwn(registry.models, o.family)) {
    return { error: `"${o.family}" is not a model family (known: ${Object.keys(registry.models).join(', ')})` };
  }
  const m = resolveModel(o.family);
  if (m.error) return { error: m.error };
  if (o.effort !== undefined) return { family: o.family, id: m.id, effort: o.effort };
  const f = resolveFlavor(o.family);
  if (f.error) return { error: f.error };
  return { family: o.family, id: m.id, effort: f.flavor.effort || '' };
}

/** The executable `name` on PATH, absolute entries only, so a repo's ./claude is never picked. */
function which(name) {
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!path.isAbsolute(dir)) continue;
    const p = path.join(dir, name);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      if (fs.statSync(p).isFile()) return p;
    } catch {}
  }
  return null;
}

/**
 * Every path `git status` reports, with its status and the file's size and
 * mtime, so a write to a file that was already dirty shows too; null outside
 * a git work tree. Ignored files and anything outside the repository are not
 * seen. --no-optional-locks: reading the status must not write the index.
 */
function snapshot(cwd) {
  const git = (...a) => spawnSync('git', ['--no-optional-locks', ...a], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const top = git('rev-parse', '--show-toplevel');
  if (top.error || top.status !== 0) return null;
  const root = top.stdout.trim();
  const st = git('status', '--porcelain=v2', '-z', '--untracked-files=all');
  if (st.error || st.status !== 0) return null;
  const seen = new Map();
  const fields = st.stdout.split('\0');
  for (let i = 0; i < fields.length; i++) {
    const e = fields[i];
    // v2 entries: `1 XY sub mH mI mW hH hI path`, `2 … score path` then the old path, `u …` (10 fields before
    // the path), `? path`. A path may hold spaces, so it is everything after the fixed fields.
    let file, xy;
    if (e[0] === '?') { xy = '??'; file = e.slice(2); }
    else if (e[0] === '1' || e[0] === '2' || e[0] === 'u') {
      const words = e.split(' ');
      xy = words[1];
      file = words.slice({ 1: 8, 2: 9, u: 10 }[e[0]]).join(' ');
      if (e[0] === '2') i++;
    } else continue;
    let stamp = 'missing';
    try { const s = fs.lstatSync(path.join(root, file)); stamp = `${s.size}:${s.mtimeMs}`; } catch {}
    seen.set(file, `${xy} ${stamp}`);
  }
  return seen;
}

function changedPaths(before, after) {
  return [...new Set([...before.keys(), ...after.keys()])].filter((p) => before.get(p) !== after.get(p)).sort();
}

/** Run the CLI with stdin from /dev/null; a signal to ask-model goes on to the CLI. */
function run(bin, argv, cwd) {
  return new Promise((done) => {
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    let child;
    let finished = false;
    const forward = (sig) => { try { child.kill(sig); } catch {} };
    const finish = (r) => {
      if (finished) return;
      finished = true;
      for (const s of signals) process.off(s, forward);
      done(r);
    };
    try {
      child = spawn(bin, argv, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      finish({ error: e });
      return;
    }
    for (const s of signals) process.on(s, forward);
    const out = [];
    const err = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', (e) => finish({ error: e }));
    child.on('close', (code, signal) => finish({
      code, signal, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'),
    }));
  });
}

const tail = (s) => String(s || '').trim().slice(-500) || '(no output)';

/** The answer from one CLI's output, or an exit code and why. */
function readAnswer(vendor, id, r) {
  if (r.error) return { exit: r.error.code === 'ENOENT' ? 3 : 4, error: `${vendor} could not start: ${r.error.message}` };
  if (r.signal) return { exit: 4, error: `${vendor} was stopped by ${r.signal}` };
  let answer;
  if (vendor === 'codex') {
    // Codex reports no model, so its answer cannot be checked; the review runtime has no check either.
    if (r.code !== 0) return { exit: 4, error: `codex exited ${r.code}: ${tail(r.stderr || r.stdout)}` };
    answer = r.stdout;
  } else {
    let env;
    try { env = JSON.parse(r.stdout); } catch {
      return { exit: 4, error: `${vendor} exited ${r.code} without a JSON reply: ${tail(r.stdout || r.stderr)}` };
    }
    if (vendor === 'claude') {
      if (env?.is_error !== false) return { exit: 4, error: `claude returned an error: ${tail(env?.result ?? r.stderr)}` };
      if (r.code !== 0) return { exit: 4, error: `claude exited ${r.code}: ${tail(r.stderr)}` };
      const used = Object.keys(env.modelUsage || {});
      if (!used.includes(id)) return { exit: 2, error: `asked for ${id}, but ${used.length ? used.join(', ') : 'no model'} answered — not its answer` };
      answer = env.result;
    } else {
      if (env?.type === 'error' || r.code !== 0) return { exit: 4, error: `grok failed (exit ${r.code}): ${tail(env?.message ?? r.stderr)}` };
      // The review runtime's proof: modelUsage names a grok model. grok may report the id it resolved to,
      // so the exact id is not required.
      const used = Object.keys(env.modelUsage || {});
      if (!used.some((k) => /grok/i.test(k))) return { exit: 2, error: `asked for ${id}, but ${used.length ? used.join(', ') : 'no model'} answered — not its answer` };
      answer = env.text;
    }
  }
  if (typeof answer !== 'string' || !answer.trim()) return { exit: 4, error: `${vendor} returned an empty answer` };
  return { answer: answer.trimEnd() };
}

async function main(argv) {
  const o = parse(argv);
  if (o.help) { process.stdout.write(`${USAGE}\n`); return 0; }
  const usage = (why) => { process.stderr.write(`ask-model: ${why}\n${USAGE}\n`); return 64; };
  if (o.error) return usage(o.error);

  let prompt;
  try { prompt = fs.readFileSync(o.promptFile, 'utf8'); } catch (e) { return usage(`cannot read --prompt-file: ${e.code || e.message}`); }
  if (!prompt.trim()) return usage(`--prompt-file ${o.promptFile} is empty`);
  if (prompt.includes('\0')) return usage(`--prompt-file ${o.promptFile} holds a NUL byte`);
  // A leading '-' would be read as a flag by every one of these CLIs; a newline before it is not.
  if (prompt.startsWith('-')) prompt = `\n${prompt}`;
  const cwd = path.resolve(o.cwd ?? process.cwd());
  try { if (!fs.statSync(cwd).isDirectory()) return usage(`--cwd ${cwd} is not a directory`); } catch { return usage(`--cwd ${cwd} does not exist`); }

  const m = resolve(o);
  if (m.error) return usage(m.error);
  const vendor = vendorOf(m.id);
  if (!vendor) return usage(`${m.family} resolves to "${m.id}", whose prefix names no known CLI (claude-, gpt-, grok-)`);
  const mode = o.investigate ? 'investigate' : 'read-only';
  process.stderr.write(`ask-model: ${m.family} (${m.id}, effort ${m.effort || 'none'}, ${mode})\n`);

  const result = { family: m.family, id: m.id, effort: m.effort || null, mode, answer: null, changed: null, error: null };
  const finish = (exit) => {
    if (result.error) process.stderr.write(`ask-model: ${result.error}\n`);
    if (o.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else if (result.answer !== null) process.stdout.write(`${result.answer}\n`);
    return exit;
  };

  const bin = which(vendor);
  if (!bin) { result.error = `the ${vendor} CLI is not on PATH`; return finish(3); }

  const before = o.investigate ? snapshot(cwd) : null;
  if (o.investigate && !before) process.stderr.write(`ask-model: ${cwd} is not in a git work tree — changes are not checked\n`);
  const r = await run(bin, argvFor(vendor, { ...m, prompt, cwd, mode }), cwd);
  const got = readAnswer(vendor, m.id, r);
  if (got.answer !== undefined) result.answer = got.answer;
  else result.error = got.error;

  if (before) {
    const after = snapshot(cwd);
    result.changed = after ? changedPaths(before, after) : null;
    if (!after || result.changed.length) {
      const what = after ? result.changed.map((p) => `  ${p}`).join('\n') : '  (the work tree could not be read after the call)';
      // A failed call is still reported; the change is what the caller must act on.
      result.error = [result.error, `files changed under --investigate (nothing was reverted):\n${what}`].filter(Boolean).join('\n');
      return finish(5);
    }
  }
  return finish(got.exit ?? 0);
}

/**
 * For `model-id --install`, after it has copied the resolver: this file beside
 * it (resolver/bin/ask-model.mjs, so ../lib/ is the resolver's lib), a launcher
 * pinned to the node running the install, and ~/.local/bin/ask-model linked to
 * it. Returns the lines to print, and an error when the link is refused.
 */
export function install({ home, studio, resolver }) {
  const tilde = (p) => (p.startsWith(home + path.sep) ? '~' + p.slice(home.length) : p);
  const put = (dest, body, mode) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, body, { mode });
    fs.renameSync(tmp, dest);
  };
  const entry = path.join(resolver, 'bin', 'ask-model.mjs');
  put(entry, fs.readFileSync(SELF), 0o644);
  const q = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
  const launcher = path.join(studio, 'bin', 'ask-model');
  put(launcher, [
    '#!/bin/sh',
    '# Installed by `model-id --install` from Agent Config Studio. Re-run that to update.',
    `NODE=${q(process.execPath)}`,
    '# Pinned path first, then node on PATH, then Homebrew\'s default; otherwise fail loudly.',
    '[ -x "$NODE" ] || NODE=$(command -v node 2>/dev/null) || NODE=',
    '[ -n "$NODE" ] || { [ -x "${MODEL_ID_BREW_NODE:-/opt/homebrew/bin/node}" ] && NODE=${MODEL_ID_BREW_NODE:-/opt/homebrew/bin/node}; }',
    'if [ -z "$NODE" ]; then',
    '  echo "ask-model: node not found" >&2',
    '  exit 3',
    'fi',
    `exec "$NODE" ${q(entry)} "$@"`,
    '',
  ].join('\n'), 0o755);

  const lines = `launcher  ${tilde(launcher)}\n`;
  const link = path.join(home, '.local', 'bin', 'ask-model');
  fs.mkdirSync(path.dirname(link), { recursive: true });
  let existing = null;
  try { existing = fs.lstatSync(link); } catch {}
  if (existing && !existing.isSymbolicLink()) return { lines, error: `${tilde(link)} exists and is not a symlink — not replacing it.` };
  if (existing) fs.unlinkSync(link);
  fs.symlinkSync(launcher, link);
  return { lines: `${lines}linked    ${tilde(link)} → ${tilde(launcher)}\n` };
}

// Run as a command, not when model-id imports it for install().
const isMain = (() => { try { return fs.realpathSync(process.argv[1]) === SELF; } catch { return false; } })();
if (isMain) process.exitCode = await main(process.argv.slice(2));
