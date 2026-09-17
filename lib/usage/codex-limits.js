import { spawn } from 'node:child_process';
import { findBinary } from '../harness.js';
import { numericPercent } from './percent.js';
// One labelling rule for both sources. A second copy here would drift the
// moment either reply shape changes, and the two would disagree about the same
// window on the same seat.
import { labelForWindow } from './codex.js';

/**
 * A Codex seat's LIVE subscription quota, asked of the service.
 *
 * Rollout logs (codex.js) only record quota as a side effect of a turn, so a
 * seat you have not used in an hour reports an hour-old number and a seat you
 * have never used reports nothing at all. That is not a staleness bug to be
 * tuned — it is a ceiling: re-reading those files can never produce a fresher
 * reading than the last turn, so "Refresh" could never actually refresh, and a
 * panel that cannot answer "how much do I have left right now" is not a gauge.
 *
 * `codex app-server` speaks JSON-RPC and answers `account/rateLimits/read`
 * with the account's current windows. No turn runs and no quota is spent, so
 * this is free to call and is the primary source; the logs become the fallback
 * for when the CLI cannot answer.
 *
 * WHY THIS MAY SPAWN A HARNESS BINARY. tests/guards.mjs otherwise bans that
 * outside lib/harness.js, because an uncontained spawn could run a model turn
 * that writes files. This one cannot, by exactly the argument grok-billing.js
 * makes for `grok agent stdio`:
 *   - argv is pinned to ['app-server'] — no prompt, no exec, no model, no
 *     tool flags, and nothing caller-supplied ever reaches it;
 *   - the ONLY requests written are `initialize` and `account/rateLimits/read`.
 *     No thread is started and no prompt is ever sent, so no turn can run;
 *   - the binary is the detected absolute real path, past wrapper shims;
 *   - the child is killed as soon as the reply arrives.
 * The guard enforces the binary, the argv and the method list statically.
 *
 * This needs the seat's credentials, which the CLI holds and this module never
 * reads — so it runs in the acs-usage CLI, not in the studio process. The seat
 * is selected the only way Codex allows: by CODEX_HOME on the child.
 */

const TIMEOUT_MS = 20_000;

// The two methods this module may send are written as LITERALS at every use.
// A constant would read the same to a person and be invisible to the static
// guard, which is what keeps a third method from ever being added quietly.

export function readCodexLimits({ codexHome, timeoutMs = TIMEOUT_MS } = {}) {
  const found = findBinary('codex');
  if (!found.installed) return Promise.resolve({ ok: false, reason: 'the codex CLI is not installed' });

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(found.binary, ['app-server'], {
        stdio: ['pipe', 'pipe', 'ignore'],
        // CODEX_HOME is how a seat is chosen; without it every seat would
        // report the default home's account and two seats would look alike.
        env: codexHome ? { ...process.env, CODEX_HOME: codexHome } : process.env,
      });
    } catch (e) {
      return resolve({ ok: false, reason: `could not start the codex app-server: ${e.message}` });
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
      () => finish({ ok: false, reason: `the codex app-server did not answer within ${timeoutMs}ms` }),
      timeoutMs);

    const write = (o) => { try { child.stdin.write(JSON.stringify(o) + '\n'); } catch { /* see stdin error */ } };

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
        if (msg.id === 1) {
          if (msg.error) return finish({ ok: false, reason: `initialize: ${msg.error.message}` });
          write({ jsonrpc: '2.0', id: 2, method: 'account/rateLimits/read', params: {} });
        } else if (msg.id === 2) {
          if (msg.error) finish({ ok: false, reason: `account/rateLimits/read: ${msg.error.message}` });
          else finish(shapeLimits(msg.result));
        }
      }
    });
    // A stream error arrives asynchronously, so the try/catch around write()
    // never sees it. Unhandled, an EPIPE here takes down the whole usage CLI
    // and no seat gets persisted — one seat being unreachable must only cost
    // that seat's reading.
    child.stdin.on('error', (e) => finish({ ok: false, reason: `codex app-server stdin failed: ${e.message}` }));
    child.on('error', (e) => finish({ ok: false, reason: `codex app-server failed: ${e.message}` }));
    child.on('exit', () => finish({ ok: false, reason: 'the codex app-server exited before answering' }));

    write({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { clientInfo: { name: 'agent-config-studio', title: 'Agent Config Studio', version: '1' } },
    });
  });
}

/** One `{primary|secondary}` entry -> the tracker's shared window shape. */
function toWindow(raw, labelFor) {
  if (!raw || typeof raw !== 'object') return null;
  // Number(null) is 0, and a 0 here reads as "plenty left" — the exact opposite
  // of "we do not know". An absent or non-numeric percent is not a window.
  const used = numericPercent(raw.usedPercent);
  if (used === null) return null;
  const minutes = Number(raw.windowDurationMins);
  return {
    label: labelFor(minutes),
    usedPercent: used,
    windowMinutes: Number.isFinite(minutes) ? minutes : null,
    // The protocol reports resetsAt in epoch SECONDS, as the rollouts do.
    resetsAt: Number.isFinite(Number(raw.resetsAt)) ? Number(raw.resetsAt) * 1000 : null,
  };
}

/**
 * The protocol's reply -> the tracker's shape.
 *
 * Window labels come from the duration, never from the primary/secondary key:
 * those keys have already swapped meaning once (see codex.js), and this reply
 * shows the same instability — a prolite account returns its weekly in
 * `primary` with `secondary` null, while a team account returns the 5h window
 * in `primary`. Keying on position would mislabel one of them.
 */
export function shapeLimits(result) {
  const label = labelForWindow;
  const rl = result?.rateLimits;
  if (!rl || typeof rl !== 'object') {
    return { ok: false, reason: 'the codex app-server returned no rate limits for this seat' };
  }
  const windows = [toWindow(rl.primary, label), toWindow(rl.secondary, label)].filter(Boolean);
  if (windows.length === 0) {
    return { ok: false, reason: 'the codex app-server reported no usable quota window for this seat' };
  }
  // Two windows of the same length are one window reported twice.
  const seen = new Set();
  const unique = windows.filter((w) => {
    const k = `${w.windowMinutes}:${w.resetsAt}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return {
    ok: true,
    planType: rl.planType ?? null,
    // Carried so a seat can be told apart from another seat's account without
    // any module opening auth.json.
    accountId: typeof result.accountId === 'string' ? result.accountId : null,
    windows: unique.sort((a, b) => (a.windowMinutes ?? 0) - (b.windowMinutes ?? 0)),
    credits: rl.credits
      ? {
          hasCredits: rl.credits.has_credits === true || rl.credits.hasCredits === true,
          unlimited: rl.credits.unlimited === true,
          balance: rl.credits.balance ?? null,
        }
      : null,
  };
}
