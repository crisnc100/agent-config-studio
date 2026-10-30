/**
 * The pack installer: reads packs/<id>/pack.json, works out exactly what an
 * install, update or uninstall will change, shows that as a preview, and then
 * changes exactly that — backups first, atomic writes, and a record in
 * ~/.agent-config-studio/packs/state.json taken under a lock.
 *
 * The rules (builds/skill-packs/plan.md "Behavior rules"):
 *  - a file the pack wrote and nobody touched since is updated in place, or on
 *    uninstall gets its exact pre-install bytes back (or goes, if it was new);
 *  - a file someone edited keeps the edit: an update reports it (--replace
 *    backs it up and takes the new one), an uninstall removes only the pack's
 *    own block or entry;
 *  - the shared review runtime is installed once and goes with its last part;
 *  - the agent guard and the push gate are installed and removed by their own
 *    installers in the runtime (one source of truth), the worktree tools by
 *    bin/install-worktree.mjs; this module snapshots and backs up around them.
 *
 * Every child process here is one of: process.execPath running a script this
 * package ships, git, or /bin/sh running the push gate's installer. No model
 * CLI is ever run from this module (tests/guards.mjs guard b).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { homeDir, loadRegistry, resolveName } from './models.js';
import { loadRoles, readUserRoles, ROLE_FIELDS, rolesUserPath } from './roles.js';
import { hashOf as rolesBase, setRole } from './roles-panel.js';
import { vendorOf } from './models-catalog.js';
import {
  addRoot, emptyState, findBlock, hashSnap, hasRoot, hasStanza, missingDirs, readBackup, readState, realFile,
  removeBlock, removeRoot, removeStanza, restoreSnap, saveBackup, sha, snapshot, upsertBlock, withStateLock,
  writeAtomic, writeLink, writeState,
} from './packs-files.js';

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PACKS_DIR = path.join(ROOT, 'packs');
const RUNTIME_SRC = path.join(PACKS_DIR, 'review-gate', 'runtime');
const ORDER = ['review-gate', 'build', 'advisor', 'second-opinion', 'handoff', 'worktree'];
const HARNESSES = ['claude', 'codex', 'grok'];
const KINDS = new Set(['skill', 'instructions', 'guard', 'push-gate', 'codex-log-access', 'worktree']);
/** The roles each pack's skills run models from: the role fix-up checks these. */
const ROLE_NEEDS = { 'review-gate': ['reviewer'], build: ['reviewer', 'advisor', 'judge'], advisor: ['advisor'], 'second-opinion': ['advisor', 'reviewer'] };
const SKILL_PATH = /^packs\/[^/]+\/skills\/(claude|codex)\/(.+)$/;

/* ── the catalog ─────────────────────────────────────────────────────── */

const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0;

/**
 * A manifest's explanations, checked: a summary, a full explain on the pack,
 * and every part with its own non-empty changes — what install shows before
 * it writes anything. Throws naming the first gap.
 */
export function validatePack(pack) {
  const where = `packs/${pack?.id}/pack.json`;
  if (!pack || !nonEmpty(pack.id) || !nonEmpty(pack.title) || !nonEmpty(pack.version)) throw new Error(`${where}: id, title and version are required`);
  if (!nonEmpty(pack.summary)) throw new Error(`${where}: summary is missing or empty`);
  for (const k of ['what', 'does', 'undo']) if (!nonEmpty(pack.explain?.[k])) throw new Error(`${where}: explain.${k} is missing or empty`);
  if (!Array.isArray(pack.explain.changes) || !pack.explain.changes.length || !pack.explain.changes.every(nonEmpty)) throw new Error(`${where}: explain.changes must list what the pack changes`);
  if (!Array.isArray(pack.parts) || !pack.parts.length) throw new Error(`${where}: no parts`);
  for (const part of pack.parts) {
    if (!KINDS.has(part.kind)) throw new Error(`${where}: part ${part.id}: unknown kind ${part.kind}`);
    const e = explainOf(pack, part);
    for (const k of ['what', 'does', 'undo']) if (!nonEmpty(e[k])) throw new Error(`${where}: part ${part.id}: explain.${k} is empty`);
    if (!Array.isArray(e.changes) || !e.changes.length || !e.changes.every(nonEmpty)) throw new Error(`${where}: part ${part.id}: explain.changes is missing or empty`);
  }
  return pack;
}

export function loadCatalog() {
  const ids = fs.readdirSync(PACKS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(PACKS_DIR, d.name, 'pack.json'))).map((d) => d.name);
  ids.sort((a, b) => (ORDER.indexOf(a) + 1 || 99) - (ORDER.indexOf(b) + 1 || 99) || a.localeCompare(b));
  return ids.map((id) => {
    return validatePack(JSON.parse(fs.readFileSync(path.join(PACKS_DIR, id, 'pack.json'), 'utf8')));
  });
}

export function getPack(id, catalog = loadCatalog()) {
  const pack = catalog.find((p) => p.id === id);
  if (!pack) throw Object.assign(new Error(`no pack "${id}" (packs: ${catalog.map((p) => p.id).join(', ')})`), { status: 404 });
  return pack;
}

/** A part's explanation: the pack's, with the part's own fields over it; `changes` is always the part's. */
export const explainOf = (pack, part) => ({ ...pack.explain, ...(part.explain || {}), changes: part.explain?.changes || [] });

/* ── this machine ────────────────────────────────────────────────────── */

const isExec = (p) => { try { return fs.statSync(p).isFile() && (fs.accessSync(p, fs.constants.X_OK), true); } catch { return false; } };
/** The way review.mjs looks a CLI up (its onPath): PATH only, nothing run. */
export const onPath = (name, env = process.env) => String(env.PATH || '').split(':').map((d) => d && path.join(d, name)).find((p) => p && isExec(p)) || null;

export function machine(env = process.env) {
  const home = env.HOME || homeDir() || os.homedir();
  const studio = path.join(home, '.agent-config-studio');
  const codexHome = env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(home, '.codex');
  const grokHome = env.GROK_HOME ? path.resolve(env.GROK_HOME) : path.join(home, '.grok');
  const claudeHome = path.join(home, '.claude');
  const clis = Object.fromEntries(HARNESSES.map((h) => [h, onPath(h, env)]));
  const homes = { claude: claudeHome, codex: codexHome, grok: grokHome };
  const present = Object.fromEntries(HARNESSES.map((h) => [h, !!clis[h] || fs.existsSync(homes[h])]));
  return {
    env, home, studio, claudeHome, codexHome, grokHome, clis, present, homes,
    statePath: path.join(studio, 'packs', 'state.json'),
    runtime: path.join(studio, 'review-gate'),
    backups: path.join(studio, 'backups'),
    node: process.execPath,
    git: onPath('git', env),
    modelId: onPath('model-id', env),
  };
}

const tilde = (m, p) => (p === m.home || p.startsWith(m.home + path.sep) ? `~${p.slice(m.home.length)}` : p);

/**
 * The Codex homes the guard and the log-access part edit: ~/.codex when it
 * exists, $CODEX_HOME, and codexHomes[] from the first review-gate config
 * that exists — the same list install-agent-guard.mjs builds.
 */
export function codexHomes(m) {
  const out = [];
  if (fs.existsSync(path.join(m.home, '.codex'))) out.push(path.join(m.home, '.codex'));
  // A $CODEX_HOME that does not exist is not a Codex install: skipped, like an absent ~/.codex.
  if (m.env.CODEX_HOME && fs.existsSync(m.env.CODEX_HOME)) out.push(path.resolve(m.env.CODEX_HOME));
  for (const file of [path.join(m.runtime, 'config.json'), path.join(m.claudeHome, 'review-config.json')]) {
    if (!fs.existsSync(file)) continue;
    let doc;
    try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new Error(`Malformed review config at ${file}: ${e.message}`); }
    const list = doc?.codexHomes ?? [];
    if (!Array.isArray(list) || list.some((p) => typeof p !== 'string' || !p.trim())) throw new Error(`codexHomes in ${file} must be a list of folder paths`);
    for (const p of list) out.push(path.resolve(m.home, p.replace(/^~(?=\/|$)/, m.home)));
    break;
  }
  return [...new Set(out)];
}

/** The global git config file git writes for --global, the way install-global.sh resolves it. */
export function globalGitConfig(m) {
  if (m.env.GIT_CONFIG_GLOBAL) return path.resolve(m.env.GIT_CONFIG_GLOBAL);
  const xdg = path.join(m.env.XDG_CONFIG_HOME || path.join(m.home, '.config'), 'git', 'config');
  return !fs.existsSync(path.join(m.home, '.gitconfig')) && fs.existsSync(xdg) ? xdg : path.join(m.home, '.gitconfig');
}

function git(m, args, { allowed = [0], cwd } = {}) {
  const r = spawnSync('git', args, { encoding: 'utf8', env: m.env, cwd });
  if (r.error || !allowed.includes(r.status)) throw new Error(`git ${args.join(' ')}: ${r.error?.message || r.stderr.trim() || `exit ${r.status}`}`);
  return r;
}

const globalHooksPath = (m) => {
  const r = git(m, ['config', '--global', '--includes', '--null', '--get-all', 'core.hooksPath'], { allowed: [0, 1] });
  return r.status === 1 ? [] : r.stdout.split('\0').slice(0, -1);
};

/** A setting the pack set in the global git config: its values now, and whether that is still just the pack's value. */
function gitSetting(m, rec) {
  const r = git(m, ['config', '--global', '--null', '--get-all', rec.key], { allowed: [0, 1] });
  const values = r.status === 1 ? [] : r.stdout.split('\0').slice(0, -1);
  return { values, ours: rec.value !== undefined && values.length === 1 && values[0] === rec.value };
}

/** An earlier install made from the review-gate working copy, before packs existed. */
export function legacyReviewGate(m) {
  return [path.join(m.studio, 'review-gate-installed'), path.join(m.claudeHome, 'review-log')].filter((p) => fs.existsSync(p));
}

/* ── requirements and roles ──────────────────────────────────────────── */

/** Each requirement of `pack`: met or not, and the fix when not. */
export function requirements(pack, m, { satisfiedPacks = new Set() } = {}) {
  const req = pack.requires || {};
  const out = [];
  const want = Number(/^>=\s*(\d+)/.exec(req.node || '')?.[1] || 0);
  const major = Number(process.versions.node.split('.')[0]);
  out.push({ id: 'node', ok: major >= want, what: `node ${process.versions.node} (needs ${req.node || 'any'})`, fix: `install Node.js ${want} or newer from https://nodejs.org` });
  if (req.git) out.push({ id: 'git', ok: !!m.git, what: m.git ? `git (${m.git})` : 'git is not on PATH', fix: 'install git from https://git-scm.com/downloads' });
  if (req.modelId) {
    out.push({ id: 'model-id', ok: !!m.modelId, what: m.modelId ? `model-id (${tilde(m, m.modelId)})` : 'model-id is not on PATH', fix: 'run: acs install-model-id (it links ~/.local/bin/model-id; put ~/.local/bin on your PATH)' });
    const loaded = loadRoles({ home: m.home });
    out.push({ id: 'roles', ok: !loaded.error, what: loaded.error ? `your ACS roles cannot be read: ${loaded.error}` : 'ACS roles', fix: 'fix roles.json in ACS → Models → Roles' });
  }
  const any = req.clis?.anyOf || [];
  if (any.length) {
    const have = any.filter((c) => m.clis[c]);
    out.push({ id: 'cli', ok: have.length > 0, what: have.length ? `agent CLI: ${have.join(', ')}` : `no agent CLI on PATH (needs one of ${any.join(', ')})`, fix: `install one of: ${any.join(', ')}` });
  }
  for (const dep of req.packs || []) {
    out.push({ id: `pack:${dep}`, ok: satisfiedPacks.has(dep), what: `the ${dep} pack's skill`, fix: `install it first (acs packs install ${dep}), or add --with-deps`, dep });
  }
  return out;
}

/** A family's CLI, from its id's prefix (lib/models-catalog.js vendorOf). */
function familyVendor(family, registry) {
  const id = resolveName(family, registry.models);
  return id ? vendorOf(id) : null;
}

/**
 * The roles `packIds` run models from whose every family needs a CLI this
 * machine lacks: review time would stop on them. Each comes with a suggested
 * fix of installed families: those the roles already use, else the first of
 * each installed vendor in the registry.
 */
export function roleProblems(packIds, m) {
  const names = [...new Set(packIds.flatMap((id) => ROLE_NEEDS[id] || []))];
  if (!names.length) return [];
  const loaded = loadRoles({ home: m.home });
  const { registry, error } = loadRegistry({ home: m.home });
  if (loaded.error || error) return [];
  const installed = (f) => { const v = familyVendor(f, registry); return !!(v && m.clis[v]); };
  const used = [...new Set(Object.values(loaded.roles).flatMap((r) => r.use || []))].filter(installed);
  const fallback = [];
  for (const [family] of Object.entries(registry.models)) {
    if (registry.families?.[family]?.track === false) continue;
    const v = familyVendor(family, registry);
    if (v && m.clis[v] && !fallback.some((f) => familyVendor(f, registry) === v)) fallback.push(family);
  }
  const suggestion = used.length ? used : fallback;
  const out = [];
  for (const name of names) {
    const role = loaded.roles[name];
    const use = role?.use || [];
    if (use.some(installed)) continue;
    out.push({ role: name, use, missing: !role, suggestion, vendors: use.map((f) => familyVendor(f, registry) || 'unknown') });
  }
  return out;
}

/* ── per-kind targets ────────────────────────────────────────────────── */

/** The harnesses a part installs into, from what is here (or was named and forced). */
function chooseHarnesses(part, m, opts) {
  const named = opts.harnesses;
  if (!part.harnesses.length) return { use: [], refused: [] };
  const want = named ? part.harnesses.filter((h) => named.includes(h) || (h === 'claude' && named.includes('grok'))) : part.harnesses;
  const here = (h) => m.present[h] || (h === 'claude' && m.present.grok);
  const use = want.filter((h) => here(h) || opts.force);
  const refused = named ? want.filter((h) => !here(h) && !opts.force) : [];
  return { use, refused };
}

const skillDest = (m, variant, rel) => path.join(variant === 'claude' ? m.claudeHome : m.codexHome, 'skills', rel);
const instructionsDest = (m, h) => (h === 'claude' ? path.join(m.claudeHome, 'CLAUDE.md') : path.join(m.codexHome, 'AGENTS.md'));
const needsRuntime = (part) => part.kind === 'guard' || part.kind === 'push-gate' || part.files.some((f) => /\/runtime\//.test(f));
const isWorktreeOption = (part) => part.kind === 'push-gate' && !part.files.length;
const unitKey = (packId, partId) => `${packId}/${partId}`;
const logRoot = (m) => path.join(m.studio, 'review-log');

/**
 * Every runtime file, with where it lands: what is on disk under the runtime
 * (links kept as links), plus each hook entry the push-gate part lists under
 * hooks/global/ that is not on disk. Those entries are links to run-hook in
 * the source tree, and npm pack leaves links out of the package, so here they
 * are made as links to run-hook (tests/packs-catalog.mjs checks that every
 * such link in the source points there).
 */
function runtimeFiles(m) {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const src = path.join(dir, e.name);
      if (e.isDirectory()) walk(src);
      else out.push({ src, dest: path.join(m.runtime, path.relative(RUNTIME_SRC, src)), link: e.isSymbolicLink() });
    }
  };
  walk(RUNTIME_SRC);
  const listed = JSON.parse(fs.readFileSync(path.join(PACKS_DIR, 'review-gate', 'pack.json'), 'utf8')).parts.flatMap((p) => p.files);
  const prefix = 'packs/review-gate/runtime/';
  for (const f of listed) {
    if (!f.startsWith(prefix) || fs.lstatSync(path.join(ROOT, f), { throwIfNoEntry: false })) continue;
    if (path.dirname(f) !== `${prefix}hooks/global`) throw new Error(`the review-gate runtime is missing ${f} — reinstall agent-config-studio`);
    out.push({ src: null, target: 'run-hook', dest: path.join(m.runtime, f.slice(prefix.length)), link: true });
  }
  return out;
}

/** What a put op will write: source bytes or link, and their hash. */
function sourceSnap(op) {
  if (op.content !== undefined) return { type: 'file', bytes: Buffer.from(op.content), mode: op.mode ?? 0o644 };
  if (op.target !== undefined) return { type: 'link', target: op.target };
  const st = fs.lstatSync(op.src);
  if (st.isSymbolicLink()) return { type: 'link', target: fs.readlinkSync(op.src) };
  return { type: 'file', bytes: fs.readFileSync(op.src), mode: st.mode & 0o777 };
}

function runtimeOps(m) {
  const ops = runtimeFiles(m).map((f) => ({ type: 'put', dest: f.dest, src: f.src, link: f.link, ...(f.target ? { target: f.target } : {}), scope: 'runtime' }));
  ops.push({ type: 'put', dest: path.join(m.runtime, 'hooks', 'node-path'), content: `${m.node}\n`, mode: 0o644, scope: 'runtime' });
  return ops;
}

/* ── planning ────────────────────────────────────────────────────────── */

const installedParts = (state, packId) => Object.keys(state.packs[packId]?.parts || {});
const hasSkill = (state, packId, pack) => installedParts(state, packId).some((id) => pack.parts.find((p) => p.id === id)?.kind === 'skill');

/**
 * What the guard installer is pointed at for `harnesses`: Claude's settings
 * (when claude is chosen) and the Codex homes (when codex is), passed to it
 * as flags so it touches nothing else.
 */
const guardTarget = (m, harnesses) => ({ claude: harnesses.includes('claude'), homes: harnesses.includes('codex') ? codexHomes(m) : [] });
const guardArgs = (t) => [...(t.claude ? [] : ['--no-claude']), ...(t.homes.length ? t.homes.flatMap((h) => ['--codex-home', h]) : ['--no-codex'])];

/** The delegated installers' touch lists: the files they may write, for the preview and the backup. */
function guardTouches(m, t) {
  const files = [];
  // The installer's own default: Claude's settings only when ~/.claude is here.
  if (t.claude && fs.existsSync(m.claudeHome)) files.push(path.join(m.claudeHome, 'settings.json'));
  for (const h of t.homes) files.push(path.join(h, 'hooks.json'), path.join(h, 'config.toml'));
  files.push(path.join(m.studio, 'review-gate-agent-guard.json'));
  return files;
}
const pushGateTouches = (m) => [globalGitConfig(m), path.join(m.studio, 'review-gate-global-hook.json')];
function worktreeTouches(m) {
  const wt = m.env.WT_HOME || path.join(m.home, '.config', 'worktree');
  const src = path.join(m.studio, 'worktree-source');
  return [path.join(wt, 'wt.zsh'), path.join(wt, 'defaults.conf'), path.join(m.env.ZDOTDIR || m.home, '.zshrc'), path.join(src, 'wt.zsh'), path.join(src, 'defaults.conf')];
}

/**
 * Everything an install of `packId` would do, without doing any of it.
 * opts: { parts, harnesses, force, withDeps, fixRoles, setRoles: {role: [families]} }.
 * `refusals` non-empty means nothing may be written.
 */
export function planInstall(packId, opts = {}, m = machine(), state = readState(m.statePath), catalog = loadCatalog()) {
  const pack = getPack(packId, catalog);
  const plan = { action: 'install', packs: [packId], units: [], ops: [], refusals: [], warnings: [], notes: [], requirements: [], roles: [], opts };
  const chosen = opts.parts?.length ? opts.parts : pack.parts.filter((p) => p.default).map((p) => p.id);
  for (const id of chosen) if (!pack.parts.some((p) => p.id === id)) plan.refusals.push(`${packId} has no part "${id}" (parts: ${pack.parts.map((p) => p.id).join(', ')})`);
  if (plan.refusals.length) return finish(plan, m);
  const units = chosen.map((id) => ({ pack, part: pack.parts.find((p) => p.id === id) }));

  // Pack dependencies: present already, added with consent, or refused with the reason.
  const satisfied = new Set();
  for (const dep of pack.requires?.packs || []) {
    const depPack = getPack(dep, catalog);
    if (hasSkill(state, dep, depPack)) { satisfied.add(dep); continue; }
    if (opts.withDeps) {
      satisfied.add(dep);
      for (const part of depPack.parts.filter((p) => p.default && p.kind === 'skill')) units.unshift({ pack: depPack, part, dependency: true });
      plan.packs.unshift(dep);
      plan.notes.push(`adds the ${dep} pack's ${depPack.parts.filter((p) => p.default && p.kind === 'skill').map((p) => p.id).join(', ')} skill: ${pack.title} needs it (${pack.id} requires ${dep})`);
    }
  }
  for (const p of plan.packs) {
    const reqs = requirements(getPack(p, catalog), m, { satisfiedPacks: satisfied });
    plan.requirements.push(...reqs.map((r) => ({ ...r, pack: p })));
    for (const r of reqs) if (!r.ok) {
      plan.refusals.push(r.dep
        ? `${pack.title} needs the ${r.dep} pack: its Grade and close run the review gate's review.mjs, so a build skill without it could not run its gate commands. Install ${r.dep} first (acs packs install ${r.dep}), or add --with-deps to install its skill now.`
        : `${r.what} — fix: ${r.fix}`);
    }
  }

  const wantPushGate = units.some((u) => u.part.kind === 'push-gate' && !isWorktreeOption(u.part)) || installedParts(state, 'review-gate').includes('push-gate');
  let runtimeNeeded = false;
  for (const { pack: pk, part, dependency } of units) {
    const key = unitKey(pk.id, part.id);
    const rec = state.packs[pk.id]?.parts?.[part.id];
    const { use, refused } = chooseHarnesses(part, m, opts);
    for (const h of refused) plan.refusals.push(`${key}: ${h} is not installed here (no ${h} CLI on PATH and no ${tilde(m, m.homes[h])}) — install it, or pass --force to install for it anyway`);
    const unit = { key, pack: pk.id, part: part.id, kind: part.kind, title: part.title, harnesses: use, dependency: !!dependency, already: !!rec };
    const newHarnesses = use.filter((h) => !(rec?.harnesses || []).includes(h));
    if (rec && part.harnesses.length && !newHarnesses.length) { plan.notes.push(`${key} is already installed — nothing to do (acs packs update updates it)`); continue; }
    if (rec && !part.harnesses.length) { plan.notes.push(`${key} is already installed — nothing to do`); continue; }
    if (part.harnesses.length && !use.length) { plan.notes.push(`${key}: none of its harnesses (${part.harnesses.join(', ')}) is installed here — skipped`); continue; }
    if (needsRuntime(part)) runtimeNeeded = true;
    const ops = [];
    if (part.kind === 'skill') {
      for (const f of part.files) {
        const mm = SKILL_PATH.exec(f);
        if (!mm || !newHarnesses.includes(mm[1])) continue;
        ops.push({ type: 'put', dest: skillDest(m, mm[1], mm[2]), src: path.join(ROOT, f) });
      }
    } else if (part.kind === 'instructions') {
      const body = fs.readFileSync(path.join(ROOT, part.files[0]), 'utf8');
      for (const h of newHarnesses) if (h !== 'grok') ops.push({ type: 'block', dest: instructionsDest(m, h), block: key, body });
    } else if (part.kind === 'guard') {
      const t = guardTarget(m, newHarnesses);
      ops.push({ type: 'delegate', what: 'guard', touches: guardTouches(m, t), args: guardArgs(t) });
      if (!fs.existsSync(m.claudeHome) && !codexHomes(m).length) plan.warnings.push(`${key}: no ~/.claude and no Codex home here, so the guard has nothing to protect yet`);
    } else if (part.kind === 'push-gate' && isWorktreeOption(part)) {
      if (!wantPushGate) plan.refusals.push(`${key} needs the push gate: add --part push-gate (or install it first)`);
      ops.push({ type: 'git-set', key: 'reviewgate.worktreeProjects', value: 'true', dest: globalGitConfig(m) });
    } else if (part.kind === 'push-gate') {
      const hooks = path.join(m.runtime, 'hooks', 'global');
      const real = fs.existsSync(hooks) ? realFile(hooks) : null;
      const current = m.git ? globalHooksPath(m) : [];
      const foreign = current.filter((v) => v !== hooks && v !== real);
      if (foreign.length) {
        plan.refusals.push(`${key}: your global git config already sets core.hooksPath = ${foreign.join(', ')} (another hook manager). The push gate needs that setting for itself, and replacing it would switch off the hooks it points at. To use the push gate, remove it (git config --global --unset core.hooksPath), move those hooks into each repo's own .git/hooks — the pass-through still runs them — and install again.`);
      }
      ops.push({ type: 'delegate', what: 'push-gate', touches: pushGateTouches(m) });
      ops.push({ type: 'setting', setting: `git config --global core.hooksPath = ${tilde(m, hooks)}` });
    } else if (part.kind === 'codex-log-access') {
      const homes = codexHomes(m);
      if (!homes.length) { plan.notes.push(`${key}: no Codex home here — skipped`); continue; }
      for (const h of homes) ops.push({ type: 'toml-add', dest: path.join(h, 'config.toml'), value: logRoot(m) });
    } else if (part.kind === 'worktree') {
      ops.push({ type: 'delegate', what: 'worktree', touches: worktreeTouches(m) });
      if (path.basename(m.env.SHELL || '') !== 'zsh') plan.warnings.push(`${key}: your shell is ${m.env.SHELL || 'unknown'}, not zsh — the worktree commands load only in zsh`);
    }
    for (const op of ops) op.unit = key;
    unit.newHarnesses = newHarnesses;
    plan.units.push(unit);
    plan.ops.push(...ops);
  }
  if (runtimeNeeded && !state.runtime) plan.ops.unshift(...runtimeOps(m).map((op) => ({ ...op, unit: 'runtime' })));
  if (runtimeNeeded) plan.runtimeRefs = plan.units.filter((u) => needsRuntime(getPack(u.pack, catalog).parts.find((p) => p.id === u.part))).map((u) => u.key);

  // The role fix-up: roles whose every family lacks a CLI here. The pack named is checked
  // even when it is already installed, so a re-run with --fix-roles or --set-role fixes them.
  plan.roles = roleProblems(plan.packs.filter((p) => p === packId || plan.units.some((u) => u.pack === p)), m);
  for (const prob of plan.roles) {
    const set = opts.setRoles?.[prob.role] || (opts.fixRoles ? prob.suggestion : null);
    if (set?.length) {
      prob.set = set;
      plan.ops.push({ type: 'role', role: prob.role, use: set, dest: rolesUserPath(m.home), unit: 'roles' });
    } else {
      plan.warnings.push(`the ${prob.role} role (${prob.use.join(', ') || 'unset'}) has no family whose CLI is installed here, so ${prob.role === 'reviewer' ? 'every review' : `the ${prob.role} step`} will stop until it is set.${prob.suggestion.length ? ` Fix now: --fix-roles (sets it to ${prob.suggestion.join(', ')}) or --set-role ${prob.role}=<families>; or later in ACS → Models → Roles.` : ' No installed CLI can run any family; install one.'}`);
    }
  }
  for (const name of Object.keys(opts.setRoles || {})) {
    if (!plan.roles.some((r) => r.role === name)) plan.ops.push({ type: 'role', role: name, use: opts.setRoles[name], dest: rolesUserPath(m.home), unit: 'roles' });
  }
  if (plan.packs.includes('review-gate')) {
    const legacy = legacyReviewGate(m);
    if (legacy.length) plan.warnings.push(`an earlier review-gate install is here (${legacy.map((p) => tilde(m, p)).join(', ')}). This installer does not migrate it; the review script still reads the older log and config locations.`);
  }
  return finish(plan, m);
}

/** Everything update would do for the installed packs (all, or `packIds`). */
export function planUpdate(packIds, opts = {}, m = machine(), state = readState(m.statePath), catalog = loadCatalog()) {
  const ids = packIds?.length ? packIds : Object.keys(state.packs);
  const plan = { action: 'update', packs: ids, units: [], ops: [], refusals: [], warnings: [], notes: [], requirements: [], roles: [], kept: [], opts };
  for (const id of ids) {
    const pack = getPack(id, catalog);
    const st = state.packs[id];
    if (!st) { plan.refusals.push(`${id} is not installed`); continue; }
    for (const [partId, rec] of Object.entries(st.parts)) {
      const part = pack.parts.find((p) => p.id === partId);
      const key = unitKey(id, partId);
      if (!part) { plan.notes.push(`${key} is no longer in the pack; uninstall removes it`); continue; }
      const ops = [];
      if (part.kind === 'skill') {
        const shipped = new Map();
        for (const f of part.files) {
          const mm = SKILL_PATH.exec(f);
          if (mm && rec.harnesses.includes(mm[1])) shipped.set(skillDest(m, mm[1], mm[2]), path.join(ROOT, f));
        }
        ops.push(...updateFiles(rec.files, shipped, opts, plan));
      } else if (part.kind === 'instructions') {
        const body = fs.readFileSync(path.join(ROOT, part.files[0]), 'utf8');
        for (const [dest, frec] of Object.entries(rec.files)) {
          if (frec.body === sha(body)) continue;
          const text = snapshot(dest)?.bytes.toString('utf8') ?? '';
          const found = findBlock(text, key);
          if (found && sha(found.body) === frec.body) ops.push({ type: 'block', dest, block: key, body });
          else if (opts.replace) ops.push({ type: 'block', dest, block: key, body, replacing: true });
          else plan.kept.push({ path: dest, why: found ? 'you edited the block' : 'the block is gone from the file' });
        }
      } else if (part.kind === 'worktree') {
        const tools = path.join(ROOT, 'tools', 'worktree');
        const [wtz, dflt] = worktreeTouches(m);
        const shippedDefaults = sha(fs.readFileSync(path.join(tools, 'defaults.conf')));
        const changed = ['wt.zsh', 'defaults.conf'].some((n) => sha(fs.readFileSync(path.join(tools, n))) !== rec.data?.source?.[n]);
        if (changed) {
          const edited = hashSnap(snapshot(wtz)) !== rec.files[wtz]?.hash;
          // defaults.conf untouched since install (what the pack wrote, or the copy it installed from) takes the new one;
          // only a customised one is kept.
          const curDefaults = hashSnap(snapshot(dflt));
          const takeDefaults = opts.replace || curDefaults === rec.files[dflt]?.hash || curDefaults === rec.data?.source?.['defaults.conf'];
          if (edited && !opts.replace) {
            plan.kept.push({ path: wtz, why: 'you edited it' });
            // install-worktree would overwrite the edited wt.zsh, so an untouched defaults.conf is replaced here directly.
            if (takeDefaults && curDefaults !== shippedDefaults) ops.push({ type: 'put', dest: dflt, src: path.join(tools, 'defaults.conf'), source: 'defaults.conf' });
          } else ops.push({ type: 'delegate', what: 'worktree', touches: worktreeTouches(m), args: takeDefaults ? ['--replace-defaults'] : [] });
          if (!takeDefaults && curDefaults !== 'absent' && curDefaults !== shippedDefaults) plan.kept.push({ path: dflt, why: 'you customised it (--replace takes the new one)' });
        }
      }
      if (!ops.length) continue;
      for (const op of ops) op.unit = key;
      plan.units.push({ key, pack: id, part: partId, kind: part.kind, harnesses: rec.harnesses });
      plan.ops.push(...ops);
    }
  }
  if (state.runtime && ids.some((id) => (state.runtime.refs || []).some((r) => r.startsWith(`${id}/`)))) {
    const shipped = new Map(runtimeOps(m).map((op) => [op.dest, op]));
    const ops = updateFiles(state.runtime.files, shipped, opts, plan);
    for (const op of ops) op.unit = 'runtime';
    plan.ops.unshift(...ops);
  }
  for (const id of ids) {
    const pack = catalog.find((p) => p.id === id);
    if (pack && state.packs[id] && state.packs[id].version !== pack.version) plan.notes.push(`${id}: ${state.packs[id].version} → ${pack.version}`);
  }
  return finish(plan, m);
}

/** Update ops for whole files: unchanged ones replaced, edited ones kept (or replaced with --replace), new ones added, dropped ones removed. */
function updateFiles(recs, shipped, opts, plan) {
  const ops = [];
  for (const [dest, src] of shipped) {
    const op = typeof src === 'string' ? { type: 'put', dest, src } : { ...src };
    const want = hashSnap(sourceSnap(op));
    const rec = recs[dest];
    const cur = hashSnap(snapshot(dest, { link: !!op.link }));
    // The shipped copy is the one installed: only a file removed or edited since needs anything (below).
    if (rec && want === rec.hash && cur === rec.hash) continue;
    if (!rec || cur === rec.hash) { if (cur !== want) ops.push(op); else ops.push({ ...op, recordOnly: true }); continue; }
    if (cur === want) { ops.push({ ...op, recordOnly: true }); continue; }
    if (opts.replace) ops.push({ ...op, replacing: true });
    else plan.kept.push({ path: dest, why: cur === 'absent' ? 'you removed it (--replace puts it back)' : 'you edited it (--replace backs it up and takes the new one)' });
  }
  for (const [dest, rec] of Object.entries(recs)) {
    if (shipped.has(dest)) continue;
    ops.push({ type: 'restore', dest, rec, link: rec.link });
  }
  return ops;
}

/** Everything uninstall would do. `parts` empty means every installed part of the pack. */
export function planUninstall(packId, opts = {}, m = machine(), state = readState(m.statePath), catalog = loadCatalog()) {
  const pack = getPack(packId, catalog);
  const plan = { action: 'uninstall', packs: [packId], units: [], ops: [], refusals: [], warnings: [], notes: [], requirements: [], roles: [], kept: [], opts };
  const st = state.packs[packId];
  if (!st) { plan.refusals.push(`${packId} is not installed`); return finish(plan, m); }
  let chosen = opts.parts?.length ? opts.parts : Object.keys(st.parts);
  for (const id of chosen) if (!st.parts[id]) plan.refusals.push(`${packId}/${id} is not installed`);
  // The worktree-projects option goes with the push gate it rides on.
  const option = pack.parts.find((p) => isWorktreeOption(p));
  if (option && chosen.includes('push-gate') && st.parts[option.id] && !chosen.includes(option.id)) {
    chosen = [...chosen, option.id];
    plan.notes.push(`also removes ${unitKey(packId, option.id)}: it needs the push gate`);
  }
  // A pack that needs this one keeps it, unless forced.
  const leaving = new Set(chosen);
  const remainingSkill = Object.keys(st.parts).some((id) => !leaving.has(id) && pack.parts.find((p) => p.id === id)?.kind === 'skill');
  for (const other of catalog) {
    if (other.id === packId || !state.packs[other.id] || !(other.requires?.packs || []).includes(packId) || remainingSkill) continue;
    if (!opts.force) plan.refusals.push(`${other.title} is installed and needs ${pack.title} (its gate commands run review.mjs). Uninstall ${other.id} first, or pass --force.`);
  }
  for (const id of chosen) {
    const rec = st.parts[id];
    if (!rec) continue;
    const key = unitKey(packId, id);
    const ops = [];
    if (rec.kind === 'guard') {
      const t = guardTarget(m, rec.harnesses);
      ops.push({ type: 'delegate', what: 'guard', touches: guardTouches(m, t), args: guardArgs(t), uninstall: true });
    }
    else if (rec.kind === 'push-gate' && rec.data?.setting !== 'reviewgate.worktreeProjects') {
      const hooks = path.join(m.runtime, 'hooks', 'global');
      const real = fs.existsSync(hooks) ? realFile(hooks) : hooks;
      const current = m.git ? globalHooksPath(m) : [];
      if (current.some((v) => v !== hooks && v !== real)) {
        // core.hooksPath is no longer the push gate's: it is kept, and only the gate's own record goes
        // (its installer refuses to uninstall over a changed core.hooksPath).
        const own = pushGateTouches(m)[1];
        if (rec.files[own]) ops.push({ type: 'restore', dest: own, rec: rec.files[own] });
        ops.push({ type: 'setting', setting: `git config --global core.hooksPath: kept (it is now ${current.join(', ')}, not the push gate's)` });
        plan.kept.push({ path: globalGitConfig(m), why: `core.hooksPath is now ${current.join(', ')}, not the push gate's ${tilde(m, hooks)}: kept` });
      } else {
        ops.push({ type: 'delegate', what: 'push-gate', touches: pushGateTouches(m), uninstall: true });
        ops.push({ type: 'setting', setting: 'git config --global core.hooksPath: restored to what it was before' });
      }
    } else {
      for (const [dest, frec] of Object.entries(rec.files)) ops.push({ type: 'restore', dest, rec: frec, link: frec.link });
    }
    for (const op of ops) op.unit = key;
    plan.units.push({ key, pack: packId, part: id, kind: rec.kind, harnesses: rec.harnesses });
    plan.ops.push(...ops);
  }
  // The runtime goes with its last reference.
  if (state.runtime) {
    const gone = new Set(plan.units.map((u) => u.key));
    const left = (state.runtime.refs || []).filter((r) => !gone.has(r));
    plan.runtimeRefs = left;
    if (!left.length) plan.ops.push(...Object.entries(state.runtime.files).map(([dest, frec]) => ({ type: 'restore', dest, rec: frec, link: frec.link, unit: 'runtime' })));
    else if (left.length !== (state.runtime.refs || []).length) plan.notes.push(`the shared review runtime stays: ${left.join(', ')} still use${left.length === 1 ? 's' : ''} it`);
  }
  return finish(plan, m);
}

/**
 * The preview: one row per file or setting, and the folders used for the
 * backups and the record. Uninstall rows say what each restore will do.
 */
function finish(plan, m) {
  const rows = [];
  const seen = new Set();
  const row = (r) => { const k = `${r.path || r.setting}`; if (seen.has(k)) return; seen.add(k); rows.push(r); };
  for (const op of plan.ops) {
    if (op.type === 'setting') { row({ setting: op.setting, unit: op.unit }); continue; }
    if (op.type === 'role') { row({ path: op.dest, unit: op.unit, action: snapshot(op.dest) ? 'edit' : 'create', note: `${op.role} role → ${op.use.join(', ')} (ACS's roles write path; kept after uninstall)` }); row({ dir: path.join(m.studio, 'history'), path: path.join(m.studio, 'history') + path.sep, unit: 'roles', action: 'record', note: 'ACS history of roles.json' }); continue; }
    if (op.type === 'delegate') {
      for (const t of op.touches) row({ path: t, unit: op.unit, action: op.uninstall ? 'restore-or-strip' : 'maybe', note: op.uninstall ? 'its own entries removed (exact earlier bytes back when unchanged)' : `${op.what} installer` });
      continue;
    }
    if (op.type === 'git-set') { row({ path: op.dest, unit: op.unit, action: 'edit' }); row({ setting: `git config --global ${op.key} = ${op.value}`, unit: op.unit }); continue; }
    if (op.type === 'restore') {
      const cur = hashSnap(snapshot(op.dest, { link: !!op.link }));
      let action = cur === op.rec.hash && !op.rec.mixed ? (op.rec.before.absent ? 'remove' : 'restore') : cur === 'absent' ? 'gone' : surgical(op.rec) ? 'strip' : 'keep';
      let why = 'edited since install', note;
      if (action === 'strip' && op.rec.how === 'git-set' && m.git) {
        // A git setting is unset only while it holds the value the pack set.
        const g = gitSetting(m, op.rec);
        if (!g.values.length) { action = 'gone'; note = `${op.rec.key} is already unset`; }
        else if (!g.ours) { action = 'keep'; why = note = `${op.rec.key} is now ${g.values.join(', ')}, not the ${op.rec.value ?? 'value'} the pack set: kept`; }
      }
      op.planned = action;
      if (action === 'keep') plan.kept.push({ path: op.dest, why });
      row({ path: op.dest, unit: op.unit, action, note: note || { remove: 'unchanged since install', restore: 'unchanged since install: its exact earlier bytes come back', strip: 'edited since install: only the pack\'s own part is removed', keep: 'edited since install: kept', gone: 'already gone' }[action] });
      continue;
    }
    const cur = snapshot(op.dest, { link: !!op.link });
    const action = op.recordOnly ? 'record' : !cur ? 'create' : op.type === 'put' ? (op.replacing ? 'replace-edited' : 'replace') : 'edit';
    row({ path: op.dest, unit: op.unit, action, note: op.type === 'block' ? 'one marked block; the rest of the file is untouched' : op.type === 'toml-add' ? `writable_roots += ${op.value}` : undefined });
  }
  const writes = rows.some((r) => r.path && !['keep', 'gone', 'record'].includes(r.action)) || plan.ops.some((o) => o.type === 'role');
  if (writes || plan.ops.some((o) => o.recordOnly)) {
    rows.push({ dir: m.backups, path: m.backups + path.sep, action: 'backup', note: 'a new folder with a copy of every existing file before it changes' });
    rows.push({ path: m.statePath, action: 'record', note: 'what was installed, its hashes and backups' });
  }
  plan.preview = rows;
  return plan;
}

const surgical = (rec) => ['block', 'toml-add', 'git-set', 'zshrc'].includes(rec.how);

/* ── applying ────────────────────────────────────────────────────────── */

const signature = (plan) => JSON.stringify([plan.preview.map((r) => [r.path, r.setting, r.action]), plan.refusals]);

/**
 * Do what `plan` says, under the state lock. The plan is rebuilt inside the
 * lock; if it no longer matches the preview that was shown, nothing is
 * written. Every existing file is backed up and the backup read back before
 * the first write; a failure part-way puts every touched file back.
 */
export async function apply(plan, { m = machine(), log = () => {} } = {}) {
  if (plan.refusals.length) throw Object.assign(new Error(plan.refusals.join('\n')), { status: 409 });
  return withStateLock(m.statePath, async () => {
    const state = readState(m.statePath);
    const fresh = plan.action === 'install' ? planInstall(plan.packs.at(-1), plan.opts, m, state)
      : plan.action === 'update' ? planUpdate(plan.packs, plan.opts, m, state) : planUninstall(plan.packs[0], plan.opts, m, state);
    if (fresh.refusals.length) throw Object.assign(new Error(fresh.refusals.join('\n')), { status: 409 });
    if (signature(fresh) !== signature(plan)) throw Object.assign(new Error('what this would change is different from the preview (another install ran, or a file changed) — run it again to see the new preview'), { status: 409 });
    return run(fresh, state, m, log);
  });
}

function opPaths(op) {
  if (op.type === 'delegate') return op.touches;
  if (op.dest) return [op.dest];
  return [];
}

async function run(plan, state, m, log) {
  const catalog = loadCatalog();
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, 'Z');
  let backupDir = null, nBackup = 0;
  const original = new Map();   // real path → {snap, link, dest}
  const realOf = (op, p) => (op.link ? path.join(realFile(path.dirname(p)), path.basename(p)) : realFile(p));
  for (const op of plan.ops) for (const p of opPaths(op)) {
    const real = realOf(op, p);
    if (!original.has(real)) original.set(real, { snap: snapshot(p, { link: !!op.link }), link: !!op.link, dest: p, dirs: missingDirs(real) });
  }
  const ensureBackupDir = () => {
    if (backupDir) return;
    let dir = path.join(m.backups, `${stamp}-packs-${plan.action}`), n = 0;
    while (fs.existsSync(dir)) dir = path.join(m.backups, `${stamp}-packs-${plan.action}-${++n}`);
    fs.mkdirSync(dir, { recursive: true });
    backupDir = dir;
  };
  const backup = (real, snap) => {
    if (!snap || snap.type === 'link') return null;
    ensureBackupDir();
    return saveBackup(backupDir, nBackup++, real, snap);
  };
  // 1. Every existing file, backed up and read back, before any write.
  const originalBackup = new Map();
  try {
    for (const [real, o] of original) originalBackup.set(real, backup(real, o.snap));
  } catch (e) {
    throw new Error(`backup failed (${e.message}) — nothing was changed`);
  }
  if (backupDir) log(`backup: ${tilde(m, backupDir)}`);

  const now = new Date().toISOString();
  const packState = (id) => {
    const pack = catalog.find((p) => p.id === id);
    state.packs[id] ??= { version: pack.version, installedAt: now, parts: {} };
    return state.packs[id];
  };
  const unitState = (key) => {
    if (key === 'runtime') { state.runtime ??= { refs: [], files: {}, dirs: [] }; return state.runtime; }
    if (key === 'roles') return null;
    const [id, part] = key.split('/');
    const u = plan.units.find((x) => x.key === key);
    const ps = packState(id);
    ps.parts[part] ??= { kind: u.kind, harnesses: [], installedAt: now, files: {}, dirs: [], data: {} };
    return ps.parts[part];
  };
  const record = (us, op, before, after, how, extra = {}) => {
    if (!us) return;
    const real = realOf(op, op.dest);
    const prior = us.files[op.dest];
    const o = original.get(real);
    // The bytes just before this op: the run's original backup, or (when an
    // earlier op in this run already changed the file) a copy taken now.
    const saved = () => (o && hashSnap(o.snap) === hashSnap(before) ? originalBackup.get(real) : backup(real, before));
    const beforeRec = prior?.before ?? (before ? (before.type === 'link'
      ? { type: 'link', target: before.target, hash: hashSnap(before) }
      : { type: 'file', backup: saved(), hash: hashSnap(before), mode: before.mode })
      : { absent: true });
    // A file holding more than the pack's own part (a block, an entry) that someone edited
    // before this write: its pre-install bytes no longer stand for "without the pack", so
    // uninstall takes out only the pack's part from then on.
    const mixed = !!prior && (prior.mixed || hashSnap(before) !== prior.hash) && how !== 'whole';
    us.files[op.dest] = { hash: hashSnap(after), before: beforeRec, how, ...(mixed ? { mixed: true } : {}), ...(op.link ? { link: true } : {}), ...extra };
    for (const d of o?.dirs || []) if (!us.dirs.includes(d)) us.dirs.push(d);
  };

  const done = [];
  try {
    for (const op of plan.ops) {
      const us = op.unit ? unitState(op.unit) : null;
      if (op.type === 'setting') continue;
      if (op.type === 'put') {
        const before = snapshot(op.dest, { link: !!op.link });
        const want = sourceSnap(op);
        if (!op.recordOnly) {
          if (want.type === 'link') writeLink(op.dest, want.target); else writeAtomic(op.dest, want.bytes, want.mode);
        }
        done.push(op);
        record(us, op, before, snapshot(op.dest, { link: !!op.link }), 'whole');
        if (op.source) us.data.source = { ...us.data.source, [op.source]: hashSnap(want) };
      } else if (op.type === 'block') {
        const before = snapshot(op.dest);
        const text = before?.bytes.toString('utf8') ?? '';
        const next = upsertBlock(text, op.block, op.body);
        writeAtomic(op.dest, next, before?.mode ?? 0o644);
        done.push(op);
        record(us, op, before, snapshot(op.dest), 'block', { body: sha(op.body) });
      } else if (op.type === 'toml-add') {
        const before = snapshot(op.dest);
        const r = addRoot(before?.bytes.toString('utf8') ?? '', op.value);
        if (r.how !== 'present') { writeAtomic(op.dest, r.text, before?.mode ?? 0o600); done.push(op); }
        record(us, op, before, snapshot(op.dest), 'toml-add', { value: op.value, added: r.how });
      } else if (op.type === 'git-set') {
        const before = snapshot(op.dest);
        git(m, ['config', '--global', op.key, op.value]);
        done.push(op);
        record(us, op, before, snapshot(op.dest), 'git-set', { key: op.key, value: op.value });
        us.data.setting = op.key;
      } else if (op.type === 'role') {
        const loaded = loadRoles({ home: m.home });
        const cur = loaded.roles[op.role] || {};
        const fields = Object.fromEntries(ROLE_FIELDS.filter((k) => k !== 'use' && cur[k] !== undefined).map((k) => [k, k === 'alt' ? (cur.altMember?.effort ? cur.altMember : cur.alt) : cur[k]]));
        const r = await setRole({ name: op.role, fields: { ...fields, use: op.use }, base: rolesBase(readUserRoles(m.home)), home: m.home });
        for (const w of r.warnings || []) log(`warning: ${w}`);
        done.push(op);
        log(`${op.role} role set to ${op.use.join(', ')}`);
      } else if (op.type === 'delegate') {
        const befores = new Map(op.touches.map((p) => [p, snapshot(p)]));
        if (op.what === 'worktree' && !op.uninstall) {
          const r = node(m, path.join(ROOT, 'bin', 'install-worktree.mjs'), op.args || []);
          log(r.out.trim());
          if (r.status !== 0) throw new Error(`install-worktree failed: ${r.out.trim()}`);
          // The source a file was installed from advances only when that file now holds it (a kept
          // defaults.conf leaves the update showing); a first install records what it installed from.
          const [wtz, dflt] = worktreeTouches(m);
          const prior = us.data.source || {};
          us.data.source = Object.fromEntries([['wt.zsh', wtz], ['defaults.conf', dflt]].map(([n, dest]) => {
            const shipped = sha(fs.readFileSync(path.join(ROOT, 'tools', 'worktree', n)));
            return [n, !prior[n] || hashSnap(snapshot(dest)) === shipped ? shipped : prior[n]];
          }));
        } else if (op.what === 'guard') {
          const r = node(m, path.join(m.runtime, 'hooks', 'install-agent-guard.mjs'), [op.uninstall ? 'uninstall' : 'install', ...op.args]);
          log(r.out.trim());
          if (r.status !== 0) throw new Error(`the agent guard installer failed: ${r.out.trim()}`);
        } else if (op.what === 'push-gate') {
          const r = shScript(m, path.join(m.runtime, 'hooks', 'install-global.sh'), [op.uninstall ? 'uninstall' : 'install']);
          log(r.out.trim());
          if (r.status !== 0) throw new Error(`the push gate installer failed: ${r.out.trim()}`);
        }
        done.push(op);
        if (!op.uninstall) {
          for (const p of op.touches) {
            const after = snapshot(p);
            if (hashSnap(after) !== hashSnap(befores.get(p))) record(us, { dest: p }, befores.get(p), after, op.what === 'worktree' ? (path.basename(p) === '.zshrc' ? 'zshrc' : 'whole') : 'delegate');
          }
        }
      } else if (op.type === 'restore') {
        restoreOne(m, op, log);
        done.push(op);
        if (plan.action === 'update' && us) delete us.files[op.dest];
      }
    }

    // The record, inside the rollback: files changed with no record of them would make a retry
    // take the pack's copy for the user's original.
    if (plan.action === 'install') {
      for (const u of plan.units) {
        const us = unitState(u.key);
        us.harnesses = [...new Set([...us.harnesses, ...(u.newHarnesses || [])])];
        packState(u.pack).version = catalog.find((p) => p.id === u.pack).version;
      }
      if (plan.runtimeRefs?.length) {
        const rt = unitState('runtime');
        rt.refs = [...new Set([...rt.refs, ...plan.runtimeRefs])];
        rt.version = catalog.find((p) => p.id === 'review-gate').version;
      }
    } else if (plan.action === 'update') {
      for (const id of plan.packs) if (state.packs[id]) state.packs[id].version = catalog.find((p) => p.id === id).version;
      if (state.runtime) state.runtime.version = catalog.find((p) => p.id === 'review-gate').version;
    } else {
      const id = plan.packs[0];
      for (const u of plan.units) {
        const rec = state.packs[id].parts[u.part];
        removeDirs(rec.dirs);
        delete state.packs[id].parts[u.part];
      }
      if (!Object.keys(state.packs[id].parts).length) delete state.packs[id];
      if (state.runtime) {
        state.runtime.refs = plan.runtimeRefs || state.runtime.refs;
        if (!state.runtime.refs.length) { removeDirs(state.runtime.dirs); state.runtime = null; }
      }
    }
    writeState(m.statePath, state);
  } catch (e) {
    // Put every touched file back the way it was before this run.
    for (const [, o] of [...original].reverse()) { try { restoreSnap(o.dest, o.snap, { link: o.link }); } catch {} }
    throw new Error(`${e.message} — every file this run touched was put back${backupDir ? ` (backups: ${backupDir})` : ''}`);
  }
  return { backupDir, kept: plan.kept || [], state };
}

/** Uninstall one file: exact earlier bytes when untouched since install, else only the pack's own part. */
function restoreOne(m, op, log) {
  const { dest, rec } = op;
  const cur = snapshot(dest, { link: !!rec.link });
  if (hashSnap(cur) === rec.hash && !rec.mixed) {
    if (rec.before.absent) restoreSnap(dest, null, { link: !!rec.link });
    else restoreSnap(dest, readBackup(rec.before), { link: !!rec.link });
    return;
  }
  if (!cur) return;
  const text = cur.type === 'file' ? cur.bytes.toString('utf8') : '';
  let next = null;
  if (rec.how === 'block') next = removeBlock(text, op.unit);
  else if (rec.how === 'toml-add') next = rec.added === 'present' ? text : removeRoot(text, rec.value, rec.added);
  else if (rec.how === 'zshrc') next = removeStanza(text);
  else if (rec.how === 'git-set') {
    // Only while it is still the value the pack set; a value changed since is the user's (finish reports it kept).
    if (gitSetting(m, rec).ours) git(m, ['config', '--global', '--unset-all', rec.key], { allowed: [0, 5] });
    return;
  } else { log(`kept ${tilde(m, dest)}: you edited it after it was installed`); return; }
  if (next !== text) writeAtomic(dest, next, cur.mode);
}

function removeDirs(dirs = []) {
  for (const d of [...dirs].sort((a, b) => b.length - a.length)) {
    try { if (!fs.readdirSync(d).length) fs.rmdirSync(d); } catch {}
  }
}

/** The pinned node running a script this package (or its installed runtime) ships. */
function node(m, script, args) {
  const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: childEnv(m), timeout: 300_000 });
  return { status: r.error ? 1 : r.status, out: `${r.stdout || ''}${r.stderr || ''}${r.error ? r.error.message : ''}` };
}
/**
 * The push gate's installer is a sh script that runs `node`: this process's
 * node, through a scratch folder holding only a `node` link ahead of PATH —
 * never node's own folder, which may hold real agent CLIs.
 */
function shScript(m, script, args) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acs-pack-node-'));
  try {
    fs.symlinkSync(process.execPath, path.join(dir, 'node'));
    const r = spawnSync('/bin/sh', [script, ...args], { encoding: 'utf8', env: { ...childEnv(m), PATH: [dir, m.env.PATH || ''].join(':') }, timeout: 300_000 });
    return { status: r.error ? 1 : r.status, out: `${r.stdout || ''}${r.stderr || ''}${r.error ? r.error.message : ''}` };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
/** The env the shipped installers run with: a $CODEX_HOME that does not exist is left out, so no Codex home is created. */
const childEnv = (m) => {
  const env = { ...m.env };
  if (env.CODEX_HOME && !fs.existsSync(env.CODEX_HOME)) delete env.CODEX_HOME;
  return env;
};

/* ── status ──────────────────────────────────────────────────────────── */

export const STATUS = {
  installed: 'installed', edited: 'edited by you', update: 'update available', broken: 'installed but not working',
  newHarness: 'new harness detected, not installed for it', absent: 'not installed',
};

/**
 * Each pack and part: installed, edited by you, update available, installed
 * but not working (with why), or a new harness it is not installed for.
 * `trust: true` runs the guard's Codex trust check (it starts `codex
 * app-server` per home; slow), reporting progress through `onProgress`.
 */
export async function status({ m = machine(), trust = true, onProgress = () => {} } = {}) {
  const state = readState(m.statePath);
  const catalog = loadCatalog();
  const out = { packs: [], legacy: legacyReviewGate(m).map((p) => tilde(m, p)), runtime: null };
  if (state.runtime) {
    const rt = { refs: state.runtime.refs, edited: [], update: false, missing: [] };
    for (const op of runtimeOps(m)) {
      const rec = state.runtime.files[op.dest];
      const cur = hashSnap(snapshot(op.dest, { link: !!op.link }));
      if (!rec || hashSnap(sourceSnap(op)) !== rec.hash) rt.update = true;
      if (rec && cur !== rec.hash) (cur === 'absent' ? rt.missing : rt.edited).push(tilde(m, op.dest));
    }
    out.runtime = rt;
  }
  for (const pack of catalog) {
    const st = state.packs[pack.id];
    const p = { id: pack.id, title: pack.title, version: pack.version, installedVersion: st?.version || null, parts: [] };
    for (const part of pack.parts) {
      const rec = st?.parts?.[part.id];
      const row = { id: part.id, kind: part.kind, statuses: [], details: [], harnesses: rec?.harnesses || [] };
      if (!rec) { row.statuses.push(STATUS.absent); p.parts.push(row); continue; }
      row.statuses.push(STATUS.installed);
      await partStatus(m, pack, part, rec, row, { trust, onProgress, state });
      if (st.version !== pack.version && !row.statuses.includes(STATUS.update)) row.statuses.push(STATUS.update);
      const { use } = chooseHarnesses(part, m, {});
      const fresh = use.filter((h) => !rec.harnesses.includes(h));
      if (fresh.length && part.harnesses.length) { row.statuses.push(STATUS.newHarness); row.details.push(`${fresh.join(', ')} is here now; install for it with: acs packs install ${pack.id} --part ${part.id}`); }
      if (row.statuses.length > 1) row.statuses = row.statuses.filter((s) => s !== STATUS.installed);
      p.parts.push(row);
    }
    if (pack.id === 'review-gate' && out.runtime && st) {
      const shared = p.parts.find((r) => r.id === 'code-review');
      if (shared && out.runtime.update && !shared.statuses.includes(STATUS.update)) shared.statuses.push(STATUS.update);
      if (shared && out.runtime.edited.length) { shared.statuses.push(STATUS.edited); shared.details.push(`edited in the shared runtime: ${out.runtime.edited.join(', ')}`); }
      if (shared && out.runtime.missing.length) { shared.statuses.push(STATUS.broken); shared.details.push(`missing from the shared runtime: ${out.runtime.missing.join(', ')} — put it back with: acs packs update review-gate --replace`); }
      if (shared) shared.statuses = [...new Set(shared.statuses)].filter((s, _, all) => s !== STATUS.installed || all.length === 1);
    }
    out.packs.push(p);
  }
  return out;
}

async function partStatus(m, pack, part, rec, row, { trust, onProgress }) {
  const add = (s, d) => { if (!row.statuses.includes(s)) row.statuses.push(s); if (d) row.details.push(d); };
  const key = unitKey(pack.id, part.id);
  if (part.kind === 'skill') {
    for (const [dest, frec] of Object.entries(rec.files)) {
      const cur = hashSnap(snapshot(dest));
      if (cur === 'absent') add(STATUS.broken, `missing: ${tilde(m, dest)} — put it back with: acs packs update ${pack.id} --replace`);
      else if (cur !== frec.hash) add(STATUS.edited, `edited: ${tilde(m, dest)}`);
    }
    for (const f of part.files) {
      const mm = SKILL_PATH.exec(f);
      if (!mm || !rec.harnesses.includes(mm[1])) continue;
      const dest = skillDest(m, mm[1], mm[2]);
      if (!rec.files[dest] || sha(fs.readFileSync(path.join(ROOT, f))) !== rec.files[dest].hash) add(STATUS.update);
    }
    if (pack.requires?.modelId && !m.modelId) add(STATUS.broken, 'model-id is not on PATH — run: acs install-model-id');
    for (const prob of roleProblems([pack.id], m)) add(STATUS.broken, `the ${prob.role} role (${prob.use.join(', ') || 'unset'}) has no family whose CLI is installed — set it in ACS → Models → Roles, or run: acs packs install ${pack.id} --fix-roles`);
  } else if (part.kind === 'instructions') {
    const body = sha(fs.readFileSync(path.join(ROOT, part.files[0]), 'utf8'));
    for (const [dest, frec] of Object.entries(rec.files)) {
      let found = null;
      try { found = findBlock(snapshot(dest)?.bytes.toString('utf8') ?? '', key); } catch (e) { add(STATUS.broken, `${tilde(m, dest)}: ${e.message}`); continue; }
      if (!found) add(STATUS.broken, `the block is gone from ${tilde(m, dest)}`);
      else if (sha(found.body) !== frec.body) add(STATUS.edited, `edited block: ${tilde(m, dest)}`);
      if (frec.body !== body) add(STATUS.update);
    }
  } else if (part.kind === 'codex-log-access') {
    for (const [dest, frec] of Object.entries(rec.files)) {
      let present = false;
      try { present = hasRoot(snapshot(dest)?.bytes.toString('utf8') ?? '', frec.value); } catch (e) { add(STATUS.broken, `${tilde(m, dest)}: ${e.message}`); continue; }
      if (!present) add(STATUS.broken, `${tilde(m, dest)} no longer lists ${tilde(m, frec.value)} in writable_roots`);
    }
  } else if (part.kind === 'worktree') {
    if (path.basename(m.env.SHELL || '') !== 'zsh') add(STATUS.broken, `your shell is not zsh (SHELL=${m.env.SHELL || 'unset'}); the worktree commands load only in zsh`);
    const [wtz, dflt, zshrc] = worktreeTouches(m);
    if (!hasStanza(snapshot(zshrc)?.bytes.toString('utf8') ?? '') && rec.files[zshrc]) add(STATUS.broken, `${tilde(m, zshrc)} no longer loads wt.zsh`);
    for (const p of [wtz, dflt]) if (rec.files[p] && hashSnap(snapshot(p)) !== rec.files[p].hash) add(STATUS.edited, `edited: ${tilde(m, p)}`);
    const tools = path.join(ROOT, 'tools', 'worktree');
    if (['wt.zsh', 'defaults.conf'].some((n) => sha(fs.readFileSync(path.join(tools, n))) !== rec.data?.source?.[n])) add(STATUS.update);
  } else if (part.kind === 'guard') {
    onProgress(`checking the agent guard${trust ? ' and each Codex home\'s trust (this starts codex app-server once per home)' : ''}…`);
    const r = trust ? node(m, path.join(m.runtime, 'hooks', 'install-agent-guard.mjs'), ['status', ...guardArgs(guardTarget(m, rec.harnesses))]) : { status: 0, out: '' };
    if (!trust) row.details.push('Codex trust not checked (--no-trust-check)');
    row.harness = {};
    for (const line of r.out.split('\n')) {
      let mm = /^Claude (Bash|Monitor): (present|missing)/.exec(line);
      if (mm) { row.harness.claude = row.harness.claude === 'not installed' || mm[2] === 'missing' ? 'not installed' : 'active'; continue; }
      mm = /^Codex (.+): entry (present|missing), (trusted|untrusted)/.exec(line);
      if (mm) row.harness[`codex ${tilde(m, mm[1])}`] = mm[2] === 'missing' ? 'not installed' : mm[3] === 'trusted' ? 'active' : 'installed but not trusted';
      mm = /Warning: Grok (.+) has \[compat\.claude\] hooks = false/.exec(line);
      if (mm) add(STATUS.broken, `Grok ignores Claude hooks: ${tilde(m, mm[1])} sets [compat.claude] hooks = false, so the guard does not protect Grok sessions`);
    }
    for (const [h, s] of Object.entries(row.harness)) if (s !== 'active') add(STATUS.broken, `${h}: ${s}${s === 'installed but not trusted' ? ' — open Codex once and trust the hook, or run: acs packs uninstall review-gate --part agent-guard then install it again' : ''}`);
    if (trust && r.status !== 0) add(STATUS.broken, r.out.trim());
  } else if (part.kind === 'push-gate' && rec.data?.setting === 'reviewgate.worktreeProjects') {
    const r = git(m, ['config', '--global', '--type=bool', '--get', 'reviewgate.worktreeProjects'], { allowed: [0, 1, 128] });
    if (r.stdout.trim() !== 'true') add(STATUS.broken, 'reviewgate.worktreeProjects is no longer true in your global git config');
  } else if (part.kind === 'push-gate') {
    const hooks = path.join(m.runtime, 'hooks', 'global');
    const current = globalHooksPath(m);
    const real = fs.existsSync(hooks) ? realFile(hooks) : hooks;
    if (!current.length || current.some((v) => v !== real && v !== hooks)) add(STATUS.broken, `global core.hooksPath is ${current.join(', ') || 'unset'}, not ${tilde(m, hooks)}: no repo is gated`);
    const probe = envIProbe(m);
    if (!probe.ok) add(STATUS.broken, `the hook does not run from a bare environment (env -i): ${probe.why}`);
    const scan = shScript(m, path.join(m.runtime, 'hooks', 'install-global.sh'), ['status']);
    const lines = scan.out.split('\n');
    const at = lines.findIndex((l) => /^Repositories with their own local core\.hooksPath/.test(l));
    row.notGated = [];
    for (const l of at >= 0 ? lines.slice(at + 1) : []) {
      const mm = /^(\/.+?): (".*")$/.exec(l);
      if (mm) { row.notGated.push(mm[1]); row.details.push(`not gated: ${tilde(m, mm[1])} sets its own core.hooksPath (${JSON.parse(mm[2].split(', ')[0])})`); }
    }
  }
}

/**
 * Run the installed pre-push hook the way a bare `env -i git push` would: a
 * scratch repo pushing to a scratch remote, git by absolute path, and an
 * environment holding nothing but HOME (and the git config location, when
 * set). Ordinary repos pass through, so a clean push with no "node is
 * missing" warning means the hook found its node.
 */
export function envIProbe(m) {
  if (!m.git) return { ok: false, why: 'git is not on PATH' };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acs-pack-probe-'));
  try {
    const repo = path.join(dir, 'repo'), remote = path.join(dir, 'remote.git');
    const g = (cwd, args, env = m.env) => spawnSync(m.git, args, { cwd, encoding: 'utf8', env, input: '' });
    g(dir, ['init', '-q', '--bare', remote]);
    g(dir, ['init', '-q', repo]);
    const ident = { ...m.env, GIT_AUTHOR_NAME: 'acs', GIT_AUTHOR_EMAIL: 'acs@localhost', GIT_COMMITTER_NAME: 'acs', GIT_COMMITTER_EMAIL: 'acs@localhost' };
    const tree = g(repo, ['hash-object', '-t', 'tree', '-w', '--stdin'], ident);
    const commit = spawnSync(m.git, ['commit-tree', tree.stdout.trim(), '-m', 'probe'], { cwd: repo, encoding: 'utf8', env: ident, input: '' });
    g(repo, ['update-ref', 'refs/heads/probe', commit.stdout.trim()]);
    const bare = { HOME: m.home };
    for (const k of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'XDG_CONFIG_HOME']) if (m.env[k]) bare[k] = m.env[k];
    const r = g(repo, ['push', '-q', remote, 'refs/heads/probe:refs/heads/probe'], bare);
    const err = `${r.stdout}${r.stderr}`;
    if (r.status !== 0) return { ok: false, why: err.trim() || `git push exited ${r.status}` };
    if (/node is missing|broken dispatcher|could not run/.test(err)) return { ok: false, why: err.trim() };
    return { ok: true };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

export { emptyState };
