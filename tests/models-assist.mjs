/**
 * ACS Assist on the model registry, against a REAL running server: a child
 * `node server.js` with HOME redirected to a temp dir holding fake `claude` and
 * `grok` binaries that record their argv. The registry file is edited while the
 * server runs, which is the property under test — no restart.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const realHome = os.homedir();
const temps = [];

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

/** Today's picker with no user file — the one stated change is the Fable id (and so its label). */
const EXPECTED = {
  claude: {
    defaultModel: 'claude-sonnet-5',
    models: [
      { id: 'claude-sonnet-5', label: 'Sonnet 5 · fast' },
      { id: 'claude-opus-5-5', label: 'Opus 5.5 · slower' },
      { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
      { id: 'claude-fable-5-1', label: 'Fable 5.1 · judgment, ~$0.60/turn' },
    ],
  },
  grok: {
    defaultModel: 'grok-4.7',
    models: [{ id: 'grok-4.7', label: 'Grok 4.7' }, { id: 'grok-4.6', label: 'Grok 4.6' }],
  },
};

const PLANTED = ['--help', 'a b', 'x;rm', 'a'.repeat(65)];

function fakeCli(file, log) {
  // Records argv, answers --version, and replies in whichever format was asked.
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!${process.execPath}
const fs = require('fs');
const a = process.argv.slice(2);
if (a[0] === '--version') { console.log('9.9.9 (fake)'); process.exit(0); }
// grok's pre-spawn MCP check (lib/harness.js inspectGrok): no servers here.
if (a[0] === 'inspect') { process.stdout.write(JSON.stringify({ mcpServers: [], plugins: [] })); process.exit(0); }
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(a) + '\\n');
process.stdin.resume(); process.stdin.on('data', () => {});
const done = () => {
  const i = a.indexOf('--output-format');
  if (a[i + 1] === 'json') process.stdout.write(JSON.stringify({ result: 'fixed file' }));
  else {
    // The contained tool set the init gate requires (lib/containment.js).
    console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1', tools: [a.includes('--prompt-file') ? 'read_file' : 'Read'], mcp_servers: [] }));
    console.log(JSON.stringify({ type: 'result', result: 'ok reply', session_id: 'sess-1', usage: {} }));
  }
  process.exit(0);
};
if (a.includes('--prompt-file')) done(); else process.stdin.on('end', done);
`, { mode: 0o755 });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

async function startServer(home) {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: { HOME: home, PORT: String(port), PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, TMPDIR: os.tmpdir() },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const base = `http://localhost:${port}`;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) break;
    try { const r = await fetch(`${base}/api/health`); if (r.ok) return { child, base, log: () => log }; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill('SIGKILL');
  throw new Error(`server did not start: ${log.slice(-600)}`);
}

async function getHarnesses(base) {
  const r = await fetch(`${base}/api/harnesses`);
  return { status: r.status, body: await r.json() };
}

async function chat(base, body) {
  const r = await fetch(`${base}/api/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const text = await r.text();
  const lines = text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } });
  return { status: r.status, done: lines.find((l) => l.t === 'done'), lines };
}

const shape = (h) => ({ defaultModel: h.defaultModel, models: h.models });
const argvLog = (log) => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const modelArg = (argv) => argv[argv.indexOf('--model') + 1];

function setup() {
  // realpath: resolveSafe compares real paths, and macOS tmpdir is behind /private.
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acs-assist-')));
  temps.push(home);
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const log = path.join(home, 'argv.jsonl');
  fakeCli(path.join(home, '.local', 'bin', 'claude'), log);
  fakeCli(path.join(home, '.grok', 'bin', 'grok'), log);
  const userFile = path.join(home, '.agent-config-studio', 'models.json');
  const writeUser = (doc) => {
    fs.mkdirSync(path.dirname(userFile), { recursive: true });
    fs.writeFileSync(userFile, typeof doc === 'string' ? doc : JSON.stringify(doc));
  };
  return { home, log, userFile, writeUser };
}

async function main() {
  console.log('\nmodels/assist');

  // ── fresh machine, then one edit to an already-running server ──────────────
  {
    const { home, log, userFile, writeUser } = setup();
    ok('HOME is redirected', home !== realHome);
    const srv = await startServer(home);
    try {
      const h0 = await getHarnesses(srv.base);
      const byId = Object.fromEntries(h0.body.harnesses.map((h) => [h.id, shape(h)]));
      ok('no user file → /api/harnesses 200', h0.status === 200);
      ok('...claude: today\'s labels, order and default', JSON.stringify(byId.claude) === JSON.stringify(EXPECTED.claude), JSON.stringify(byId.claude));
      ok('...grok: today\'s labels, order and default', JSON.stringify(byId.grok) === JSON.stringify(EXPECTED.grok), JSON.stringify(byId.grok));
      ok('...no registryError', h0.body.registryError === null, h0.body.registryError);
      const claude0 = h0.body.harnesses.find((h) => h.id === 'claude');
      ok('...a saved claude-fable-5 selection migrates to the new Fable id', claude0.retired?.['claude-fable-5'] === 'claude-fable-5-1', JSON.stringify(claude0.retired));
      const reg = await (await fetch(`${srv.base}/api/registry`)).json();
      ok('/api/registry carries the same picker and registryError', JSON.stringify(reg.harnesses) === JSON.stringify(h0.body.harnesses) && reg.registryError === null);

      const t0 = await chat(srv.base, { message: 'hi', harness: 'claude' });
      const a0 = argvLog(log).at(-1) || [];
      ok('a turn with no model runs the default', t0.done?.ok === true && modelArg(a0) === 'claude-sonnet-5', JSON.stringify(a0));
      const tf = await chat(srv.base, { message: 'hi', harness: 'claude', model: 'claude-fable-5-1' });
      const af = argvLog(log).at(-1) || [];
      ok('Fable keeps effort high from the registry', tf.done?.ok === true && modelArg(af) === 'claude-fable-5-1' && af[af.indexOf('--effort') + 1] === 'high', JSON.stringify(af));
      const old = await chat(srv.base, { message: 'hi', harness: 'claude', model: 'claude-fable-5' });
      ok('the retired id itself is no longer on the allowlist', old.status === 400);

      // Criterion 4: edit the user file only, same server process.
      writeUser({ models: { opus: 'claude-opus-6' } });
      const h1 = await getHarnesses(srv.base);
      const c1 = h1.body.harnesses.find((h) => h.id === 'claude');
      ok('one edit reaches the running server: opus → claude-opus-6', c1.models.some((m) => m.id === 'claude-opus-6' && m.label === 'Opus 6 · slower') &&
         !c1.models.some((m) => m.id === 'claude-opus-5-5'), JSON.stringify(c1.models));
      ok('...every other entry unchanged', c1.models.filter((m) => m.id !== 'claude-opus-6').map((m) => m.id).join() ===
         EXPECTED.claude.models.filter((m) => m.id !== 'claude-opus-5-5').map((m) => m.id).join());
      const t1 = await chat(srv.base, { message: 'hi', harness: 'claude', model: 'claude-opus-6' });
      ok('...and a turn on it spawns with the new id', t1.done?.ok === true && modelArg(argvLog(log).at(-1)) === 'claude-opus-6');

      // Criterion 5: planted ids.
      fs.writeFileSync(log, '');
      writeUser({ assist: { claude: { default: 'sonnet', picker: [...PLANTED.map((model) => ({ model })), { model: 'sonnet', note: 'fast' }] } } });
      const h2 = await getHarnesses(srv.base);
      const c2 = h2.body.harnesses.find((h) => h.id === 'claude');
      ok('planted ids → /api/harnesses still 200', h2.status === 200);
      ok('...only the valid entry survives', c2.models.map((m) => m.id).join() === 'claude-sonnet-5', JSON.stringify(c2.models));
      for (const p of PLANTED) {
        ok(`...${JSON.stringify(p.length > 20 ? `${p.slice(0, 6)}…(${p.length})` : p)} rejected with a reason`,
           (h2.body.registryError || '').includes(JSON.stringify(p).slice(1, -1).slice(0, 40)) && /dropped/.test(h2.body.registryError), h2.body.registryError);
      }
      for (const p of PLANTED) {
        const r = await chat(srv.base, { message: 'hi', harness: 'claude', model: p });
        ok(`...naming ${JSON.stringify(p.slice(0, 8))} directly is a 400`, r.status === 400);
      }
      const t2 = await chat(srv.base, { message: 'hi', harness: 'claude' });
      ok('...a turn with the default still works', t2.done?.ok === true && modelArg(argvLog(log).at(-1)) === 'claude-sonnet-5');

      // The same ids planted as family VALUES, not picker entries.
      writeUser({ models: { opus: '--help', haiku: 'x;rm', fable: 'a b' } });
      const h3 = await getHarnesses(srv.base);
      const c3 = h3.body.harnesses.find((h) => h.id === 'claude');
      ok('bad family values are dropped with a reason', c3.models.map((m) => m.id).join() === 'claude-sonnet-5' &&
         ['--help', 'x;rm', 'a b'].every((p) => h3.body.registryError.includes(p)), `${JSON.stringify(c3.models)} ${h3.body.registryError}`);
      await chat(srv.base, { message: 'hi', harness: 'claude' });
      const everything = argvLog(log).flat();
      ok('no planted string ever reached a spawn argv', PLANTED.every((p) => !everything.includes(p)) &&
         everything.filter((a) => a === '--help').length === 0, JSON.stringify(everything.filter((a) => PLANTED.includes(a))));

      // Default dropped → first surviving entry.
      writeUser({ assist: { claude: { default: 'x;rm', picker: [{ model: 'x;rm' }, { model: 'opus', note: 'slower' }, { model: 'haiku' }] } } });
      const h4 = await getHarnesses(srv.base);
      const c4 = h4.body.harnesses.find((h) => h.id === 'claude');
      ok('default dropped → default is the first surviving entry', c4.defaultModel === 'claude-opus-5-5' && /default "x;rm" is not in the picker/.test(h4.body.registryError), `${c4.defaultModel} ${h4.body.registryError}`);
      const t4 = await chat(srv.base, { message: 'hi', harness: 'claude' });
      ok('...and a default turn runs it', t4.done?.ok === true && modelArg(argvLog(log).at(-1)) === 'claude-opus-5-5');

      // Everything dropped → the shipped picker.
      writeUser({ assist: { claude: { default: '--help', picker: PLANTED.map((model) => ({ model })) } } });
      const h5 = await getHarnesses(srv.base);
      const c5 = h5.body.harnesses.find((h) => h.id === 'claude');
      ok('all dropped → the shipped picker and default', JSON.stringify(shape(c5)) === JSON.stringify(EXPECTED.claude) && /no usable model left/.test(h5.body.registryError), h5.body.registryError);
      const t5 = await chat(srv.base, { message: 'hi', harness: 'claude' });
      ok('...and a default turn works', t5.done?.ok === true && modelArg(argvLog(log).at(-1)) === 'claude-sonnet-5');

      // A bad effort must not reach argv either.
      writeUser({ assist: { claude: { default: 'sonnet', picker: [{ model: 'sonnet' }, { model: 'fable', effort: '--dangerously-skip-permissions' }] } } });
      const h6 = await getHarnesses(srv.base);
      ok('a picker entry with an invalid effort is dropped', !h6.body.harnesses.find((h) => h.id === 'claude').models.some((m) => m.id === 'claude-fable-5-1') && /effort/.test(h6.body.registryError));

      // A file that only replaces the picker keeps the shipped default and the Fable migration.
      writeUser({ assist: { claude: { picker: [{ model: 'fable', note: 'judgment', effort: 'high' }, { model: 'sonnet', note: 'fast' }] } } });
      const h8 = await getHarnesses(srv.base);
      const c8 = h8.body.harnesses.find((h) => h.id === 'claude');
      ok('picker-only user file: the picker is replaced as a whole list', c8.models.map((m) => m.id).join() === 'claude-fable-5-1,claude-sonnet-5', JSON.stringify(c8.models));
      ok('...the shipped default is kept', c8.defaultModel === 'claude-sonnet-5' && h8.body.registryError === null, `${c8.defaultModel} ${h8.body.registryError}`);
      ok('...and the claude-fable-5 migration is kept', c8.retired?.['claude-fable-5'] === 'claude-fable-5-1', JSON.stringify(c8.retired));

      // Fixing the file clears the error without a restart.
      fs.rmSync(userFile);
      const h7 = await getHarnesses(srv.base);
      ok('removing the user file restores the defaults, error cleared', h7.body.registryError === null &&
         JSON.stringify(shape(h7.body.harnesses.find((h) => h.id === 'claude'))) === JSON.stringify(EXPECTED.claude));
    } finally {
      srv.child.kill('SIGKILL');
    }
  }

  // ── malformed user file present at start ───────────────────────────────────
  {
    const { log, writeUser, home } = setup();
    writeUser('{ "models": { "opus": ');
    const srv = await startServer(home);
    try {
      ok('malformed user file → server starts', true);
      const h = await getHarnesses(srv.base);
      ok('...registryError present and names the file', h.status === 200 && /models\.json/.test(h.body.registryError || '') && /not valid JSON/.test(h.body.registryError), h.body.registryError);
      ok('...defaults served', JSON.stringify(shape(h.body.harnesses.find((x) => x.id === 'claude'))) === JSON.stringify(EXPECTED.claude));
      const t = await chat(srv.base, { message: 'hi', harness: 'grok' });
      const a = argvLog(log).at(-1) || [];
      ok('...and a grok turn runs the default', t.done?.ok === true && a[a.indexOf('-m') + 1] === 'grok-4.7', JSON.stringify(a));
      const as = await fetch(`${srv.base}/api/assist`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ harness: 'claude', action: 'tighten', path: path.join(home, '.claude', 'CLAUDE.md'), content: 'x' }),
      });
      ok('...one-shot assist also runs the default', as.status === 200 && modelArg(argvLog(log).at(-1)) === 'claude-sonnet-5', String(as.status));
    } finally {
      srv.child.kill('SIGKILL');
    }
  }

  // ── the browser side of the migration: resolveHarness from public/app.js ───
  {
    const src = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
    const start = src.indexOf('function resolveHarness()');
    let i = src.indexOf('{', start), depth = 0;
    for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) break; }
    const fn = src.slice(start, i + 1);
    const run = (stored) => {
      const h = { id: 'claude', label: 'Claude', models: EXPECTED.claude.models, defaultModel: 'claude-sonnet-5', retired: { 'claude-fable-5': 'claude-fable-5-1' } };
      const ctx = {
        C: { harness: 'claude', model: stored },
        S: { registry: { defaultHarness: 'claude' } },
        harnesses: () => [h], harnessOf: (id) => (id === 'claude' ? h : null), modelsOf: (x) => x?.models ?? [],
        notice() {}, saveSessions() {},
      };
      vm.runInNewContext(`${fn}\nresolveHarness();`, ctx);
      return ctx.C.model;
    };
    ok('app.js: a saved claude-fable-5 selection becomes claude-fable-5-1', run('claude-fable-5') === 'claude-fable-5-1');
    ok('app.js: an unknown saved id still falls back to the default', run('claude-nope-1') === 'claude-sonnet-5');
    ok('app.js: no saved model takes the harness default', run(null) === 'claude-sonnet-5');
    ok('app.js: no hardcoded default model id', !/model:\s*'claude-/.test(src));
  }

  for (const t of temps) fs.rmSync(t, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
