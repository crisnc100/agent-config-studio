/* Agent Config Studio — front end */

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const esc = (s) => s.replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const S = {
  registry: null,
  view: 'welcome',      // welcome | entry | search | scope
  entry: null,
  file: null,           // { path, kind, content, mtime, display }
  original: '',
  draft: '',
  tab: 'preview',
  assistAction: 'tighten',
  assistResult: null,
  assistBusy: false,
};

/* ── api ─────────────────────────────────────────────────────────────── */
async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

/* ── notices ─────────────────────────────────────────────────────────── */
let noticeTimer;
function notice(kind, text, list, sticky) {
  clearTimeout(noticeTimer);
  const slot = $('notice-slot');
  slot.innerHTML = '';
  const n = el('div', `notice ${kind}`);
  n.appendChild(el('div', null, text));
  if (list?.length) {
    const ul = el('ul');
    list.forEach((x) => ul.appendChild(el('li', null, x)));
    n.appendChild(ul);
  }
  slot.appendChild(n);
  if (!sticky) noticeTimer = setTimeout(() => { slot.innerHTML = ''; }, 6000);
}
const clearNotice = () => { clearTimeout(noticeTimer); $('notice-slot').innerHTML = ''; };

/* ── boot ────────────────────────────────────────────────────────────── */
async function boot() {
  marked.setOptions({ gfm: true, breaks: false, mangle: false, headerIds: false });
  S.registry = await api('GET', '/api/registry');
  seedCollapsed();
  renderSidebar();

  const total = S.registry.groups.reduce(
    (n, g) => n + g.entries.reduce((m, e) => m + e.files.length, 0), 0);
  $('brand-sub').textContent = `${total} files · ${S.registry.history.commits} versions`;

  wireGlobalKeys();

  // Deep links: #file=<path> for any file, #scope for the scope view.
  if (location.hash.startsWith('#scope')) return openScope();
  const m = location.hash.match(/file=([^&]+)/);
  if (m) {
    const p = decodeURIComponent(m[1]);
    const entry = entryForFile(p);
    if (entry) return openEntry(entry, p);
  }
  renderWelcome();
}

function entryForFile(p) {
  for (const g of S.registry.groups) {
    const e = g.entries.find((x) => x.files.some((f) => f.path === p));
    if (e) return e;
  }
  return null;
}

/* ── sidebar ─────────────────────────────────────────────────────────── */
const stored = localStorage.getItem('acs.collapsed');
const collapsed = new Set(stored ? JSON.parse(stored) : []);
/** First run: start with the groups the server marks as low-traffic collapsed. */
function seedCollapsed() {
  if (stored) return;
  S.registry.groups.filter((g) => g.collapsed).forEach((g) => collapsed.add(g.id));
}

function renderSidebar() {
  const tree = $('tree');
  tree.innerHTML = '';
  for (const g of S.registry.groups) {
    if (!g.entries.length) continue;
    const wrap = el('div', 'group');

    const head = el('button', 'group-head');
    head.appendChild(el('span', 'group-title', g.title));
    head.appendChild(el('span', 'group-count', String(g.entries.length)));
    head.onclick = () => {
      collapsed.has(g.id) ? collapsed.delete(g.id) : collapsed.add(g.id);
      localStorage.setItem('acs.collapsed', JSON.stringify([...collapsed]));
      renderSidebar();
    };
    wrap.appendChild(head);

    if (!collapsed.has(g.id)) {
      if (g.subtitle) wrap.appendChild(el('div', 'group-sub', g.subtitle));
      for (const e of g.entries) {
        const b = el('button', 'item' + (S.entry?.id === e.id ? ' active' : ''));
        b.appendChild(el('span', `item-dot ${e.harness}`));
        b.appendChild(el('span', 'item-label', e.label));
        if (e.extraFiles > 0) b.appendChild(el('span', 'item-badge', `+${e.extraFiles}`));
        b.title = e.description ? `${e.display}\n\n${e.description}` : e.display;
        b.onclick = () => openEntry(e);
        wrap.appendChild(b);
      }
    }
    tree.appendChild(wrap);
  }
}

function findEntry(id) {
  for (const g of S.registry.groups) {
    const e = g.entries.find((x) => x.id === id);
    if (e) return e;
  }
  return null;
}

/* ── opening files ───────────────────────────────────────────────────── */
function confirmDiscard() {
  if (!isDirty()) return true;
  return confirm('You have unsaved changes. Discard them?');
}
const isDirty = () => S.file && S.draft !== S.original;

async function openEntry(entry, filePath) {
  if (!confirmDiscard()) return;
  S.entry = entry;
  S.view = 'entry';
  S.assistResult = null;
  clearNotice();
  renderSidebar();
  await loadFile(filePath || entry.primary || entry.files[0]?.path);
}

async function loadFile(p) {
  if (!p) return;
  try {
    const f = await api('GET', `/api/file?path=${encodeURIComponent(p)}`);
    S.file = f;
    S.original = f.content;
    S.draft = f.content;
    S.tab = S.tab === 'history' || S.tab === 'compare' ? 'preview' : S.tab;
    window.history.replaceState(null, '', `#file=${encodeURIComponent(f.path)}`);
    renderAll();
  } catch (e) {
    notice('error', e.message, null, true);
  }
}

/* ── chrome ──────────────────────────────────────────────────────────── */
function renderAll() {
  renderTopbar();
  renderFilebar();
  renderTabs();
  renderContent();
  renderStatus();
}

function renderTopbar() {
  const t = $('title');
  t.innerHTML = '';
  if (S.view === 'entry' && S.entry) {
    t.appendChild(document.createTextNode(S.entry.label));
    const tag = el('span', `harness-tag ${S.entry.harness}`,
      S.entry.harness === 'both' ? 'shared' : S.entry.harness);
    t.appendChild(tag);
    $('title-path').textContent = S.file?.display || S.entry.display;
  } else if (S.view === 'search') {
    t.textContent = 'Search results';
    $('title-path').textContent = '';
  } else if (S.view === 'scope') {
    t.textContent = 'Scope chain';
    $('title-path').textContent = 'What actually applies when an agent runs in a directory';
  } else {
    t.textContent = 'Agent Config Studio';
    $('title-path').textContent = '';
  }
  $('btn-assist').disabled = S.view !== 'entry' || !S.file;
}

function renderFilebar() {
  const bar = $('filebar');
  const files = S.entry?.files || [];
  if (S.view !== 'entry' || files.length < 2) { bar.hidden = true; return; }
  bar.hidden = false;
  bar.innerHTML = '';
  for (const f of files) {
    const c = el('button', 'filechip' + (S.file?.path === f.path ? ' active' : ''), f.name);
    c.onclick = () => { if (confirmDiscard()) loadFile(f.path); };
    bar.appendChild(c);
  }
}

function renderTabs() {
  const tabs = $('tabs');
  tabs.innerHTML = '';
  tabs.style.display = (S.view === 'entry' && S.file) ? 'flex' : 'none';
  if (S.view !== 'entry' || !S.file) return;
  const list = [['preview', 'Preview'], ['edit', 'Edit'], ['history', 'History']];
  if (S.entry.pairedWith && /SKILL\.md$/.test(S.file.path)) list.push(['compare', 'Compare']);
  for (const [id, label] of list) {
    const b = el('button', 'tab' + (S.tab === id ? ' active' : ''), label);
    b.onclick = () => { S.tab = id; renderContent(); renderTabs(); renderStatus(); };
    tabs.appendChild(b);
  }
}

function renderStatus() {
  const L = $('status-left'), R = $('status-right');
  if (S.view === 'entry' && S.file) {
    const lines = S.draft.split('\n').length;
    L.textContent = `${lines} lines · ${S.draft.length.toLocaleString()} chars · ${S.file.kind}`;
    R.innerHTML = '';
    if (isDirty()) {
      R.appendChild(el('span', 'dot-dirty', '● unsaved'));
    } else {
      R.appendChild(el('span', null, 'saved'));
    }
  } else {
    L.textContent = S.registry ? `history: ${S.registry.history.path}` : '';
    R.textContent = '';
  }
  $('btn-save').disabled = !isDirty();
}

/* ── content panes ───────────────────────────────────────────────────── */
function renderContent() {
  const c = $('content');
  c.innerHTML = '';
  if (S.view === 'welcome') return renderWelcome();
  if (S.view === 'search') return;         // rendered directly by doSearch
  if (S.view === 'scope') return;          // rendered directly by openScope
  if (!S.file) return;

  if (S.tab === 'preview') return renderPreview(c);
  if (S.tab === 'edit') return renderEditor(c);
  if (S.tab === 'history') return renderHistory(c);
  if (S.tab === 'compare') return renderCompare(c);
}

function renderWelcome() {
  const c = $('content');
  c.innerHTML = '';
  const w = el('div', 'empty');
  w.appendChild(el('div', 'empty-title', 'Pick anything on the left to read or edit it.'));
  const hint = el('div');
  hint.innerHTML = 'Every save is committed to a shadow git repo, so nothing is ever lost. ' +
    'Press <span class="kbd">⌘K</span> to search across every config file at once.';
  w.appendChild(hint);
  c.appendChild(w);
}

/**
 * Split a leading YAML frontmatter block off the body. Markdown would otherwise
 * render `---\nname: x\n---` as a setext heading, which swallows the top of
 * every SKILL.md.
 */
function splitFrontmatter(text) {
  if (!text.startsWith('---')) return { fields: null, body: text };
  const end = text.indexOf('\n---', 3);
  if (end === -1) return { fields: null, body: text };
  const block = text.slice(3, end);
  const body = text.slice(text.indexOf('\n', end + 1) + 1);
  const fields = [];
  for (const line of block.split('\n')) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (m) fields.push([m[1], m[2].trim()]);
    else if (fields.length && line.trim()) fields[fields.length - 1][1] += ' ' + line.trim();
  }
  return { fields: fields.length ? fields : null, body };
}

function renderPreview(c) {
  if (S.file.kind !== 'markdown') {
    c.appendChild(el('pre', 'raw', S.draft));
    return;
  }
  const { fields, body } = splitFrontmatter(S.draft);
  const d = el('div', 'md');
  if (fields) {
    const card = el('div', 'fm-card');
    for (const [k, v] of fields) {
      const row = el('div', 'fm-row');
      row.appendChild(el('div', 'fm-key', k));
      row.appendChild(el('div', 'fm-val', v));
      card.appendChild(row);
    }
    d.appendChild(card);
  }
  const bodyEl = el('div');
  bodyEl.innerHTML = marked.parse(body);
  d.appendChild(bodyEl);
  c.appendChild(d);
}

function renderEditor(c) {
  const wrap = el('div', 'editor-wrap');
  const ta = el('textarea', 'editor');
  ta.value = S.draft;
  ta.spellcheck = false;
  ta.oninput = () => { S.draft = ta.value; renderStatus(); };
  ta.onkeydown = (ev) => {
    if (ev.key === 'Tab') {
      ev.preventDefault();
      const s = ta.selectionStart, e = ta.selectionEnd;
      ta.value = ta.value.slice(0, s) + '  ' + ta.value.slice(e);
      ta.selectionStart = ta.selectionEnd = s + 2;
      S.draft = ta.value;
      renderStatus();
    }
  };
  wrap.appendChild(ta);
  c.appendChild(wrap);
  setTimeout(() => ta.focus(), 0);
}

async function renderHistory(c) {
  const box = el('div', 'hist');
  box.appendChild(el('div', 'scope-sub', 'Every save the studio has made to this file.'));
  c.appendChild(box);
  let data;
  try { data = await api('GET', `/api/history?path=${encodeURIComponent(S.file.path)}`); }
  catch (e) { box.appendChild(el('div', 'scope-sub', e.message)); return; }

  if (!data.commits.length) {
    box.appendChild(el('div', 'scope-sub', 'No versions recorded yet — the first save will create one.'));
    return;
  }
  data.commits.forEach((cm, i) => {
    const row = el('div', 'hist-row');
    row.appendChild(el('span', 'hist-sha', cm.sha.slice(0, 8)));
    row.appendChild(el('span', 'hist-when', new Date(cm.at).toLocaleString()));
    row.appendChild(el('span', 'hist-msg', cm.subject));
    if (i === 0) row.appendChild(el('span', 'item-badge', 'current'));

    const view = el('button', 'btn ghost', 'Diff');
    view.style.padding = '3px 10px';
    view.onclick = () => showVersionDiff(cm.sha);
    row.appendChild(view);

    if (i > 0) {
      const rest = el('button', 'btn danger', 'Restore');
      rest.style.padding = '3px 10px';
      rest.onclick = () => restoreVersion(cm.sha);
      row.appendChild(rest);
    }
    box.appendChild(row);
  });
}

async function showVersionDiff(sha) {
  const c = $('content');
  c.innerHTML = '';
  const back = el('button', 'btn ghost', '← back to history');
  back.style.margin = '16px 0 0 20px';
  back.onclick = () => renderContent();
  c.appendChild(back);
  try {
    const { content } = await api('GET',
      `/api/history/version?path=${encodeURIComponent(S.file.path)}&sha=${sha}`);
    c.appendChild(diffView(content, S.draft, `${sha.slice(0, 8)}`, 'now'));
  } catch (e) {
    c.appendChild(el('div', 'scope-sub', e.message));
  }
}

async function restoreVersion(sha) {
  if (!confirm(`Restore this file to version ${sha.slice(0, 8)}?\n\nThe current contents are already committed, so this is reversible.`)) return;
  try {
    const r = await api('POST', '/api/history/restore', { path: S.file.path, sha });
    S.file.content = r.content;
    S.file.mtime = r.mtime;
    S.original = r.content;
    S.draft = r.content;
    S.tab = 'preview';
    renderAll();
    notice('ok', `Restored to ${sha.slice(0, 8)}.`);
  } catch (e) {
    notice('error', e.message, null, true);
  }
}

async function renderCompare(c) {
  const other = findEntry(S.entry.pairedWith);
  if (!other) { c.appendChild(el('div', 'scope-sub', 'Paired skill not found.')); return; }
  const grid = el('div', 'compare');

  for (const [entry, content] of [[S.entry, S.draft], [other, null]]) {
    const col = el('div', 'compare-col');
    const head = el('div', 'compare-head');
    head.appendChild(el('span', `harness-tag ${entry.harness}`, entry.harness));
    head.appendChild(el('span', null, `${entry.label}/SKILL.md`));
    col.appendChild(head);
    const body = el('div', 'md');
    body.innerHTML = '<p style="color:var(--muted)">loading…</p>';
    col.appendChild(body);
    grid.appendChild(col);

    if (content != null) {
      body.innerHTML = marked.parse(content);
    } else {
      const p = entry.primary;
      api('GET', `/api/file?path=${encodeURIComponent(p)}`)
        .then((f) => { body.innerHTML = marked.parse(f.content); })
        .catch((e) => { body.innerHTML = `<p style="color:var(--red)">${esc(e.message)}</p>`; });
      const open = el('button', 'btn ghost', 'Open →');
      open.style.cssText = 'padding:2px 9px;margin-left:auto';
      open.onclick = () => openEntry(entry);
      head.appendChild(open);
    }
  }
  c.appendChild(grid);
}

/* ── diff ────────────────────────────────────────────────────────────── */
function lineDiff(a, b) {
  const A = a.split('\n'), B = b.split('\n');
  // Guard: full LCS is O(n*m); fall back to a blunt replace on huge files.
  if (A.length * B.length > 4_000_000) {
    return [...A.map((t) => ({ type: 'del', text: t })), ...B.map((t) => ({ type: 'add', text: t }))];
  }
  const m = A.length, n = B.length;
  const dp = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (A[i] === B[j]) { out.push({ type: 'ctx', text: A[i], na: i + 1, nb: j + 1 }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ type: 'del', text: A[i], na: i + 1 }); i++; }
    else { out.push({ type: 'add', text: B[j], nb: j + 1 }); j++; }
  }
  while (i < m) out.push({ type: 'del', text: A[i], na: ++i });
  while (j < n) out.push({ type: 'add', text: B[j], nb: ++j });
  return out;
}

function diffView(oldText, newText, oldLabel = 'before', newLabel = 'after') {
  const rows = lineDiff(oldText, newText);
  const wrap = el('div', 'diff');
  const changes = rows.filter((r) => r.type !== 'ctx').length;
  const head = el('div', 'scope-sub');
  head.style.padding = '0 8px 10px';
  head.textContent = changes === 0
    ? 'Identical.'
    : `${rows.filter(r => r.type === 'add').length} added, ${rows.filter(r => r.type === 'del').length} removed  ·  ${oldLabel} → ${newLabel}`;
  wrap.appendChild(head);

  // Collapse long unchanged runs to 3 lines of context on each side.
  const keep = new Array(rows.length).fill(false);
  rows.forEach((r, i) => {
    if (r.type === 'ctx') return;
    for (let k = Math.max(0, i - 3); k <= Math.min(rows.length - 1, i + 3); k++) keep[k] = true;
  });
  let skipped = 0;
  rows.forEach((r, i) => {
    if (!keep[i]) { skipped++; return; }
    if (skipped) { wrap.appendChild(el('div', 'diff-skip', `⋯ ${skipped} unchanged lines`)); skipped = 0; }
    const line = el('div', `diff-line ${r.type}`);
    line.appendChild(el('span', 'n', r.type === 'add' ? String(r.nb ?? '') : String(r.na ?? '')));
    const t = el('span', 't', (r.type === 'add' ? '+ ' : r.type === 'del' ? '- ' : '  ') + r.text);
    line.appendChild(t);
    wrap.appendChild(line);
  });
  if (skipped) wrap.appendChild(el('div', 'diff-skip', `⋯ ${skipped} unchanged lines`));
  return wrap;
}

/* ── save ────────────────────────────────────────────────────────────── */
async function save() {
  if (!isDirty()) return;
  const btn = $('btn-save');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    const r = await api('PUT', '/api/file', {
      path: S.file.path, content: S.draft, mtime: S.file.mtime,
    });
    if (!r.saved && r.errors?.length) {
      notice('error', 'Not saved — this would break the file:', r.errors, true);
    } else if (r.unchanged) {
      notice('ok', 'No changes to save.');
    } else {
      S.original = S.draft;
      S.file.mtime = r.mtime;
      if (r.warnings?.length) notice('warn', 'Saved, with notes:', r.warnings, true);
      else notice('ok', `Saved · version ${r.sha?.slice(0, 8) ?? ''}`);
      S.registry.history.commits++;
    }
  } catch (e) {
    notice('error', e.message, null, true);
  } finally {
    btn.textContent = 'Save';
    renderStatus();
  }
}

/* ── search ──────────────────────────────────────────────────────────── */
let searchTimer;
$('search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  if (q.length < 2) { if (S.view === 'search') { S.view = 'welcome'; renderAll(); } return; }
  searchTimer = setTimeout(() => doSearch(q), 220);
});

async function doSearch(q) {
  S.view = 'search';
  renderTopbar(); renderTabs(); renderStatus();
  $('filebar').hidden = true;
  const c = $('content');
  c.innerHTML = '<div class="results"><div class="scope-sub"><span class="spinner"></span> searching…</div></div>';
  let data;
  try { data = await api('GET', `/api/search?q=${encodeURIComponent(q)}`); }
  catch (e) { c.innerHTML = `<div class="results"><div class="scope-sub">${esc(e.message)}</div></div>`; return; }

  c.innerHTML = '';
  const box = el('div', 'results');
  box.appendChild(el('div', 'scope-sub',
    data.hits.length ? `${data.hits.length} files contain “${q}”` : `Nothing matches “${q}”.`));
  const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig');

  for (const h of data.hits) {
    const b = el('button', 'result');
    const head = el('div', 'result-head');
    head.appendChild(el('span', `item-dot ${h.harness}`));
    head.appendChild(el('span', 'result-name', `${h.entryLabel}${h.file !== 'SKILL.md' ? ' · ' + h.file : ''}`));
    head.appendChild(el('span', 'item-badge', h.group));
    head.appendChild(el('span', 'result-path', h.display));
    b.appendChild(head);
    for (const m of h.matches) {
      const line = el('div', 'result-line');
      line.innerHTML = `<span class="result-ln">${m.line}</span>` +
        esc(m.text).replace(rx, (x) => `<b>${x}</b>`);
      b.appendChild(line);
    }
    if (h.total > h.matches.length) {
      b.appendChild(el('div', 'result-line', `  +${h.total - h.matches.length} more`));
    }
    b.onclick = () => {
      const entry = findEntry(h.entryId);
      if (entry) openEntry(entry, h.path);
    };
    box.appendChild(b);
  }
  c.appendChild(box);
}

/* ── scope view ──────────────────────────────────────────────────────── */
async function openScope() {
  if (!confirmDiscard()) return;
  S.view = 'scope';
  S.entry = null;
  window.history.replaceState(null, '', '#scope');
  renderSidebar(); renderTopbar(); renderTabs(); renderStatus();
  $('filebar').hidden = true;
  const c = $('content');
  c.innerHTML = '';
  const box = el('div', 'scope');
  box.appendChild(el('h2', null, 'What applies where'));
  box.appendChild(el('div', 'scope-sub',
    'Pick a directory to see every memory file an agent loads there, in the order they layer.'));
  const sel = el('select', 'scope-select');
  box.appendChild(sel);
  const list = el('div');
  box.appendChild(list);
  c.appendChild(box);

  const { dirs } = await api('GET', '/api/scope/dirs');
  for (const d of dirs) {
    const o = el('option', null, d.display);
    o.value = d.path;
    sel.appendChild(o);
  }
  const load = async () => {
    list.innerHTML = '<div class="scope-sub"><span class="spinner"></span></div>';
    const { chain } = await api('GET', `/api/scope?dir=${encodeURIComponent(sel.value)}`);
    list.innerHTML = '';
    if (!chain.length) { list.appendChild(el('div', 'scope-sub', 'No memory files apply here.')); return; }
    chain.forEach((f, i) => {
      const row = el('div', 'scope-item');
      row.appendChild(el('div', 'scope-rank', String(i + 1)));
      const body = el('div', 'scope-body');
      body.appendChild(el('div', 'scope-path', f.display));
      body.appendChild(el('div', 'scope-note',
        `${f.scope === 'global' ? 'Global' : 'Directory'} · ${f.note} · ${(f.size / 1024).toFixed(1)} KB`));
      row.appendChild(body);
      const open = el('button', 'btn ghost scope-open', 'Open');
      open.onclick = () => {
        for (const g of S.registry.groups) {
          const e = g.entries.find((x) => x.files.some((ff) => ff.path === f.path));
          if (e) return openEntry(e, f.path);
        }
        notice('warn', 'That file is not in the registry yet — reload to pick it up.');
      };
      row.appendChild(open);
      list.appendChild(row);
    });
  };
  sel.onchange = load;
  load();
}

/* ── assist drawer ───────────────────────────────────────────────────── */
function openDrawer() {
  if (!S.file) return;
  $('drawer').classList.add('open');
  $('scrim').classList.add('open');
  renderDrawer();
}
function closeDrawer() {
  $('drawer').classList.remove('open');
  $('scrim').classList.remove('open');
}

function renderDrawer() {
  const body = $('drawer-body'), foot = $('drawer-foot');
  body.innerHTML = ''; foot.innerHTML = '';

  body.appendChild(el('p', 'assist-label', 'Quick actions'));
  const acts = el('div', 'assist-actions');
  for (const a of S.registry.assistActions) {
    const chip = el('button', 'assist-chip' + (S.assistAction === a.id ? ' active' : ''), a.label);
    chip.onclick = () => { S.assistAction = a.id; renderDrawer(); };
    acts.appendChild(chip);
  }
  const custom = el('button', 'assist-chip' + (S.assistAction === 'custom' ? ' active' : ''), 'Custom…');
  custom.onclick = () => { S.assistAction = 'custom'; renderDrawer(); };
  acts.appendChild(custom);
  body.appendChild(acts);

  let input;
  if (S.assistAction === 'custom') {
    body.appendChild(el('p', 'assist-label', 'Instruction'));
    input = el('textarea', 'assist-input');
    input.placeholder = 'e.g. "Add a rule that Codex reviews run at high effort by default"';
    input.id = 'assist-instruction';
    body.appendChild(input);
  }

  body.appendChild(el('div', 'scope-sub',
    `Runs the local claude CLI against ${S.file.display}. Nothing is written until you apply it.`));

  if (S.assistBusy) {
    const busy = el('div', 'assist-out');
    busy.innerHTML = '<span class="spinner"></span> <span style="color:var(--muted)">thinking… this can take up to a minute</span>';
    body.appendChild(busy);
  }

  if (S.assistResult) {
    const out = el('div', 'assist-out');
    if (S.assistResult.readOnly) {
      out.appendChild(el('p', 'assist-label', 'Findings'));
      const md = el('div', 'md');
      md.style.cssText = 'padding:0;font-size:13.5px';
      md.innerHTML = marked.parse(S.assistResult.result);
      out.appendChild(md);
    } else {
      // The model occasionally answers with prose instead of file contents, or
      // decides to gut the file. Both show up as a huge shrink — flag it loudly,
      // because the diff alone is easy to skim past.
      const before = S.draft.length, after = S.assistResult.result.length;
      if (after < before * 0.5) {
        const warn = el('div', 'notice warn');
        warn.style.margin = '0 0 12px';
        warn.textContent = after === 0
          ? 'The model returned an empty file. Do not apply this unless you meant to clear it.'
          : `This cuts the file by ${Math.round((1 - after / before) * 100)}% (${before.toLocaleString()} → ${after.toLocaleString()} chars). Read the diff carefully — the model may have answered with prose instead of file contents.`;
        out.appendChild(warn);
      }
      out.appendChild(el('p', 'assist-label', 'Proposed changes'));
      const d = diffView(S.draft, S.assistResult.result, 'current', 'proposed');
      d.style.padding = '0';
      out.appendChild(d);
    }
    body.appendChild(out);
  }

  const run = el('button', 'btn primary', S.assistBusy ? 'Running…' : 'Run');
  run.disabled = S.assistBusy;
  run.onclick = () => runAssist(input?.value);
  foot.appendChild(run);

  if (S.assistResult && !S.assistResult.readOnly) {
    const apply = el('button', 'btn', 'Apply to editor');
    apply.onclick = () => {
      S.draft = S.assistResult.result;
      S.assistResult = null;
      S.tab = 'edit';
      closeDrawer();
      renderAll();
      notice('warn', 'Applied to the editor — review it, then Save to write to disk.', null, true);
    };
    foot.appendChild(apply);
  }
  if (S.assistResult) {
    const clear = el('button', 'btn ghost', 'Clear');
    clear.onclick = () => { S.assistResult = null; renderDrawer(); };
    foot.appendChild(clear);
  }
}

async function runAssist(instruction) {
  S.assistBusy = true;
  S.assistResult = null;
  renderDrawer();
  try {
    const r = await api('POST', '/api/assist', {
      path: S.file.path,
      content: S.draft,
      action: S.assistAction === 'custom' ? null : S.assistAction,
      instruction: instruction || null,
      model: $('assist-model').value,
    });
    S.assistResult = r;
  } catch (e) {
    notice('error', `Assist failed: ${e.message}`, null, true);
  } finally {
    S.assistBusy = false;
    renderDrawer();
  }
}

/* ── wiring ──────────────────────────────────────────────────────────── */
$('btn-save').onclick = save;
$('btn-assist').onclick = openDrawer;
$('drawer-close').onclick = closeDrawer;
$('scrim').onclick = closeDrawer;
$('btn-scope').onclick = openScope;
$('btn-theme').onclick = () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('acs.theme', next);
};
document.documentElement.dataset.theme = localStorage.getItem('acs.theme') || 'dark';

function wireGlobalKeys() {
  window.addEventListener('keydown', (e) => {
    const meta = e.metaKey || e.ctrlKey;
    if (meta && e.key === 's') { e.preventDefault(); save(); }
    else if (meta && e.key === 'k') { e.preventDefault(); $('search').focus(); $('search').select(); }
    else if (meta && e.key === 'e' && S.file) {
      e.preventDefault();
      S.tab = S.tab === 'edit' ? 'preview' : 'edit';
      renderContent(); renderTabs();
    } else if (e.key === 'Escape') {
      closeDrawer();
      if (document.activeElement === $('search')) $('search').blur();
    }
  });
  window.addEventListener('beforeunload', (e) => {
    if (isDirty()) { e.preventDefault(); e.returnValue = ''; }
  });
}

boot().catch((e) => {
  document.body.innerHTML =
    `<div class="empty"><div class="empty-title">Could not start</div><div>${esc(e.message)}</div></div>`;
});
