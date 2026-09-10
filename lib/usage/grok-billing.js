import { spawn } from 'node:child_process';
import { findBinary } from '../harness.js';
import { numericPercent } from './percent.js';

/**
 * Grok's weekly subscription quota.
 *
 * xAI publishes no quota on disk, but the CLI knows one: `/usage show` calls
 * the JSON-RPC method `_x.ai/billing` over the agent protocol, which returns
 * `creditUsagePercent` plus the current weekly period. That is the same shape
 * as Codex's rate_limits and Claude's limits[], so a Grok seat can carry a real
 * gauge rather than activity alone.
 *
 * WHY THIS MAY SPAWN A HARNESS BINARY. tests/guards.mjs otherwise bans that
 * outside lib/harness.js, because an uncontained spawn could run a model turn
 * that writes files. This one cannot:
 *   - argv is pinned to ['agent','stdio'] — no prompt, no model, no tool flags;
 *   - the ONLY requests written are `initialize` and `_x.ai/billing`. No
 *     session is created and no prompt is ever sent, so no turn can run;
 *   - the binary is the detected absolute real path, past wrapper shims;
 *   - the child is killed as soon as the reply arrives.
 * The guard enforces the binary and the argv statically.
 *
 * This needs the user's Grok credentials, which the CLI holds and this module
 * never reads — so it runs in the acs-usage CLI, not in the studio process.
 */

const TIMEOUT_MS = 20_000;

/** Weekly quota for a Grok seat, or null with a reason. */
export function readGrokBilling({ grokHome, timeoutMs = TIMEOUT_MS } = {}) {
  const found = findBinary('grok');
  if (!found.installed) return Promise.resolve({ ok: false, reason: 'the grok CLI is not installed' });

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(found.binary, ['agent', 'stdio'], {
        stdio: ['pipe', 'pipe', 'ignore'],
        env: grokHome ? { ...process.env, GROK_HOME: grokHome } : process.env,
      });
    } catch (e) {
      return resolve({ ok: false, reason: `could not start the grok agent: ${e.message}` });
    }

    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill('SIGKILL'); } catch {}
      resolve(value);
    };
    const timer = setTimeout(
      () => finish({ ok: false, reason: `the grok agent did not answer within ${timeoutMs}ms` }), timeoutMs);

    let buf = '';
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1 && msg.result) {
          write({ jsonrpc: '2.0', id: 2, method: '_x.ai/billing', params: {} });
        } else if (msg.id === 2) {
          if (msg.error) finish({ ok: false, reason: `_x.ai/billing: ${msg.error.message}` });
          else finish(shapeBilling(msg.result));
        }
      }
    });
    const write = (o) => { try { child.stdin.write(JSON.stringify(o) + '\n'); } catch { /* handled below */ } };
    // A stream error arrives asynchronously, so the try/catch around write()
    // never sees it. Unhandled, an EPIPE here takes down the whole usage CLI
    // and no seat gets persisted — one vendor being unreachable must only cost
    // that vendor's reading.
    child.stdin.on('error', (e) => finish({ ok: false, reason: `grok agent stdin failed: ${e.message}` }));
    child.on('error', (e) => finish({ ok: false, reason: `grok agent failed: ${e.message}` }));
    child.on('close', () => finish({ ok: false, reason: 'the grok agent exited before answering' }));

    write({ jsonrpc: '2.0', id: 1, method: 'initialize',
            params: { protocolVersion: 1, clientCapabilities: {} } });
  });
}

/** `_x.ai/billing` -> the tracker's shared window shape. */
export function shapeBilling(result) {
  const cfg = result?.config;
  if (!cfg) return { ok: false, reason: '_x.ai/billing returned no config' };

  const used = numericPercent(cfg.creditUsagePercent);
  if (used === null) {
    return { ok: false, reason: '_x.ai/billing returned no usable creditUsagePercent' };
  }

  const end = Date.parse(cfg.currentPeriod?.end ?? cfg.billingPeriodEnd ?? '');
  const start = Date.parse(cfg.currentPeriod?.start ?? cfg.billingPeriodStart ?? '');
  const weekly = cfg.currentPeriod?.type === 'USAGE_PERIOD_TYPE_WEEKLY';

  return {
    ok: true,
    tier: result.subscription_tier ?? null,
    windows: [{
      label: weekly ? 'Weekly' : 'Current period',
      usedPercent: used,
      resetsAt: Number.isFinite(end) ? end : null,
      windowMinutes: weekly ? 10080
        : (Number.isFinite(end) && Number.isFinite(start) ? Math.round((end - start) / 60000) : null),
    }],
    prepaidBalance: cfg.prepaidBalance?.val ?? null,
    onDemandUsed: cfg.onDemandUsed?.val ?? null,
    onDemandCap: cfg.onDemandCap?.val ?? null,
  };
}
