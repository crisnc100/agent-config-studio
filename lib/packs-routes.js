/**
 * The Packs card's server half (builds/skill-packs P3): what server.js's
 * /api/packs routes return, over lib/packs.js. Nothing here decides what an
 * install, update or uninstall does — every plan, apply and status is
 * lib/packs.js's, the same code `acs packs` runs.
 *
 * Status (the Codex trust check starts `codex app-server` per home) and apply
 * (the installers it runs block on their children) run in a worker thread,
 * so the studio keeps answering while they work. Status is a job the page
 * polls; a run already going is joined rather than started twice.
 */
import crypto from 'node:crypto';
import { Worker } from 'node:worker_threads';
import {
  PREVIEW_SYMBOL, PREVIEW_WHAT, STATUS, apply, explainOf, hasSkill, legacyReviewGate, loadCatalog, machine,
  planInstall, planSignature, planUninstall, planUpdate, requirements, status,
} from './packs.js';
import { readState } from './packs-files.js';
import { loadRoles } from './roles.js';

const HARNESSES = [['claude', 'Claude Code'], ['codex', 'Codex'], ['grok', 'Grok']];
const ACTIONS = ['install', 'update', 'uninstall'];
/** The fields each action takes besides `action` and `pack`; anything else is a 400. */
const FIELDS = { install: ['parts', 'harnesses', 'withDeps', 'fixRoles', 'setRoles'], update: ['replace'], uninstall: ['parts'] };
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

const tilde = (m, p) => (typeof p === 'string' && (p === m.home || p.startsWith(`${m.home}/`)) ? `~${p.slice(m.home.length)}` : p);
const tildeText = (m, s) => String(s ?? '').split(`${m.home}/`).join('~/');

/* ── the catalog ─────────────────────────────────────────────────────── */

/** Every pack with its explanations, requirements and installed parts, and which harnesses are here. */
export function catalogView(m = machine()) {
  const catalog = loadCatalog();
  const state = readState(m.statePath);
  const satisfiedPacks = new Set(catalog.filter((p) => hasSkill(state, p.id, p)).map((p) => p.id));
  return {
    packs: catalog.map((pack) => {
      const st = state.packs[pack.id];
      return {
        id: pack.id, title: pack.title, version: pack.version, summary: pack.summary, explain: pack.explain,
        requires: { packs: pack.requires?.packs || [] },
        parts: pack.parts.map((part) => ({
          id: part.id, title: part.title, default: !!part.default, kind: part.kind, harnesses: part.harnesses, explain: explainOf(pack, part),
        })),
        requirements: requirements(pack, m, { satisfiedPacks }).map((r) => ({ id: r.id, ok: r.ok, what: tildeText(m, r.what), fix: r.fix, dep: r.dep || null })),
        installed: st ? {
          version: st.version,
          parts: Object.fromEntries(Object.entries(st.parts).map(([id, rec]) => [id, { harnesses: rec.harnesses || [], installedAt: rec.installedAt || null }])),
        } : null,
      };
    }),
    harnesses: HARNESSES.map(([id, label]) => ({
      id, label, present: !!m.present[id], cli: !!m.clis[id], home: tilde(m, m.homes[id]),
      why: m.present[id] ? null : `no ${id} CLI on PATH and no ${tilde(m, m.homes[id])}`,
    })),
    legacy: legacyReviewGate(m).map((p) => tilde(m, p)),
    words: { status: STATUS, symbol: PREVIEW_SYMBOL, what: PREVIEW_WHAT },
  };
}

/* ── a plan request ──────────────────────────────────────────────────── */

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
function list(body, name, allowed, what) {
  const v = body[name];
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length > 32 || v.some((x) => typeof x !== 'string')) throw bad(`${name} must be a list of ${what} names`);
  for (const x of v) if (!allowed.includes(x)) throw bad(`unknown ${what} "${x.slice(0, 64)}" (${what}s: ${allowed.join(', ')})`);
  return [...new Set(v)];
}
function flag(body, name) {
  const v = body[name];
  if (v !== undefined && typeof v !== 'boolean') throw bad(`${name} must be true or false`);
  return v === true;
}

/**
 * A plan (or apply) request, checked against the catalog: the action, a
 * pack the catalog has, its parts, the harnesses ACS knows, and roles and
 * families ACS's roles know. Anything else is a 400 — a typo is never
 * dropped silently into a different preview.
 */
export function parseRequest(body, { apply: forApply = false, m = machine() } = {}) {
  if (!isObj(body)) throw bad('the request body must be a JSON object');
  const { action } = body;
  if (!ACTIONS.includes(action)) throw bad(`action must be one of ${ACTIONS.join(', ')}`);
  const allowed = new Set(['action', 'pack', ...FIELDS[action], ...(forApply ? ['signature'] : [])]);
  for (const k of Object.keys(body)) if (!allowed.has(k)) throw bad(`unknown field "${k.slice(0, 64)}" for ${action}`);
  const catalog = loadCatalog();
  if (typeof body.pack !== 'string') throw bad('pack must be a pack name');
  const pack = catalog.find((p) => p.id === body.pack);
  if (!pack) throw bad(`unknown pack "${body.pack.slice(0, 64)}" (packs: ${catalog.map((p) => p.id).join(', ')})`);
  const opts = {};
  if (action === 'install' || action === 'uninstall') {
    const parts = list(body, 'parts', pack.parts.map((p) => p.id), 'part');
    if (parts) opts.parts = parts;
  }
  if (action === 'install') {
    const harnesses = list(body, 'harnesses', HARNESSES.map(([id]) => id), 'harness');
    if (harnesses) {
      if (!harnesses.length) throw bad('harnesses, when given, must name at least one harness');
      opts.harnesses = harnesses;
    }
    if (flag(body, 'withDeps')) opts.withDeps = true;
    if (flag(body, 'fixRoles')) opts.fixRoles = true;
    if (body.setRoles !== undefined) {
      if (!isObj(body.setRoles)) throw bad('setRoles must map a role to a list of families');
      const loaded = loadRoles({ home: m.home });
      if (loaded.error) throw bad(`your ACS roles cannot be read: ${loaded.error}`);
      const setRoles = {};
      for (const [role, fams] of Object.entries(body.setRoles)) {
        if (!Object.hasOwn(loaded.roles, role)) throw bad(`unknown role "${role.slice(0, 64)}" (roles: ${Object.keys(loaded.roles).join(', ')})`);
        const use = list({ use: fams }, 'use', loaded.families, 'family');
        if (!use?.length) throw bad(`setRoles.${role} must name at least one family`);
        setRoles[role] = use;
      }
      if (Object.keys(setRoles).length) opts.setRoles = setRoles;
    }
  }
  if (action === 'update' && flag(body, 'replace')) opts.replace = true;
  let signature = null;
  if (forApply) {
    if (typeof body.signature !== 'string' || !/^[0-9a-f]{64}$/.test(body.signature)) throw bad('signature must be the preview\'s signature (preview first)');
    signature = body.signature;
  }
  return { action, pack: pack.id, opts, signature };
}

/** The plan a request names: lib/packs.js's own planner for its action. */
export function buildPlan(req, m = machine()) {
  if (req.action === 'install') return planInstall(req.pack, { ...req.opts }, m);
  if (req.action === 'update') return planUpdate([req.pack], { ...req.opts }, m);
  return planUninstall(req.pack, { ...req.opts }, m);
}

/** The plan as the page shows it: the CLI's preview rows and words, paths from ~, and the signature apply needs back. */
export function planView(plan, m = machine()) {
  return {
    action: plan.action,
    packs: plan.packs,
    units: plan.units.map((u) => ({ key: u.key, pack: u.pack, part: u.part, kind: u.kind, title: u.title || null, harnesses: u.harnesses || [], dependency: !!u.dependency })),
    preview: plan.preview.map((r) => ({
      ...(r.setting ? { setting: tildeText(m, r.setting) } : { path: tilde(m, r.path) }),
      action: r.action || null, symbol: r.setting ? '~' : PREVIEW_SYMBOL[r.action] || '?', what: r.setting ? null : PREVIEW_WHAT[r.action] || r.action,
      note: r.note ? tildeText(m, r.note) : null, unit: r.unit || null,
    })),
    requirements: plan.requirements.map((r) => ({ id: r.id, ok: r.ok, what: tildeText(m, r.what), fix: r.fix, pack: r.pack, dep: r.dep || null })),
    refusals: plan.refusals.map((s) => tildeText(m, s)),
    warnings: plan.warnings.map((s) => tildeText(m, s)),
    notes: plan.notes.map((s) => tildeText(m, s)),
    kept: (plan.kept || []).map((k) => ({ path: tilde(m, k.path), why: tildeText(m, k.why) })),
    roles: (plan.roles || []).map((r) => ({ role: r.role, use: r.use, missing: !!r.missing, suggestion: r.suggestion, set: r.set || null })),
    changes: plan.ops.length > 0,
    signature: planSignature(plan),
  };
}

/* ── apply and status, off the event loop ────────────────────────────── */

/**
 * Apply the request the page previewed (in the worker): re-plan, refuse
 * unless it is still exactly that preview, then lib/packs.js apply, which
 * re-plans and compares once more inside the state lock.
 */
export async function applyRequest(req, { m = machine(), log = () => {} } = {}) {
  const plan = buildPlan(req, m);
  if (plan.refusals.length) throw bad(plan.refusals.map((s) => tildeText(m, s)).join('\n'), 409);
  if (planSignature(plan) !== req.signature) throw bad('what this would change is different from the preview you saw (another install ran, or a file changed) — preview it again', 409);
  try {
    const r = await apply(plan, { m, log: (s) => log(tildeText(m, s)) });
    return {
      action: plan.action, packs: plan.packs, units: plan.units.map((u) => u.key),
      backupDir: r.backupDir ? tilde(m, r.backupDir) : null,
      kept: r.kept.map((k) => ({ path: tilde(m, k.path), why: tildeText(m, k.why) })),
      notes: plan.notes.map((s) => tildeText(m, s)), warnings: plan.warnings.map((s) => tildeText(m, s)),
    };
  } catch (e) { throw bad(tildeText(m, e.message), e.status || 500); }
}

/** `acs packs status`, as rows the page reads. */
export async function statusRequest({ trust = true, onProgress = () => {}, m = machine() } = {}) {
  const r = await status({ m, trust, onProgress: (s) => onProgress(tildeText(m, s)) });
  return {
    trust,
    legacy: r.legacy,
    runtime: r.runtime,
    packs: r.packs.map((p) => ({
      id: p.id, title: p.title, version: p.version, installedVersion: p.installedVersion,
      parts: p.parts.map((x) => ({
        id: x.id, kind: x.kind, statuses: x.statuses, details: x.details.map((d) => tildeText(m, d)), harnesses: x.harnesses,
        harness: x.harness || null, notGated: (x.notGated || []).map((p2) => tilde(m, p2)),
      })),
    })),
  };
}

const JOB = new URL('./packs-job.js', import.meta.url);

/** One worker run: progress lines as they come, then its result or its error. */
function runJob(data, onProgress = () => {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn, v) => { if (!settled) { settled = true; fn(v); } };
    const w = new Worker(JOB, { workerData: data });
    w.on('message', (msg) => {
      if (msg.t === 'progress') onProgress(msg.message);
      else if (msg.t === 'done') settle(resolve, msg.result);
      else if (msg.t === 'error') settle(reject, Object.assign(new Error(msg.message), { status: msg.status || 500, payload: msg.log?.length ? { log: msg.log } : undefined }));
    });
    w.on('error', (e) => settle(reject, Object.assign(new Error(`the packs worker failed: ${e.message}`), { status: 500 })));
    w.on('exit', (code) => settle(reject, Object.assign(new Error(`the packs worker stopped (exit ${code}) before it answered`), { status: 500 })));
  });
}

/** Applies finished so far: a status job started before one is not joined after it. */
let applied = 0;

/** Apply in the worker, after the same checks on this thread so a stale preview is a quick 409. */
export async function applyJob(req, m = machine()) {
  const plan = buildPlan(req, m);
  if (plan.refusals.length) throw bad(plan.refusals.map((s) => tildeText(m, s)).join('\n'), 409);
  if (planSignature(plan) !== req.signature) throw bad('what this would change is different from the preview you saw (another install ran, or a file changed) — preview it again', 409);
  try { return await runJob({ kind: 'apply', req }); }
  finally { applied++; }
}

const jobs = new Map();
const KEEP_MS = 10 * 60_000;

/** A status job's state, as the page polls it. */
const jobView = (j) => ({
  id: j.id, trust: j.trust, running: j.running, startedAt: j.startedAt, finishedAt: j.finishedAt,
  elapsedMs: (j.finishedAt ?? Date.now()) - j.startedAt, progress: j.progress, result: j.result, error: j.error,
});

/** Start a status job, or join the one already running with the same trust setting and no apply since. */
export function startStatus({ trust = true } = {}) {
  const now = Date.now();
  for (const [id, j] of jobs) if (!j.running && now - j.finishedAt > KEEP_MS) jobs.delete(id);
  const live = [...jobs.values()].find((j) => j.running && j.trust === trust && j.applied === applied);
  if (live) return jobView(live);
  const j = { id: crypto.randomBytes(8).toString('hex'), trust, applied, running: true, startedAt: now, finishedAt: null, progress: [], result: null, error: null };
  jobs.set(j.id, j);
  j.progress.push({ at: now, message: trust ? 'reading what is installed, then checking each part (with the Codex trust check)…' : 'reading what is installed, then checking each part (no Codex trust check)…' });
  runJob({ kind: 'status', trust }, (message) => j.progress.push({ at: Date.now(), message }))
    .then((result) => { j.result = { ...result, checkedAt: new Date().toISOString() }; }, (e) => { j.error = e.message; })
    .finally(() => { j.running = false; j.finishedAt = Date.now(); });
  return jobView(j);
}

/** A status job by id, or a 404. */
export function statusJob(id) {
  const j = typeof id === 'string' ? jobs.get(id) : null;
  if (!j) throw bad('no such status check — start one with GET /api/packs/status', 404);
  return jobView(j);
}

