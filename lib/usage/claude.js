import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Reads subscription headroom for a Claude seat.
 *
 * Unlike Codex, Claude writes no quota state to disk — the only source is
 * `GET /api/oauth/usage` on api.anthropic.com, which is UNDOCUMENTED (found by
 * running `strings` on the CLI binary). Treat it as something that can vanish
 * without warning: every failure path here has to degrade to a stated reason,
 * never to a fabricated number.
 *
 * Nothing in this module logs, returns, or persists a token.
 */

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

/* ── credential sources ────────────────────────────────────────────────────
 * Ordered cheapest-and-most-local first. Each returns a token or null, and
 * never throws — a source that isn't applicable on this OS is a miss, not an
 * error. `env` exists so a packaged product can hand the engine a token the
 * user connected explicitly, without any credential-store access at all.
 */

/** macOS. The item is `Claude Code-credentials`; the suffixed variants hold only MCP OAuth. */
export function fromKeychain(service = 'Claude Code-credentials') {
  if (process.platform !== 'darwin') return null;
  try {
    const raw = execFileSync('security', ['find-generic-password', '-s', service, '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 });
    const oauth = JSON.parse(raw)?.claudeAiOauth;
    return oauth?.accessToken
      ? { token: oauth.accessToken, expiresAt: oauth.expiresAt ?? null,
          subscriptionType: oauth.subscriptionType ?? null, source: 'keychain' }
      : null;
  } catch { return null; }
}

/** Linux/Windows, and older macOS installs. Often present but stale — validated below. */
export function fromCredentialsFile(file = path.join(os.homedir(), '.claude', '.credentials.json')) {
  try {
    const oauth = JSON.parse(fs.readFileSync(file, 'utf8'))?.claudeAiOauth;
    return oauth?.accessToken
      ? { token: oauth.accessToken, expiresAt: oauth.expiresAt ?? null,
          subscriptionType: oauth.subscriptionType ?? null, source: 'credentials-file' }
      : null;
  } catch { return null; }
}

/** An explicitly connected token. The only source that needs no credential-store access. */
export function fromEnv(varName = 'ACS_CLAUDE_TOKEN') {
  const t = process.env[varName];
  return t ? { token: t, expiresAt: null, subscriptionType: null, source: 'env' } : null;
}

export const DEFAULT_SOURCES = [fromEnv, fromKeychain, fromCredentialsFile];

/**
 * First source that yields a credential that is not already expired.
 *
 * Expiry is checked because a stale file WILL be found before a live keychain
 * entry on a machine that has both — this one does, and its file's token was
 * revoked three months ago while Claude Code kept working.
 */
export function resolveCredential(sources = DEFAULT_SOURCES, now = Date.now()) {
  const tried = [];
  for (const src of sources) {
    const cred = src();
    if (!cred) { tried.push(`${src.name}: none`); continue; }
    if (cred.expiresAt && cred.expiresAt <= now) {
      tried.push(`${cred.source}: expired ${new Date(cred.expiresAt).toISOString()}`);
      continue;
    }
    return { cred, tried };
  }
  return { cred: null, tried };
}

/* ── response shaping ──────────────────────────────────────────────────────
 * Read `limits[]`, never the top-level keys. Those carry rotating internal
 * codenames (`tangelo`, `iguana_necktie`, `nimbus_quill`, `omelette`) whose
 * meaning is opaque and unstable; `limits[]` is self-describing.
 */

export function labelForLimit(limit) {
  const model = limit?.scope?.model?.display_name;
  const surface = limit?.scope?.surface;
  switch (limit?.kind) {
    case 'session':       return 'Current session (5h)';
    case 'weekly_all':    return 'Weekly (all models)';
    case 'weekly_scoped': return `Weekly (${model || surface || 'scoped'})`;
    default:              return limit?.kind ? `${limit.kind}${model ? ` (${model})` : ''}` : 'Unknown limit';
  }
}

/** Raw `/api/oauth/usage` body -> the tracker's shared window shape. */
export function shapeUsage(body) {
  const limits = Array.isArray(body?.limits) ? body.limits : [];
  const windows = limits
    .filter((l) => Number.isFinite(Number(l?.percent)))
    .map((l) => ({
      label: labelForLimit(l),
      usedPercent: Number(l.percent),
      resetsAt: l.resets_at ? Date.parse(l.resets_at) : null,
      windowMinutes: l.kind === 'session' ? 300 : l.group === 'weekly' ? 10080 : null,
      // Passed through rather than re-derived: the server knows about boosts and
      // promotional ceilings that a raw percentage does not express.
      severity: l.severity ?? null,
      isActive: l.is_active === true,
      kind: l.kind ?? null,
    }));

  const spend = body?.spend;
  return {
    windows,
    // Extra usage is a separate pool from the subscription, so it is reported
    // beside the windows rather than folded into them.
    extraUsage: body?.extra_usage
      ? {
          enabled: body.extra_usage.is_enabled === true,
          usedCredits: body.extra_usage.used_credits ?? null,
          monthlyLimit: body.extra_usage.monthly_limit ?? null,
          utilization: body.extra_usage.utilization ?? null,
          currency: body.extra_usage.currency ?? null,
        }
      : null,
    spend: spend?.limit
      ? {
          usedMinor: spend.used?.amount_minor ?? null,
          limitMinor: spend.limit?.amount_minor ?? null,
          currency: spend.limit?.currency ?? null,
          exponent: spend.limit?.exponent ?? 2,
          percent: spend.percent ?? null,
          enabled: spend.enabled === true,
        }
      : null,
  };
}

/**
 * Live headroom for one Claude seat.
 *
 * `fetchImpl` is injectable so the shaping can be tested without a network call
 * or a real credential.
 */
export async function readClaudeUsage({
  sources = DEFAULT_SOURCES, fetchImpl = fetch, timeoutMs = 10_000, now = Date.now(),
} = {}) {
  const base = { vendor: 'claude', windows: [], observedAt: null };

  const { cred, tried } = resolveCredential(sources, now);
  if (!cred) {
    return { ...base, ok: false, reason: `no usable Claude credential (${tried.join('; ') || 'no sources'})` };
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(USAGE_URL, {
      headers: { authorization: `Bearer ${cred.token}`, accept: 'application/json' },
      signal: ac.signal,
    });
  } catch (e) {
    // The message can quote request state; never let a token reach a log line.
    return { ...base, ok: false, credentialSource: cred.source,
             reason: `usage request failed: ${redact(String(e?.message || e), cred.token)}` };
  } finally { clearTimeout(timer); }

  if (res.status === 401 || res.status === 403) {
    return { ...base, ok: false, credentialSource: cred.source,
             reason: `credential rejected (HTTP ${res.status}) — run \`claude\` once to refresh it` };
  }
  if (!res.ok) {
    return { ...base, ok: false, credentialSource: cred.source,
             reason: `usage endpoint returned HTTP ${res.status}` };
  }

  let body;
  try { body = await res.json(); }
  catch { return { ...base, ok: false, credentialSource: cred.source, reason: 'usage endpoint returned non-JSON' }; }

  const shaped = shapeUsage(body);
  if (shaped.windows.length === 0) {
    // A 200 with no limits[] is the shape changing under us — say so rather
    // than rendering an empty gauge that reads as "nothing used".
    return { ...base, ok: false, credentialSource: cred.source,
             reason: 'usage endpoint returned no recognisable limits — the undocumented shape may have changed' };
  }

  return {
    ...base, ok: true,
    credentialSource: cred.source,
    subscriptionType: cred.subscriptionType,
    ...shaped,
    observedAt: now,
    source: USAGE_URL,
  };
}

const redact = (text, token) => (token ? text.split(token).join('<token>') : text);
