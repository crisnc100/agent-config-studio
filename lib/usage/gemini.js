import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { locateBinary } from '../harness.js';
import { EFFORTS, ID_RE, vendorOf } from '../models.js';
import { numericPercent } from './percent.js';

/**
 * A Gemini seat's subscription quota, and the Gemini models it offers, read
 * through the Antigravity CLI (agy).
 *
 * `agy -p /usage --output-format json` answers from print mode without starting
 * an agent turn: no model call, no quota spent, no conversation left behind
 * (agy changelog 1.1.11; probed on 1.5.13, builds/gemini-usage/plan.md). agy
 * signs itself in from the keychain, so this module never sees a credential;
 * like Grok's, the reading is taken by the acs-usage CLI and the studio renders
 * the snapshot. `agy --output-format json models` lists the models the same
 * way, with zero turns (builds/gemini-models/plan.md); the Models panel's
 * "Check now" asks for it.
 *
 * WHY THIS MAY SPAWN A HARNESS BINARY. tests/guards.mjs otherwise bans that
 * outside lib/harness.js, because an uncontained spawn could run a model turn.
 * This one cannot:
 *   - argv is pinned to ['--version'], ['-p','/usage','--output-format','json']
 *     or ['--output-format','json','models'], nothing caller-supplied ever
 *     reaches it;
 *   - the /usage call only runs on an agy at or above MIN_VERSION. Below it,
 *     print mode sent "/usage" to the model as a prompt — a real turn. The
 *     models call only runs at or above MODELS_MIN_VERSION;
 *   - a reply is accepted only when agy says it answered the command asked for
 *     with zero turns and status SUCCESS, so a future agy that changed this
 *     shows as an error, never as a reading;
 *   - each call runs in a fresh empty folder (agy loads workspace hooks, MCP
 *     servers and agents from the folder it starts in and every one above),
 *     with stdin closed and cmux's agy hooks switched off, and is killed at
 *     the deadline, or sooner when the studio stops (stopAgyCalls);
 *   - agy's self-updater is off for the call (AGY_CLI_DISABLE_AUTO_UPDATE,
 *     honoured only as "true"): ask-model and the review gate run agy only at
 *     the version its containment was probed on, and a usage refresh that
 *     installed a newer one would stop every Gemini call until it is re-probed;
 *   - the binary is the detected absolute real path, past the cmux wrapper.
 * The guard enforces the binary, every call whole (nothing appended to the argv),
 * the options and the temp folder statically.
 */

// For the two agy calls of one reading together: the usage CLI is itself killed at 30 s (lib/usage/refresh.js), and a
// slow agy must cost only this seat's reading, never the whole snapshot; "Check now" on Models waits for the models
// reading. The probe's two calls took about 2 s.
const TIMEOUT_MS = 20_000;
export const MIN_VERSION = [1, 1, 11];
// `models` prints JSON from 1.1.12 on. The floor is also the only guard against an agy that lacks the subcommand:
// what such an agy would make of a bare `models` word (an interactive prompt?) was never probed, because finding
// out could run a turn. Every agy from 1.1.12 on has it.
export const MODELS_MIN_VERSION = [1, 1, 12];

/** `1.5.13` (or a line containing it) → [1, 5, 13]; null when there is no version in it. */
export function parseVersion(text) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(text ?? ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function versionAtLeast(v, min = MIN_VERSION) {
  if (!v) return false;
  for (let i = 0; i < 3; i++) if (v[i] !== min[i]) return v[i] > min[i];
  return true;
}

const WINDOW_MINUTES = { '5h': 300, weekly: 10080 };
const WINDOW_LABEL = { '5h': '5-hour', weekly: 'Weekly' };

const GEMINI_GROUP = 'Gemini Models';
// Matched by family name alone: ACS source carries no versioned model name (tests/models.mjs), and agy names this
// group after the model's version.
const ARGON_GROUP = /\bargon\b/i;

/** One agy bucket → the tracker's shared window shape, or null when it cannot be read. */
function toWindow(b, label) {
  const left = numericPercent(b?.remaining_fraction);
  if (left === null || left < 0 || left > 1) return null;
  const reset = Date.parse(b.reset_time ?? '');
  return {
    label,
    // Unrounded: Pause picks the tightest window by comparing these, and two windows that round alike can still
    // differ. Every display rounds on its own.
    usedPercent: (1 - left) * 100,
    resetsAt: Number.isFinite(reset) ? reset : null,
    windowMinutes: WINDOW_MINUTES[b.window] ?? null,
  };
}

/**
 * agy's `/usage` JSON → windows for the seat.
 *
 * `windows` is the Gemini Models pool only: that is what a pause of the gemini
 * account covers and what its reset is timed from. Argon has its own weekly
 * limit on Pro plans and is carried separately, shown without a gauge. The
 * "Claude and GPT models" group is dropped: those models are never run through
 * Antigravity here, so their limits would only add rows nothing pauses.
 */
export function shapeUsage(json) {
  if (!json || typeof json !== 'object') return { ok: false, reason: 'agy /usage returned no JSON' };
  if (json.command?.name !== 'usage' || json.num_turns !== 0) {
    return { ok: false, reason: 'agy did not answer /usage as a command (it may have run a model turn), so its reply was not used' };
  }
  const groups = Array.isArray(json.command?.data?.groups) ? json.command.data.groups : [];
  const gemini = groups.find((g) => g?.name === GEMINI_GROUP);
  const windows = (Array.isArray(gemini?.buckets) ? gemini.buckets : [])
    .filter((b) => WINDOW_MINUTES[b?.window])
    .map((b) => toWindow(b, WINDOW_LABEL[b.window]))
    .filter(Boolean)
    .sort((a, b) => a.windowMinutes - b.windowMinutes);
  if (windows.length === 0) return { ok: false, reason: `agy /usage reported no readable ${GEMINI_GROUP} limits` };

  const argonGroup = groups.find((g) => g?.name !== GEMINI_GROUP && ARGON_GROUP.test(String(g?.name ?? '')));
  const argonBucket = (Array.isArray(argonGroup?.buckets) ? argonGroup.buckets : []).find((b) => b?.window === 'weekly');
  const argon = argonBucket ? toWindow(argonBucket, 'Argon weekly') : null;
  return { ok: true, windows, extraWindows: argon ? [argon] : [] };
}

const EFFORT_ORDER = [...EFFORTS];
const EFFORT_SUFFIX = new RegExp(`-(${EFFORT_ORDER.join('|')})$`);
const MAX_MODELS = 200;

/** "<name> (High)" → "<name>" when the parenthesis names this id's effort; any other label is kept whole. */
function modelName(label, effort) {
  const text = label.slice(0, 200);
  const m = / \(([^()]*)\)$/.exec(text);
  return m && effort && m[1].toLowerCase() === effort ? text.slice(0, m.index) : text;
}

/**
 * agy's `models` JSON → one entry per Gemini model: `{ id, displayName, efforts }`.
 *
 * agy lists a model once per effort (`<base>-high`, labelled "<name> (High)"). The registry holds the base id and
 * passes effort on its own (agy takes a base id since 1.3.4), so a model's variants are one entry here, or a family
 * on the base id would look gone from the list. Other vendors' ids are dropped: Claude and GPT models are never run
 * through Antigravity.
 */
export function shapeModels(json) {
  if (!json || typeof json !== 'object') return { ok: false, reason: 'agy models returned no JSON' };
  if (json.command?.name !== 'models' || json.num_turns !== 0) {
    return { ok: false, reason: 'agy did not answer models as a command (it may have run a model turn), so its reply was not used' };
  }
  const list = json.command?.data?.models;
  if (!Array.isArray(list)) return { ok: false, reason: 'agy models returned no model list' };
  const byId = new Map();
  for (const m of list) {
    const raw = m?.id;
    if (typeof raw !== 'string' || !ID_RE.test(raw) || vendorOf(raw) !== 'agy') continue;
    const effort = EFFORT_SUFFIX.exec(raw)?.[1] ?? null;
    const id = effort ? raw.slice(0, -(effort.length + 1)) : raw;
    if (vendorOf(id) !== 'agy' || id.endsWith('-')) continue;
    let entry = byId.get(id);
    if (!entry) {
      if (byId.size >= MAX_MODELS) continue;
      entry = { id, displayName: null, efforts: [] };
      byId.set(id, entry);
    }
    if (effort && !entry.efforts.includes(effort)) entry.efforts.push(effort);
    if (entry.displayName === null && typeof m.label === 'string') entry.displayName = modelName(m.label, effort);
  }
  const models = [...byId.values()].map((e) => ({ ...e, efforts: EFFORT_ORDER.filter((x) => e.efforts.includes(x)) }));
  if (!models.length) return { ok: false, reason: 'agy listed no Gemini models' };
  return { ok: true, models };
}

const API_KEY_REASON = 'agy is signed in with an API key, which has no subscription quota — sign in with your Google account in agy';

/** Why a reply without status "SUCCESS" was not used: a missing, empty or non-string status says so as well. */
const statusReason = (what, status) => (typeof status === 'string' && status
  ? `agy ${what} reported ${status.slice(0, 80)}`
  : `agy ${what} reported no SUCCESS status`);

// The calls in flight. Their deadline and folder removal live in this process, and the studio's stop re-raises its
// signal without letting either run (server.js), so it ends these first.
const LIVE = new Set();

/** End every agy call in flight now: SIGKILL, its folder removed, its promise settled. Synchronous, for a stop handler. */
export function stopAgyCalls() {
  for (const end of [...LIVE]) end();
}

/**
 * Run one pinned agy call in a fresh empty folder; resolves { code, stdout } or { error }.
 * `which` picks the argv, each written as a literal for the guard.
 */
function runAgy(found, which, timeoutMs) {
  return new Promise((resolve) => {
    let dir = null;
    let child;
    const cleanup = () => { if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} dir = null; } };
    try {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acs-agy-usage-'));
      const opts = { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, CMUX_ANTIGRAVITY_HOOKS_DISABLED: '1', AGY_CLI_DISABLE_AUTO_UPDATE: 'true' } };
      if (which === 'version') child = spawn(found.binary, ['--version'], opts);
      else if (which === 'usage') child = spawn(found.binary, ['-p', '/usage', '--output-format', 'json'], opts);
      else if (which === 'models') child = spawn(found.binary, ['--output-format', 'json', 'models'], opts);
      else throw new Error(`no pinned agy call named ${which}`);
    } catch (e) {
      cleanup();
      return resolve({ error: `could not start agy: ${e.message}` });
    }
    let settled = false;
    const stopped = () => finish({ error: 'agy was stopped: the studio is shutting down' });
    const finish = (v) => {
      if (settled) return;
      settled = true;
      LIVE.delete(stopped);
      clearTimeout(timer);
      try { child.kill('SIGKILL'); } catch {}
      cleanup();
      resolve(v);
    };
    LIVE.add(stopped);
    const timer = setTimeout(() => finish({ error: `agy did not answer within ${Math.round(timeoutMs / 1000)}s` }), timeoutMs);
    const MAX = 4 << 20;
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      out += d;
      if (out.length > MAX) finish({ error: 'agy printed more than expected' });
    });
    child.on('error', (e) => finish({ error: `agy failed: ${e.message}` }));
    child.on('close', (code, signal) => finish(signal && code === null ? { error: `agy was killed by ${signal}` } : { code, stdout: out }));
  });
}

/** agy's first `--version` line, its parsed version and how to show it; or `failure`, why it could not be read. */
async function readAgyVersion(found, timeoutMs) {
  const ver = await runAgy(found, 'version', timeoutMs);
  if (ver.error || ver.code !== 0) return { failure: ver.error ?? `exit ${ver.code}` };
  const line = String(ver.stdout).trim().split('\n')[0] || null;
  const version = parseVersion(line);
  return { line, version, shown: version ? version.join('.') : line };
}

/**
 * The Gemini quota as the seat reports it. Never throws; every failure is ok:false with a reason, and
 * `agyVersion` is set whenever agy reported one.
 */
export async function readGeminiSeat({ timeoutMs = TIMEOUT_MS, found = locateBinary('agy'), now = Date.now } = {}) {
  const base = { vendor: 'gemini', harness: 'agy', windows: [], extraWindows: [], observedAt: null, agyVersion: null };
  if (!found?.installed) return { ...base, ok: false, reason: 'the Antigravity CLI (agy) is not installed' };

  const deadline = Date.now() + timeoutMs;
  const ver = await readAgyVersion(found, timeoutMs);
  if (ver.failure) return { ...base, ok: false, reason: `could not read agy's version (${ver.failure}), so agy /usage was not run` };
  const withVersion = { ...base, agyVersion: ver.shown };
  if (!versionAtLeast(ver.version)) {
    return { ...withVersion, ok: false,
             reason: `agy ${ver.line ?? '(unknown version)'} is older than ${MIN_VERSION.join('.')}, where /usage would run as a model prompt — update agy (agy update)` };
  }

  const left = deadline - Date.now();
  if (left <= 0) return { ...withVersion, ok: false, reason: `agy did not answer within ${Math.round(timeoutMs / 1000)}s` };
  const r = await runAgy(found, 'usage', left);
  if (r.error) return { ...withVersion, ok: false, reason: r.error };
  if (r.code === 2) return { ...withVersion, ok: false, reason: API_KEY_REASON };
  if (r.code !== 0) return { ...withVersion, ok: false, reason: `agy /usage exited ${r.code} — if agy is signed out, run \`agy\` and sign in` };

  let json;
  try { json = JSON.parse(r.stdout); } catch { return { ...withVersion, ok: false, reason: 'agy /usage did not print JSON' }; }
  if (json?.status !== 'SUCCESS') return { ...withVersion, ok: false, reason: statusReason('/usage', json?.status) };
  const shaped = shapeUsage(json);
  if (!shaped.ok) return { ...withVersion, ok: false, reason: shaped.reason };
  return { ...withVersion, ok: true, windows: shaped.windows, extraWindows: shaped.extraWindows, observedAt: now(), reason: null };
}

/**
 * The Gemini models agy offers its current sign-in, for the Models panel's "Check now". Never throws; every failure
 * is ok:false with a reason, and `agyVersion` is set whenever agy reported one.
 */
export async function readGeminiModels({ timeoutMs = TIMEOUT_MS, found = locateBinary('agy') } = {}) {
  const base = { models: [], agyVersion: null };
  if (!found?.installed) return { ...base, ok: false, reason: 'the Antigravity CLI (agy) is not installed' };

  const deadline = Date.now() + timeoutMs;
  const ver = await readAgyVersion(found, timeoutMs);
  if (ver.failure) return { ...base, ok: false, reason: `could not read agy's version (${ver.failure}), so agy models was not run` };
  const withVersion = { ...base, agyVersion: ver.shown };
  if (!versionAtLeast(ver.version, MODELS_MIN_VERSION)) {
    return { ...withVersion, ok: false,
             reason: `agy ${ver.line ?? '(unknown version)'} is older than ${MODELS_MIN_VERSION.join('.')}, the first that lists its models as JSON — update agy (agy update)` };
  }

  const left = deadline - Date.now();
  if (left <= 0) return { ...withVersion, ok: false, reason: `agy did not answer within ${Math.round(timeoutMs / 1000)}s` };
  const r = await runAgy(found, 'models', left);
  if (r.error) return { ...withVersion, ok: false, reason: r.error };
  if (r.code !== 0) return { ...withVersion, ok: false, reason: `agy models exited ${r.code} — if agy is signed out, run \`agy\` and sign in` };

  let json;
  try { json = JSON.parse(r.stdout); } catch { return { ...withVersion, ok: false, reason: 'agy models did not print JSON' }; }
  if (json?.status !== 'SUCCESS') return { ...withVersion, ok: false, reason: statusReason('models', json?.status) };
  const shaped = shapeModels(json);
  if (!shaped.ok) return { ...withVersion, ok: false, reason: shaped.reason };
  return { ...withVersion, ok: true, models: shaped.models, reason: null };
}
