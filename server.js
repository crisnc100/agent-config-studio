import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveSafe, assertWritable, assertNotHardLinked, openUserFile, readUserText, isCredential, isDenied, kindOf, tilde, currentRoots, HOME, STUDIO_HOME, CODEX_HOME } from './lib/paths.js';
import { migrateRoots, rootsPath, previewRoot, addRoot, removeRoot, EDIT_GRANTS } from './lib/roots.js';
import { readSetup, writeSetup } from './lib/setup-state.js';
import { detectClis } from './lib/setup-clis.js';
import { scanOnce } from './lib/setup-scan.js';
import { nextSteps, pathStep } from './lib/setup-commands.js';
import { isPartial } from './lib/walk-budget.js';
import { locateBinary } from './lib/harness.js';
import { refreshLoginDirs, loginDirs, loginDirsKnown, loginDirsSettled, LOGIN_READ_MS } from './lib/login-path.js';
import { buildRegistry, scopeChain, onWalkDone, staleLargeWalks } from './lib/registry.js';
import { listSkills, resolveSkills, toPublic, readInSkill, parseFrontmatter, SKILL_LIMITS } from './lib/skills.js';
import { readSkillUsage, attachUsage, USAGE_CAVEAT } from './lib/skill-usage.js';
import { buildSkillsZip, ZIP_LIMITS } from './lib/zip.js';
import { contentDisposition, assertSelectionFits } from './lib/download.js';
import { validate } from './lib/validate.js';
import * as history from './lib/history.js';
import * as worktree from './lib/worktree.js';
import * as mutate from './lib/mutate.js';
import { runAssist, listActions } from './lib/assist.js';
import { streamTurn, parseEdits, resolveMentions } from './lib/chat.js';
import { detectHarnesses, HARNESSES, modelsFor, registryError } from './lib/harness.js';
import { createWatcher, snapshotOf, diffSnapshots, expectWrite, tagOrigin } from './lib/watch.js';
import { renderSnapshot, createSeat, removeSeat, moveSeatToPrivateHome, suggestSeats, addSuggestedSeat } from './lib/usage/seats.js';
import { refreshSnapshot } from './lib/usage/refresh.js';
import { refreshCodexCatalogs } from './lib/usage/codex-limits.js';
import { startLogin, loginState, cancelLogin } from './lib/usage/connect.js';
import { codexProcessesUsingHome, stopProcesses } from './lib/usage/processes.js';
import { loadSeats } from './lib/usage/seats.js';
import {
  createModelsState, setModel, resetModel, dismiss, applySidecar, whereUsed,
} from './lib/models-panel.js';
import { loadRegistry } from './lib/models.js';
import * as memoryOps from './lib/memory-ops.js';
import { contextMap, contextFile } from './lib/context-map.js';
import {
  syncShortcuts, install as installShortcuts, uninstall as uninstallShortcuts,
  isInstalled as shortcutsInstalled, shortcutsFromSeats, shortcutsPath, zshenvPath,
  validateWord, validateFlags, readShortcutConfig, writeShortcutConfig,
} from './lib/usage/shell.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * This start's identity, for `acs stop`: /api/health echoes the nonce, and
 * the run file the listener writes (studio dir, mode 0600) records it with
 * the pid. The launcher signals a pid only when both agree.
 */
const RUN_NONCE = crypto.randomBytes(16).toString('hex');
const runFile = (port) => path.join(STUDIO_HOME, 'run', `${port}.json`);
const PUBLIC = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 8787);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

const json = (res, code, body) => {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(s) });
  res.end(s);
};

/**
 * Did this request come from THIS page, rather than merely from this machine?
 *
 * The Host check the server does first does not answer that: a browser sets
 * Host to localhost for a cross-site request too, and readBody parses JSON
 * whatever the content-type, so any page the user has open could reach these
 * endpoints with no CORS preflight. That was survivable when the routes only
 * read files. It is not now: they SIGTERM codex sessions, move a seat out of
 * ~/.codex, and append a source line to ~/.zshenv.
 *
 * The PORT must match too. Sec-Fetch-Site reports 'same-site' for
 * localhost:5173 -> localhost:8787 because site ignores port, so without the
 * Origin comparison any other dev server the user has open — vite, storybook, a
 * compromised dev dependency — reaches these endpoints.
 *
 * Compared against this request's own Host rather than the configured PORT: the
 * server may be listening somewhere else entirely (an ephemeral port under
 * test, or ACS_PORT), and Host is already proven to be localhost by then.
 *
 * A missing Origin passes, and has to: a same-origin GET navigation — which is
 * how a browser saves a file to disk — sends no Origin at all.
 */
function sameOriginRequest(req) {
  const origin = req.headers.origin;
  const site = req.headers['sec-fetch-site'];
  const originOk = !origin || origin === `http://${req.headers.host}`
    || origin === `https://${req.headers.host}`;
  return originOk && !(site && site === 'cross-site');
}

/**
 * The stricter check for the two skills endpoints, which are GETs and so are
 * NOT covered by the global non-GET policy above.
 *
 * sameOriginRequest lets a missing Origin through with Sec-Fetch-Site:
 * same-site, and same-site is exactly what another localhost port sends — so
 * any dev server on this machine could fire an <img> at the export and make
 * this process walk and read every project tree, or hit /api/skills and make
 * it rescan 1.1GB of transcripts and rewrite the usage cache. Here only
 * `same-origin` (this page's fetch or download link) and `none` (the user
 * typed the URL) pass, and either way any Origin present must be this host.
 * An absent header is a non-browser client — curl, the test suites — which a
 * foreign page cannot impersonate: every browser that could be tricked into
 * sending the request sends Sec-Fetch-Site to a localhost origin.
 */
function strictSameOrigin(req) {
  const origin = req.headers.origin;
  const site = req.headers['sec-fetch-site'];
  const originOk = !origin || origin === `http://${req.headers.host}`
    || origin === `https://${req.headers.host}`;
  return originOk && (site === undefined || site === 'same-origin' || site === 'none');
}

async function readBody(req, limit = 8 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw Object.assign(new Error('body too large'), { status: 413 });
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('invalid JSON body'), { status: 400 }); }
}

const SESSION_LIMIT = 256;

function launchedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  try { return path.resolve(entry) === fileURLToPath(import.meta.url); }
  catch { return false; }
}

/**
 * Keep the generated shell file in step with the registry.
 *
 * Without this, "Move to its own folder" leaves the seat's word and the bare
 * `codex` export pointing at the home it just left — the shared one the move
 * existed to escape. New seats get no word and removed seats keep one until
 * someone happens to re-open the panel and press Save.
 *
 * Only regenerates when shortcuts are actually installed: it must not create
 * shell config for someone who never asked for it, and a seat change must not
 * fail because of shell wiring.
 */
function resyncShortcuts() {
  try {
    if (!shortcutsInstalled()) return;
    syncShortcuts({ config: readShortcutConfig() });
  } catch { /* advisory */ }
}

function detectedHarnessPayload(detected) {
  const harnesses = detected.map((h) => ({
    id: h.id,
    label: h.label,
    models: h.models,
    defaultModel: h.defaultModel,
    retired: h.retired ?? {},
    streams: h.streams,
  }));
  const defaultHarness = harnesses.some((h) => h.id === 'claude')
    ? 'claude'
    : (harnesses[0]?.id ?? 'claude');
  // Read on every request, like the allowlist itself: a registry fixed on disk
  // clears the warning without a restart.
  return { harnesses, defaultHarness, registryError: registryError() };
}

function normalizeHarnessId(value) {
  if (value === undefined || value === null || value === '') return 'claude';
  if (typeof value !== 'string') {
    throw Object.assign(new Error('invalid harness'), { status: 400 });
  }
  return value;
}

function turnSucceeded(result) {
  if (!result) return false;
  if (result.code !== undefined && result.code !== 0) return false;
  if (result.err) return false;
  if (result.is_error === true) return false;
  const text = typeof result.text === 'string' ? result.text.trim() : '';
  return text.length > 0;
}

function rememberSession(sessions, sessionId, harnessId) {
  if (!sessionId || typeof sessionId !== 'string') return;
  if (sessions.has(sessionId)) sessions.delete(sessionId);
  sessions.set(sessionId, harnessId);
  while (sessions.size > SESSION_LIMIT) {
    const oldest = sessions.keys().next().value;
    sessions.delete(oldest);
  }
}

async function resolveIncoming(body, { detectFn, sessions, checkSession }) {
  const harness = normalizeHarnessId(body?.harness);
  if (!Object.hasOwn(HARNESSES, harness)) {
    throw Object.assign(new Error(`unknown harness: ${harness}`), { status: 400 });
  }
  const detected = await detectFn();
  if (!detected.some((h) => h.id === harness)) {
    throw Object.assign(new Error(`harness not detected: ${harness}`), { status: 400 });
  }
  const desc = HARNESSES[harness];
  const { models, defaultModel } = modelsFor(desc);
  let model = body?.model;
  if (model === undefined || model === null || model === '') {
    // The default comes from a user-editable file, so it is held to the same
    // allowlist as a model the browser names.
    model = defaultModel;
    if (typeof model !== 'string' || !Object.hasOwn(models, model)) {
      throw Object.assign(new Error(`harness ${harness} has no valid default model`), { status: 500 });
    }
  } else if (typeof model !== 'string' || !Object.hasOwn(models, model)) {
    throw Object.assign(new Error(`model ${model} is not valid for harness ${harness}`), { status: 400 });
  }

  let sessionId = body?.sessionId || null;
  if (checkSession && sessionId) {
    sessionId = String(sessionId);
    if (!sessions.has(sessionId)) {
      sessionId = null;
    } else if (sessions.get(sessionId) !== harness) {
      throw Object.assign(
        new Error(`session is bound to harness ${sessions.get(sessionId)}, not ${harness}`),
        { status: 409 },
      );
    }
  } else if (!checkSession) {
    sessionId = null;
  }

  return { harness, model, sessionId, desc };
}

/* ── live file events ─────────────────────────────────────────────────── */

const sseClients = new Set();
let lastSnapshot = snapshotOf(buildRegistry());

function broadcast(payload) {
  const frame = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    try { res.write(frame); } catch { sseClients.delete(res); }
  }
}

function handleEvents(req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write('retry: 2000\n\n');
  sseClients.add(res);

  // Keep intermediaries from closing an idle stream.
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25_000);
  req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
}

// A selection is a query string, and a query string is a header: Node's own
// header cap is 16KB, so anything approaching that is an attempt to make the
// server work, not a person picking skills. Both caps are refused before
// listSkills() — which walks every project folder — is ever called.
const MAX_EXPORT_QUERY_BYTES = 8 * 1024;
const MAX_EXPORT_IDS = 256;

// Exactly what skillId() produces. Nothing path-shaped can match it, which is
// what makes "this endpoint accepts no filesystem path" a property of the
// parser rather than a promise in a comment.
const SKILL_ID = /^[0-9a-f]{12}$/;

const bad = (msg, status) => Object.assign(new Error(msg), { status });

/**
 * GET /api/skills/export?ids=a,b,c — the download itself.
 *
 * WHY IT IS NOT IN THE ROUTES TABLE. The /api/ dispatcher wraps every handler
 * in `json(res, 200, await handler(...))`. A route registered there can return
 * a JSON body and nothing else, so an archive routed through it would arrive
 * as a JSON-escaped string. handleChat and handleEvents already have this
 * problem and already solve it the same way — matched ahead of the dispatcher,
 * writing their own headers. The cost of stepping outside the dispatcher is
 * that its try/catch does not cover this code either: readInSkill and the zip
 * writer throw errors carrying .status (400/403/404/413), and with no catch
 * here one of those would surface as an unhandled rejection and a socket that
 * never closes instead of a clean error. Hence the wrapper below.
 *
 * WHY IT IS A GET. A browser can only save a response straight to disk from a
 * navigation or an anchor — both GETs. A POST download has to be read into a
 * Blob and handed to createObjectURL, which buffers the whole archive a second
 * time inside the page. The endpoint is also read-only, which is the usual
 * argument for a GET.
 *
 * That GET is why the origin check is applied HERE rather than inherited. The
 * server's global check deliberately exempts GET, and for the read-only JSON
 * routes that is fine. It is not fine for this one: same-origin policy stops a
 * foreign page READING the response, but an <img> or a hidden iframe pointed at
 * this URL still makes the server walk every project tree and hash every skill
 * on the machine. Refusing a cross-site request costs nothing — a same-origin
 * download navigation sends no Origin and Sec-Fetch-Site: same-origin — and it
 * removes a free amplifier. This is a check on this endpoint only; the app's
 * global policy is unchanged.
 */
async function handleSkillExport(req, res, url) {
  try {
    if (!strictSameOrigin(req)) throw bad('cross-origin requests are not accepted', 403);
    if (Buffer.byteLength(req.url) > MAX_EXPORT_QUERY_BYTES) throw bad('request line is too long', 413);

    // `ids` is the ONLY parameter read. A `path` or `name` alongside it is not
    // rejected, it is simply never looked at — there is no code path in this
    // handler that could turn a query value into a filesystem location.
    const raw = (url.searchParams.get('ids') || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!raw.length) throw bad('ids is required', 400);
    if (raw.length > MAX_EXPORT_IDS) throw bad(`at most ${MAX_EXPORT_IDS} skills can be exported at once`, 400);
    for (const id of raw) {
      if (!SKILL_ID.test(id)) throw bad(`not a skill id: ${JSON.stringify(id.slice(0, 40))}`, 400);
    }
    // Deduplicated here, before anything is looked up, so a repeated id cannot
    // put the same bundle in the archive twice under a `-2` suffix.
    const ids = [...new Set(raw)];

    // Only the selected ids are resolved, from metadata: nothing is read or
    // hashed until the selection has passed the caps below. listSkills() would
    // read and hash every bundle on the machine first, and turn an oversized
    // bundle into a broken row (409) instead of the 413 it is.
    const byId = resolveSkills(ids);
    const rows = ids.map((id) => {
      const row = byId.get(id);
      // Unknown ids 404 rather than being skipped: a selection that silently
      // shrinks hands back an archive that looks complete and is not.
      if (!row) throw bad(`no such skill: ${id}`, 404);
      if (row.broken) throw bad(`skill cannot be exported: ${row.reason || 'broken'}`, 409);
      if (!row.files.length) throw bad(`skill has no files: ${id}`, 409);
      return row;
    });

    const limits = { ...ZIP_LIMITS, ...SKILL_LIMITS };
    assertSelectionFits(rows, limits);

    if (rows.length === 1) {
      // The bar: a single skill arrives as `<skill-name>.md`, never SKILL.md,
      // with its frontmatter untouched — so the bytes are shipped exactly as
      // readInSkill returned them, with no re-serialisation in between. The
      // display name comes from those same bytes.
      const body = readInSkill(rows[0].dir, 'SKILL.md', { budget: { remaining: limits.maxBytes } });
      const fmName = (parseFrontmatter(body.toString('utf8'))?.name || '').trim();
      res.writeHead(200, {
        'content-type': 'text/markdown; charset=utf-8',
        'content-length': body.length,
        'content-disposition': contentDisposition(fmName || rows[0].name, '.md'),
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
      res.end(body);
      return;
    }

    // readInSkill is passed as THE reader, so every byte in the archive crosses
    // the containment rule on its way in. Nothing here touches fs directly.
    const zip = buildSkillsZip(rows, { read: readInSkill, maxBytes: limits.maxBytes, maxEntries: limits.maxEntries });
    res.writeHead(200, {
      'content-type': 'application/zip',
      'content-length': zip.length,
      // What the archive does NOT reproduce, as a count: the names themselves
      // are on each row's `excluded` in /api/skills, and a count is the only
      // form of them that is safe to put in a header.
      'x-skills-excluded': String(zip.excluded.length),
      'content-disposition': contentDisposition(`skills-${rows.length}`, '.zip', 'skills'),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    res.end(zip);
  } catch (e) {
    // headersSent can only be true if a throw happened after writeHead, which
    // would mean a half-written body. Destroying the socket is the honest
    // signal there — a truncated archive with a 200 on it is worse than a
    // failed transfer, because the recipient cannot tell.
    if (res.headersSent) { res.destroy(); return; }
    json(res, e.status || 500, { error: e.message });
  }
}

/**
 * A path that left the registry while its file is still on disk, because
 * the path is no longer allowed: its folder was removed from roots.json or
 * made read-only. That is an access change, not a deletion, and the page must
 * not close an editor with unsaved work over it.
 */
function isRevoked(p) {
  if (!fs.existsSync(p)) return false;
  try { resolveSafe(p); return false; } catch { return true; }
}

/**
 * Rebuild, diff, and tell every open tab what actually changed. A change on
 * disk also has large roots walked again, off the main path (lib/registry.js);
 * the rebuild that walk's end triggers passes `fromWalk` and does not.
 */
async function onFilesChanged({ fromWalk = false } = {}) {
  if (!fromWalk) staleLargeWalks();
  let registry;
  try { registry = buildRegistry(); } catch { return; }
  const next = snapshotOf(registry);
  const delta = diffSnapshots(lastSnapshot, next);
  lastSnapshot = next;

  if (!delta.added.length && !delta.removed.length && !delta.changed.length) return;

  const revoked = delta.removed.filter(isRevoked);
  delta.removed = delta.removed.filter((p) => !revoked.includes(p));

  // The studio's own writes go out tagged, so the page can stay quiet about
  // them; everything else is an outside change (lib/watch.js tagOrigin).
  const { studio, outside } = tagOrigin(delta);
  outside.revoked = revoked;
  for (const [part, origin] of [[studio, 'studio'], [outside, 'outside']]) {
    const gone = part.revoked || [];
    if (!part.added.length && !part.removed.length && !part.changed.length && !gone.length) continue;
    broadcast({
      type: 'files',
      origin,
      added: part.added.map(tilde),
      removed: part.removed.map(tilde),
      changed: part.changed.map(tilde),
      revoked: gone.map(tilde),
      addedPaths: part.added,
      removedPaths: part.removed,
      changedPaths: part.changed,
      revokedPaths: gone,
      total: next.size,
    });
  }
}

/** The folder list as the page sees it: display paths, statuses, problems. */
function rootsView() {
  const r = currentRoots();
  return {
    state: r.state, error: r.error, file: tilde(r.path),
    // `partial`: a discovery walk of this folder hit its cap (lib/walk-budget.js).
    roots: r.roots.map((x) => ({ id: x.id, label: x.label, access: x.access, status: x.status, display: tilde(x.path), partial: Boolean(x.real && isPartial(x.real)) })),
    invalid: [
      ...r.invalid.map((x) => ({ id: typeof x.entry?.id === 'string' ? x.entry.id : null, reason: x.reason })),
      // A built-in home ignored for where it really points, named as such.
      ...r.builtinInvalid.map((b) => ({ id: b.name, reason: `${b.name} is ignored: ${b.reason}` })),
    ],
    addHint: 'acs roots add <path>',
  };
}

/**
 * Call `onChange` whenever roots.json is written, replaced or removed. The
 * studio's folder is watched flat — the CLI writes a temp file and renames it
 * over roots.json — and the file's identity decides, so a lock file or a
 * seats.json write next to it is not a roots change.
 */
function watchRoots(onChange, { debounceMs = 150 } = {}) {
  const sig = () => { try { const st = fs.statSync(rootsPath()); return `${st.ino}:${st.mtimeMs}:${st.size}`; } catch { return 'absent'; } };
  let last = sig();
  let timer = null;
  let w = null;
  try {
    fs.mkdirSync(STUDIO_HOME, { recursive: true });
    w = fs.watch(STUDIO_HOME, { persistent: false }, () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const now = sig();
        if (now === last) return;
        last = now;
        onChange();
      }, debounceMs);
    });
  } catch { /* without a watch, roots apply on the next start */ }
  return { close() { clearTimeout(timer); try { w?.close(); } catch {} } };
}

const sha256Text = (text) => crypto.createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');

/** Refuse a request that did not come from this page — for the GETs and setup writes below. */
const requireStrict = (req) => {
  if (!strictSameOrigin(req)) throw bad('cross-origin requests are not accepted', 403);
};

/** The body as a plain object; an array, a string or null is not a request. */
async function objectBody(req) {
  const b = await readBody(req, 64 * 1024);
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw bad('the request body must be a JSON object', 400);
  return b;
}

/** A string field, or a 400 naming it. Absent is allowed only when optional. */
function field(body, name, { optional = false, max = 4096 } = {}) {
  const v = body[name];
  if (v === undefined && optional) return undefined;
  if (typeof v !== 'string' || v.length > max) throw bad(`${name} must be a string`, 400);
  return v;
}

/**
 * A folder path typed in the browser: absolute, or from `~`. A relative path
 * would resolve against the server's own working directory — this checkout —
 * which is never what the person meant.
 */
function typedFolder(body) {
  const p = field(body, 'path').trim();
  if (!p) throw bad('a folder path is required', 400);
  if (!(p.startsWith('/') || p === '~' || p.startsWith('~/'))) {
    throw bad(`type the folder's full path, starting with / or ~/ — "${p.slice(0, 80)}" is relative`, 400);
  }
  return p;
}

/** The folders as registered, by realpath, for the scan's "already added / covered". */
const registeredReal = () => currentRoots().roots.map((r) => r.real).filter(Boolean);

/** Which agent CLIs are installed, for seat suggestions: located only, no --version run. */
const installedClis = () => Object.fromEntries(['claude', 'codex', 'grok'].map((id) => [id, locateBinary(id).installed]));

export function createApp(opts = {}) {
  const detectFn = opts.detectHarnesses || detectHarnesses;
  // The usage collector: production reads the stored snapshot and spawns the
  // acs-usage CLI to refresh it. Only an in-process caller can replace it —
  // the offline walkthrough, so it never reaches a Keychain or the network.
  // Nothing reads it from the environment or a request (tests/setup-guards.mjs).
  const usage = opts.usageCollector || { render: () => renderSnapshot(), refresh: () => refreshSnapshot() };
  const streamTurnFn = opts.streamTurn || streamTurn;
  const runAssistFn = opts.runAssist || runAssist;
  const sessions = new Map();
  const models = createModelsState({
    detectFn,
    codexHomes: () => loadSeats().seats.filter((x) => x.vendor === 'codex' && x.home).map((x) => x.home),
    refreshCodex: opts.refreshCodexCatalogs || refreshCodexCatalogs,
  });

  /** A family the registry knows, or a 400 — never a path or free text. */
  const knownFamily = (family) => {
    if (typeof family !== 'string' || !Object.hasOwn(loadRegistry().defaults.models, family)) {
      throw Object.assign(new Error(`unknown model family "${family}"`), { status: 400 });
    }
    return family;
  };

  /** The live alert a request names, or a 409: accept and dismiss act only on what detection shows now. */
  const liveAlert = async (family, key) => {
    const row = (await models.view()).rows.find((r) => r.family === knownFamily(family));
    const alert = row?.alerts.find((a) => a.key === key);
    if (!alert) throw Object.assign(new Error('That alert no longer applies. Check again.'), { status: 409 });
    return { row, alert };
  };

  const ROUTES = {
  /** Identity probe so the launcher never kills an unrelated process on this port. */
  'GET /api/health': async () => ({ app: 'agent-config-studio', pid: process.pid, nonce: RUN_NONCE }),

  /**
   * Read-only view of configured MCP servers. Global servers live in
   * ~/.claude.json next to oauth tokens, API-key responses and 44 projects of
   * history — so only the mcpServers key is extracted, and that file is never
   * exposed through the file API.
   */
  /**
   * Subscription headroom per seat.
   *
   * The studio never reads a credential — that rule is why `.credentials.json`
   * and `auth.json` are hard-blocked in lib/paths.js, and this endpoint does not
   * weaken it. Claude's headroom needs an OAuth token, so its reading comes from
   * the snapshot the `acs-usage` CLI wrote, and carries its age. Codex needs no
   * credential (it reads its own rollout logs), so it is refreshed live here.
   */
  'GET /api/usage': async () => {
    try { return await usage.render(); }
    catch (e) { return { takenAt: Date.now(), storedAt: null, seats: [], error: e.message }; }
  },

  /**
   * Register a seat. A codex seat gets its own CODEX_HOME created for it (or
   * adopts ~/.codex if no seat has claimed it yet) and comes back with the one
   * login command to run — the studio never performs the login itself, because
   * the OAuth flow needs a browser and the credential must not pass through
   * here.
   *
   * Only vendor and label are accepted. The home is always derived server-side
   * from the generated id: taking a path from the request body would turn this
   * into a directory-creation primitive.
   */
  'POST /api/usage/seats': async (req) => {
    const { vendor, label } = await readBody(req);
    let res;
    try { res = createSeat({ vendor, label }); }
    catch (e) { const err = new Error(e.message); err.status = 400; throw err; }
    resyncShortcuts();
    return res;
  },

  /**
   * Unregister a seat. The seat's home is deliberately left on disk — it holds
   * a real login and its session history, and dropping a row from a list must
   * never destroy credentials. Removing the directory stays a manual act.
   */
  'POST /api/usage/seats/remove': async (req) => {
    const { id } = await readBody(req);
    try { removeSeat(id); }
    catch (e) { const err = new Error(e.message); err.status = 404; throw err; }
    resyncShortcuts();
    return { removed: id };
  },

  /**
   * Take a fresh reading for the seats that need a credential.
   *
   * Spawned as a child process on purpose: the token is read by the CLI and
   * written to the snapshot, and never enters this process. Same shape as the
   * assist path, which shells out to the harness CLI rather than handling auth.
   * Fixed argv — nothing from the request reaches it.
   */
  'POST /api/usage/refresh': async () => usage.refresh(),

  /**
   * Shell shortcuts: give each Codex seat a word you can type.
   *
   * The generated file is owned entirely by ACS and rewritten in full; the only
   * touch to a human-owned file is a single `source` line appended once to
   * ~/.zshenv (never .zshrc — zsh reads .zshenv for EVERY shell, which is why
   * shortcuts installed elsewhere appear to work only "sometimes").
   *
   * Words and flags are validated against a strict allowlist before they are
   * rendered. This output is executed by every terminal the user opens, so a
   * value that merely looks odd is refused rather than escaped.
   */
  'GET /api/usage/shortcuts': async () => {
    const { seats } = loadSeats();
    const config = readShortcutConfig();
    return {
      installed: shortcutsInstalled(),
      file: shortcutsPath(),
      zshenv: zshenvPath(),
      shortcuts: shortcutsFromSeats(seats, config),
    };
  },

  'POST /api/usage/shortcuts': async (req) => {
    const body = await readBody(req);
    const { defaultId = null, install: wantInstall } = body;
    // Defaults only cover `undefined`; an explicit null reached Object.entries
    // and became a 500 where the caller deserves a 400.
    const isPlain = (v) => v === undefined || (v !== null && typeof v === 'object' && !Array.isArray(v));
    if (!isPlain(body.words) || !isPlain(body.flags)) {
      const err = new Error('words and flags must be objects'); err.status = 400; throw err;
    }
    const words = body.words ?? {};
    const flags = body.flags ?? {};
    const clean = { words: {}, flags: {}, defaultId: null };
    // The default seat is an id from the registry, never a path: it decides
    // which subscription a bare `codex` spends, so it must not be free text.
    if (defaultId != null && defaultId !== '') {
      const { seats } = loadSeats();
      if (!seats.some((x) => x.id === defaultId && x.vendor === 'codex')) {
        const err = new Error(`no codex seat with id "${defaultId}"`); err.status = 400; throw err;
      }
      clean.defaultId = defaultId;
    }
    const problems = [];
    for (const [id, word] of Object.entries(words)) {
      if (word === '' || word == null) continue;          // blank = fall back to derived
      const bad = validateWord(String(word));
      if (bad) problems.push(`${id}: ${bad}`); else clean.words[id] = String(word);
    }
    for (const [id, f] of Object.entries(flags)) {
      if (f === '' || f == null) continue;
      const bad = validateFlags(String(f));
      if (bad) problems.push(`${id}: ${bad}`); else clean.flags[id] = String(f);
    }
    if (problems.length) { const err = new Error(problems.join('; ')); err.status = 400; throw err; }

    // Only rewrite preferences that were actually supplied. Turning shortcuts
    // OFF posts empty maps, and writing those through would erase every chosen
    // word, flag and default — so turning them back on would silently change
    // which subscription a bare `codex` bills.
    const supplied = Object.keys(words).length || Object.keys(flags).length || defaultId;
    const merged = supplied ? clean : readShortcutConfig();
    writeShortcutConfig(merged);
    const r = syncShortcuts({ config: merged });
    if (!r.ok) { const err = new Error(r.problems.join('; ')); err.status = 400; throw err; }
    if (wantInstall === true) installShortcuts();
    else if (wantInstall === false) uninstallShortcuts();
    return {
      ok: true, installed: shortcutsInstalled(), file: r.file,
      shortcuts: r.shortcuts, zshenv: zshenvPath(),
    };
  },


  /**
   * Start a Codex sign-in for one seat and return the OAuth URL, so the user
   * signs in in the browser they already have open instead of a terminal.
   *
   * Only a registered seat id crosses the wire; the home is looked up from the
   * registry, never taken from the request.
   */
  'POST /api/usage/connect': async (req) => {
    const { id, reauth } = await readBody(req);
    const seat = loadSeats().seats.find((x) => x.id === id);
    if (!seat) { const e = new Error(`no seat with id "${id}"`); e.status = 404; throw e; }
    if (seat.vendor !== 'codex') {
      const e = new Error(`${seat.vendor} seats are not connected this way`); e.status = 400; throw e;
    }
    return startLogin({ seatId: seat.id, home: seat.home, reauth: reauth === true });
  },

  /**
   * What is currently holding a seat's home open, and stopping it.
   *
   * A Codex process refreshes its credentials back into its home on its own
   * schedule, so one left running across a sign-in silently undoes it. Telling
   * people to "quit your session first" in a runbook does not work — they
   * cannot see which processes those are. The studio finds them and offers.
   */
  /**
   * Move a seat out of the shared ~/.codex into a private home.
   *
   * Only an id crosses the wire; the destination is derived server-side, the
   * same rule as seat creation — a path from a request body would make this a
   * directory-creation primitive. No credential is copied: the new home starts
   * signed out and is connected from the panel.
   */
  'POST /api/usage/seats/move': async (req) => {
    const { id } = await readBody(req);
    let res;
    try { res = moveSeatToPrivateHome({ id }); }
    catch (e) { const err = new Error(e.message); err.status = 400; throw err; }
    resyncShortcuts();
    return res;
  },

  'POST /api/usage/seats/conflicts': async (req) => {
    const { id } = await readBody(req);
    const seat = loadSeats().seats.find((x) => x.id === id);
    if (!seat) { const e = new Error(`no seat with id "${id}"`); e.status = 404; throw e; }
    if (!seat.home) return { conflicts: [] };
    return { conflicts: await codexProcessesUsingHome(seat.home) };
  },

  /**
   * Stop them. The pid list is a HINT, never an instruction: processes.js
   * re-verifies each pid still holds THIS seat's home before signalling it, so
   * a stale or forged pid cannot turn this into a remote-kill primitive.
   * SIGTERM only — a Codex session asked to stop should get to save its work.
   */
  'POST /api/usage/seats/conflicts/stop': async (req) => {
    const { id, pids } = await readBody(req);
    const seat = loadSeats().seats.find((x) => x.id === id);
    if (!seat) { const e = new Error(`no seat with id "${id}"`); e.status = 404; throw e; }
    if (!seat.home) { const e = new Error('this seat has no home'); e.status = 400; throw e; }
    const result = await stopProcesses(seat.home, pids);
    // SIGTERM is a request, and a Codex session takes a moment to flush and
    // exit. Re-listing immediately reports a successful stop as a failure, so
    // give them a few seconds to go before calling anything "still running".
    let remaining = [];
    for (let i = 0; i < 10; i++) {
      try { remaining = await codexProcessesUsingHome(seat.home); }
      catch { remaining = []; break; }        // unknown: let the login precheck decide
      if (!remaining.length) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    return { ...result, remaining };
  },

  'POST /api/usage/connect/state': async (req) => {
    const { id } = await readBody(req);
    const seat = loadSeats().seats.find((x) => x.id === id);
    if (!seat) { const e = new Error(`no seat with id "${id}"`); e.status = 404; throw e; }
    return loginState({ seatId: seat.id, home: seat.home });
  },

  'POST /api/usage/connect/cancel': async (req) => {
    const { id } = await readBody(req);
    return cancelLogin({ seatId: String(id || '') });
  },

  'GET /api/mcp': async () => {
    const out = { global: [], codex: [], note: null };

    try {
      const raw = JSON.parse(readUserText(path.join(HOME, '.claude.json')));
      out.global = Object.entries(raw.mcpServers || {}).map(([name, cfg]) => ({
        name, transport: cfg.type || (cfg.command ? 'stdio' : 'unknown'),
        target: cfg.url || cfg.command || '', scope: 'global',
      }));
      for (const [proj, cfg] of Object.entries(raw.projects || {})) {
        for (const [name, s] of Object.entries(cfg.mcpServers || {})) {
          out.global.push({
            name, transport: s.type || (s.command ? 'stdio' : 'unknown'),
            target: s.url || s.command || '', scope: tilde(proj),
          });
        }
      }
      out.note = 'Global MCP is defined in ~/.claude.json, which also holds credentials — shown read-only. Use `claude mcp add/remove` to change it.';
    } catch (e) {
      // No file yet is how a fresh machine starts, not an error to show raw.
      out.note = e.code === 'ENOENT' ? 'No MCP servers configured yet.' : `Could not read ~/.claude.json: ${e.message}`;
    }

    try {
      const toml = readUserText(path.join(CODEX_HOME, 'config.toml'));
      for (const m of toml.matchAll(/^\[mcp_servers\.([A-Za-z0-9_-]+)\]/gm)) {
        out.codex.push({ name: m[1], scope: '~/.codex/config.toml' });
      }
    } catch { /* codex config is optional */ }

    return out;
  },

  /**
   * The project folders as roots.json says now, for the Folders section and
   * every label the page shows. Read-only: folders are added with
   * `acs roots add`. Paths go out in display form only.
   */
  'GET /api/roots': async () => rootsView(),

  /**
   * Adding a folder from the browser (the setup screen). A maintainer decision,
   * 2026-10-03: edit folders may be added here, behind the strict origin
   * check, lib/roots.js's own reject list — the same rules as `acs roots add`,
   * none repeated here — and a confirm naming the folder.
   *
   * preview says where a typed path really is and what each access would
   * refuse. add for an edit folder needs `confirm` equal to preview's
   * `canonical`, re-checked under the registry lock at write time, so a link
   * re-pointed after the dialog adds nothing. Every field is type-checked
   * first; a malformed body writes nothing.
   */
  'POST /api/roots/preview': async (req) => {
    requireStrict(req);
    const body = await objectBody(req);
    const p = typedFolder(body);
    const label = field(body, 'label', { optional: true, max: 200 });
    const v = previewRoot({ path: p, label }, { home: HOME });
    return { canonical: v.canonical, display: v.display, typed: v.typed, label: v.label, access: v.access, grants: EDIT_GRANTS };
  },
  'POST /api/roots/add': async (req) => {
    requireStrict(req);
    const body = await objectBody(req);
    const p = typedFolder(body);
    const access = body.access;
    if (access !== 'edit' && access !== 'read') throw bad('access must be "edit" or "read"', 400);
    const label = field(body, 'label', { optional: true, max: 200 });
    const confirm = field(body, 'confirm', { optional: true });
    if (access === 'edit' && confirm === undefined) {
      throw bad('adding an edit folder needs a confirm naming it — preview it first', 400);
    }
    let added;
    try { added = addRoot({ path: p, access, label, confirm }, { home: HOME }); }
    catch (e) { throw bad(e.message, 400); }
    return { added: { id: added.root.id, label: added.root.label, access: added.root.access, display: tilde(added.root.path) }, roots: rootsView() };
  },
  'POST /api/roots/remove': async (req) => {
    requireStrict(req);
    const id = field(await objectBody(req), 'id', { max: 100 });
    try { removeRoot(id, { home: HOME }); }
    catch (e) { throw bad(e.message, /no folder with id/.test(e.message) ? 404 : 400); }
    return { removed: id, roots: rootsView() };
  },

  /**
   * The setup screen. status is what boot routing reads; complete is Skip or
   * Finish. clis and scan do real work (version probes, a filesystem walk),
   * so — GETs or not — they take the strict origin check, like /api/skills:
   * another page must not be able to set them off.
   */
  'GET /api/setup/status': async () => readSetup({ home: HOME }),
  'POST /api/setup/complete': async (req) => {
    requireStrict(req);
    const { completed } = await objectBody(req);
    if (completed !== 'done' && completed !== 'skipped') throw bad('completed must be "done" or "skipped"', 400);
    try { return writeSetup(completed, { home: HOME }); }
    catch (e) { throw bad(`setup.json could not be written: ${e.code || e.message}`, 500); }
  },
  'GET /api/setup/clis': async (req, url) => {
    requireStrict(req);
    // Recheck reads the login shell's PATH again (capped, so the answer fits
    // in about 4 s); the result is the server's from then on, for every lookup.
    const recheck = url.searchParams.get('recheck') === '1';
    // Without Recheck, the read made at start is awaited (bounded): the first
    // answer must already be about a new terminal's PATH.
    if (!recheck) await loginDirsSettled(LOGIN_READ_MS);
    const pendingDirs = recheck ? refreshLoginDirs({ timeoutMs: LOGIN_READ_MS }) : null;
    const clis = await detectClis({ home: HOME, pendingDirs });
    // acs on the PATH a new terminal has, not the one this server inherited
    // (a launcher-only entry the profile drops must not count). When the
    // login shell has not answered, it is unknown — null — and the Done step
    // shows this checkout's absolute bin/acs, which works either way.
    const acsOnPath = loginDirsKnown()
      ? locateBinary('acs', loginDirs().map((d) => path.join(d, 'acs'))).installed
      : null;
    return { clis, acsOnPath, path: pathStep({ acsOnPath }), next: nextSteps({ acsOnPath: acsOnPath === true }), checkedAt: Date.now() };
  },
  'GET /api/setup/scan': async (req) => {
    requireStrict(req);
    const r = await scanOnce({ home: HOME, registered: registeredReal(), display: tilde });
    if (r.busy) throw bad('the last scan is still finishing on a slow folder — try again in a moment', 409);
    return r;
  },
  'GET /api/setup/accounts': async (req) => {
    requireStrict(req);
    return { suggestions: suggestSeats({ home: HOME, binaries: installedClis() }).map((sg) => ({ ...sg, home: sg.home ? tilde(sg.home) : null })) };
  },
  /**
   * Add an account from setup: a suggestion by its `key` — exactly the home
   * detection found, re-detected here, never a path from the request — or a
   * manual vendor + label, through the same createSeat as Usage.
   */
  'POST /api/setup/seats': async (req) => {
    requireStrict(req);
    const body = await objectBody(req);
    const label = field(body, 'label', { optional: true, max: 200 });
    let res;
    try {
      if (body.key !== undefined) res = addSuggestedSeat({ key: field(body, 'key', { max: 20 }), label, home: HOME, binaries: installedClis() });
      else res = createSeat({ vendor: field(body, 'vendor', { max: 20 }), label: label ?? '' });
    } catch (e) { throw bad(e.message, e.status || 400); }
    resyncShortcuts();
    return res;
  },

  'GET /api/registry': async () => ({
    ...buildRegistry(),
    history: await history.repoStats(),
    assistActions: listActions(),
    ...detectedHarnessPayload(await detectFn()),
    // The Models button's badge, so it shows without a click.
    modelAlerts: await models.view().then((v) => v.pending, () => 0),
  }),

  /**
   * Every skill on the machine, labelled by source and with the copies
   * collapsed. Rows carry an opaque id and no filesystem path — this endpoint
   * takes no parameters, and the ones that follow it take ids only, so there is
   * nothing here a page could hand back to reach a file of its choosing.
   */
  // The usage read is cached per transcript file, so the cost of a panel open
  // is a stat of each transcript, not a re-read of 1.1GB. It is also allowed to
  // fail: a skills list without the signal is useful, a 500 is not.
  'GET /api/skills': async (req) => {
    // A GET, so the global non-GET policy does not cover it — and it is not
    // free: it walks every project tree and rescans the transcript corpus,
    // rewriting the usage cache. See strictSameOrigin.
    if (!strictSameOrigin(req)) throw bad('cross-origin requests are not accepted', 403);
    const rows = listSkills().map(toPublic);
    let usage;
    try { usage = await readSkillUsage(); }
    catch (e) {
      return { skills: rows, usage: { available: false, reason: e.message, caveat: USAGE_CAVEAT } };
    }
    // `root` is deliberately dropped: the rest of this payload carries no
    // filesystem path, and a test asserts exactly that.
    const { root, ...stats } = usage.stats;
    return { skills: attachUsage(rows, usage), usage: { available: true, caveat: USAGE_CAVEAT, stats } };
  },

  /**
   * The Memory view: every auto-memory fact grouped by repository, plus the
   * rot around it. A GET that rescans changed transcripts, so it takes the
   * strict origin check for the same reason /api/skills does.
   *
   * Every memory route below takes ids and nothing else — `id`, `ids`,
   * `opId`, `action`. No handler reads a path from the request, so there is
   * no value a page could send that names a file of its choosing; the ids are
   * random and resolved server-side (lib/memory-ops.js).
   */
  'GET /api/memory': async (req) => {
    if (!strictSameOrigin(req)) throw bad('cross-origin requests are not accepted', 403);
    return memoryOps.memoryView();
  },
  'GET /api/memory/file': async (req, url) => {
    if (!strictSameOrigin(req)) throw bad('cross-origin requests are not accepted', 403);
    return memoryOps.memoryFile(url.searchParams.get('id'));
  },
  'GET /api/memory/ops': async () => ({ ops: memoryOps.listOps() }),
  'POST /api/memory/preview': async (req) => {
    const { action, ids } = await readBody(req);
    return memoryOps.preview({ action, ids });
  },
  'POST /api/memory/accept': async (req) => memoryOps.accept((await readBody(req)).opId),
  'POST /api/memory/restore': async (req) => memoryOps.restore((await readBody(req)).opId),
  'POST /api/memory/keep': async (req) => memoryOps.keep((await readBody(req)).id),

  /**
   * The Context view: CLAUDE.md / AGENTS.md / .cursor rules per project, copies
   * collapsed, drift flagged. Read-only; the diff fetches texts by id.
   */
  'GET /api/context': async (req) => {
    if (!strictSameOrigin(req)) throw bad('cross-origin requests are not accepted', 403);
    return contextMap();
  },
  'GET /api/context/file': async (req, url) => {
    if (!strictSameOrigin(req)) throw bad('cross-origin requests are not accepted', 403);
    return contextFile(url.searchParams.get('id'));
  },

  /**
   * The Models panel. Catalogs are the CLIs' own on-disk caches, read at
   * start and on "Check now", and only projected fields leave
   * lib/models-catalog.js. "Check now" first has Codex refresh its catalogs
   * through lib/usage/codex-limits.js; ACS reads no credential either way.
   */
  'GET /api/models': async () => models.view(),
  'POST /api/models/check': async () => { await models.check({ refresh: true }); return models.view(); },
  'GET /api/models/where': async (_req, url) => whereUsed(knownFamily(url.searchParams.get('family'))),

  'POST /api/models/set': async (req) => {
    const { family, id, confirm } = await readBody(req);
    const s = await models.current();
    return setModel({ family, id, confirm: confirm === true, catalogs: s.catalogs, claudeVersion: s.claudeVersion });
  },
  'POST /api/models/reset': async (req) => resetModel({ family: (await readBody(req)).family }),

  /** Accepting writes exactly what a manual edit of the same id writes. */
  'POST /api/models/accept': async (req) => {
    const { family, key } = await readBody(req);
    const { row, alert } = await liveAlert(family, key);
    if (!alert.acceptable || !alert.candidate) {
      throw Object.assign(new Error(alert.reason || 'This alert has nothing to accept.'), { status: 409 });
    }
    const s = await models.current();
    return setModel({ family: row.family, id: alert.candidate, confirm: true, catalogs: s.catalogs, claudeVersion: s.claudeVersion });
  },
  'POST /api/models/dismiss': async (req) => {
    const { family, key } = await readBody(req);
    const { row, alert } = await liveAlert(family, key);
    return { dismissed: await dismiss({ family: row.family, id: row.id, key: alert.key }) };
  },
  'POST /api/models/sidecar': async (req) => {
    const { kind, from, to, mtime } = await readBody(req);
    return applySidecar({ kind, from, to, mtime });
  },

  /** The Assist picker alone, without the file registry — what a model-registry edit changes. */
  'GET /api/harnesses': async () => detectedHarnessPayload(await detectFn()),

  'GET /api/file': async (_req, url) => {
    const abs = resolveSafe(url.searchParams.get('path'));
    // Judged and read through one descriptor (lib/paths.js openUserFile).
    let opened;
    try { opened = openUserFile(abs, { maxBytes: 4 * 1024 * 1024 }); }
    catch (e) { throw e.status === 413 ? Object.assign(new Error('file too large to edit here'), { status: 413 }) : e; }
    const { stat } = opened;
    const content = opened.buf.toString('utf8');
    return {
      path: abs, display: tilde(abs), kind: kindOf(abs),
      content, size: stat.size, mtime: stat.mtimeMs,
      lines: content.split('\n').length,
    };
  },

  'PUT /api/file': async (req) => {
    const { path: p, content, mtime } = await readBody(req);
    const abs = resolveSafe(p);
    if (typeof content !== 'string') throw Object.assign(new Error('content required'), { status: 400 });

    const stat = await fsp.stat(abs);
    // Refuse to clobber a change made outside the studio since this editor loaded.
    if (mtime && Math.abs(stat.mtimeMs - mtime) > 1) {
      throw Object.assign(
        new Error('This file changed on disk since you opened it. Reload before saving.'),
        { status: 409 }
      );
    }

    const kind = kindOf(abs);
    const check = validate(abs, content, kind);
    if (!check.ok) return { saved: false, ...check };

    assertNotHardLinked(abs);   // the write would refuse it; say so before reading it
    const before = readUserText(abs);
    if (before === content) {
      return { saved: false, unchanged: true, ...check };
    }

    // Capture whatever is on disk right now before replacing it, so there is
    // always a version to diff and restore against.
    await history.recordBaseline(abs, `state of ${tilde(abs)} before edit`).catch(() => {});

    assertWritable(abs);
    assertNotHardLinked(abs);
    await fsp.writeFile(abs, content, 'utf8');
    expectWrite(abs, 'changed', sha256Text(content));
    const after = await fsp.stat(abs);

    // The write succeeded; a history failure must not be reported as a failed
    // save, or the UI would claim the file is unchanged when it is not.
    let sha = null, historyError = null;
    try {
      sha = await history.record(abs, `edit ${tilde(abs)}`);
    } catch (e) {
      historyError = e.message;
    }
    return { saved: true, sha, historyError, mtime: after.mtimeMs, ...check };
  },

  'POST /api/validate': async (req) => {
    const { path: p, content } = await readBody(req);
    const abs = resolveSafe(p);
    return validate(abs, content ?? '', kindOf(abs));
  },

  'GET /api/history': async (_req, url) => {
    const abs = resolveSafe(url.searchParams.get('path'));
    return { commits: await history.logFor(abs) };
  },

  'GET /api/history/version': async (_req, url) => {
    const raw = url.searchParams.get('path');
    const abs = resolveSafe(raw);
    const sha = url.searchParams.get('sha');
    if (!/^[0-9a-f]{7,40}$/.test(sha || '')) throw Object.assign(new Error('bad sha'), { status: 400 });
    // A version is content too: never one recorded under a denied name, nor
    // for a path that is — by identity — a credential now.
    if (isDenied(String(raw)) || isDenied(abs) || isCredential(abs)) throw Object.assign(new Error('path is protected'), { status: 403 });
    return { content: await history.contentAt(abs, sha), sha };
  },

  'POST /api/history/restore': async (req) => {
    const { path: p, sha, mtime } = await readBody(req);
    const abs = resolveSafe(p);
    if (!/^[0-9a-f]{7,40}$/.test(sha || '')) throw Object.assign(new Error('bad sha'), { status: 400 });

    const stat = await fsp.stat(abs);
    if (mtime && Math.abs(stat.mtimeMs - mtime) > 1) {
      throw Object.assign(
        new Error('This file changed on disk since you opened it. Reload before restoring.'),
        { status: 409 }
      );
    }

    const content = await history.contentAt(abs, sha);
    // Preserve the current contents before overwriting, so a restore is itself
    // reversible even if the current version was never saved through the studio.
    await history.recordBaseline(abs, `state of ${tilde(abs)} before restore`).catch(() => {});

    assertWritable(abs);
    assertNotHardLinked(abs);
    await fsp.writeFile(abs, content, 'utf8');
    expectWrite(abs, 'changed', sha256Text(content));
    const after = await fsp.stat(abs);
    let newSha = null, historyError = null;
    try {
      newSha = await history.record(abs, `restore ${tilde(abs)} to ${sha.slice(0, 8)}`);
    } catch (e) {
      historyError = e.message;
    }
    return { restored: true, content, sha: newSha, historyError, mtime: after.mtimeMs };
  },

  'POST /api/snapshot': async () => history.snapshotAll('manual snapshot'),

  // `projects` runs the toolkit per registered project (zsh, git, gh), so it
  // takes the strict origin check a GET download does: a cross-site <img>
  // must not be able to set those off. `status=0` is the register form's
  // quick read; `project=<key>` narrows to one, validated against repos/.
  'GET /api/worktree': async (req, url) => {
    const out = { registered: worktree.listRegistered(), candidates: await worktree.listCandidates() };
    if (url.searchParams.get('status') === '0') return out;
    if (!strictSameOrigin(req)) throw bad('cross-origin requests are not accepted', 403);
    const one = url.searchParams.get('project');
    out.projects = one === null ? await worktree.allProjectStatus() : [await worktree.projectStatus(one)];
    return out;
  },
  // No repo named is a bad request — never a fallback to the server's own
  // checkout, which is where git would look with an empty path.
  'GET /api/worktree/bases': async (_req, url) => {
    const repo = url.searchParams.get('repo');
    if (!repo) throw bad('repo required', 400);
    return worktree.listBases(repo);
  },
  'POST /api/worktree/init': async (req) => {
    const body = await readBody(req);
    await worktree.refuseReadRoots(body);
    await worktree.refuseSymlinkedRepos(body);
    const r = await worktree.initProject(body);
    await history.snapshotAll(`register worktree project ${body.key}`);
    return r;
  },

  'POST /api/create': async (req) => mutate.create(await readBody(req)),
  'POST /api/create-file': async (req) => mutate.addFile(await readBody(req)),
  'POST /api/delete': async (req) => mutate.remove(await readBody(req)),
  'GET /api/trash': async () => ({ items: await mutate.listTrash() }),
  'POST /api/trash/restore': async (req) => mutate.restoreTrash(await readBody(req)),

  'GET /api/scope': async (_req, url) => {
    // No folder named and no edit folder registered: nothing to walk, and no
    // phantom default folder a stranger does not have.
    const dir = url.searchParams.get('dir') || currentRoots().editRoots[0];
    if (!dir) return { dir: null, display: null, chain: [] };
    const abs = resolveSafe(dir);
    return { dir: abs, display: tilde(abs), chain: scopeChain(abs) };
  },

  'GET /api/scope/dirs': async () => {
    // Candidate directories worth checking a scope chain for: every edit
    // folder and the two levels beneath it.
    const editRoots = currentRoots().editRoots;
    const out = new Set(editRoots);
    const walk = (root, depth) => {
      if (depth > 2) return;
      let ents;
      try { ents = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
        const d = path.join(root, e.name);
        out.add(d);
        walk(d, depth + 1);
      }
    };
    for (const r of editRoots) walk(r, 0);
    return { dirs: [...out].sort().map((d) => ({ path: d, display: tilde(d) })) };
  },

  'GET /api/search': async (_req, url) => {
    const q = (url.searchParams.get('q') || '').trim();
    if (q.length < 2) return { hits: [] };
    const needle = q.toLowerCase();
    const { groups } = buildRegistry();
    const safe = currentRoots().safeRoots;
    const hits = [];
    for (const g of groups) {
      for (const e of g.entries) {
        for (const f of e.files) {
          if (f.size > 1024 * 1024) continue;
          // Re-proved per file, as the editor would: a registry built a moment
          // ago is not a licence to read a path that has since become a link.
          let text;
          try {
            const abs = resolveSafe(f.path, safe);
            if (isDenied(abs)) continue;
            text = readUserText(abs, { maxBytes: 1024 * 1024 });
          } catch { continue; }
          const lines = text.split('\n');
          const matches = [];
          for (let i = 0; i < lines.length && matches.length < 4; i++) {
            if (lines[i].toLowerCase().includes(needle)) {
              matches.push({ line: i + 1, text: lines[i].trim().slice(0, 220) });
            }
          }
          if (matches.length) {
            hits.push({
              group: g.title, entryId: e.id, entryLabel: e.label,
              file: f.name, path: f.path, display: f.display,
              harness: e.harness, matches,
              total: lines.filter((l) => l.toLowerCase().includes(needle)).length,
            });
          }
        }
      }
    }
    hits.sort((a, b) => b.total - a.total);
    return { hits: hits.slice(0, 60), query: q };
  },

  'POST /api/assist': async (req) => {
    const body = await readBody(req);
    const { harness, model } = await resolveIncoming(body, { detectFn, sessions, checkSession: false });
    const abs = resolveSafe(body.path);
    return runAssistFn({
      action: body.action,
      instruction: body.instruction,
      filePath: abs,
      content: body.content ?? '',
      model,
      harness,
    });
  },
  };

/**
 * Streaming chat turn. Emits newline-delimited JSON so the browser can render
 * tokens as they arrive — a 100s wait behind a spinner reads as a hang.
 */
  async function handleChat(req, res) {
  let body;
  try { body = await readBody(req); }
  catch (e) { return json(res, e.status || 400, { error: e.message }); }

  let resolved;
  try { resolved = await resolveIncoming(body, { detectFn, sessions, checkSession: true }); }
  catch (e) { return json(res, e.status || 400, { error: e.message }); }

  let mentions;
  try { mentions = resolveMentions(body.mentions); }
  catch (e) { return json(res, e.status || 400, { error: e.message }); }

  const message = String(body.message || '').trim();
  if (!message) return json(res, 400, { error: 'message required' });

  res.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-cache',
    'x-accel-buffering': 'no',
  });
  const send = (obj) => { if (!res.writableEnded) res.write(JSON.stringify(obj) + '\n'); };

  const turn = streamTurnFn({
    message,
    mentions,
    sessionId: resolved.sessionId,
    seed: body.seed || null,
    model: resolved.model,
    cwd: mentions.length ? path.dirname(mentions[0]) : HOME,
    harness: resolved.harness,
  }, (text) => send({ t: 'delta', text }));

  // If the browser aborts, kill the child rather than leaving it running.
  req.on('close', () => { if (!res.writableEnded) turn.kill(); });

  try {
    const result = await turn.done;
    const text = result.text || '';
    const sessionId = result.sessionId ?? null;
    if (turnSucceeded(result) && sessionId) {
      rememberSession(sessions, sessionId, resolved.harness);
    }
    // Edits are only ever read from a turn that worked: a refused or failed
    // turn's text proposes nothing.
    const ok = turnSucceeded(result);
    const proposals = (ok ? parseEdits(text, mentions) : []).map((p) => {
      let mtime = null;
      try { mtime = p.path ? fs.statSync(p.path).mtimeMs : null; } catch {}
      return {
        path: p.path, display: p.display, kind: p.kind,
        error: p.error, edits: p.edits || 1, mtime,
        current: p.current, proposed: p.proposed,
      };
    });
    // The done event has to carry three things the browser cannot infer: the
    // reply itself (a streams:false harness sends no deltas, so this is the
    // only copy), whether the turn actually worked, and — only when it did —
    // the session id. A refused id must not be handed back for the client to
    // store and resume against.
    send({
      t: 'done',
      ok,
      text,
      sessionId: ok ? sessionId : null,
      error: ok ? null : ((result.err || '').slice(0, 400) ||
        `${resolved.harness} exited ${result.code ?? '?'} without a usable reply`),
      proposals, stats: result.stats, rateLimit: result.rateLimit,
    });
  } catch (e) {
    send({ t: 'error', message: e.message });
  }
  res.end();
  }

  const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // Local-only tool: refuse anything that did not originate from this machine.
  const host = (req.headers.host || '').split(':')[0];
  if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(host)) {
    res.writeHead(403).end('agent-config-studio only serves localhost');
    return;
  }

  // ...and refuse anything that did not originate from this PAGE.
  //
  // The Host check alone does not do that: a browser sets Host to localhost for
  // a cross-site request too, and readBody parses JSON whatever the
  // content-type, so any page the user has open could post here with no CORS
  // preflight. That was survivable when the routes only read files. It is not
  // now: these endpoints SIGTERM codex sessions, move a seat out of ~/.codex,
  // and append a source line to ~/.zshenv.
  if (req.method !== 'GET' && req.method !== 'HEAD' && !sameOriginRequest(req)) {
    res.writeHead(403).end('cross-origin requests are not accepted');
    return;
  }

  // These stream their own responses rather than returning a JSON body.
  if (req.method === 'POST' && url.pathname === '/api/chat') {
    return void handleChat(req, res);
  }
  if (req.method === 'GET' && url.pathname === '/api/events') {
    return void handleEvents(req, res);
  }
  if (req.method === 'GET' && url.pathname === '/api/skills/export') {
    return void handleSkillExport(req, res, url);
  }

  if (url.pathname.startsWith('/api/')) {
    const handler = ROUTES[`${req.method} ${url.pathname}`];
    if (!handler) return json(res, 404, { error: 'no such endpoint' });
    try {
      json(res, 200, await handler(req, url));
    } catch (e) {
      json(res, e.status || 500, { error: e.message });
    }
    return;
  }

  // Static files
  let rel = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = path.join(PUBLIC, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(PUBLIC)) return void res.writeHead(403).end('nope');
  try {
    const buf = await fsp.readFile(file);
    // no-store, not a validator. This is a local single-user app whose assets
    // are read off disk every request, so caching buys nothing — and with no
    // cache headers at all a browser applies its own heuristic freshness and
    // will serve a stale app.js indefinitely. That has already happened twice:
    // the panel kept rendering an old build while the API returned new data,
    // which reads as "the app is broken" and is nearly impossible to diagnose
    // from the UI. Correctness over a saved kilobyte.
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store, must-revalidate',
    });
    res.end(buf);
  } catch {
    res.writeHead(404).end('not found');
  }
  });
  // An idle keep-alive socket must outlive the client's own idle timeout, or
  // the server closes it just as the client reuses it. Node 20.0's fetch hits
  // exactly that against the 5 s default (ECONNRESET / "other side closed" on
  // the next request after a quiet spell). headersTimeout must stay above it.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  return { server, sessions, models };
}

/**
 * The startup banner's folder lines: the real roots, or how to add one. Never
 * a default folder a stranger does not have.
 */
function rootsBanner() {
  const r = currentRoots();
  const ignored = r.builtinInvalid.map((b) => `\n  ignored    ${b.name}: ${b.reason}`).join('');
  if (r.state === 'error') return `  folders    ${r.error} — no project folders active${ignored}`;
  const lines = r.roots.map((x) => `${x.access.padEnd(5)} ${tilde(x.path)}${x.status === 'missing' ? '  (missing)' : ''}${x.real && isPartial(x.real) ? '  (large folder — partially indexed)' : ''}`);
  if (!lines.length) return `  folders    no project folders yet — run: acs roots add <path>${ignored}`;
  return lines.map((l, i) => `  ${i ? '         ' : 'folders  '}  ${l}`).join('\n') + ignored;
}

/**
 * Start the studio as `acs` does: migration, history, watchers, the live
 * roots event, then listen. `app` reaches createApp — only an in-process
 * caller can pass it (the offline walkthrough's usage collector); launched
 * directly, it is always empty.
 */
export async function startStudio({ port = PORT, app = {} } = {}) {
  // First start writes roots.json (and the setup marker when it seeds the
  // legacy folders). An unreadable file is left alone and reported.
  try { migrateRoots(); } catch (e) { console.error(`roots.json: ${e.message}`); }
  await history.ensureRepo();
  // Catch up on anything edited outside the studio since last run, so the
  // history repo is an honest record rather than only of studio-made edits.
  await history.snapshotAll('external changes since last run').catch(() => {});

  let watcher = createWatcher(onFilesChanged);
  // roots.json changed: the derived lists already follow it, so re-aim the
  // file watchers at the new folders, diff the registry (revoked files go out
  // as such), then tell every tab to reload what it shows.
  // A large root's off-path walk finished: re-aim the watchers at what it
  // found and tell the tabs.
  onWalkDone(async () => {
    watcher.close();
    watcher = createWatcher(onFilesChanged);
    await onFilesChanged({ fromWalk: true }).catch(() => {});
  });
  const rootsWatch = watchRoots(async () => {
    watcher.close();
    // The rebuild first: it walks the new folders, and on Linux the watcher
    // is aimed at what that walk found (lib/watch.js).
    await onFilesChanged().catch(() => {});
    watcher = createWatcher(onFilesChanged);
    broadcast({ type: 'roots', ...rootsView() });
  });
  const { server, models } = createApp(app);
  // The login shell's PATH, once, so `acs` and the CLIs are judged against
  // what a new terminal would find. Recheck reads it again.
  refreshLoginDirs().catch(() => {});
  // Detection runs once at start (and on "Check now"); there is no timer.
  models.check().catch(() => {});

  let runIno = null;
  server.listen(port, '127.0.0.1', () => {
    try {
      const file = runFile(port);
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid, nonce: RUN_NONCE, server: fileURLToPath(import.meta.url) }) + '\n', { mode: 0o600 });
      fs.renameSync(tmp, file);
      runIno = fs.statSync(file).ino;
    } catch { /* without it, `acs stop` refuses rather than guesses */ }
    const { groups } = buildRegistry();
    const total = groups.reduce((n, g) => n + g.entries.reduce((m, e) => m + e.files.length, 0), 0);
    console.log(`
  Agent Config Studio
  ───────────────────────────────────────────────
  →  http://localhost:${port}

  tracking   ${total} files across ${groups.length} groups
  history    ${tilde(STUDIO_HOME)}/history
${rootsBanner()}
  watching   ${watcher.count} directories for live changes
`);
  });

  // Only this start's own run file is removed (same inode): a newer start may own it now.
  process.on('exit', () => {
    try { if (runIno !== null && fs.statSync(runFile(port)).ino === runIno) fs.unlinkSync(runFile(port)); } catch {}
  });
  const stop = () => {
    rootsWatch.close();
    watcher.close();
    console.log('\n  stopped.');
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return server;
}

if (launchedDirectly()) await startStudio();
