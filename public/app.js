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

/**
 * Render markdown, then strip anything executable from the result.
 * The preview shows third-party plugin skills and model-generated assist
 * output, and marked passes raw HTML straight through — an `onerror` handler
 * in a skill file would otherwise run with same-origin access to the write API.
 */
const DANGEROUS_TAGS = 'script,style,iframe,object,embed,link,meta,form,base';
function renderMarkdown(src) {
  const host = document.createElement('div');
  host.innerHTML = marked.parse(src);
  host.querySelectorAll(DANGEROUS_TAGS).forEach((n) => n.remove());
  host.querySelectorAll('*').forEach((n) => {
    for (const attr of [...n.attributes]) {
      const name = attr.name.toLowerCase();
      const value = attr.value.replace(/\s+/g, '').toLowerCase();
      if (name.startsWith('on')) n.removeAttribute(attr.name);
      else if (/^(href|src|xlink:href|action|formaction)$/.test(name) &&
               /^(javascript|vbscript|data:text\/html)/.test(value)) {
        n.removeAttribute(attr.name);
      }
    }
  });
  return host.innerHTML;
}

const S = {
  registry: null,
  view: 'welcome',      // welcome | entry | search | scope
  entry: null,
  file: null,           // { path, kind, content, mtime, display }
  original: '',
  draft: '',
  tab: 'preview',
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
  connectEvents();
  restoreSessions();
  resolveHarness();

  // Deep links: #file=<path> for any file, #scope for the scope view.
  if (location.hash.startsWith('#scope')) return openScope();
  if (location.hash.startsWith('#mcp')) return openMcp();
  if (location.hash.startsWith('#usage')) return openUsage();
  if (location.hash.startsWith('#trash')) return openTrash();
  if (location.hash.startsWith('#assist')) { renderWelcome(); return openDrawer(); }
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

    // A row, not a button — it holds its own "new" button, and nesting
    // interactive elements inside a button is invalid.
    const head = el('div', 'group-head');
    const toggle = el('button', 'group-toggle');
    toggle.appendChild(el('span', 'group-title', g.title));
    toggle.appendChild(el('span', 'group-count', String(g.entries.length)));
    toggle.onclick = () => {
      collapsed.has(g.id) ? collapsed.delete(g.id) : collapsed.add(g.id);
      localStorage.setItem('acs.collapsed', JSON.stringify([...collapsed]));
      renderSidebar();
    };
    head.appendChild(toggle);

    if (g.createKind) {
      const add = el('button', 'group-add', '+');
      add.title = `New ${g.title.replace(/s$/, '').toLowerCase()}`;
      add.onclick = (ev) => { ev.stopPropagation(); createInGroup(g); };
      head.appendChild(add);
    }
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
  } else if (S.view === 'mcp') {
    t.textContent = 'MCP servers';
    $('title-path').textContent = 'Model Context Protocol servers across both harnesses';
  } else if (S.view === 'trash') {
    t.textContent = 'Trash';
    $('title-path').textContent = 'Deleted items — restorable';
  } else {
    t.textContent = 'Agent Config Studio';
    $('title-path').textContent = '';
  }
  const onEntry = S.view === 'entry' && !!S.file;
  // Assist is a chat over the whole corpus — reachable with nothing open.
  $('btn-assist').disabled = false;

  const del = $('btn-delete');
  del.hidden = !onEntry;
  del.disabled = !onEntry || !S.entry?.deletable;
  del.title = S.entry?.deletable === false
    ? (S.entry.undeletableReason || 'Cannot be deleted')
    : 'Delete (moves to trash, recoverable)';

  // Copying a skill across harnesses is only meaningful for skills.
  const copy = $('btn-copy');
  const isSkill = S.entry?.kindLabel === 'skill' && /SKILL\.md$/.test(S.file?.path || '');
  copy.hidden = !(onEntry && isSkill);
  if (!copy.hidden) {
    copy.textContent = S.entry.harness === 'claude' ? 'Copy to Codex' : 'Copy to Claude';
  }
}

function renderFilebar() {
  const bar = $('filebar');
  const files = S.entry?.files || [];
  const group = S.entry ? S.registry.groups.find((g) => g.entries.includes(S.entry)) : null;
  const canAdd = !!group?.canAddFiles && S.entry?.kindLabel === 'skill';

  if (S.view !== 'entry' || (files.length < 2 && !canAdd)) { bar.hidden = true; return; }
  bar.hidden = false;
  bar.innerHTML = '';
  for (const f of files) {
    const c = el('button', 'filechip' + (S.file?.path === f.path ? ' active' : ''), f.name);
    c.onclick = () => { if (confirmDiscard()) loadFile(f.path); };
    bar.appendChild(c);
  }
  if (canAdd) {
    const add = el('button', 'filechip', '+ file');
    add.title = 'Add a reference file to this skill';
    add.onclick = addFileToEntry;
    bar.appendChild(add);
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
  // Save only ever acts on the open file — never leave it live on a view that
  // isn't showing one.
  $('btn-save').disabled = S.view !== 'entry' || !isDirty();
}

/* ── content panes ───────────────────────────────────────────────────── */
function renderContent() {
  const c = $('content');
  c.innerHTML = '';
  if (S.view === 'welcome') return renderWelcome();
  if (S.view === 'search') return;         // rendered directly by doSearch
  if (S.view === 'scope') return;          // rendered directly by openScope
  if (S.view === 'mcp') return;            // rendered directly by openMcp
  if (S.view === 'usage') return;          // rendered directly by openUsage
  if (S.view === 'trash') return;          // rendered directly by openTrash
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
  // The closing `---` may be the last line with no trailing newline; treating a
  // missing newline as index 0 would hand the whole file back as the body and
  // render the frontmatter as a heading all over again.
  const nl = text.indexOf('\n', end + 1);
  const body = nl === -1 ? '' : text.slice(nl + 1);
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
  bodyEl.innerHTML = renderMarkdown(body);
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
  if (isDirty() && !confirm('You have unsaved changes in the editor. Restoring will discard them.\n\nContinue?')) return;
  if (!confirm(`Restore this file to version ${sha.slice(0, 8)}?\n\nThe current contents are recorded first, so this is reversible.`)) return;
  try {
    const r = await api('POST', '/api/history/restore', {
      path: S.file.path, sha, mtime: S.file.mtime,
    });
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
      body.innerHTML = renderMarkdown(content);
    } else {
      const p = entry.primary;
      api('GET', `/api/file?path=${encodeURIComponent(p)}`)
        .then((f) => { body.innerHTML = renderMarkdown(f.content); })
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
  // Snapshot exactly what is being sent. Anything typed during the round trip
  // must stay dirty — assigning from the live draft afterwards would mark
  // unwritten edits as saved.
  const file = S.file;
  const content = S.draft;

  const btn = $('btn-save');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    const r = await api('PUT', '/api/file', {
      path: file.path, content, mtime: file.mtime,
    });
    const stillOpen = S.file && S.file.path === file.path;

    if (!r.saved && r.errors?.length) {
      notice('error', 'Not saved — this would break the file:', r.errors, true);
    } else if (r.unchanged) {
      notice('ok', 'No changes to save.');
    } else {
      if (stillOpen) {
        S.original = content;
        S.file.mtime = r.mtime;
      }
      const notes = [...(r.warnings || [])];
      if (r.historyError) notes.push(`File written, but not versioned: ${r.historyError}`);
      if (notes.length) notice('warn', 'Saved, with notes:', notes, true);
      else notice('ok', `Saved · version ${r.sha?.slice(0, 8) ?? ''}`);
      S.registry.history.commits++;
      if (stillOpen && S.draft !== content) {
        notice('warn', 'Saved what was sent — you typed more since, so there are still unsaved changes.', null, true);
      }
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

/* ── create / delete ─────────────────────────────────────────────────── */

async function refreshRegistry(selectPath) {
  S.registry = await api('GET', '/api/registry');
  // The rebuild produces fresh entry objects; re-point at the equivalent one so
  // identity checks (active row, "can add files") keep working.
  if (S.file) S.entry = entryForFile(S.file.path) ?? S.entry;
  resolveHarness();       // detection is re-run server-side on every rebuild
  renderSidebar();
  const total = S.registry.groups.reduce(
    (n, g) => n + g.entries.reduce((m, e) => m + e.files.length, 0), 0);
  $('brand-sub').textContent = `${total} files · ${S.registry.history.commits} versions`;
  if (selectPath) {
    const entry = entryForFile(selectPath);
    if (entry) await openEntry(entry, selectPath);
  }
}

/* ── live file events ────────────────────────────────────────────────── */
/**
 * The corpus is edited by other things — Claude Code writing auto-memory, a
 * skill installed from the terminal, an agent touching a CLAUDE.md. Without
 * this the sidebar silently goes stale until a reload.
 */
function connectEvents() {
  const es = new EventSource('/api/events');

  es.onmessage = async (ev) => {
    let d;
    try { d = JSON.parse(ev.data); } catch { return; }
    if (d.type !== 'files') return;

    await refreshRegistry().catch(() => {});

    const openPath = S.file?.path;
    if (openPath && d.removedPaths?.includes(openPath)) {
      S.entry = null; S.file = null; S.original = ''; S.draft = '';
      S.view = 'welcome';
      renderAll();
      notice('warn', 'The file you had open was deleted outside the studio.', null, true);
      return;
    }

    if (openPath && d.changedPaths?.includes(openPath)) {
      if (isDirty()) {
        // Never silently discard their edits — the save will 409 anyway.
        notice('warn',
          'This file changed on disk while you were editing it. Your unsaved changes are still here, but saving will be refused until you reload.',
          null, true);
      } else {
        const f = await api('GET', `/api/file?path=${encodeURIComponent(openPath)}`).catch(() => null);
        if (f) {
          S.file = f; S.original = f.content; S.draft = f.content;
          renderAll();
          notice('ok', 'Reloaded — this file changed on disk.');
        }
      }
      return;
    }

    // Only announce structural changes; a save you just made is not news.
    const parts = [];
    if (d.added?.length) parts.push(`${d.added.length} added`);
    if (d.removed?.length) parts.push(`${d.removed.length} removed`);
    if (parts.length) {
      const names = [...(d.added || []), ...(d.removed || [])]
        .slice(0, 3).map((p) => p.split('/').pop()).join(', ');
      notice('ok', `${parts.join(', ')} outside the studio — ${names}${(d.added.length + d.removed.length) > 3 ? '…' : ''}`);
    }
    setLive(true);
  };

  es.onerror = () => setLive(false);
  es.onopen = () => setLive(true);
}

function setLive(on) {
  const dot = $('live-dot');
  if (dot) {
    dot.classList.toggle('on', !!on);
    dot.title = on ? 'Watching for changes made outside the studio' : 'Live updates disconnected — reconnecting';
  }
}

async function createInGroup(group) {
  // Worktrees are not a file scaffold — registering a project runs `wtinit`.
  if (group.createKind === 'worktree-project') return openWorktreeForm();
  const name = prompt(`New ${group.title.replace(/s$/, '').toLowerCase()} name\n\nLowercase letters, numbers and hyphens.`);
  if (!name) return;
  try {
    const r = await api('POST', '/api/create', { kind: group.createKind, name });
    await refreshRegistry(r.path);
    S.tab = 'edit';
    renderAll();
    notice('ok', `Created ${r.display} — fill in the description, then Save.`);
  } catch (e) {
    notice('error', e.message, null, true);
  }
}


/* ── register a worktree project ─────────────────────────────────────── */

/**
 * The + on Worktrees runs `wtinit` for a repo, so a new project gets its trunk,
 * its layout and its own commands without dropping to a terminal.
 */
async function openWorktreeForm() {
  let data;
  try {
    data = await api('GET', '/api/worktree');
  } catch (e) {
    return notice('error', e.message, null, true);
  }
  if (!data.candidates.length) {
    return notice('ok', 'Every git repo found is already registered.');
  }

  const wrap = el('div', 'wt-overlay');
  const card = el('div', 'wt-card');
  wrap.appendChild(card);
  card.appendChild(el('h2', 'wt-title', 'Register a project'));
  card.appendChild(el('p', 'wt-sub',
    'Creates the trunk, sets where worktrees go, and defines this project’s commands. Runs once per project.'));

  const field = (label, control, hint) => {
    const f = el('div', 'wt-field');
    f.appendChild(el('label', null, label));
    f.appendChild(control);
    const h = el('div', 'wt-hint', hint || '');
    f.appendChild(h);
    card.appendChild(f);
    return h;
  };

  const repo = el('select');
  for (const c of data.candidates) {
    const o = el('option', null, c.display);
    o.value = c.path;
    repo.appendChild(o);
  }
  field('Repository', repo);

  const key = el('input');
  key.type = 'text';
  field('Project name', key,
    'Names the trunk and the worktrees — kylie gives kylie-trunk and kylie-<name>.');

  const cmd = el('input');
  cmd.type = 'text';
  const cmdHint = field('Command prefix', cmd, '');

  const base = el('select');
  field('Branch from', base, 'New worktrees are always cut from the latest of this branch.');

  const layout = el('select');
  for (const [v, t] of [
    ['flat', 'Beside the trunk (kylie/kylie-alpha)'],
    ['sub', 'In a subfolder (personal/airflo-wt/airflo-alpha)'],
  ]) {
    const o = el('option', null, t);
    o.value = v;
    layout.appendChild(o);
  }
  field('Where worktrees go', layout,
    'Use a subfolder when the containing directory also holds other projects.');

  const out = el('pre', 'wt-out');
  out.hidden = true;
  card.appendChild(out);

  const row = el('div', 'wt-actions');
  const cancel = el('button', 'btn ghost', 'Cancel');
  const go = el('button', 'btn primary', 'Register');
  row.appendChild(cancel);
  row.appendChild(go);
  card.appendChild(row);

  const guessKey = (p) => p.split('/').pop().toLowerCase().replace(/[^a-z0-9-]/g, '');
  const syncCmd = () => {
    cmdHint.textContent = cmd.value
      ? `Gives you ${cmd.value}new, ${cmd.value}ls, ${cmd.value}go — and ${cmd.value} to jump to the trunk.`
      : 'Optional. Without one you use the generic wnew/wls inside the repo.';
  };

  const loadBases = async () => {
    base.innerHTML = '';
    try {
      const b = await api('GET', `/api/worktree/bases?repo=${encodeURIComponent(repo.value)}`);
      for (const name of b.bases) {
        const o = el('option', null, name);
        o.value = name;
        if (name === b.suggested) o.selected = true;
        base.appendChild(o);
      }
      if (!b.bases.length) base.appendChild(el('option', null, '(no origin branches found)'));
    } catch {
      base.appendChild(el('option', null, '(could not read branches)'));
    }
  };

  const onRepo = () => {
    key.value = guessKey(repo.value);
    cmd.value = key.value;
    syncCmd();
    loadBases();
  };
  repo.onchange = onRepo;
  cmd.oninput = syncCmd;
  onRepo();

  const close = () => {
    document.removeEventListener('keydown', onKey);
    wrap.remove();
  };
  const onKey = (ev) => { if (ev.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  cancel.onclick = close;
  wrap.onclick = (ev) => { if (ev.target === wrap) close(); };

  go.onclick = async () => {
    go.disabled = true;
    go.textContent = 'Running…';
    out.hidden = false;
    out.textContent = 'wtinit…';
    const body = {
      repoPath: repo.value,
      key: key.value.trim(),
      cmd: cmd.value.trim(),
      base: base.value.startsWith('origin/') ? base.value : '',
    };
    if (layout.value === 'sub') {
      const parent = repo.value.split('/').slice(0, -1).join('/');
      body.root = `${parent}/${body.key}-wt`;
    }
    try {
      const r = await api('POST', '/api/worktree/init', body);
      out.textContent = r.output;
      go.textContent = 'Done';
      await refreshRegistry();
      renderAll();
      notice('ok', `${body.key} registered — open a new terminal to use ${body.cmd || 'wnew'}.`);
      setTimeout(close, 2500);
    } catch (e) {
      out.textContent = e.message;
      go.disabled = false;
      go.textContent = 'Register';
    }
  };

  document.body.appendChild(wrap);
  key.focus();
}

/** Seed a new skill in the other harness from the open one. */
async function copyToOtherHarness() {
  const from = S.entry.harness;
  const kind = from === 'claude' ? 'codex-skill' : 'claude-skill';
  const name = prompt(`Copy "${S.entry.label}" into ${from === 'claude' ? 'Codex' : 'Claude'} skills as:`, S.entry.label);
  if (!name) return;
  try {
    const r = await api('POST', '/api/create', { kind, name, sourcePath: S.file.path });
    await refreshRegistry(r.path);
    notice('ok', `Created ${r.display} as a copy — edit it freely, the two are expected to diverge.`);
  } catch (e) {
    notice('error', e.message, null, true);
  }
}

async function addFileToEntry() {
  const name = prompt('New file name inside this skill\n\ne.g. reference.md, config.example.json');
  if (!name) return;
  try {
    const r = await api('POST', '/api/create-file', { dir: S.entry.dir, name });
    await refreshRegistry(r.path);
    notice('ok', `Created ${r.display}.`);
  } catch (e) {
    notice('error', e.message, null, true);
  }
}

async function deleteTarget({ path: p, label, isWhole, protectedEntry }) {
  if (protectedEntry) {
    const typed = prompt(
      `"${label}" is loaded by the harness on every session.\n\n` +
      `Type its name to confirm deletion:`);
    if (typed !== label) {
      if (typed !== null) notice('warn', 'Name did not match — nothing was deleted.');
      return;
    }
  } else if (!confirm(
    `Delete ${label}?\n\n` +
    `It moves to the studio's trash and is committed to history first, so you can restore it either way.`)) {
    return;
  }

  try {
    const r = await api('POST', '/api/delete', { path: p });
    const wasOpen = S.file && (S.file.path === p || S.file.path.startsWith(p + '/'));
    await refreshRegistry();
    if (wasOpen || isWhole) {
      S.entry = null; S.file = null; S.original = ''; S.draft = '';
      S.view = 'welcome';
      renderAll();
    } else {
      renderAll();
    }
    notice('ok', `Deleted ${r.display} (${r.files} file${r.files === 1 ? '' : 's'}). Recover it under Trash.`, null, true);
  } catch (e) {
    notice('error', e.message, null, true);
  }
}

function deleteOpenEntry() {
  const e = S.entry;
  if (!e) return;
  if (!e.deletable) { notice('warn', e.undeletableReason || 'This cannot be deleted.', null, true); return; }

  const multi = e.files.length > 1;
  // For a multi-file skill, make "this file" vs "the whole skill" an explicit choice.
  if (multi && S.file) {
    const whole = confirm(
      `Delete the whole "${e.label}" skill (${e.files.length} files)?\n\n` +
      `OK = delete the entire skill\nCancel = delete only ${S.file.display.split('/').pop()}`);
    if (whole) {
      return deleteTarget({ path: e.dir, label: e.label, isWhole: true, protectedEntry: e.protected });
    }
    return deleteTarget({ path: S.file.path, label: S.file.display.split('/').pop(), isWhole: false });
  }
  const target = e.files.length === 1 && !e.dir.endsWith(e.label) ? e.files[0].path : (e.primary || e.files[0]?.path);
  return deleteTarget({
    path: e.kindLabel === 'skill' ? e.dir : target,
    label: e.label, isWhole: true, protectedEntry: e.protected,
  });
}

/* ── trash view ──────────────────────────────────────────────────────── */
async function openTrash() {
  if (!confirmDiscard()) return;
  S.view = 'trash';
  S.entry = null;
  window.history.replaceState(null, '', '#trash');
  renderSidebar(); renderTopbar(); renderTabs(); renderStatus();
  $('filebar').hidden = true;

  const c = $('content');
  c.innerHTML = '<div class="scope"><div class="scope-sub"><span class="spinner"></span></div></div>';
  const { items } = await api('GET', '/api/trash');
  c.innerHTML = '';
  const box = el('div', 'scope');
  box.appendChild(el('h2', null, 'Trash'));
  box.appendChild(el('div', 'scope-sub',
    'Deleted items, newest first. Contents were committed to history before removal, so anything here is recoverable two ways.'));

  if (!items.length) {
    box.appendChild(el('div', 'scope-sub', 'Nothing deleted yet.'));
    c.appendChild(box);
    return;
  }
  for (const it of items) {
    const row = el('div', 'scope-item');
    row.appendChild(el('div', 'scope-rank', it.isDir ? 'DIR' : 'FILE'));
    const body = el('div', 'scope-body');
    body.appendChild(el('div', 'scope-path', it.display));
    body.appendChild(el('div', 'scope-note',
      `${new Date(it.deletedAt).toLocaleString()} · ${it.fileCount} file${it.fileCount === 1 ? '' : 's'}` +
      (it.restorable ? '' : ' · something now exists at that path')));
    row.appendChild(body);
    const btn = el('button', 'btn ghost scope-open', 'Restore');
    btn.disabled = !it.restorable;
    btn.onclick = async () => {
      try {
        const r = await api('POST', '/api/trash/restore', { id: it.id });
        await refreshRegistry();
        notice('ok', `Restored ${r.display}.`);
        openTrash();
      } catch (e) { notice('error', e.message, null, true); }
    };
    row.appendChild(btn);
    box.appendChild(row);
  }
  c.appendChild(box);
}

/* ── Usage view ──────────────────────────────────────────────────────── */

/**
 * Subscription headroom per seat.
 *
 * This is a routing gauge, not a dashboard: the question it answers is "which
 * subscription should the next task go to", so seats sort by the headroom of
 * their tightest window and the answer is the first line.
 *
 * The studio reads no credential of its own. Codex seats are read live from
 * their own logs; Claude's reading is taken by a separate process and shown
 * with its age rather than implied to be current.
 */

let usageTimer = null;

/**
 * A command the user has to run in their own terminal.
 *
 * The studio never performs a login: the OAuth flow needs a browser, and the
 * credential must not pass through here. So the honest affordance is the exact
 * command, ready to copy.
 */
/**
 * Sign a Codex seat in without leaving the browser.
 *
 * `codex login` prints an OAuth URL and runs a local callback server, so the
 * studio starts it, opens the URL, and polls until the seat has credentials.
 * The token lands in the seat's own auth.json — the studio never sees it.
 */
function connectRow(seat, { reauth = false } = {}) {
  const row = el('div', 'usage-hint');
  const btn = el('button', 'btn', reauth ? 'Sign in as a different account' : 'Sign in with ChatGPT');
  const status = el('span', 'usage-hint-label', '');

  btn.onclick = async () => {
    btn.disabled = true; status.textContent = 'starting sign-in…';
    let res;
    try { res = await api('POST', '/api/usage/connect', { id: seat.seatId, reauth }); }
    catch (e) { btn.disabled = false; status.textContent = ''; return notice('error', e.message); }
    // Something is holding this seat's home open. Signing in now would be
    // undone the next time that process refreshes its token, so offer to stop
    // it here rather than sending the user to a terminal to find pids.
    if (res.conflicts?.length) {
      btn.disabled = false;
      status.textContent = '';
      row.appendChild(conflictRow(seat, res.conflicts, res.error, () => btn.click()));
      return;
    }
    if (res.error) { btn.disabled = false; status.textContent = ''; return notice('error', res.error); }

    // The window.open happens after an await, so the browser's user-activation
    // window may have expired and the popup be blocked silently. Always render
    // the link too, so a blocked tab is a visible next step rather than a UI
    // that claims to be waiting for something that never opened.
    const opened = window.open(res.url, '_blank', 'noopener');
    const link = el('a', 'usage-hint-link', 'Open the sign-in page');
    link.href = res.url;
    link.target = '_blank';
    link.rel = 'noopener';
    row.appendChild(link);
    status.textContent = opened
      ? 'waiting for you to finish in the other tab…'
      : 'your browser blocked the popup — use the link';

    // Poll rather than hold a request open for the whole OAuth round trip.
    const started = Date.now();
    const poll = setInterval(async () => {
      if (S.view !== 'usage') return clearInterval(poll);
      let st;
      try { st = await api('POST', '/api/usage/connect/state', { id: seat.seatId }); }
      catch { return; }
      if (st.signedIn) {
        clearInterval(poll);
        // Reconcile through the CLI before repainting. It is the only process
        // that can read account identity, so until it has run, the studio
        // cannot know this seat changed account — and would keep filtering
        // against the previous login.
        status.textContent = 'signed in — checking this seat…';
        try { await api('POST', '/api/usage/refresh'); } catch { /* the repaint still shows state */ }
        notice('info', `${seat.label} is signed in. Its usage appears after the seat runs once.`);
        paintUsage();
      } else if (!st.running && Date.now() - started > 5000) {
        clearInterval(poll);
        btn.disabled = false;
        status.textContent = 'sign-in was cancelled or did not complete';
      }
    }, 2000);
  };

  row.appendChild(btn);
  row.appendChild(status);
  return row;
}

/**
 * A seat is busy: running Codex processes hold its home open.
 *
 * This is the UI for a failure that used to be a runbook instruction. A Codex
 * process refreshes its credentials back into its home on its own schedule, so
 * one left running across a sign-in silently undoes it minutes later. "Quit
 * your session first" is not actionable — nobody can see which sessions those
 * are. So: name them, and offer one button.
 */
function conflictRow(seat, conflicts, message, retry) {
  const box = el('div', 'usage-conflict');
  box.appendChild(el('div', 'usage-conflict-why', message
    || 'Something is using this seat right now. Signing in would be undone when it next refreshes.'));

  const list = el('div', 'usage-conflict-list');
  for (const c of conflicts) {
    list.appendChild(el('div', 'usage-conflict-item', `${c.command} · pid ${c.pid}`));
  }
  box.appendChild(list);

  const stop = el('button', 'btn', conflicts.length === 1 ? 'Quit it and sign in' : 'Quit them and sign in');
  stop.onclick = async () => {
    stop.disabled = true;
    stop.textContent = 'stopping…';
    let r;
    try { r = await api('POST', '/api/usage/seats/conflicts/stop', { id: seat.seatId, pids: conflicts.map((c) => c.pid) }); }
    catch (e) { stop.disabled = false; stop.textContent = 'Quit them and sign in'; return notice('error', e.message); }
    if (r.remaining?.length) {
      stop.disabled = false;
      stop.textContent = 'Try again';
      return notice('error',
        `${r.remaining.length} still running (${r.remaining.map((x) => x.pid).join(', ')}). ` +
        'Some processes need to be closed from their own window.');
    }
    box.remove();
    retry();
  };
  box.appendChild(stop);
  box.appendChild(el('div', 'usage-conflict-note',
    'They are asked to stop, not force-killed, so anything in progress gets to save.'));
  return box;
}

/**
 * A seat is still parked in the shared ~/.codex.
 *
 * Not an error — it usually reads fine — which is why this is offered on a
 * healthy card too. The point is that its ACCOUNT can be changed by things the
 * user never sees: the ChatGPT desktop app, a bare `codex login`, any
 * long-lived process refreshing a token back into that folder.
 */
function sharedHomeNotice(s) {
  const warn = el('div', 'usage-conflict');
  warn.appendChild(el('div', 'usage-conflict-why',
    'This seat shares the default Codex folder with the ChatGPT app and every plain ' +
    '`codex` command. Anything that signs in there changes this seat\'s account. ' +
    'Moving it to its own folder means only you decide what it is signed in to.'));
  const move = el('button', 'btn', 'Move to its own folder');
  move.onclick = async () => {
    move.disabled = true; move.textContent = 'moving…';
    try {
      await api('POST', '/api/usage/seats/move', { id: s.seatId });
      notice('info', `${s.label} now has its own folder. Sign it in to finish.`);
    } catch (e) {
      move.disabled = false; move.textContent = 'Move to its own folder';
      return notice('error', e.message);
    }
    await paintUsage();
  };
  warn.appendChild(move);
  warn.appendChild(el('div', 'usage-conflict-note',
    'Your settings stay shared. Only the sign-in and session history become private, ' +
    'so you will sign in once more after this.'));
  return warn;
}

/** The seat's account changed since we last looked — deliberate, or not. */
function accountChangedNotice() {
  return el('div', 'usage-offline-why',
    'This seat is signed in to a different account than last time. If you did not just ' +
    're-authenticate it, something else is writing to this folder — earlier readings have ' +
    'been discarded because they belong to the previous account.');
}

/** Signed in, but Codex has not recorded a quota reading yet. */
function waitingHint() {
  const row = el('div', 'usage-hint');
  row.appendChild(el('span', 'usage-hint-label',
    'Connected. Codex reports quota only after a turn runs, so this fills in the first time you use this seat.'));
  return row;
}

/**
 * Shell shortcuts panel.
 *
 * The point of the whole feature: switching subscriptions should be a word you
 * type, not a path you remember. Everything here is one screen of plain choices;
 * the validation that makes it safe lives on the server, because this output is
 * executed by every terminal the user opens.
 */
function shortcutsPanel(state) {
  const form = el('div', 'usage-add');
  form.appendChild(el('div', 'usage-add-title', 'Terminal shortcuts'));

  if (!state.shortcuts.length) {
    form.appendChild(el('div', 'usage-add-note',
      'Shortcuts apply to Codex seats — they are the only ones whose account is chosen by ' +
      'the terminal. Add a second Codex seat and it will appear here.'));
    return form;
  }

  const edits = { words: {}, flags: {}, defaultId: (state.shortcuts.find((s) => s.isDefault) || {}).id };
  for (const sc of state.shortcuts) {
    const row = el('div', 'usage-add-row');
    row.appendChild(el('span', 'usage-shortcut-seat', sc.label));

    const word = document.createElement('input');
    word.className = 'usage-add-label';
    word.value = sc.word;
    word.maxLength = 24;
    word.placeholder = 'word to type';
    word.oninput = () => { edits.words[sc.id] = word.value.trim(); };

    const flags = document.createElement('input');
    flags.className = 'usage-add-label';
    flags.value = sc.flags || '';
    flags.maxLength = 120;
    flags.placeholder = 'always-on flags (e.g. --yolo)';
    flags.oninput = () => { edits.flags[sc.id] = flags.value.trim(); };

    // Which seat a bare `codex` spends is an explicit choice — otherwise it
    // would follow registry order, and reordering seats would quietly move a
    // subscription's spend.
    const def = document.createElement('label');
    def.className = 'usage-shortcut-default';
    const radio = document.createElement('input');
    radio.type = 'radio'; radio.name = 'acs-default-seat';
    radio.checked = !!sc.isDefault;
    radio.onchange = () => { edits.defaultId = sc.id; };
    def.appendChild(radio);
    def.appendChild(document.createTextNode(' default'));

    row.appendChild(word); row.appendChild(flags); row.appendChild(def);
    form.appendChild(row);
    form.appendChild(el('div', 'usage-add-note',
      `Type “${sc.word}”, “codex ${sc.word}”, or “codex-${sc.word}” — each runs Codex on this seat.` +
      (sc.isDefault ? ' A plain “codex” runs this one.' : '')));
  }

  const controls = el('div', 'usage-add-row');
  const save = el('button', 'btn', state.installed ? 'Save' : 'Turn on shortcuts');
  save.onclick = async () => {
    save.disabled = true;
    const words = { ...Object.fromEntries(state.shortcuts.map((s) => [s.id, s.word])), ...edits.words };
    const flags = { ...Object.fromEntries(state.shortcuts.map((s) => [s.id, s.flags || ''])), ...edits.flags };
    try {
      const r = await api('POST', '/api/usage/shortcuts',
        { words, flags, defaultId: edits.defaultId, install: true });
      notice('info', `Shortcuts saved: ${r.shortcuts.map((s) => s.word).join(', ')}. ` +
        'Open a new terminal tab to use them.');
    } catch (e) { notice('error', e.message); }
    save.disabled = false;
    await paintUsage();
  };
  controls.appendChild(save);

  if (state.installed) {
    const off = el('button', 'btn ghost', 'Turn off');
    off.onclick = async () => {
      off.disabled = true;
      try {
        await api('POST', '/api/usage/shortcuts', { words: {}, flags: {}, install: false });
        notice('info', 'Shortcuts removed from your shell. Existing tabs keep them until reopened.');
      } catch (e) { notice('error', e.message); }
      await paintUsage();
    };
    controls.appendChild(off);
  }
  form.appendChild(controls);

  form.appendChild(el('div', 'usage-add-note',
    state.installed
      ? `Active in every terminal. Installed as one line in ${state.zshenv}, which zsh reads for ` +
        'every shell — new tabs, scripts and all. Switching seats never asks you to sign in again.'
      : 'Turning these on adds a single line to your shell profile. Nothing else on your machine changes.'));
  form.appendChild(el('div', 'usage-add-note',
    'Quit a running Codex session before switching — the account is fixed when it starts.'));
  return form;
}

function addSeatForm() {
  const form = el('div', 'usage-add');
  form.appendChild(el('div', 'usage-add-title', 'Track another subscription'));

  const row = el('div', 'usage-add-row');
  const vendor = document.createElement('select');
  vendor.className = 'usage-add-vendor';
  for (const [value, text] of [['codex', 'Codex (ChatGPT)'], ['claude', 'Claude'], ['grok', 'Grok']]) {
    const o = document.createElement('option');
    o.value = value; o.textContent = text;
    vendor.appendChild(o);
  }
  const label = document.createElement('input');
  label.className = 'usage-add-label';
  label.placeholder = 'Name it — e.g. "Codex (work)"';
  label.maxLength = 60;

  const save = el('button', 'btn', 'Add');
  const submit = async () => {
    if (!label.value.trim()) return label.focus();
    save.disabled = true;
    let res;
    try { res = await api('POST', '/api/usage/seats', { vendor: vendor.value, label: label.value.trim() }); }
    catch (e) { save.disabled = false; return notice('error', e.message); }
    S.usageAdding = false;
    await paintUsage();
    if (res.loginCommand) {
      notice('info', `Seat added. Run the login command shown on "${res.seat.label}" to connect it.`);
    } else if (res.note) {
      notice('info', res.note);
    }
  };
  save.onclick = submit;
  label.onkeydown = (e) => { if (e.key === 'Enter') submit(); };

  row.appendChild(vendor); row.appendChild(label); row.appendChild(save);
  form.appendChild(row);
  form.appendChild(el('div', 'usage-add-note',
    'A second Codex seat gets its own home, sharing your config by symlink — only the login and ' +
    'session history differ. You sign in from here; no terminal needed. ' +
    'A Grok seat reads its weekly quota through the Grok CLI, so sign in with `grok login` first.'));
  return form;
}


/** A seat's headroom is set by its tightest window — the first one to stop you. */
function seatHeadroom(s) {
  // A stale reading is not headroom, it is a memory — never route on it.
  if (!s.ok || s.stale || !s.windows.length) return null;
  return 100 - Math.max(...s.windows.map((w) => w.usedPercent));
}

function untilText(ts) {
  if (!ts) return '';
  const ms = ts - Date.now();
  if (ms <= 0) return 'resetting';
  const h = Math.floor(ms / 3.6e6), mn = Math.round((ms % 3.6e6) / 6e4);
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  return h ? `${h}h ${mn}m` : `${mn}m`;
}

const fmtTokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
const agoText = (ms) => (ms == null ? '' : ms < 60000 ? 'just now' : `${untilText(Date.now() + ms)} ago`);

async function openUsage() {
  if (!confirmDiscard()) return;
  S.view = 'usage';
  S.entry = null;
  window.history.replaceState(null, '', '#usage');
  renderSidebar(); renderTopbar(); renderTabs(); renderStatus();
  $('filebar').hidden = true;

  const c = $('content');
  c.innerHTML = '<div class="scope"><div class="scope-sub"><span class="spinner"></span> reading usage…</div></div>';
  await paintUsage();

  // Meant to be left open, so it keeps itself current. Cleared whenever the
  // view changes so a closed panel is not polling forever.
  clearInterval(usageTimer);
  usageTimer = setInterval(() => {
    if (S.view !== 'usage') { clearInterval(usageTimer); usageTimer = null; return; }
    paintUsage();
  }, 60_000);
}

async function paintUsage() {
  const c = $('content');
  let u;
  try { u = await api('GET', '/api/usage'); }
  catch (e) { c.innerHTML = `<div class="scope"><div class="scope-sub">${esc(e.message)}</div></div>`; return; }
  if (S.view !== 'usage') return;   // the view changed while the request was in flight

  const seats = [...(u.seats || [])].sort((a, b) => {
    const ha = seatHeadroom(a), hb = seatHeadroom(b);
    if (ha === null && hb === null) return 0;
    if (ha === null) return 1;      // unreadable seats sink; they are not "full"
    if (hb === null) return -1;
    return hb - ha;
  });

  c.innerHTML = '';
  const box = el('div', 'scope');

  const panelHead = el('div', 'usage-head');
  panelHead.appendChild(el('h2', null, 'Subscription usage'));
  const actions = el('div', 'usage-actions');

  const refresh = el('button', 'btn ghost', 'Refresh');
  refresh.onclick = async () => {
    refresh.disabled = true; refresh.textContent = 'Refreshing…';
    // The reading Claude needs a token for is taken by a child process, so the
    // credential never enters the studio. It can take a second.
    try { await api('POST', '/api/usage/refresh'); } catch (e) { notice('error', e.message); }
    await paintUsage();
  };
  actions.appendChild(refresh);

  const addBtn = el('button', 'btn ghost', '+ Add seat');
  addBtn.onclick = () => { S.usageAdding = !S.usageAdding; paintUsage(); };
  actions.appendChild(addBtn);

  const scBtn = el('button', 'btn ghost', 'Shortcuts');
  scBtn.onclick = () => { S.usageShortcuts = !S.usageShortcuts; paintUsage(); };
  actions.appendChild(scBtn);
  panelHead.appendChild(actions);
  box.appendChild(panelHead);

  if (S.usageAdding) box.appendChild(addSeatForm());
  if (S.usageShortcuts) {
    let sc = null;
    try { sc = await api('GET', '/api/usage/shortcuts'); } catch (e) { notice('error', e.message); }
    if (sc) box.appendChild(shortcutsPanel(sc));
  }

  if (!seats.length) {
    box.appendChild(el('div', 'scope-sub',
      'No subscriptions tracked yet — use + Add seat above.'));
    c.appendChild(box);
    return;
  }

  const best = seats.find((s) => seatHeadroom(s) !== null);
  const head = el('div', 'usage-route');
  if (best) {
    head.appendChild(el('span', 'usage-route-label', 'Route to'));
    head.appendChild(el('span', 'usage-route-seat', best.label));
    head.appendChild(el('span', 'usage-route-pct', `${Math.round(seatHeadroom(best))}% left`));
  } else {
    head.appendChild(el('span', 'usage-route-label', 'No seat is reporting usable headroom'));
  }
  box.appendChild(head);

  for (const s of seats) {
    const card = el('div', 'usage-seat');
    const title = el('div', 'usage-seat-head');
    title.appendChild(el('span', 'usage-seat-name', s.label));
    const meta = [s.vendor, s.planType, s.subscriptionType].filter(Boolean).join(' · ');
    title.appendChild(el('span', 'usage-seat-meta', meta));
    card.appendChild(title);

    const drop = el('button', 'usage-drop', '×');
    drop.title = 'Stop tracking this seat';
    drop.onclick = async () => {
      // Unregisters only. The seat's home holds a real login and its history,
      // so removing a row from a list must never destroy credentials.
      if (!confirm(`Stop tracking "${s.label}"?\n\nIts login and history stay on disk.`)) return;
      try { await api('POST', '/api/usage/seats/remove', { id: s.seatId }); }
      catch (e) { return notice('error', e.message); }
      paintUsage();
    };
    title.appendChild(drop);

    if (!s.ok) {
      // A signed-in seat with no turns yet is a different state from one that
      // was never connected, and telling someone to re-run a login that already
      // worked is the worst thing this panel could do.
      // Three states, not two. A seat whose vendor publishes no quota is
      // connected and working — calling it "not connected" is simply false.
      const duplicate = Boolean(s.duplicateOf);
      const noQuota = !duplicate && s.noQuota === true && s.signedIn === true;
      // A seat whose window rolled over HAS usage — it is just too old to trust.
      // Calling that "no usage yet" contradicted the reason line printed
      // directly beneath it and sent people to re-run a login that had worked.
      const rolled = !duplicate && !noQuota && s.windowRolledOver === true;
      const waiting = !duplicate && !noQuota && !rolled && s.signedIn === true;
      const why = el('div', 'usage-offline');
      const tag = el('span', 'usage-offline-tag',
        duplicate ? 'duplicate account'
          : noQuota ? 'connected · no quota published'
          : rolled ? 'signed in · reading out of date'
          : waiting ? 'signed in · no usage yet' : 'not connected');
      if (waiting || noQuota || rolled) tag.classList.add('waiting');
      if (duplicate) tag.classList.add('duplicate');
      why.appendChild(tag);
      why.appendChild(el('span', 'usage-offline-why', s.reason || ''));
      card.appendChild(why);

      if (noQuota && s.activity) {
        const bits = [];
        if (s.activity.turns) {
          bits.push(`${s.activity.turns} turn${s.activity.turns === 1 ? '' : 's'} in the last 24h`);
          bits.push(`${fmtTokens(s.activity.inputTokens + s.activity.outputTokens)} tokens`);
        }
        if (s.lastActiveAt) bits.push(`last used ${agoText(Date.now() - s.lastActiveAt)}`);
        // Deliberately no dollar figure: the cost field is in "ticks" whose
        // scale is unverified, and a wrong one would be a confident wrong number.
        if (bits.length) card.appendChild(el('div', 'usage-note', bits.join(' · ')));
      }
      if (s.vendor === 'codex' && s.home) {
        // A duplicate is signed in — it just needs a DIFFERENT account, so the
        // affordance is re-auth, not sign-in.
        card.appendChild(s.duplicateOf ? connectRow(s, { reauth: true })
          : waiting ? waitingHint() : connectRow(s));
      }
    } else {
      for (const w of s.windows) {
        const row = el('div', 'usage-row');
        const track = el('div', 'usage-track');
        const fill = el('div', 'usage-fill');
        // Everything in this panel measures what is LEFT, never what is spent.
        // Both directions used to appear here at once — an unlabelled "72%" on
        // the bar meaning spent, and "97% headroom" in the summary meaning
        // left — which put the conversion in the reader's head and got a seat
        // read as empty when it was untouched. One direction, stated in words.
        const left = Math.min(100, Math.max(0, 100 - w.usedPercent));
        fill.style.width = `${left}%`;
        // Tinting is by pressure, not by vendor: the colour has to mean the
        // same thing on every gauge or it stops being readable at a glance.
        fill.dataset.level = left <= 10 ? 'high' : left <= 30 ? 'mid' : 'low';
        track.appendChild(fill);
        row.appendChild(el('span', 'usage-pct', `${Math.round(left)}% left`));
        row.appendChild(track);
        const lbl = el('span', 'usage-label', w.label);
        if (w.resetsAt) lbl.appendChild(el('span', 'usage-reset', ` resets in ${untilText(w.resetsAt)}`));
        row.appendChild(lbl);
        card.appendChild(row);
      }
      const notes = [];
      if (s.credits?.hasCredits) {
        notes.push(`credits ${s.credits.unlimited ? 'unlimited'
          : (s.credits.balance == null ? 'available' : s.credits.balance)}`);
      }
      if (s.extraUsage?.enabled) {
        notes.push(`extra usage ${s.extraUsage.usedCredits}/${s.extraUsage.monthlyLimit} ${s.extraUsage.currency}`);
      }
      // A reading is only as good as its age. Codex readings come from the last
      // turn that ran, so an idle seat's number can be hours old and still true.
      // A held-over reading must say so, or a stale number looks current.
      if (s.staleReason) notes.push(`${s.staleReason} — showing the last good reading`);
      if (s.stale && s.observedAt) {
        const stale = el('div', 'usage-stale',
          `as of ${agoText(Date.now() - s.observedAt)} — not current. Run a turn on this seat to refresh it.`);
        card.appendChild(stale);
      }
      if (s.expiredWindows) notes.push(`${s.expiredWindows} window(s) hidden — already reset`);
      if (s.readingAge != null && s.readingAge > 5 * 60_000) notes.push(`read ${agoText(s.readingAge)}`);
      else if (s.observedAt && Date.now() - s.observedAt > 30 * 60_000) {
        notes.push(`last recorded turn ${agoText(Date.now() - s.observedAt)}`);
      }
      if (notes.length) card.appendChild(el('div', 'usage-note', notes.join(' · ')));
    }
    // Both notices live at CARD level, not inside the not-ok branch. A seat
    // parked in the shared folder is usually reading perfectly well — that is
    // exactly the state the offer is for — and an account change that already
    // has a reading would otherwise be invisible.
    if (s.sharedHome) card.appendChild(sharedHomeNotice(s));
    if (s.accountChanged) card.appendChild(accountChangedNotice());

    box.appendChild(card);
  }

  box.appendChild(el('div', 'scope-sub',
    'Codex reads its own logs live. Claude needs an OAuth token, which the studio never handles ' +
    'itself — Refresh takes that reading in a separate process.'));
  c.appendChild(box);
}

/* ── MCP view ────────────────────────────────────────────────────────── */
async function openMcp() {
  if (!confirmDiscard()) return;
  S.view = 'mcp';
  S.entry = null;
  window.history.replaceState(null, '', '#mcp');
  renderSidebar(); renderTopbar(); renderTabs(); renderStatus();
  $('filebar').hidden = true;

  const c = $('content');
  c.innerHTML = '<div class="scope"><div class="scope-sub"><span class="spinner"></span> reading MCP config…</div></div>';
  let m;
  try { m = await api('GET', '/api/mcp'); }
  catch (e) { c.innerHTML = `<div class="scope"><div class="scope-sub">${esc(e.message)}</div></div>`; return; }

  c.innerHTML = '';
  const box = el('div', 'scope');
  box.appendChild(el('h2', null, 'MCP servers'));
  box.appendChild(el('div', 'scope-sub', m.note || ''));

  const section = (title, rows, empty) => {
    box.appendChild(el('p', 'assist-label', title));
    if (!rows.length) { box.appendChild(el('div', 'scope-sub', empty)); return; }
    for (const s of rows) {
      const row = el('div', 'scope-item');
      row.appendChild(el('div', 'scope-rank', s.name.slice(0, 2).toUpperCase()));
      const body = el('div', 'scope-body');
      body.appendChild(el('div', 'scope-path', s.name));
      const bits = [s.scope, s.transport, s.target].filter(Boolean);
      body.appendChild(el('div', 'scope-note', bits.join(' · ')));
      row.appendChild(body);
      box.appendChild(row);
    }
  };

  section('Claude Code — read-only', m.global, 'No MCP servers configured.');
  section('Codex', m.codex, 'No MCP servers in config.toml.');

  const editable = S.registry.groups.find((g) => g.id === 'mcp');
  if (editable) {
    box.appendChild(el('p', 'assist-label', 'Project .mcp.json — editable'));
    for (const e of editable.entries) {
      const row = el('div', 'scope-item');
      row.appendChild(el('div', 'scope-rank', '{ }'));
      const body = el('div', 'scope-body');
      body.appendChild(el('div', 'scope-path', e.display));
      body.appendChild(el('div', 'scope-note', e.description || ''));
      row.appendChild(body);
      const open = el('button', 'btn ghost scope-open', 'Open');
      open.onclick = () => openEntry(e);
      row.appendChild(open);
      box.appendChild(row);
    }
  }
  c.appendChild(box);
}

/* ── assist chat ─────────────────────────────────────────────────────── */
/**
 * Sessions are the unit of work: one thread about one topic, kept across drawer
 * open/close and page reloads. Up to MAX_SESSIONS are retained; the CLI session
 * behind a thread is an implementation detail that changes when you compact,
 * while the thread itself keeps its identity.
 */
const MAX_SESSIONS = 5;
const CONTEXT_LIMIT = 200_000;
const SESSIONS_KEY = 'acs.sessions.v2';

const C = {
  sessions: [],
  activeId: null,
  busy: false,
  stream: '',
  startedAt: 0,
  running: null,        // {harness, model} captured at submit — see sendTurn
  abort: null,
  draft: '',
  picker: null,
  harness: null,        // reconciled against the server's detected list at boot
  model: 'claude-sonnet-5',
};

/* ── harness ─────────────────────────────────────────────────────────── */
/**
 * Which CLI runs Assist. The choice is explicit and sticky: it never follows
 * the file you have open. A model that changes underneath you as you move
 * between files produces "why did this answer get worse" reports that nobody
 * can reproduce.
 */
const harnesses = () => S.registry?.harnesses ?? [];
const harnessOf = (id) => harnesses().find((h) => h.id === id) || null;
const harnessLabel = (id) => harnessOf(id)?.label ?? id ?? 'no harness';
/** The server sends each harness's models as [{id,label}] — its own allowlist. */
const modelsOf = (h) => h?.models ?? [];

/**
 * Reconcile the stored choice with what the server actually detected. A harness
 * that has gone away is reported, not swapped out from under you — the whole
 * point of the picker is that you know what answered.
 */
function resolveHarness() {
  const list = harnesses();
  if (!list.length) { C.harness = null; return; }
  const want = C.harness;
  const h = harnessOf(want) ?? harnessOf(S.registry.defaultHarness) ?? list[0];
  if (want && h.id !== want) {
    notice('warn', `${want} is no longer available here — Assist switched to ${h.label}.`, null, true);
  }
  if (h.id !== C.harness) {
    C.harness = h.id;
    // Moved off a harness you had chosen — its model means nothing here. With
    // nothing stored (first run, or a session written before the picker) the
    // model below is still valid and worth keeping.
    if (want) C.model = h.defaultModel;
  }
  // A stored model may belong to a harness you have since left.
  if (!modelsOf(h).some((m) => m.id === C.model)) C.model = h.defaultModel;
  saveSessions();
}

const PRESETS = [
  ['Tighten', 'Tighten the attached file. Cut filler and hedging. Preserve every rule, path, command and threshold exactly. Do not add rules.'],
  ['Critique', 'Review the attached file and give me the three most important problems — ambiguous rules, contradictions, or anything stale. Be specific and quote the text. Do not rewrite it.'],
  ['Improve description', 'Improve only the `description` field in the frontmatter so the model loads this skill at the right moment. Leave everything else byte-identical.'],
];

const COMPACT_PROMPT =
  'Summarise this conversation so it can continue in a fresh context. Cover: what we are working on, ' +
  'decisions made, edits already applied, and anything still pending. Be dense and specific — file paths, ' +
  'exact wording we settled on, open questions. No preamble. This summary is the only thing that survives.';

function newSession(mentions = []) {
  return {
    id: 's' + Math.random().toString(36).slice(2, 10),
    title: 'New session',
    mentions: [...mentions],
    messages: [],
    slots: {},            // harness id -> its CLI session, seed and stats
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/**
 * Per-harness CLI state inside one thread. The transcript is yours, but the CLI
 * session under it belongs to whichever harness produced it: switching harness
 * parks that slot and opens a fresh one, and switching back resumes where you
 * were. A Claude session id is never offered to grok — the server refuses the
 * pair, and the client has no business asking.
 */
function newSlot() {
  return {
    cliSessionId: null,
    seed: null,
    compactions: 0,
    stats: { turns: 0, contextTokens: 0, costUsd: 0, baselineTokens: 0 },
  };
}
const slotOf = (s, harness = C.harness) => s?.slots?.[harness || 'none'] ?? null;
function slotFor(s, harness = C.harness) {
  const key = harness || 'none';
  s.slots ||= {};
  return (s.slots[key] ||= newSlot());
}

function active() {
  return C.sessions.find((s) => s.id === C.activeId) || null;
}

function ensureSession() {
  let s = active();
  if (!s) {
    if (!C.sessions.length) {
      s = newSession(S.file ? [S.file.path] : []);
      C.sessions.unshift(s);
    } else {
      s = C.sessions[0];
    }
    C.activeId = s.id;
  }
  return s;
}

function saveSessions() {
  try {
    localStorage.setItem(SESSIONS_KEY, JSON.stringify({
      activeId: C.activeId,
      harness: C.harness,
      model: C.model,
      sessions: C.sessions.map((s) => ({
        ...s,
        // Proposals are dropped: by next load the file may have moved on, and a
        // stale diff must never remain applyable.
        messages: s.messages.map((m) => ({
          role: m.role, text: m.text, error: m.error, note: m.note,
          mentions: m.mentions, harness: m.harness,
        })),
      })),
    }));
  } catch { /* quota or private mode */ }
}

function restoreSessions() {
  try {
    const raw = localStorage.getItem(SESSIONS_KEY);
    if (!raw) return;
    const t = JSON.parse(raw);
    C.sessions = (t.sessions || []).slice(0, MAX_SESSIONS).map((s) => {
      // Sessions written before the picker have one flat CLI session, and it
      // can only have come from Claude.
      const { cliSessionId, seed, stats, compactions, ...rest } = s;
      return {
        ...rest,
        slots: s.slots ?? {
          claude: {
            cliSessionId: cliSessionId ?? null,
            seed: seed ?? null,
            compactions: compactions ?? 0,
            stats: { ...newSlot().stats, ...(stats || {}) },
          },
        },
        messages: (s.messages || []).map((m) => ({ ...m, proposals: [] })),
      };
    });
    C.activeId = t.activeId && C.sessions.some((s) => s.id === t.activeId) ? t.activeId : (C.sessions[0]?.id ?? null);
    if (t.harness) C.harness = t.harness;
    if (t.model) C.model = t.model;
  } catch { /* corrupt store — start clean */ }
}

/** Context is a property of the CLI session, so it is read per harness slot. */
function contextPct(s) {
  return Math.min(100, Math.round(((slotOf(s)?.stats.contextTokens || 0) / CONTEXT_LIMIT) * 100));
}
const contextLeft = (s) => 100 - contextPct(s);

/** Tokens attributable to this conversation, excluding fixed harness overhead. */
function conversationTokens(s) {
  const st = slotOf(s)?.stats;
  if (!st?.baselineTokens) return 0;
  return Math.max(0, (st.contextTokens || 0) - st.baselineTokens);
}
/** Below this, compaction frees less than it costs to run. */
const COMPACT_WORTH_IT = 15_000;

function titleFor(s) {
  if (s.title && s.title !== 'New session') return s.title;
  const firstUser = s.messages.find((m) => m.role === 'user');
  if (firstUser) return firstUser.text.replace(/\s+/g, ' ').slice(0, 42);
  if (s.mentions.length) return s.mentions[0].split('/').pop();
  return 'New session';
}

/* ── drawer ──────────────────────────────────────────────────────────── */
function openDrawer() {
  $('drawer').classList.add('open');
  $('scrim').classList.add('open');
  const s = ensureSession();
  // Default the target to whatever is open — still you pointing at it, just
  // without retyping what you are already looking at.
  if (!s.mentions.length && S.file) s.mentions = [S.file.path];
  renderChat();
  setTimeout(() => $('chat-input')?.focus(), 60);
}
function closeDrawer() {
  $('drawer').classList.remove('open');
  $('scrim').classList.remove('open');
}

function allFiles() {
  const out = [];
  for (const g of S.registry.groups) {
    for (const e of g.entries) {
      for (const f of e.files) out.push({ ...f, group: g.title, entry: e.label, harness: e.harness });
    }
  }
  return out;
}

function renderChat() {
  renderSessionBar();
  renderChatBody();
  renderCompose();
}

/* ── session bar ─────────────────────────────────────────────────────── */
function renderSessionBar() {
  const bar = $('session-bar');
  const s = active();
  bar.innerHTML = '';
  if (!s) { bar.hidden = true; return; }
  bar.hidden = false;

  // Switcher
  const row = el('div', 'sess-row');
  const sel = el('select', 'sess-select');
  C.sessions.forEach((x) => {
    const comp = slotOf(x)?.compactions ?? 0;
    const o = el('option', null,
      `${titleFor(x)}  ·  ${contextLeft(x)}% left${comp ? ` · compacted ×${comp}` : ''}`);
    o.value = x.id;
    if (x.id === C.activeId) o.selected = true;
    sel.appendChild(o);
  });
  sel.onchange = () => { C.activeId = sel.value; C.draft = ''; saveSessions(); renderChat(); };
  row.appendChild(sel);

  const add = el('button', 'btn ghost sess-btn', '+');
  add.title = `New session (${C.sessions.length}/${MAX_SESSIONS})`;
  add.onclick = createSession;
  row.appendChild(add);

  const del = el('button', 'btn ghost sess-btn', '×');
  del.title = 'Delete this session';
  del.onclick = deleteSession;
  row.appendChild(del);
  bar.appendChild(row);

  // Context meter — how much room is LEFT, which is the number that matters.
  // It describes the CURRENT harness's slot; switching harness shows that one.
  const sl = slotFor(s);
  const left = contextLeft(s);
  const label = el('div', 'sess-label');
  const big = el('span', 'sess-left', `${left}% context left`);
  if (left <= 15) big.classList.add('hot');
  else if (left <= 35) big.classList.add('warm');
  label.appendChild(big);
  const conv = conversationTokens(s);
  label.appendChild(el('span', 'sess-dim',
    `${sl.stats.turns} turn${sl.stats.turns === 1 ? '' : 's'}` +
    (sl.stats.baselineTokens
      ? ` · ${(conv / 1000).toFixed(1)}k conversation + ${(sl.stats.baselineTokens / 1000).toFixed(0)}k overhead`
      : ` · ${(sl.stats.contextTokens / 1000).toFixed(1)}k / 200k`)));
  if (sl.stats.costUsd) label.appendChild(el('span', 'sess-dim', `$${sl.stats.costUsd.toFixed(2)}`));

  const convo = conversationTokens(s);
  const compact = el('button', 'btn ghost sess-compact', 'Compact');
  compact.disabled = C.busy || !sl.cliSessionId || convo < COMPACT_WORTH_IT;
  compact.title = convo < COMPACT_WORTH_IT
    ? `Not worth it yet — only ${(convo / 1000).toFixed(1)}k of this context is the conversation. ` +
      `The other ${(sl.stats.baselineTokens / 1000).toFixed(0)}k is ${harnessLabel(C.harness)}'s own overhead and compaction cannot reclaim it.`
    : `Summarise ${(convo / 1000).toFixed(1)}k of conversation and continue in a fresh context. Same session.`;
  compact.onclick = compactSession;
  label.appendChild(compact);
  bar.appendChild(label);

  const meter = el('div', 'sess-meter');
  const fill = el('div', 'sess-fill');
  fill.style.width = `${Math.max(2, 100 - left)}%`;
  if (left <= 15) fill.classList.add('hot');
  else if (left <= 35) fill.classList.add('warm');
  meter.appendChild(fill);
  bar.appendChild(meter);

  if (left <= 15) {
    bar.appendChild(el('div', 'sess-warn',
      'Nearly full. Auto-compaction is off in your settings, so compact this thread or start a new one before the next turn.'));
  }
}

function createSession() {
  if (C.sessions.length >= MAX_SESSIONS) {
    notice('warn',
      `You're at the ${MAX_SESSIONS}-session cap. Delete one with × before starting another.`, null, true);
    return;
  }
  const s = newSession(S.file ? [S.file.path] : []);
  C.sessions.unshift(s);
  C.activeId = s.id;
  C.draft = '';
  saveSessions();
  renderChat();
}

function deleteSession() {
  const s = active();
  if (!s) return;
  if (s.messages.length && !confirm(`Delete "${titleFor(s)}"?\n\nThe conversation is discarded. Files and edits you already accepted are untouched.`)) return;
  C.sessions = C.sessions.filter((x) => x.id !== s.id);
  C.activeId = C.sessions[0]?.id ?? null;
  if (!C.sessions.length) ensureSession();
  saveSessions();
  renderChat();
}

/**
 * Manual compaction. Claude Code's own /compact does not work through
 * `-p --resume` — it reports success but the history is gone, verified. So we
 * ask for a summary, then continue the same thread on a fresh CLI session
 * seeded with it. Same session to you; new session id underneath.
 */
async function compactSession() {
  const s = active();
  const req = { harness: C.harness, model: C.model };
  const sl = slotFor(s ?? {}, req.harness);
  if (!s || C.busy || !sl.cliSessionId) return;

  C.busy = true;
  C.stream = '';
  C.startedAt = Date.now();
  C.running = req;
  C.abort = new AbortController();
  renderChat();
  clearInterval(tickTimer);
  tickTimer = setInterval(renderChatBody, 1000);

  try {
    const final = await streamChat({
      message: COMPACT_PROMPT,
      mentions: [],
      sessionId: sl.cliSessionId,
      harness: req.harness,
      model: req.model,
      onDelta: () => renderChatBody(),
    });
    // Fail closed: only an explicit ok:true is a success. The server has exactly one
    // `done` sender and it always sets `ok`, so a missing field means a malformed or
    // truncated stream — which must not persist a session id or render as a reply.
    if (final?.ok !== true) throw new Error(final?.error || 'The turn failed.');
    const summary = (C.stream || final?.text || '').trim();
    if (!summary) throw new Error('Compaction returned nothing — thread left as it was.');

    const turnsBefore = sl.stats.turns;
    sl.seed = summary;
    sl.cliSessionId = null;                // next turn starts fresh, seeded
    sl.compactions += 1;
    sl.stats.contextTokens = 0;
    sl.stats.baselineTokens = 0;
    s.messages = [{
      role: 'assistant',
      harness: req.harness,
      note: `Compacted ${turnsBefore} turn${turnsBefore === 1 ? '' : 's'} into a summary. The thread continues from here.`,
      text: summary,
    }];
    saveSessions();
    notice('ok', `Compacted — ${contextLeft(s)}% context free again.`);
  } catch (e) {
    if (e.name !== 'AbortError') notice('error', `Compaction failed: ${e.message}`, null, true);
  } finally {
    clearInterval(tickTimer);
    C.busy = false;
    C.stream = '';
    C.running = null;
    C.abort = null;
    renderChat();
  }
}

/* ── transcript ──────────────────────────────────────────────────────── */
function renderChatBody() {
  const body = $('drawer-body');
  const s = active();
  const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 80;
  body.innerHTML = '';

  if (s && !s.messages.length && !C.busy) {
    const intro = el('div', 'chat-intro');
    intro.appendChild(el('p', 'assist-label', 'Ask for a change'));
    intro.appendChild(el('div', 'scope-sub',
      'Attach the files you want changed with @, then say what you want. Edits come back as diffs you accept per file — nothing is written until you do.'));
    const row = el('div', 'assist-actions');
    for (const [label, text] of PRESETS) {
      const chip = el('button', 'assist-chip', label);
      chip.onclick = () => { C.draft = text; renderCompose(); $('chat-input')?.focus(); };
      row.appendChild(chip);
    }
    intro.appendChild(row);
    body.appendChild(intro);
  }

  for (const m of s?.messages || []) body.appendChild(renderMessage(m));

  if (C.busy) {
    // Named for the harness that is actually running, not the one now picked —
    // you may have switched the dropdown while this turn was in flight.
    const run = C.running || { harness: C.harness };
    const secs = (Date.now() - C.startedAt) / 1000;
    const live = el('div', 'msg assistant');
    const meta = el('div', 'msg-meta');
    meta.appendChild(el('span', 'spinner'));
    meta.appendChild(el('span', null, `${harnessLabel(run.harness)} · ${secs.toFixed(0)}s`));
    live.appendChild(meta);
    const prose = stripEditBlocks(C.stream);
    live.appendChild(prose
      ? el('div', 'msg-text', prose)
      : el('div', 'msg-wait', waitingLine(run.harness, secs)));
    body.appendChild(live);
  }
  if (atBottom) body.scrollTop = body.scrollHeight;
}

/**
 * The silence before the first token is harness-sized — Claude's is ~5s, grok's
 * has been measured at 37s — and a harness with streams:false has no first
 * token at all, only the finished reply. Say which of those you are waiting on;
 * an unexplained spinner reads as a hang.
 */
function waitingLine(harness, secs) {
  if (harnessOf(harness)?.streams === false) {
    return 'Working — this harness returns the whole reply at once, so nothing appears until it is done.';
  }
  return secs < 12 ? 'Working…' : 'Working — still waiting on the first token.';
}

/** Edit blocks are rendered as diffs below, so keep them out of the prose. */
function stripEditBlocks(text) {
  return text
    .replace(/^@@(EDIT|APPEND)[ \t]+.*$[\s\S]*?^@@END[ \t]*$/gm, '')
    .replace(/^@@(EDIT|APPEND)[ \t]+.*$[\s\S]*/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function renderMessage(m) {
  const wrap = el('div', `msg ${m.role}`);
  if (m.note) wrap.appendChild(el('div', 'msg-note', m.note));

  if (m.role === 'user') {
    wrap.appendChild(el('div', 'msg-text', m.text));
    if (m.mentions?.length) {
      const chips = el('div', 'msg-chips');
      for (const p of m.mentions) chips.appendChild(el('span', 'chip-mini', p.split('/').pop()));
      wrap.appendChild(chips);
    }
    return wrap;
  }
  // Threads can mix harnesses, so each reply says who wrote it.
  if (m.harness) wrap.appendChild(el('div', 'msg-meta', harnessLabel(m.harness)));
  if (m.error) { wrap.appendChild(el('div', 'notice error', m.error)); return wrap; }

  const prose = stripEditBlocks(m.text);
  if (prose) {
    const t = el('div', 'msg-text md');
    t.innerHTML = renderMarkdown(prose);
    wrap.appendChild(t);
  }
  for (const p of m.proposals || []) wrap.appendChild(renderProposal(p));
  return wrap;
}

function renderProposal(p) {
  const card = el('div', 'prop');
  const head = el('div', 'prop-head');
  head.appendChild(el('span', 'prop-path', p.display));
  if (!p.error) head.appendChild(el('span', 'item-badge', `${p.edits} edit${p.edits === 1 ? '' : 's'}`));
  card.appendChild(head);

  if (p.error) { card.appendChild(el('div', 'prop-error', p.error)); return card; }
  if (p.state === 'accepted') { card.appendChild(el('div', 'prop-ok', 'Applied and versioned.')); return card; }
  if (p.state === 'rejected') { card.appendChild(el('div', 'prop-error', 'Rejected — nothing written.')); return card; }

  const d = diffView(p.current, p.proposed, 'now', 'proposed');
  d.style.padding = '0';
  card.appendChild(d);

  const foot = el('div', 'prop-foot');
  const accept = el('button', 'btn primary', 'Accept');
  accept.onclick = () => acceptProposal(p);
  const reject = el('button', 'btn ghost', 'Reject');
  reject.onclick = () => { p.state = 'rejected'; renderChatBody(); };
  const open = el('button', 'btn ghost', 'Open file');
  open.onclick = () => {
    const entry = entryForFile(p.path);
    if (entry) { closeDrawer(); openEntry(entry, p.path); }
  };
  foot.append(accept, reject, open);
  card.appendChild(foot);
  return card;
}

async function acceptProposal(p) {
  try {
    const r = await api('PUT', '/api/file', { path: p.path, content: p.proposed, mtime: p.mtime });
    if (!r.saved && r.errors?.length) {
      notice('error', `Not applied — ${p.display} would be invalid:`, r.errors, true);
      return;
    }
    p.state = 'accepted';
    renderChatBody();
    if (S.file?.path === p.path) {
      S.file.mtime = r.mtime;
      S.original = p.proposed;
      S.draft = p.proposed;
      renderAll();
    }
    S.registry.history.commits++;
    notice('ok', `Applied to ${p.display} · version ${r.sha?.slice(0, 8) ?? ''}`);
  } catch (e) {
    notice('error', e.message, null, true);
  }
}

/* ── compose ─────────────────────────────────────────────────────────── */
function renderCompose() {
  const box = $('drawer-compose');
  const s = ensureSession();
  box.innerHTML = '';

  const chips = el('div', 'mention-row');
  for (const p of s.mentions) {
    const chip = el('span', 'mention-chip');
    chip.appendChild(el('span', null, p.split('/').pop()));
    const x = el('button', 'mention-x', '×');
    x.title = p;
    x.onclick = () => { s.mentions = s.mentions.filter((q) => q !== p); saveSessions(); renderCompose(); };
    chip.appendChild(x);
    chips.appendChild(chip);
  }
  const add = el('button', 'mention-add', s.mentions.length ? '+ file' : '@ attach a file');
  add.onclick = () => { C.draft += (C.draft.endsWith(' ') || !C.draft ? '' : ' ') + '@'; openPicker(''); };
  chips.appendChild(add);
  box.appendChild(chips);

  if (C.picker) box.appendChild(renderPicker());

  const input = el('textarea', 'chat-input');
  input.id = 'chat-input';
  input.placeholder = s.mentions.length
    ? 'What should change in these files?'
    : 'Ask a question, or attach a file with @ to make edits…';
  input.value = C.draft;
  input.rows = 3;
  input.oninput = () => {
    C.draft = input.value;
    const m = input.value.slice(0, input.selectionStart).match(/@([^\s@]*)$/);
    if (m) openPicker(m[1], true); else if (C.picker) { C.picker = null; renderCompose(); }
  };
  input.onkeydown = (ev) => {
    if (C.picker) {
      const list = pickerMatches();
      if (ev.key === 'ArrowDown') { ev.preventDefault(); C.picker.index = Math.min(C.picker.index + 1, list.length - 1); renderCompose(); return; }
      if (ev.key === 'ArrowUp') { ev.preventDefault(); C.picker.index = Math.max(C.picker.index - 1, 0); renderCompose(); return; }
      if (ev.key === 'Enter' || ev.key === 'Tab') { ev.preventDefault(); choosePicker(list[C.picker.index]); return; }
      if (ev.key === 'Escape') { ev.preventDefault(); C.picker = null; renderCompose(); return; }
    }
    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); sendTurn(); }
  };
  box.appendChild(input);

  const row = el('div', 'compose-row');

  // Harness first, then that harness's models. Only detected harnesses are
  // offered — the server refuses the rest anyway.
  const list = harnesses();
  const harness = el('select', 'assist-harness');
  harness.title = 'Which CLI answers. Sticky — it never changes with the file you open.';
  if (!list.length) {
    harness.appendChild(el('option', null, 'No harness detected'));
    harness.disabled = true;
  } else {
    for (const h of list) {
      const o = el('option', null, h.label); o.value = h.id;
      if (h.id === C.harness) o.selected = true;
      harness.appendChild(o);
    }
  }
  harness.onchange = () => {
    C.harness = harness.value;
    C.model = harnessOf(C.harness)?.defaultModel ?? C.model;
    saveSessions();
    // The whole chat re-renders: context, cost and turns all belong to the new
    // harness's slot, not the one you just left.
    renderChat();
  };
  row.appendChild(harness);

  const current = harnessOf(C.harness);
  const model = el('select', 'assist-model');
  // The server owns the list — it is the same object used as the allowlist.
  const choices = current ? modelsOf(current) : [{ id: C.model, label: C.model }];
  // A saved session may name a model that is no longer offered; don't let the
  // dropdown show one thing while the server silently runs another.
  if (!choices.some((c) => c.id === C.model)) C.model = choices[0].id;
  for (const { id, label } of choices) {
    const o = el('option', null, label); o.value = id;
    if (id === C.model) o.selected = true;
    model.appendChild(o);
  }
  model.disabled = !current;
  model.onchange = () => { C.model = model.value; saveSessions(); };
  row.appendChild(model);
  row.appendChild(el('span', 'spacer'));

  if (C.busy) {
    const cancel = el('button', 'btn danger', 'Cancel');
    cancel.onclick = () => C.abort?.abort();
    row.appendChild(cancel);
  } else {
    const send = el('button', 'btn primary', 'Send');
    send.disabled = !C.harness;
    if (!C.harness) send.title = 'No supported CLI was found on this machine.';
    send.onclick = sendTurn;
    row.appendChild(send);
  }
  box.appendChild(row);
}

/* ── @ file picker ───────────────────────────────────────────────────── */
function openPicker(query, keepIndex) {
  C.picker = { query, index: keepIndex && C.picker ? Math.min(C.picker.index, 20) : 0 };
  renderCompose();
  $('chat-input')?.focus();
}

function pickerMatches() {
  const s = active();
  const q = (C.picker?.query || '').toLowerCase();
  const files = allFiles().filter((f) => !s?.mentions.includes(f.path));
  if (!q) return files.slice(0, 12);
  return files
    .map((f) => {
      const i = `${f.entry} ${f.name} ${f.display}`.toLowerCase().indexOf(q);
      return i === -1 ? null : { f, score: i };
    })
    .filter(Boolean)
    .sort((a, b) => a.score - b.score)
    .slice(0, 12)
    .map((x) => x.f);
}

function renderPicker() {
  const list = pickerMatches();
  const box = el('div', 'picker');
  if (!list.length) { box.appendChild(el('div', 'picker-empty', 'No file matches that.')); return box; }
  list.forEach((f, i) => {
    const row = el('button', 'picker-row' + (i === C.picker.index ? ' active' : ''));
    row.appendChild(el('span', `item-dot ${f.harness}`));
    row.appendChild(el('span', 'picker-name', f.entry === f.name ? f.name : `${f.entry} · ${f.name}`));
    row.appendChild(el('span', 'picker-path', f.display));
    row.onmousedown = (ev) => { ev.preventDefault(); choosePicker(f); };
    box.appendChild(row);
  });
  return box;
}

function choosePicker(f) {
  if (!f) return;
  const s = ensureSession();
  if (!s.mentions.includes(f.path)) s.mentions.push(f.path);
  C.draft = C.draft.replace(/@([^\s@]*)$/, '').replace(/\s+$/, '');
  C.picker = null;
  saveSessions();
  renderCompose();
  $('chat-input')?.focus();
}

/* ── sending ─────────────────────────────────────────────────────────── */
let tickTimer;

/** Shared streaming reader for both normal turns and compaction. */
async function streamChat({ message, mentions, sessionId, seed, harness, model, onDelta }) {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // harness and model are passed in, never read from C: the picker may move
    // while this request is open and the turn must stay what it was at submit.
    body: JSON.stringify({ message, mentions, sessionId, seed, model, harness }),
    signal: C.abort.signal,
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', final = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      if (ev.t === 'delta') { C.stream += ev.text; onDelta?.(); }
      else if (ev.t === 'done') final = ev;
      else if (ev.t === 'error') throw new Error(ev.message);
    }
  }
  return final;
}

async function sendTurn() {
  const text = C.draft.trim();
  if (!text || C.busy) return;
  if (!C.harness) { notice('error', 'No supported CLI was found on this machine.', null, true); return; }
  const s = ensureSession();
  // Bound at submit: everything below writes back through these, so moving the
  // picker mid-turn cannot land a reply or a session id in another harness.
  const run = { harness: C.harness, model: C.model };
  const sl = slotFor(s, run.harness);

  s.messages.push({ role: 'user', text, mentions: [...s.mentions] });
  if (s.title === 'New session') s.title = titleFor(s);
  C.draft = '';
  C.picker = null;
  C.busy = true;
  C.stream = '';
  C.startedAt = Date.now();
  C.running = run;
  C.abort = new AbortController();
  // The running state goes up NOW, not on the first delta: grok has taken 37s
  // to say anything at all, and half a minute of dead UI reads as a crash.
  renderChat();
  clearInterval(tickTimer);
  tickTimer = setInterval(renderChatBody, 1000);

  try {
    const final = await streamChat({
      message: text,
      mentions: s.mentions,
      sessionId: sl.cliSessionId,
      seed: sl.cliSessionId ? null : sl.seed,
      harness: run.harness,
      model: run.model,
      onDelta: renderChatBody,
    });

    // A turn the server calls failed is a failure here too: no reply text, no
    // session id kept. The server refuses to bind an id from a failed turn, so
    // storing one would only guarantee the next turn is rejected.
    // Fail closed: only an explicit ok:true is a success. The server has exactly one
    // `done` sender and it always sets `ok`, so a missing field means a malformed or
    // truncated stream — which must not persist a session id or render as a reply.
    if (final?.ok !== true) throw new Error(final?.error || 'The turn failed.');

    sl.cliSessionId = final?.sessionId ?? sl.cliSessionId;
    if (final?.stats) {
      sl.stats.turns += 1;
      sl.stats.contextTokens = final.stats.contextTokens || sl.stats.contextTokens;
      sl.stats.costUsd = (sl.stats.costUsd || 0) + (final.stats.costUsd || 0);
      // The first turn is almost entirely the harness's own overhead — system
      // prompt, tool definitions, CLAUDE.md, skills index. Recording it lets us
      // report how much of the context is actually *this conversation*.
      if (!sl.stats.baselineTokens) sl.stats.baselineTokens = final.stats.contextTokens || 0;
    }
    s.updatedAt = Date.now();
    s.messages.push({
      role: 'assistant', harness: run.harness,
      // Deltas when there were any; a harness with streams:false sends none and
      // its whole reply arrives in the done event instead.
      text: C.stream || final?.text || '',
      proposals: final?.proposals ?? [],
    });

    if (final?.rateLimit?.status && final.rateLimit.status !== 'allowed') {
      notice('warn', `Usage limit: ${final.rateLimit.status}` +
        (final.rateLimit.resetsAt ? ` — resets ${new Date(final.rateLimit.resetsAt).toLocaleTimeString()}` : ''), null, true);
    }
  } catch (e) {
    // The server binds each session id to the harness that issued it. If it
    // refuses ours the slot is dead — drop it so the next turn starts clean
    // instead of re-offering an id that can only be rejected again.
    if (/session is bound/i.test(e.message)) sl.cliSessionId = null;
    s.messages.push({
      role: 'assistant', harness: run.harness, text: '',
      error: e.name === 'AbortError' ? 'Cancelled.' : e.message,
    });
  } finally {
    clearInterval(tickTimer);
    C.busy = false;
    C.stream = '';
    C.running = null;
    C.abort = null;
    saveSessions();
    renderChat();
  }
}

/* ── wiring ──────────────────────────────────────────────────────────── */
$('btn-save').onclick = save;
$('btn-assist').onclick = openDrawer;
$('drawer-close').onclick = closeDrawer;
$('scrim').onclick = closeDrawer;
$('btn-scope').onclick = openScope;
$('btn-mcp').onclick = openMcp;
$('btn-usage').onclick = openUsage;
$('btn-trash').onclick = openTrash;
$('btn-delete').onclick = deleteOpenEntry;
$('btn-copy').onclick = copyToOtherHarness;
$('btn-theme').onclick = () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('acs.theme', next);
};
document.documentElement.dataset.theme = localStorage.getItem('acs.theme') || 'dark';

function wireGlobalKeys() {
  window.addEventListener('keydown', (e) => {
    const meta = e.metaKey || e.ctrlKey;
    if (meta && e.key === 's') { e.preventDefault(); if (S.view === 'entry') save(); }
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
