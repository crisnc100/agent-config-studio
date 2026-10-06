#!/usr/bin/env node
/**
 * model-id — which id is current <family>?
 *
 *   model-id <family>        claude-fable-5-1          (from the registry)
 *   model-id <raw-id>        passes through unchanged  (gpt-5.6-sol → gpt-5.6-sol)
 *   model-id --table         family → id
 *   model-id --json          the merged registry
 *   model-id --lint [paths]  raw ids / versioned names in the skill scope; exit 1 on any
 *   model-id --sidecars      ids in CLI-owned files that are not current registry values
 *   model-id --install       copy this resolver out of the checkout and link ~/.local/bin/model-id
 *
 * A failed resolution NEVER prints an empty string. It exits 1, says why on
 * stderr, and prints MODEL-ID-UNRESOLVED-<name> — an id every CLI rejects
 * loudly — so an unchecked `-m "$(model-id x)"` cannot fall through to a CLI's
 * own default model.
 *
 * Imports lib/models.js only. Never lib/harness.js: that module sweeps temp
 * files at import, and this runs from every skill.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULTS_PATH, homeDir, lint, loadRegistry, resolveModel, sidecars, userPath,
} from '../lib/models.js';

const args = process.argv.slice(2);
const tilde = (p) => (p.startsWith(homeDir() + path.sep) ? '~' + p.slice(homeDir().length) : p);

function unresolved(name, why) {
  process.stderr.write(`model-id: ${why}\n`);
  process.stdout.write(`MODEL-ID-UNRESOLVED-${String(name).replace(/[^A-Za-z0-9._-]/g, '_') || 'missing'}\n`);
  process.exit(1);
}

function registryOrDie() {
  const r = loadRegistry();
  if (r.error) {
    process.stderr.write(`model-id: model registry is invalid — ${r.error}\n`);
    process.exit(1);
  }
  return r;
}

/**
 * Copies, not a symlink into a checkout: the resolver every skill calls must
 * not change or vanish when a worktree is removed or a branch is checked out.
 * The launcher pins the node that ran the install, because a skill's
 * non-interactive `sh -c` may not have node on PATH at all.
 */
function install() {
  const home = homeDir();
  const studio = path.join(home, '.agent-config-studio');
  const resolver = path.join(studio, 'resolver');
  const src = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const put = (rel, body, mode = 0o644) => {
    const dest = path.join(resolver, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, body, { mode });
    fs.renameSync(tmp, dest);
  };
  put('bin/model-id.mjs', fs.readFileSync(path.join(src, 'bin', 'model-id')));
  put('lib/models.js', fs.readFileSync(path.join(src, 'lib', 'models.js')));
  put('models.default.json', fs.readFileSync(DEFAULTS_PATH));
  put('package.json', '{ "type": "module", "private": true }\n');

  const launcher = path.join(studio, 'bin', 'model-id');
  const entry = path.join(resolver, 'bin', 'model-id.mjs');
  const q = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
  fs.mkdirSync(path.dirname(launcher), { recursive: true });
  const body = [
    '#!/bin/sh',
    '# Installed by `model-id --install` from Agent Config Studio. Re-run that to update.',
    `NODE=${q(process.execPath)}`,
    '# Pinned path first, then node on PATH, then Homebrew\'s default; otherwise fail loudly.',
    '[ -x "$NODE" ] || NODE=$(command -v node 2>/dev/null) || NODE=',
    '[ -n "$NODE" ] || { [ -x "${MODEL_ID_BREW_NODE:-/opt/homebrew/bin/node}" ] && NODE=${MODEL_ID_BREW_NODE:-/opt/homebrew/bin/node}; }',
    'if [ -z "$NODE" ]; then',
    '  echo "model-id: node not found" >&2',
    '  echo "MODEL-ID-UNRESOLVED-${1:-missing}"',
    '  exit 1',
    'fi',
    `exec "$NODE" ${q(entry)} "$@"`,
    '',
  ].join('\n');
  fs.writeFileSync(`${launcher}.tmp-${process.pid}`, body, { mode: 0o755 });
  fs.renameSync(`${launcher}.tmp-${process.pid}`, launcher);

  const link = path.join(home, '.local', 'bin', 'model-id');
  fs.mkdirSync(path.dirname(link), { recursive: true });
  let existing = null;
  try { existing = fs.lstatSync(link); } catch {}
  if (existing && !existing.isSymbolicLink()) {
    process.stderr.write(`model-id: ${tilde(link)} exists and is not a symlink — not replacing it.\n`);
    process.exit(1);
  }
  if (existing) fs.unlinkSync(link);
  fs.symlinkSync(launcher, link);
  process.stdout.write(`installed ${tilde(resolver)}\nlauncher  ${tilde(launcher)}\nlinked    ${tilde(link)} → ${tilde(launcher)}\n`);
}

const [first, ...rest] = args;

if (first === '--install') {
  install();
} else if (first === '--json') {
  const r = registryOrDie();
  process.stdout.write(JSON.stringify({ ...r.registry, source: r.source }, null, 2) + '\n');
} else if (first === '--table') {
  const r = registryOrDie();
  const w = Math.max(...Object.keys(r.registry.models).map((k) => k.length));
  for (const [k, v] of Object.entries(r.registry.models)) process.stdout.write(`${k.padEnd(w)}  ${v}\n`);
  process.stdout.write(`\nsource: ${tilde(r.source)}${r.source === DEFAULTS_PATH ? ` (no ${tilde(userPath())})` : ''}\n`);
} else if (first === '--lint') {
  const { files, hits } = lint(rest);
  for (const h of hits) process.stdout.write(`${tilde(h.file)}:${h.line}: ${h.match}  — ${h.text ?? ''}\n`);
  process.stderr.write(`model-id --lint: ${hits.length} hit(s) in ${files} file(s)\n`);
  process.exit(hits.length ? 1 : 0);
} else if (first === '--sidecars') {
  const r = registryOrDie();
  const found = sidecars();
  for (const s of found) {
    process.stdout.write(`${tilde(s.file)} ${s.where}: ${s.value} is not a current registry id\n`);
  }
  process.stderr.write(`model-id --sidecars: ${found.length} stale id(s) against ${tilde(r.source)}\n`);
} else if (first === undefined || first.startsWith('-') || rest.length) {
  unresolved(first ?? '', 'usage: model-id <family|raw-id> | --table | --json | --lint [paths] | --sidecars | --install');
} else {
  const r = resolveModel(first);
  if (r.error) unresolved(first, r.error);
  process.stdout.write(`${r.id}\n`);
}
