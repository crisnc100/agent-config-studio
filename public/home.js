/* Agent Config Studio — what Home says, decided from each route's answer */

/**
 * Pure, and loaded before app.js, so tests/home.mjs runs it in a VM exactly as
 * the browser does. app.js fetches and paints; everything here turns route
 * answers into what a card states — and never states a number a route did not
 * give.
 *
 * A source is { state: 'loading' | 'ok' | 'error', data, error }.
 */

/** An HTTP 200 carrying `error` is a failure too: Usage reports some that way. */
function homeSource(data) {
  if (data && typeof data === 'object' && typeof data.error === 'string' && data.error) {
    return { state: 'error', error: data.error, data };
  }
  return { state: 'ok', data };
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const ATTENTION_SOURCES = [
  ['models', 'Models'],
  ['memory', 'Memory'],
  ['worktrees', 'Worktrees'],
  ['context', 'Context'],
];

/** Model alerts, one line each, from /api/models (not the registry's bare count). */
function modelItems(m) {
  const out = [];
  for (const r of m.rows || []) {
    for (const a of (r.alerts || []).filter((x) => !x.dismissed)) {
      const text = a.kind === 'update' ? `${r.family}: a newer id is available${a.candidate ? ` — ${a.candidate}` : ''}`
        : a.kind === 'retiring' ? `${r.family} is retiring${a.date ? ` on ${new Date(a.date).toLocaleDateString()}` : ''}`
        : `${r.family} is no longer offered by its CLI`;
      out.push({ source: 'models', kind: a.kind === 'update' ? 'info' : 'warn', text, action: { view: 'models', label: 'Review' } });
    }
  }
  return out;
}

/** Memory cleanups waiting, a count per kind. */
function memoryItems(d) {
  const f = d.findings || {};
  const kinds = [
    [f.emptySlugs, (n) => `${plural(n, 'empty project folder')} to clear`],
    [f.dangling, (n) => `${plural(n, 'index link')} to a missing file`],
    [f.unindexed, (n) => `${plural(n, 'memory file')} missing from ${n === 1 ? 'its' : 'their'} index`],
    [f.oversized, (n) => `${plural(n, 'memory index', 'memory indexes')} over the length the harness reads`],
  ];
  return kinds.filter(([list]) => list?.length).map(([list, text]) => ({
    source: 'memory', kind: 'warn', text: text(list.length), action: { view: 'memory', label: 'Clean up', tab: 'cleanups' },
  }));
}

/**
 * Finished worktrees per project. A project whose status could not be read is
 * not "nothing finished": it is reported, and it keeps the empty state away.
 */
function worktreeItems(d) {
  const items = [];
  const unknown = [];
  for (const p of d.projects || []) {
    if (p.status !== 'ok') { unknown.push(p.key); continue; }
    const done = (p.worktrees || []).filter((w) => !w.trunk && w.verdict?.status === 'done').length;
    if (done) {
      items.push({ source: 'worktrees', kind: 'info', text: `${p.key}: ${plural(done, 'finished worktree')} ready to remove`,
        action: { view: 'worktrees', label: 'Show' } });
    }
  }
  return { items, unknown };
}

function contextItems(d) {
  const n = d.totals?.drifted || 0;
  return n ? [{ source: 'context', kind: 'warn', text: `${plural(n, 'context file')} drifted from trunk`, action: { view: 'context', label: 'Compare' } }] : [];
}

/**
 * The Needs-attention card. "Nothing needs you" is allowed only when every
 * source answered and none had anything — a failed or pending source is
 * silence, not good news.
 */
function attentionModel(sources) {
  const items = [];
  const loading = [];
  const failed = [];
  const partial = [];
  for (const [id, label] of ATTENTION_SOURCES) {
    const s = sources[id] || { state: 'loading' };
    if (s.state === 'loading') { loading.push({ id, label }); continue; }
    if (s.state === 'error') { failed.push({ id, label, error: s.error }); continue; }
    if (id === 'models') items.push(...modelItems(s.data));
    else if (id === 'memory') items.push(...memoryItems(s.data));
    else if (id === 'context') items.push(...contextItems(s.data));
    else if (id === 'worktrees') {
      const w = worktreeItems(s.data);
      items.push(...w.items);
      if (w.unknown.length) partial.push({ id, label, text: `status unknown for ${w.unknown.join(', ')}` });
    }
  }
  const clear = !items.length && !loading.length && !failed.length && !partial.length;
  return { items, loading, failed, partial, clear };
}

/** The Accounts & usage card: the configured seats, ranked and labelled as Usage does. */
function accountsModel(usage) {
  const ranked = rankSeats(usage.seats);
  const route = routeSeat(ranked);
  const rows = ranked.map((s) => {
    const st = seatState(s);
    return {
      id: s.seatId,
      label: s.label,
      meta: [s.vendor, s.planType, s.subscriptionType].filter(Boolean).join(' · '),
      state: st,
      windows: s.ok ? (s.windows || []).map((w) => ({ label: w.label, left: Math.round(windowLeft(w)), level: pressure(windowLeft(w)), resetsAt: w.resetsAt || null })) : [],
      reason: s.ok ? null : (s.reason || null),
      stale: !!(s.ok && s.stale),
      observedAt: s.observedAt || null,
      connect: seatConnect(s),
    };
  });
  return { route, rows };
}

/**
 * The CLIs card. Only what the server detected, and only the fields it
 * returns: version and sign-in are not in the harness payload, so they read
 * "unknown" — never inferred from a binary being there. Codex has no Assist
 * detector; its health is its Usage seats.
 */
function cliModel(harnesses, usage) {
  const rows = (harnesses?.harnesses || []).map((h) => ({
    id: h.id, label: h.label, detected: true, version: null, signedIn: null,
    note: `${plural((h.models || []).length, 'model')} offered to Assist`,
  }));
  let codex;
  if (!usage || usage.state === 'loading') codex = { state: 'loading' };
  else if (usage.state === 'error') codex = { state: 'error', error: usage.error };
  else {
    const seats = (usage.data.seats || []).filter((s) => s.vendor === 'codex');
    const reading = seats.filter((s) => s.ok).length;
    const signIn = seats.filter((s) => ['offline', 'duplicate'].includes(seatState(s).kind)).length;
    codex = { state: 'ok', seats: seats.length, reading, signIn };
  }
  return { rows, codex };
}

/** The Recent card: trash entries and the last history summary — no edit feed exists. */
function recentModel(trash, history, max = 4) {
  const items = (trash?.items || []).slice(0, max).map((it) => ({
    id: it.id, display: it.display, deletedAt: it.deletedAt, isDir: !!it.isDir, restorable: !!it.restorable,
  }));
  return {
    trash: items,
    more: Math.max(0, (trash?.items || []).length - items.length),
    last: history && history.commits ? { subject: history.lastSubject || '', at: history.lastAt || null, commits: history.commits } : null,
  };
}
