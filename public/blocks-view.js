/* Agent Config Studio — the Shared rules view: each shared rule, every copy of it in your instruction files and skills, and a word-by-word comparison (lib/blocks.js) */

/**
 * Loaded before app.js, which owns the helpers this calls (el, api,
 * renderMarkdown, renderSidebar…). Reading is GET /api/blocks alone; Compare
 * works from the data already read. The one write is making one copy match:
 * a preview the person reads, then apply with the preview's signature
 * (tests/blocks-ui.mjs pins those three calls).
 *
 * Ratings come from the server and measure wording (shared word pairs), never
 * meaning, so no label here may claim two copies mean the same thing.
 */
/** match: the one copy being made to match ({ key, rule, copy, busy, preview, error, stale }); matched: the last apply's result. */
const BB = { data: null, error: null, loading: false, rule: null, match: null, matched: null };
const BB_LABEL = { same: 'Matches', reworded: 'Small changes', differs: 'Big changes' };
const BB_ORDER = { differs: 0, reworded: 1, same: 2 };
const BB_NOTE = {
  'the whole block is there, with more added': 'The whole rule is here, inside longer text.',
  'edited after it was added': 'Changed by hand after it was pasted in.',
  'an older version of the block': 'Pasted from an older version of the rule.',
};
const BB_GROUPS = [
  { id: 'look', title: 'Needs a look', sub: 'At least one copy is quite different from the reference: it may leave part of the rule out, add other rules, or sit inside a longer paragraph.',
    empty: 'Nothing needs a look. Every copy matches or has only small wording changes.' },
  { id: 'small', title: 'Small wording changes', sub: 'Every copy is close to the reference, with a few words changed. Check that the meaning held.',
    empty: 'No rule has small wording changes right now.' },
  { id: 'match', title: 'Match everywhere', sub: 'Every copy is word for word the same.', empty: 'No rule matches word for word everywhere yet.' },
  // No empty line: this group shows only when some rule is in it.
  { id: 'none', title: 'Not in your files', sub: 'The studio has these rules, but none of your files carries a copy.' },
];
const BB_CLI = { claude: 'Claude', codex: 'Codex', grok: 'Grok' };
const BB_COMPARE_HASH = '#blocks/compare';

const bbPlural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const bbMine = (b) => b.copies.filter((c) => !c.pack);
const bbWorstFirst = (copies) => [...copies].sort((x, y) => BB_ORDER[x.rating] - BB_ORDER[y.rating]);

/** A rule's group is set by its worst copy outside the studio's packs; pack copies never move it. */
function bbGroup(b) {
  const mine = bbMine(b);
  if (!mine.length) return 'none';
  if (mine.some((c) => c.rating === 'differs')) return 'look';
  if (mine.some((c) => c.rating === 'reworded')) return 'small';
  return 'match';
}

/** "3 of 12 copies match", counted over your copies only. */
function bbCounts(b) {
  const mine = bbMine(b);
  if (!mine.length) return 'Not found in any of your files.';
  const m = mine.filter((c) => c.rating === 'same').length;
  // "1 of 7 copies matches", "0 of 1 copy matches", "2 of 5 copies match": singular when either number is one.
  return `${m} of ${bbPlural(mine.length, 'copy', 'copies')} ${m === 1 || mine.length === 1 ? 'matches' : 'match'}`;
}

function bbStatus(d) {
  const n = { look: 0, small: 0, match: 0, none: 0 };
  for (const b of d.blocks) n[bbGroup(b)]++;
  const parts = [
    `${bbPlural(n.look, 'rule')} ${n.look === 1 ? 'needs' : 'need'} a look`,
    `${n.small} ${n.small === 1 ? 'has' : 'have'} small wording changes`,
    `${n.match} ${n.match === 1 ? 'matches' : 'match'} everywhere`,
  ];
  if (n.none) parts.push(`${n.none} not in your files`);
  parts.push(`checked ${bbPlural(d.scanned.files, 'file')}`);
  return parts.join(' · ');
}

const bbCli = (id) => BB_CLI[id] || (id ? id[0].toUpperCase() + id.slice(1) : '');

/** Where a copy lives, in words: "CLAUDE.md (Claude, global) · line 168", "SKILL.md in the build skill (Claude) · lines 75–79". */
function bbPlace(c) {
  const name = c.file.split('/').pop();
  // A project's skill folder could be any CLI's: name the project, never guess the CLI.
  const who = c.source === 'project' ? `${c.project || 'a'} project` : c.source === 'shared' ? 'shared skills folder' : bbCli(c.source);
  const what = c.kind === 'instructions' ? `${name} (${who}, global)` : c.skill ? `${name} in the ${c.skill} skill (${who})` : `${name} (${who})`;
  const at = c.endLine > c.line ? `lines ${c.line}–${c.endLine}` : `line ${c.line}`;
  return `${what} · ${at}`;
}

/** How many of this rule's copies share a file with `c`. */
const bbRepeats = (copies, c) => copies.filter((x) => x.file === c.file).length;
const bbRepeatWords = (n) => (n === 2 ? 'Appears twice in this file' : `Appears ${n} times in this file`);

function bbCopyHead(row, c, copies) {
  row.appendChild(el('span', `bb-rating bb-rating-${c.rating}`, BB_LABEL[c.rating]));
  const where = el('div', 'bb-loc');
  where.appendChild(el('div', 'bb-place', bbPlace(c)));
  where.appendChild(el('code', 'bb-path', c.file));
  row.appendChild(where);
  const n = bbRepeats(copies, c);
  if (n > 1) row.appendChild(el('span', 'bb-flag', bbRepeatWords(n)));
  if (c.note) row.appendChild(el('span', 'bb-note', BB_NOTE[c.note] || c.note));
}

function bbPacksLine(b) {
  const n = b.copies.length - bbMine(b).length;
  return n ? el('p', 'bb-packs', `Also in the studio's own packs: ${bbPlural(n, 'copy', 'copies')} (you don't need to change these).`) : null;
}

/** The share of the summary's word pairs that the text already says: a summary that only repeats the text is cut. */
function bbRepeatsText(summary, text) {
  const pairs = (s) => {
    const w = s.toLowerCase().replace(/['’]/g, '').match(/[\p{L}\p{N}]+/gu) || [];
    return new Set(w.slice(1).map((x, i) => `${w[i]} ${x}`));
  };
  const a = pairs(summary), b = pairs(text);
  if (!a.size) return false;
  let shared = 0;
  for (const x of a) if (b.has(x)) shared++;
  // Measured on the shipped rules: a summary that says its text again scored 0.80; shorter restatements 0.13–0.63.
  return shared / a.size >= 0.75;
}

function bbCard(b) {
  const group = bbGroup(b);
  const card = el('section', 'bb-card');
  card.id = `bb-${b.id}`;
  card.appendChild(el('h4', 'bb-name', b.name));
  card.appendChild(el('p', 'bb-counts', bbCounts(b)));
  if (b.summary && !bbRepeatsText(b.summary, b.text)) card.appendChild(el('p', 'bb-summary', b.summary));
  card.appendChild(el('div', 'bb-label', 'Reference version'));
  const text = el('div', 'bb-text md');
  text.innerHTML = renderMarkdown(b.text);
  card.appendChild(text);
  const mine = bbMine(b);
  if (mine.length) {
    const list = el('ul', 'bb-copies');
    for (const c of bbWorstFirst(mine)) {
      const row = el('li', `bb-copy bb-${c.rating}`);
      bbCopyHead(row, c, mine);
      list.appendChild(row);
    }
    card.appendChild(list);
  }
  const packs = bbPacksLine(b);
  if (packs) card.appendChild(packs);
  if (group === 'look' || group === 'small') {
    const cmp = el('button', group === 'look' ? 'btn primary' : 'btn', 'Compare copies');
    cmp.onclick = () => bbCompare(b.id);
    const row = el('div', 'bb-actions');
    row.appendChild(cmp);
    card.appendChild(row);
  }
  return card;
}

/* ── loading and the list ─────────────────────────────────────────────── */
async function openBlocks() {
  if (!confirmDiscard()) return;
  // Back from Compare shows the rules already read; arriving from elsewhere reads them again.
  const fresh = S.view !== 'blocks-compare' || !BB.data;
  S.view = 'blocks';
  leaveEditor();
  window.history.replaceState(null, '', '#blocks');
  renderSidebar(); renderTopbar(); renderTabs(); renderStatus();
  $('filebar').hidden = true;
  if (!fresh) {
    const from = BB.rule;
    BB.rule = null;
    paintBlocks();
    const btn = from ? document.getElementById(`bb-${from}`)?.querySelector('.bb-actions .btn') : null;
    if (btn) { btn.scrollIntoView?.({ block: 'center' }); btn.focus(); }
    return;
  }
  if (!BB.data) $('content').innerHTML = '<div class="scope"><div class="scope-sub"><span class="spinner"></span> Reading your instruction files and skills…</div></div>';
  await bbLoad();
}

async function bbLoad() {
  BB.loading = true;
  bbPaint();
  try { BB.data = await api('GET', '/api/blocks'); BB.error = null; }
  catch (e) { BB.error = e.message; }
  BB.loading = false;
  bbPaint();
}

const bbPaint = () => { if (S.view === 'blocks') paintBlocks(); else if (S.view === 'blocks-compare') paintCompare(); };

function bbFailed(box) {
  const n = el('div', 'notice error');
  n.setAttribute('role', 'alert');
  n.appendChild(el('div', null, `The shared rules could not be read: ${BB.error}`));
  const retry = el('button', 'btn', 'Try again');
  retry.onclick = () => bbLoad();
  n.appendChild(retry);
  box.appendChild(n);
}

function paintBlocks() {
  if (S.view !== 'blocks') return;
  const c = $('content');
  if (!BB.data && !BB.error) return;
  c.innerHTML = '';
  const box = el('div', 'scope bb');
  box.appendChild(pageHeading('Shared rules'));
  box.appendChild(el('p', 'scope-sub bb-intro', 'Some rules appear in more than one of your instruction files and skills. The studio keeps one reference version of each and checks every file for it. When copies drift apart, your agents follow different versions of the same rule, depending on which file they read.'));
  if (BB.error && !BB.data) { bbFailed(box); c.appendChild(box); return; }
  const d = BB.data;
  const bar = el('div', 'bb-bar');
  bar.appendChild(el('span', 'bb-total', bbStatus(d)));
  const again = el('button', 'btn ghost', BB.loading ? 'Checking…' : 'Check again');
  again.disabled = BB.loading;
  again.onclick = () => bbLoad();
  bar.appendChild(again);
  box.appendChild(bar);
  if (BB.error) box.appendChild(el('div', 'notice error', `The last check failed: ${BB.error}`));
  if (d.scanned.unreadable.length) box.appendChild(el('p', 'bb-unreadable', `Could not read ${bbPlural(d.scanned.unreadable.length, 'file')}: ${d.scanned.unreadable.join(', ')}`));
  if (!d.blocks.length) box.appendChild(el('p', 'bb-empty', 'No shared rules yet.'));
  for (const g of BB_GROUPS) {
    const rules = d.blocks.filter((b) => bbGroup(b) === g.id);
    if (!rules.length && !g.empty) continue;
    const sec = el('section', `bb-group bb-group-${g.id}`);
    sec.appendChild(el('h3', 'bb-group-title', g.title));
    sec.appendChild(el('p', 'bb-group-sub', g.sub));
    if (!rules.length) sec.appendChild(el('p', 'bb-group-empty', g.empty));
    for (const b of rules) sec.appendChild(bbCard(b));
    box.appendChild(sec);
  }
  c.appendChild(box);
}

/* ── Compare copies ───────────────────────────────────────────────────── */
/**
 * A word-level diff: each side cut into words and the spaces between them,
 * words compared lowercased with punctuation and Markdown marks dropped, and
 * a longest common subsequence over the words. Returns each side as runs of
 * { text, mark }; joined, a side's runs are exactly its text.
 */
function bbWordDiff(ref, copy) {
  const toks = (s) => s.split(/(\s+)/).filter((x) => x !== '').map((x) => ({ text: x, key: /^\s+$/.test(x) ? '' : x.toLowerCase().replace(/['’]/g, '').replace(/[^\p{L}\p{N}]+/gu, '') }));
  const a = toks(ref), b = toks(copy);
  const aw = a.filter((x) => x.key), bw = b.filter((x) => x.key);
  const n = aw.length, m = bw.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = aw[i].key === bw[j].key ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  for (let i = 0, j = 0; i < n || j < m;) {
    if (i < n && j < m && aw[i].key === bw[j].key) { i++; j++; }
    else if (j >= m || (i < n && dp[i + 1][j] >= dp[i][j + 1])) aw[i++].mark = true;
    else bw[j++].mark = true;
  }
  // Runs: a mark spans the spaces between marked words, never the spaces around them; a token with no word (a list dash, "**") is never marked.
  const runs = (ts) => {
    const out = [];
    for (let k = 0; k < ts.length; k++) {
      const t = ts[k];
      let mark = !!t.mark;
      if (!t.key && /^\s+$/.test(t.text)) {
        const prev = ts.slice(0, k).reverse().find((x) => x.key), next = ts.slice(k + 1).find((x) => x.key);
        mark = !!(prev?.mark && next?.mark && ts[k - 1]?.key && ts[k + 1]?.key);
      }
      const last = out[out.length - 1];
      if (last && last.mark === mark) last.text += t.text; else out.push({ text: t.text, mark });
    }
    return out;
  };
  return { ref: runs(a), copy: runs(b) };
}

function bbDiffBox(runs, cls, title) {
  const box = el('div', 'bb-diff');
  for (const r of runs) {
    if (!r.mark) { box.appendChild(document.createTextNode(r.text)); continue; }
    const m = el(cls === 'bb-missing' ? 'del' : 'ins', cls, r.text);
    m.title = title;
    box.appendChild(m);
  }
  return box;
}

const bbRuleOf = (hash) => {
  try { return decodeURIComponent(/[&]rule=([^&]+)/.exec(hash)?.[1] || '') || null; } catch { return null; /* a malformed link names no rule */ }
};
/** Whether a Compare link names a rule other than the one shown. */
const bbRuleMoved = (hash) => bbRuleOf(hash) !== BB.rule;

function bbCompare(id) {
  BB.rule = id;
  BB.match = null; BB.matched = null;
  location.hash = `${BB_COMPARE_HASH}&rule=${encodeURIComponent(id)}`;
  openBlocksCompare();
}

async function openBlocksCompare() {
  if (!confirmDiscard()) return;
  const id = bbRuleOf(location.hash) || BB.rule;
  BB.rule = id;
  S.view = 'blocks-compare';
  leaveEditor();
  window.history.replaceState(null, '', `${BB_COMPARE_HASH}&rule=${encodeURIComponent(id || '')}`);
  renderSidebar(); renderTopbar(); renderTabs(); renderStatus();
  $('filebar').hidden = true;
  $('content').scrollTop = 0;
  if (BB.data) { paintCompare(); return; }
  $('content').innerHTML = '<div class="scope"><div class="scope-sub"><span class="spinner"></span> Reading your instruction files and skills…</div></div>';
  await bbLoad();
}

function bbBack() {
  BB.match = null; BB.matched = null;
  location.hash = '#blocks';
  openBlocks();
}

function paintCompare() {
  if (S.view !== 'blocks-compare') return;
  const c = $('content');
  if (!BB.data && !BB.error) return;
  c.innerHTML = '';
  const box = el('div', 'scope bb');
  const top = el('div', 'bb-actions');
  const back = el('button', 'btn', 'Back');
  back.onclick = bbBack;
  top.appendChild(back);
  const b = BB.data?.blocks.find((x) => x.id === BB.rule);
  box.appendChild(el('h2', 'bb-cmp-title', b ? `Compare copies: ${b.name}` : 'Compare copies'));
  box.appendChild(top);
  if (BB.error && !BB.data) { bbFailed(box); c.appendChild(box); return; }
  if (!b) { box.appendChild(el('p', 'bb-empty', 'That rule is not on the list any more.')); c.appendChild(box); return; }
  box.appendChild(el('p', 'bb-cmp-intro', 'Each of your copies beside the reference version. The studio compares words, not meaning: read both and decide whether the copy still says what you want.'));
  if (BB.matched?.rule === b.id) {
    const r = BB.matched;
    const n = el('div', 'notice bb-result', `Updated ${r.file}: that copy now matches the reference. ${r.undo}`);
    n.setAttribute('role', 'status');
    box.appendChild(n);
  }
  const legend = el('p', 'bb-legend');
  legend.appendChild(el('del', 'bb-missing', 'Missing from this copy'));
  legend.appendChild(el('ins', 'bb-only', 'Only in this copy'));
  box.appendChild(legend);
  const mine = bbMine(b);
  if (!mine.length) box.appendChild(el('p', 'bb-empty', 'Not found in any of your files.'));
  for (const copy of bbWorstFirst(mine)) {
    const sec = el('section', `bb-cmp bb-${copy.rating}`);
    const head = el('div', 'bb-copy');
    bbCopyHead(head, copy, mine);
    sec.appendChild(head);
    if (copy.rating === 'same') {
      sec.appendChild(el('p', 'bb-same', 'Word for word the same as the reference.'));
    } else {
      const d = bbWordDiff(b.text.replace(/\n$/, ''), copy.text || '');
      const cols = el('div', 'bb-cols');
      const ref = el('div', 'bb-ref');
      ref.appendChild(el('div', 'bb-label', 'Reference'));
      ref.appendChild(bbDiffBox(d.ref, 'bb-missing', 'Missing from this copy'));
      const own = el('div', 'bb-mine');
      own.appendChild(el('div', 'bb-label', 'This copy'));
      own.appendChild(bbDiffBox(d.copy, 'bb-only', 'Only in this copy'));
      cols.appendChild(ref);
      cols.appendChild(own);
      sec.appendChild(cols);
      if (copy.textCut) sec.appendChild(el('p', 'bb-note', 'This copy is long: only its start is shown, so words further on may be marked as missing.'));
      bbMatchPart(sec, b, copy);
    }
    box.appendChild(sec);
  }
  const packs = bbPacksLine(b);
  if (packs) box.appendChild(packs);
  c.appendChild(box);
}

const bbKey = (c) => `${c.file}\n${c.line}\n${c.endLine}`;

/** Under a drifted copy: its button, the preview with Make it match and Cancel, or why it cannot be replaced. */
function bbMatchPart(sec, b, copy) {
  if (!copy.canMatch) {
    if (copy.whyNot) sec.appendChild(el('p', 'bb-why', copy.whyNot));
    return;
  }
  const m = BB.match?.key === bbKey(copy) ? BB.match : null;
  if (!m) {
    const row = el('div', 'bb-actions');
    const go = el('button', 'btn', 'Make this copy match');
    go.disabled = !!BB.match?.busy;
    go.onclick = () => bbPreview(b.id, copy);
    row.appendChild(go);
    sec.appendChild(row);
    return;
  }
  const box = el('div', 'bb-match');
  box.setAttribute('role', 'region');
  box.setAttribute('aria-label', 'Preview of the change');
  const acts = el('div', 'bb-actions');
  if (m.error) {
    const n = el('div', 'notice error', m.error);
    n.setAttribute('role', 'alert');
    box.appendChild(n);
    if (m.stale) {
      const again = el('button', 'btn', 'Preview again');
      again.disabled = m.busy;
      again.onclick = () => bbPreviewAgain(m);
      acts.appendChild(again);
    }
  }
  const p = m.preview;
  if (p) {
    const at = p.endLine > p.line ? `lines ${p.line}–${p.endLine}` : `line ${p.line}`;
    box.appendChild(el('p', null, `In ${p.file}, ${at} become the reference version:`));
    box.appendChild(bbLineDiff(p.diff, p.line));
    box.appendChild(el('p', 'bb-match-note', 'The old file is saved to History first, so you can put it back. Nothing else in the file changes.'));
    const yes = el('button', 'btn primary', m.busy ? 'Saving…' : 'Make it match');
    yes.disabled = m.busy;
    yes.onclick = () => bbApply();
    acts.appendChild(yes);
  } else if (m.busy) {
    box.appendChild(el('p', 'bb-match-note', 'Reading the file…'));
  }
  const cancel = el('button', 'btn ghost', 'Cancel');
  cancel.disabled = m.busy;
  cancel.onclick = () => { BB.match = null; paintCompare(); };
  acts.appendChild(cancel);
  box.appendChild(acts);
  sec.appendChild(box);
}

/** The server's line diff, numbered from the copy's first line in the file. */
function bbLineDiff(rows, from) {
  const wrap = el('div', 'diff bb-lines');
  const type = { '+': 'add', '-': 'del', ' ': 'ctx' };
  let a = from - 1, n = from - 1;
  for (const r of rows) {
    if (r.op !== '+') a++;
    if (r.op !== '-') n++;
    const line = el('div', `diff-line ${type[r.op]}`);
    line.appendChild(el('span', 'n', String(r.op === '-' ? a : n)));
    line.appendChild(el('span', 't', `${r.op} ${r.line}`));
    wrap.appendChild(line);
  }
  return wrap;
}

function bbFocusMatch() {
  const box = $('content').querySelector('.bb-match');
  box?.scrollIntoView?.({ block: 'nearest' });
  box?.querySelector('.btn.primary, .btn:not(.ghost)')?.focus?.({ preventScroll: true });
}

async function bbPreview(rule, copy) {
  const m = { key: bbKey(copy), rule, copy, busy: true, preview: null, error: null, stale: false };
  BB.match = m; BB.matched = null;
  paintCompare();
  try { m.preview = await api('POST', '/api/blocks/match/preview', { rule, file: copy.file, line: copy.line, endLine: copy.endLine }); }
  catch (e) { m.error = e.message; m.stale = e.status === 409; }
  if (BB.match !== m) return;
  m.busy = false;
  paintCompare();
  bbFocusMatch();
}

/**
 * After a refusal the copy may have moved: check again first, then preview
 * the same copy where it is now — by its place if it is still there, else
 * the one drifted copy of this rule left in that file. With none, or more
 * than one, the refreshed page is left for the person to choose from.
 */
async function bbPreviewAgain(m) {
  m.busy = true;
  paintCompare();
  await bbLoad();
  if (BB.match !== m) return;
  const rule = BB.data?.blocks.find((x) => x.id === m.rule);
  const offered = (rule?.copies || []).filter((c) => c.canMatch);
  const here = offered.find((c) => bbKey(c) === m.key) || (() => {
    const inFile = offered.filter((c) => c.file === m.copy.file);
    return inFile.length === 1 ? inFile[0] : null;
  })();
  if (!here) { BB.match = null; paintCompare(); return; }
  await bbPreview(m.rule, here);
}

async function bbApply() {
  const m = BB.match;
  if (!m?.preview || m.busy) return;
  m.busy = true; m.error = null;
  paintCompare();
  const { rule, copy, preview } = m;
  let r;
  try { r = await api('POST', '/api/blocks/match/apply', { rule, file: copy.file, line: copy.line, endLine: copy.endLine, signature: preview.signature }); }
  catch (e) {
    if (BB.match !== m) return;
    m.busy = false; m.error = e.message; m.stale = e.status === 409;
    if (m.stale) m.preview = null;
    paintCompare();
    bbFocusMatch();
    return;
  }
  if (BB.match === m) BB.match = null;
  BB.matched = { ...r, rule };
  await bbLoad();
}
