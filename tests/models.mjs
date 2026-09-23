/**
 * The model registry and its resolver, run as real child processes against a
 * redirected HOME. Nothing here writes the real ~/.agent-config-studio,
 * ~/.claude or ~/.codex; the one real-HOME check (the lint over the live skill
 * scope) only reads.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'model-id');
const DEFAULTS = JSON.parse(fs.readFileSync(path.join(ROOT, 'models.default.json'), 'utf8'));
const realHome = os.homedir();
const temps = [];

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

function tempHome(userFile) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'acs-models-'));
  temps.push(home);
  if (userFile !== undefined) {
    fs.mkdirSync(path.join(home, '.agent-config-studio'), { recursive: true });
    fs.writeFileSync(path.join(home, '.agent-config-studio', 'models.json'),
      typeof userFile === 'string' ? userFile : JSON.stringify(userFile));
  }
  return home;
}

const write = (file, body) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body); };

function run(home, ...args) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8', env: { HOME: home, PATH: '/usr/bin:/bin' },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

console.log('\nmodels/resolver');

// --- every family, raw passthrough --------------------------------------------
{
  const home = tempHome();
  ok('HOME is redirected', home !== realHome);
  for (const [fam, id] of Object.entries(DEFAULTS.models)) {
    const r = run(home, fam);
    ok(`${fam} → ${id}`, r.code === 0 && r.out === `${id}\n`, JSON.stringify(r));
  }
  for (const raw of ['gpt-5.6-sol', 'claude-opus-5-5', 'grok-4.7']) {
    const r = run(home, raw);
    ok(`raw id ${raw} passes through`, r.code === 0 && r.out === `${raw}\n`, JSON.stringify(r));
  }
  const unk = run(home, 'opuss');
  ok('unknown family → exit 1', unk.code === 1);
  ok('...prints MODEL-ID-UNRESOLVED-opuss, never an empty string', unk.out === 'MODEL-ID-UNRESOLVED-opuss\n', unk.out);
  ok('...and says why on stderr', /unknown model family "opuss"/.test(unk.err), unk.err);
  const none = run(home);
  ok('no argument → exit 1 with a non-empty unresolved id', none.code === 1 && /^MODEL-ID-UNRESOLVED-\S+\n$/.test(none.out), none.out);
  const tbl = run(home, '--table');
  ok('--table lists every family', tbl.code === 0 && Object.entries(DEFAULTS.models).every(([k, v]) => new RegExp(`^${k}\\s+${v.replace(/\./g, '\\.')}$`, 'm').test(tbl.out)), tbl.out);
  const js = run(home, '--json');
  let parsed = null;
  try { parsed = JSON.parse(js.out); } catch {}
  ok('--json is the merged registry', parsed?.models?.fable === DEFAULTS.models.fable && parsed?.assist?.claude);
}

// --- user file: per-key merge, unknown keys, malformed, bad values -------------
{
  const home = tempHome({ models: { opus: 'claude-opus-6' } });
  ok('a file setting only opus changes opus', run(home, 'opus').out === 'claude-opus-6\n');
  ok('...and keeps every other default', run(home, 'fable').out === `${DEFAULTS.models.fable}\n` &&
     run(home, 'astra').out === `${DEFAULTS.models.astra}\n`);

  const typo = tempHome({ models: { opuss: 'claude-opus-5-5' } });
  const t = run(typo, 'fable');
  ok('unknown family key in the user file → error, not a silent no-op', t.code === 1 && t.out === 'MODEL-ID-UNRESOLVED-fable\n' && /unknown family "opuss"/.test(t.err), JSON.stringify(t));
  const top = tempHome({ modles: {} });
  ok('unknown top-level key → error', run(top, 'fable').code === 1 && /unknown key "modles"/.test(run(top, 'fable').err));

  const broken = tempHome('{ "models": { "opus": ');
  const b = run(broken, 'opus');
  ok('malformed user file → exit 1', b.code === 1);
  ok('...stdout is MODEL-ID-UNRESOLVED-opus', b.out === 'MODEL-ID-UNRESOLVED-opus\n', b.out);
  ok('...stderr names the file', b.err.includes('models.json') && /not valid JSON/.test(b.err), b.err);
  ok('--table refuses a malformed registry too', run(broken, '--table').code === 1);

  const bad = tempHome({ models: { opus: 'x;rm -rf ~' } });
  const bv = run(bad, 'opus');
  ok('a family whose value is not a valid id → exit 1, never the value', bv.code === 1 && bv.out === 'MODEL-ID-UNRESOLVED-opus\n', JSON.stringify(bv));
  const nonstr = tempHome({ models: { opus: 5 } });
  ok('a non-string value is a shape error', run(nonstr, 'fable').code === 1);
}

// --- $HOME is what is honored ---------------------------------------------------
{
  const a = tempHome({ models: { grok: 'grok-4.7' } });
  const b = tempHome({ models: { grok: 'grok-4.5' } });
  ok('two HOMEs, two answers', run(a, 'grok').out === 'grok-4.7\n' && run(b, 'grok').out === 'grok-4.5\n');
}

// --- resolver imports only lib/models.js ---------------------------------------
{
  const src = fs.readFileSync(BIN, 'utf8');
  const imports = [...src.matchAll(/^import[\s\S]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
  ok('bin/model-id imports only node: builtins and ../lib/models.js',
     imports.every((i) => i.startsWith('node:') || i === '../lib/models.js'), imports.join(', '));
  const lib = fs.readFileSync(path.join(ROOT, 'lib', 'models.js'), 'utf8');
  ok('lib/models.js imports no other lib module', ![...lib.matchAll(/from\s+['"](\.[^'"]+)['"]/g)].length);
}

// --- install, then a non-interactive sh with a minimal PATH ---------------------
{
  const home = tempHome();
  const inst = spawnSync(process.execPath, [BIN, '--install'], { encoding: 'utf8', env: { HOME: home, PATH: '/usr/bin:/bin' } });
  ok('--install succeeds into a temp HOME', inst.status === 0, inst.stderr);
  const link = path.join(home, '.local', 'bin', 'model-id');
  const launcher = path.join(home, '.agent-config-studio', 'bin', 'model-id');
  ok('~/.local/bin/model-id is a symlink to the launcher', fs.lstatSync(link).isSymbolicLink() && fs.readlinkSync(link) === launcher);
  ok('the resolver is a copy, not a link into this checkout',
     !fs.lstatSync(path.join(home, '.agent-config-studio', 'resolver', 'lib', 'models.js')).isSymbolicLink());
  const sh = spawnSync('/bin/sh', ['-c', 'model-id fable'], {
    encoding: 'utf8', env: { HOME: home, PATH: `/usr/bin:/bin:${path.join(home, '.local', 'bin')}` },
  });
  ok('/bin/sh -c "model-id fable" with PATH=/usr/bin:/bin:~/.local/bin', sh.status === 0 && sh.stdout === `${DEFAULTS.models.fable}\n`, JSON.stringify({ o: sh.stdout, e: sh.stderr }));
  const shBad = spawnSync('/bin/sh', ['-c', 'model-id nope'], {
    encoding: 'utf8', env: { HOME: home, PATH: `/usr/bin:/bin:${path.join(home, '.local', 'bin')}` },
  });
  ok('...and a failure through the launcher still prints the unresolved id', shBad.status === 1 && shBad.stdout === 'MODEL-ID-UNRESOLVED-nope\n', shBad.stdout);

  // The launcher pins the node that ran the install. On a machine where that
  // path does not exist (Homebrew's /opt/homebrew/bin, another box), it falls
  // back to node on PATH, and with no node anywhere it fails loudly.
  const launcherSrc = fs.readFileSync(launcher, 'utf8');
  ok('the launcher pins the absolute node that ran the install', launcherSrc.includes(`NODE='${process.execPath}'`));
  fs.writeFileSync(launcher, launcherSrc.replace(/^NODE=.*$/m, "NODE='/opt/homebrew/bin/node-not-here'"));
  // MODEL_ID_BREW_NODE stands in for /opt/homebrew/bin/node so the result does not depend on this machine.
  const noNode = spawnSync('/bin/sh', ['-c', 'model-id fable'], {
    encoding: 'utf8', env: { HOME: home, PATH: `/usr/bin:/bin:${path.join(home, '.local', 'bin')}`, MODEL_ID_BREW_NODE: '/nonexistent/node' },
  });
  ok('pinned node missing and none on PATH → exit 1, MODEL-ID-UNRESOLVED-fable, "node not found"',
     noNode.status === 1 && noNode.stdout === 'MODEL-ID-UNRESOLVED-fable\n' && /node not found/.test(noNode.stderr), JSON.stringify(noNode));
  const onPath = spawnSync('/bin/sh', ['-c', 'model-id fable'], {
    encoding: 'utf8', env: { HOME: home, PATH: `/usr/bin:/bin:${path.dirname(process.execPath)}:${path.join(home, '.local', 'bin')}` },
  });
  const brew = spawnSync('/bin/sh', ['-c', 'model-id fable'], {
    encoding: 'utf8', env: { HOME: home, PATH: `/usr/bin:/bin:${path.join(home, '.local', 'bin')}`, MODEL_ID_BREW_NODE: process.execPath },
  });
  ok('pinned node missing, none on PATH, Homebrew node present → resolves', brew.status === 0 && brew.stdout === `${DEFAULTS.models.fable}\n`, JSON.stringify(brew));
  ok('pinned node missing but node on PATH → still resolves', onPath.status === 0 && onPath.stdout === `${DEFAULTS.models.fable}\n`, JSON.stringify(onPath));

  // The copy keeps working when the checkout it came from is gone.
  const moved = fs.mkdtempSync(path.join(os.tmpdir(), 'acs-models-src-'));
  temps.push(moved);
  for (const rel of ['bin/model-id', 'lib/models.js', 'models.default.json', 'package.json']) {
    write(path.join(moved, rel), fs.readFileSync(path.join(ROOT, rel)));
  }
  const home2 = tempHome();
  spawnSync(process.execPath, [path.join(moved, 'bin', 'model-id'), '--install'], { env: { HOME: home2, PATH: '/usr/bin:/bin' } });
  fs.rmSync(moved, { recursive: true, force: true });
  const after = spawnSync('/bin/sh', ['-c', 'model-id opus'], {
    encoding: 'utf8', env: { HOME: home2, PATH: `/usr/bin:/bin:${path.join(home2, '.local', 'bin')}` },
  });
  ok('the installed resolver survives its source checkout being deleted', after.stdout === `${DEFAULTS.models.opus}\n`, after.stderr);

  const home3 = tempHome();
  write(path.join(home3, '.local', 'bin', 'model-id'), '#!/bin/sh\necho mine\n');
  const clash = spawnSync(process.execPath, [BIN, '--install'], { encoding: 'utf8', env: { HOME: home3, PATH: '/usr/bin:/bin' } });
  ok('install refuses to replace a real file at ~/.local/bin/model-id', clash.status === 1 &&
     fs.readFileSync(path.join(home3, '.local', 'bin', 'model-id'), 'utf8') === '#!/bin/sh\necho mine\n');
}

// The fallback the skills use: with no model-id on PATH the substitution is a loud, invalid id.
{
  const r = spawnSync('/bin/sh', ['-c', 'printf %s "$(model-id fable || echo MODEL-ID-UNRESOLVED-fable)"'], {
    encoding: 'utf8', env: { PATH: '/usr/bin:/bin' },
  });
  ok('no model-id on PATH: "$(model-id fable || echo …)" expands to MODEL-ID-UNRESOLVED-fable, not ""', r.stdout === 'MODEL-ID-UNRESOLVED-fable', JSON.stringify(r.stdout));
}

console.log('\nmodels/sidecars');
{
  const home = tempHome({ models: { opus: 'claude-opus-6' } });
  write(path.join(home, '.claude', 'settings.json'), JSON.stringify({
    model: 'opus', modelSettings: { [DEFAULTS.models.opus]: { effort: 'high' }, [DEFAULTS.models.fable]: {} },
  }));
  write(path.join(home, '.codex', 'config.toml'), `model = "${DEFAULTS.models.sol}"\n[profiles.x]\nmodel = "gpt-4.1"\n`);
  const r = run(home, '--sidecars');
  ok('after an opus bump, settings.json modelSettings[<shipped opus>] is flagged', r.out.includes(`modelSettings["${DEFAULTS.models.opus}"]`), r.out);
  ok('...a current id is not flagged', !r.out.includes(`modelSettings["${DEFAULTS.models.fable}"]`), r.out);
  ok('...a family alias as `model` is not flagged', !/settings\.json model:/.test(r.out), r.out);
  ok('...a stale config.toml model is flagged by line', /config\.toml line 3 model: gpt-4\.1/.test(r.out) && !r.out.includes('line 1'), r.out);
  ok('--sidecars reports, it does not rewrite', JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8')).modelSettings[DEFAULTS.models.opus]);
  const clean = tempHome();
  write(path.join(clean, '.claude', 'settings.json'), JSON.stringify({ modelSettings: { [DEFAULTS.models.opus]: {} } }));
  ok('with no bump the same entry is current', run(clean, '--sidecars').out === '');
}

console.log('\nmodels/lint');
{
  const home = tempHome();
  const skill = path.join(home, '.claude', 'skills', 'demo', 'SKILL.md');
  write(skill, '---\nname: demo\n---\nRun `claude -p --model "$(model-id fable || echo MODEL-ID-UNRESOLVED-fable)" --effort high`.\n');
  write(path.join(home, '.codex', 'skills', 'demo', 'SKILL.md'), 'Astra high reviews.\n');
  write(path.join(home, '.claude', 'CLAUDE.md'), 'Fable judges. Current ids: `model-id --table`.\n');
  // Out of scope by rule: these may carry anything.
  write(path.join(home, '.codex', 'skills', '.system', 'x', 'SKILL.md'), 'gpt-6-astra\n');
  write(path.join(home, '.claude', 'skills', 'synced', 'x', 'SKILL.md'), 'Opus 5\n');
  write(path.join(home, '.claude', 'skills', 'demo', 'SKILL.md.bak-1'), 'claude-opus-5\n');
  write(path.join(home, '.claude', 'skills', 'skills_retired', 'SKILL.md'), 'grok-4.6\n');
  const clean = run(home, '--lint');
  ok('clean scope → exit 0', clean.code === 0, clean.out + clean.err);

  write(skill, '---\nname: demo\n---\nRun `codex exec -m gpt-6-astra`.\n');
  const raw = run(home, '--lint');
  ok('a planted raw id → non-zero', raw.code === 1);
  ok('...naming file:line', raw.out.includes('~/.claude/skills/demo/SKILL.md:4') || raw.out.includes(`${skill}:4`), raw.out);

  write(skill, '---\nname: demo\n---\nRun `claude -p --model "$(model-id fable)"`.\n');
  const bare = run(home, '--lint');
  ok('a bare $(model-id x) with no || fallback → non-zero, naming file:line', bare.code === 1 && /SKILL\.md:4: \$\(model-id fable\)/.test(bare.out), bare.out);

  write(skill, '---\nname: demo\n---\nThe judge is Fable 5.1.\n');
  const ver = run(home, '--lint');
  ok('a planted versioned name → non-zero, naming file:line', ver.code === 1 && /SKILL\.md:4: Fable 5/.test(ver.out), ver.out);

  write(skill, '---\nname: demo\n---\nclean\n');
  const proj = path.join(home, 'Documents', 'Projects', 'personal', 'app', '.claude', 'review-config.json');
  write(proj, '{\n  "model": "gpt-5.6-sol"\n}\n');
  const pr = run(home, '--lint');
  ok('a raw id in a project .claude/review-config.json → non-zero', pr.code === 1);
  ok('...naming file:line', /app\/\.claude\/review-config\.json:2: gpt-5/.test(pr.out), pr.out);

  const one = run(home, '--lint', path.join(home, '.claude', 'skills', 'demo', 'SKILL.md'));
  ok('--lint <path> lints only that path', one.code === 0, one.out);
  write(path.join(home, '.claude', 'CLAUDE.md'), 'Builders: GPT-6 Sol medium.\n');
  const doctrine = run(home, '--lint');
  ok('~/.claude/CLAUDE.md is in the default scope again: a versioned name there → non-zero', doctrine.code === 1 && /CLAUDE\.md:1: GPT-6/.test(doctrine.out), doctrine.out);
  write(path.join(home, '.claude', 'CLAUDE.md'), 'Fable judges. Current ids: `model-id --table`.\n');
}

// ACS's own source is held to the same rule by this test rather than by the
// user-facing lint: ids live in models.default.json and nowhere else.
{
  const r = spawnSync(process.execPath, [BIN, '--lint', 'lib', 'server.js', 'public/app.js', 'public/index.html'], {
    cwd: ROOT, encoding: 'utf8', env: { HOME: realHome, PATH: '/usr/bin:/bin' },
  });
  // `grok-1` there is a usage-seat id (the first grok seat), not a model id.
  const allowed = (l) => /lib\/usage\/seats\.js:\d+: grok-1 /.test(l);
  const hits = r.stdout.split('\n').filter(Boolean).filter((l) => !allowed(l));
  ok('lib/, server.js and public/ carry no raw model id or versioned name', hits.length === 0, hits.join(' | '));
}

// The live scope, read-only: criterion 7's "exit 0 over full scope".
{
  const r = spawnSync(process.execPath, [BIN, '--lint'], { encoding: 'utf8', env: { HOME: realHome, PATH: '/usr/bin:/bin' } });
  ok('model-id --lint exits 0 over the real skill scope', r.status === 0, `${r.stdout.split('\n').slice(0, 8).join(' | ')} ${r.stderr}`);
}

for (const t of temps) fs.rmSync(t, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
