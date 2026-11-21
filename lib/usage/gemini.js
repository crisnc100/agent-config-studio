import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { locateBinary } from '../harness.js';
import { numericPercent } from './percent.js';

/**
 * A Gemini seat's subscription quota, read through the Antigravity CLI (agy).
 *
 * `agy -p /usage --output-format json` answers from print mode without starting
 * an agent turn: no model call, no quota spent, no conversation left behind
 * (agy changelog 1.1.11; probed on 1.5.13, builds/gemini-usage/plan.md). agy
 * signs itself in from the keychain, so this module never sees a credential;
 * like Grok's, the reading is taken by the acs-usage CLI and the studio renders
 * the snapshot.
 *
 * WHY THIS MAY SPAWN A HARNESS BINARY. tests/guards.mjs otherwise bans that
 * outside lib/harness.js, because an uncontained spawn could run a model turn.
 * This one cannot:
 *   - argv is pinned to ['--version'] or ['-p','/usage','--output-format','json'],
 *     nothing caller-supplied ever reaches it;
 *   - the /usage call only runs on an agy at or above MIN_VERSION. Below it,
 *     print mode sent "/usage" to the model as a prompt — a real turn;
 *   - a reply is accepted only when agy says it answered the `usage` command
 *     with zero turns, so a future agy that changed this shows as an error,
 *     never as a reading;
 *   - each call runs in a fresh empty folder (agy loads workspace hooks, MCP
 *     servers and agents from the folder it starts in and every one above),
 *     with stdin closed and cmux's agy hooks switched off, and is killed at
 *     the deadline;
 *   - the binary is the detected absolute real path, past the cmux wrapper.
 * The guard enforces the binary, both calls whole (nothing appended to the argv),
 * the options and the temp folder statically.
 */

// For both agy calls together: the usage CLI is itself killed at 30 s (lib/usage/refresh.js), and a slow agy must
// cost only this seat's reading, never the whole snapshot. The probe's two calls took about 2 s.
const TIMEOUT_MS = 20_000;
export const MIN_VERSION = [1, 1, 11];

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

const API_KEY_REASON = 'agy is signed in with an API key, which has no subscription quota — sign in with your Google account in agy';

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
      const opts = { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, CMUX_ANTIGRAVITY_HOOKS_DISABLED: '1' } };
      child = which === 'version'
        ? spawn(found.binary, ['--version'], opts)
        : spawn(found.binary, ['-p', '/usage', '--output-format', 'json'], opts);
    } catch (e) {
      cleanup();
      return resolve({ error: `could not start agy: ${e.message}` });
    }
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill('SIGKILL'); } catch {}
      cleanup();
      resolve(v);
    };
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

/**
 * The Gemini quota as the seat reports it. Never throws; every failure is ok:false with a reason, and
 * `agyVersion` is set whenever agy reported one.
 */
export async function readGeminiSeat({ timeoutMs = TIMEOUT_MS, found = locateBinary('agy'), now = Date.now } = {}) {
  const base = { vendor: 'gemini', harness: 'agy', windows: [], extraWindows: [], observedAt: null, agyVersion: null };
  if (!found?.installed) return { ...base, ok: false, reason: 'the Antigravity CLI (agy) is not installed' };

  const deadline = Date.now() + timeoutMs;
  const ver = await runAgy(found, 'version', timeoutMs);
  if (ver.error || ver.code !== 0) {
    return { ...base, ok: false, reason: `could not read agy's version (${ver.error ?? `exit ${ver.code}`}), so agy /usage was not run` };
  }
  const versionLine = String(ver.stdout).trim().split('\n')[0] || null;
  const version = parseVersion(versionLine);
  const withVersion = { ...base, agyVersion: version ? version.join('.') : versionLine };
  if (!versionAtLeast(version)) {
    return { ...withVersion, ok: false,
             reason: `agy ${versionLine ?? '(unknown version)'} is older than ${MIN_VERSION.join('.')}, where /usage would run as a model prompt — update agy (agy update)` };
  }

  const left = deadline - Date.now();
  if (left <= 0) return { ...withVersion, ok: false, reason: `agy did not answer within ${Math.round(timeoutMs / 1000)}s` };
  const r = await runAgy(found, 'usage', left);
  if (r.error) return { ...withVersion, ok: false, reason: r.error };
  if (r.code === 2) return { ...withVersion, ok: false, reason: API_KEY_REASON };
  if (r.code !== 0) return { ...withVersion, ok: false, reason: `agy /usage exited ${r.code} — if agy is signed out, run \`agy\` and sign in` };

  let json;
  try { json = JSON.parse(r.stdout); } catch { return { ...withVersion, ok: false, reason: 'agy /usage did not print JSON' }; }
  if (json?.status && json.status !== 'SUCCESS') {
    return { ...withVersion, ok: false, reason: `agy /usage reported ${String(json.status).slice(0, 80)}` };
  }
  const shaped = shapeUsage(json);
  if (!shaped.ok) return { ...withVersion, ok: false, reason: shaped.reason };
  return { ...withVersion, ok: true, windows: shaped.windows, extraWindows: shaped.extraWindows, observedAt: now(), reason: null };
}
