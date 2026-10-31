/**
 * The pack installer's sandbox (tests/packs-*.mjs): a temp HOME with its own
 * CODEX_HOME, GROK_HOME, GIT_CONFIG_GLOBAL and GIT_CONFIG_NOSYSTEM, and a
 * PATH that holds only stub CLIs, a `node` link and the system folders —
 * never node's own folder, which may hold real agent CLIs.
 *
 * The stubs never call a model. claude, codex and grok record each call and
 * answer a review with one fixed finding; codex also speaks just enough of
 * the app-server protocol (initialize, hooks/list) for the agent guard's
 * trust check, reading the hooks.json and config.toml of its CODEX_HOME
 * (STUB_HOOKS_DELAY_MS holds the hooks/list answer back, for a slow check).
 * model-id is the real resolver, installed into the temp HOME by
 * `bin/model-id.mjs --install`.
 *
 * A run leaves nothing behind, pass or fail: every sandbox root and every
 * child a suite hands to track() is removed or killed when the process
 * exits (a thrown error and Ctrl-C included), and done() fails the suite if
 * a temp dir this run made is still there.
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const PACKS = path.join(ROOT, 'bin', 'packs.mjs');
const J = JSON.stringify;
export const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

/** What this run made: sandbox roots to remove and children to stop, whatever way it ends. */
const made = new Set();
const children = new Set();

/** A child process the suite started (a server, a CLI in the background): killed if the run ends first. */
export function track(child) {
  children.add(child);
  child.once('exit', () => children.delete(child));
  return child;
}

function sweep() {
  for (const c of children) { try { c.kill('SIGKILL'); } catch {} }
  children.clear();
  for (const root of made) { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} }
}
process.on('exit', sweep);
for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143]]) process.on(sig, () => { sweep(); process.exit(code); });

export function tests() {
  let pass = 0, fail = 0;
  const ok = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`  ok   ${name}`); }
    else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${String(detail).slice(0, 2000)}` : ''}`); }
  };
  const done = () => {
    sweep();
    const left = [...made].filter((root) => fs.existsSync(root));
    ok(`no acs-packs-* temp dir this run made is left (${made.size} made)`, left.length === 0, left.join(' '));
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  };
  return { ok, done };
}

const FINDING = { issue: 'off-by-one in loop', file: 'a.js', line: '2', quote: 'for (let i = 0; i <= n; i++) {}', suggestion: 'use <', likelihood: 5, impact: 5, protected: false, trigger: 'calling f(3)' };

function modelStub(name, calls) {
  return `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path')
const a = process.argv.slice(2)
fs.mkdirSync(${J(calls)}, { recursive: true })
fs.writeFileSync(path.join(${J(calls)}, '${name}-' + process.pid + '-' + Date.now() + '.json'), JSON.stringify(a))
if (${J(name)} === 'codex' && a[0] === 'app-server') {
  // The agent guard's trust check: hooks/list over JSON-RPC, from this CODEX_HOME's own files.
  const home = process.env.CODEX_HOME
  const read = (f) => { try { return fs.readFileSync(path.join(home, f), 'utf8') } catch { return '' } }
  let buf = ''
  process.stdin.on('data', (d) => {
    buf += d
    let at
    while ((at = buf.indexOf('\\n')) >= 0) {
      const line = buf.slice(0, at); buf = buf.slice(at + 1)
      if (!line.trim()) continue
      const msg = JSON.parse(line)
      if (msg.id === 1) process.stdout.write(JSON.stringify({ id: 1, result: {} }) + '\\n')
      if (msg.id === 2) setTimeout(() => {
        let hooks = {}
        try { hooks = JSON.parse(read('hooks.json') || '{}') } catch {}
        const hash = process.env.STUB_TRUST_HASH || 'sha256:stub-guard'
        const toml = read('config.toml')
        const data = (hooks.hooks?.PreToolUse || []).map((g, gi) => ({ hooks: g.hooks.map((h, hi) => {
          const key = path.join(home, 'hooks.json') + ':pre_tool_use:' + gi + ':' + hi
          return { command: h.command, key, currentHash: hash, trustStatus: toml.includes('trusted_hash = ' + JSON.stringify(hash)) && !process.env.STUB_UNTRUSTED ? 'trusted' : 'untrusted' }
        }) }))
        process.stdout.write(JSON.stringify({ id: 2, result: { data } }) + '\\n')
      }, Number(process.env.STUB_HOOKS_DELAY_MS) || 0)
    }
  })
  return
}
if (a[0] === '--version') { console.log('${name} 9.9.9 (stub)'); process.exit(0) }
const schema = a.includes('--output-schema') ? fs.readFileSync(a[a.indexOf('--output-schema') + 1], 'utf8') : a[a.indexOf('--json-schema') + 1]
const reply = String(schema).includes('verdicts') ? '{"verdicts":[]}' : ${J(J({ findings: [FINDING] }))}
if (a.includes('-o')) fs.writeFileSync(a[a.indexOf('-o') + 1], reply)
else if (${J(name)} === 'grok') console.log(JSON.stringify({ structuredOutput: JSON.parse(reply), modelUsage: { 'grok-stub': {} } }))
else console.log(JSON.stringify({ type: 'result', is_error: false, result: reply, structured_output: JSON.parse(reply) }))
`;
}

/**
 * A fresh machine. `clis` names the agent CLIs it has; `modelId` installs the
 * real resolver; `dirs` creates harness homes (claude → ~/.claude, codex →
 * $CODEX_HOME). Returns helpers bound to it.
 */
export function sandbox(label, { clis = ['claude'], modelId = true, dirs = clis, shell = '/bin/zsh' } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `acs-packs-${label}-`)));
  made.add(root);
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin'), nodeBin = path.join(root, 'node-bin'), calls = path.join(root, 'calls');
  fs.mkdirSync(home); fs.mkdirSync(bin); fs.mkdirSync(nodeBin);
  fs.symlinkSync(process.execPath, path.join(nodeBin, 'node'));
  for (const c of clis) { fs.writeFileSync(path.join(bin, c), modelStub(c, calls)); fs.chmodSync(path.join(bin, c), 0o755); }
  const gitconfig = path.join(root, 'gitconfig');
  fs.writeFileSync(gitconfig, '[user]\n\tname = Sandbox\n\temail = sandbox@example.test\n');
  const env = {
    HOME: home, CODEX_HOME: path.join(home, '.codex'), GROK_HOME: path.join(home, '.grok'),
    GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1', TMPDIR: root, SHELL: shell, LANG: 'C',
    PATH: [bin, path.join(home, '.local', 'bin'), nodeBin, '/usr/bin', '/bin'].join(':'),
  };
  for (const d of dirs) fs.mkdirSync(d === 'claude' ? path.join(home, '.claude') : d === 'codex' ? env.CODEX_HOME : env.GROK_HOME, { recursive: true });
  if (modelId) {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'model-id.mjs'), '--install'], { env, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`model-id --install: ${r.stderr}`);
  }
  const packs = (args, extra = {}, opts = {}) => {
    const r = spawnSync(process.execPath, [PACKS, ...args], { env: { ...env, ...extra }, encoding: 'utf8', timeout: 120_000, cwd: root, ...opts });
    return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}`, stdout: r.stdout || '', stderr: r.stderr || '' };
  };
  const json = (args, extra) => { const r = packs([...args, '--json'], extra); try { return { ...r, data: JSON.parse(r.stdout) }; } catch { return { ...r, data: null }; } };
  const run = (cmd, args, { cwd = root, extra = {}, input } = {}) => {
    const r = spawnSync(cmd, args, { cwd, env: { ...env, ...extra }, encoding: 'utf8', timeout: 60_000, input });
    return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}`, stdout: r.stdout || '', stderr: r.stderr || '' };
  };
  const git = (cwd, ...args) => run('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd });
  const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
  const state = () => JSON.parse(fs.readFileSync(path.join(home, '.agent-config-studio', 'packs', 'state.json'), 'utf8'));
  const callsOf = (name) => { try { return fs.readdirSync(calls).filter((f) => f.startsWith(`${name}-`)).map((f) => JSON.parse(fs.readFileSync(path.join(calls, f), 'utf8'))); } catch { return []; } };
  const roles = (doc) => { fs.mkdirSync(path.join(home, '.agent-config-studio'), { recursive: true }); fs.writeFileSync(path.join(home, '.agent-config-studio', 'roles.json'), `${J({ version: 1, ...doc }, null, 2)}\n`); };
  const cleanup = () => fs.rmSync(root, { recursive: true, force: true });
  return { root, home, bin, env, gitconfig, packs, json, run, git, read, state, callsOf, roles, cleanup, calls };
}

/** Every entry under `dir` (files by hash and mode, links by target) — the before/after of a C11 check. */
export function tree(dir, skip = () => false) {
  const out = new Map();
  const walk = (p) => {
    let st;
    try { st = fs.lstatSync(p); } catch { return; }
    if (skip(p)) return;
    if (st.isSymbolicLink()) out.set(p, `link:${fs.readlinkSync(p)}`);
    else if (st.isDirectory()) { out.set(p, 'dir'); for (const n of fs.readdirSync(p)) walk(path.join(p, n)); }
    else out.set(p, `${sha(fs.readFileSync(p))}:${(st.mode & 0o777).toString(8)}`);
  };
  walk(dir);
  return out;
}

/** The paths whose entry differs between two trees. */
export function changed(a, b) {
  const out = [];
  for (const [p, v] of b) if (a.get(p) !== v) out.push(p);
  for (const p of a.keys()) if (!b.has(p)) out.push(p);
  return out.sort();
}

/** A repo with a base commit on main and one change on feat, ready for a review. */
export function reviewRepo(sb, name = 'repo') {
  const repo = path.join(sb.root, name);
  fs.mkdirSync(repo);
  const g = (...a) => { const r = sb.git(repo, ...a); if (r.code !== 0) throw new Error(r.out); return r.stdout.trim(); };
  g('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.js'), 'export const f = (n) => n\n');
  g('add', '.'); g('commit', '-qm', 'base');
  g('checkout', '-qb', 'feat');
  fs.writeFileSync(path.join(repo, 'a.js'), 'export const f = (n) => {\n  for (let i = 0; i <= n; i++) {}\n  return n\n}\n');
  g('add', '.'); g('commit', '-qm', 'change');
  return { repo, g };
}
