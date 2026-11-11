/* Agent Config Studio — the Building blocks view: each shared rule block, and every skill copy of it (lib/blocks.js) */

/**
 * Loaded before app.js, which owns the helpers this calls (el, api,
 * renderMarkdown, renderSidebar…). Read-only: the one request it makes is
 * GET /api/blocks (tests/blocks-ui.mjs holds it to that).
 */
const BB = { data: null, error: null, loading: false };
const BB_WORD = { same: 'same', reworded: 'reworded', differs: 'differs' };

async function openBlocks() {
  if (!confirmDiscard()) return;
  S.view = 'blocks';
  leaveEditor();
  window.history.replaceState(null, '', '#blocks');
  renderSidebar(); renderTopbar(); renderTabs(); renderStatus();
  $('filebar').hidden = true;
  if (!BB.data) $('content').innerHTML = '<div class="scope"><div class="scope-sub"><span class="spinner"></span> Reading the blocks and your skills…</div></div>';
  await bbLoad();
}

async function bbLoad() {
  BB.loading = true;
  if (BB.data) paintBlocks();
  try { BB.data = await api('GET', '/api/blocks'); BB.error = null; }
  catch (e) { BB.error = e.message; }
  BB.loading = false;
  paintBlocks();
}

const bbPlural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function bbCounts(b) {
  if (!b.copies.length) return 'No skill or instruction file carries a copy yet.';
  const parts = ['same', 'reworded', 'differs'].filter((k) => b.counts[k]).map((k) => `${b.counts[k]} ${BB_WORD[k]}`);
  return `${bbPlural(b.copies.length, 'copy', 'copies')}: ${parts.join(', ')}`;
}

function bbCopyRow(c) {
  const row = el('li', `bb-copy bb-${c.rating}`);
  row.appendChild(el('span', `bb-rating bb-rating-${c.rating}`, BB_WORD[c.rating]));
  const where = c.endLine > c.line ? `${c.file}:${c.line}–${c.endLine}` : `${c.file}:${c.line}`;
  row.appendChild(el('code', 'bb-where', where));
  if (c.kind === 'instructions') row.appendChild(el('span', 'bb-kind', 'instruction file'));
  if (c.marked) row.appendChild(el('span', 'bb-marked', 'marked'));
  if (c.note) row.appendChild(el('span', 'bb-note', c.note));
  return row;
}

function bbCard(b) {
  const card = el('section', 'bb-card');
  card.id = `bb-${b.id}`;
  card.appendChild(el('h3', 'bb-name', b.name));
  if (b.summary) card.appendChild(el('p', 'bb-summary', b.summary));
  const text = el('div', 'bb-text md');
  text.innerHTML = renderMarkdown(b.text);
  card.appendChild(text);
  card.appendChild(el('p', 'bb-counts', bbCounts(b)));
  if (b.copies.length) {
    const list = el('ul', 'bb-copies');
    // What needs a look comes first: differs, then reworded, then same.
    const order = { differs: 0, reworded: 1, same: 2 };
    for (const c of [...b.copies].sort((x, y) => order[x.rating] - order[y.rating])) list.appendChild(bbCopyRow(c));
    card.appendChild(list);
  }
  return card;
}

function paintBlocks() {
  if (S.view !== 'blocks') return;
  const c = $('content');
  c.innerHTML = '';
  const box = el('div', 'scope bb');
  box.appendChild(pageHeading('Building blocks'));
  if (BB.error && !BB.data) {
    const n = el('div', 'notice error');
    n.setAttribute('role', 'alert');
    n.appendChild(el('div', null, `The blocks could not be read: ${BB.error}`));
    const retry = el('button', 'btn', 'Try again');
    retry.onclick = () => bbLoad();
    n.appendChild(retry);
    box.appendChild(n);
    c.appendChild(box);
    return;
  }
  const d = BB.data;
  const bar = el('div', 'bb-bar');
  const copies = d.blocks.reduce((n, b) => n + b.copies.length, 0);
  bar.appendChild(el('span', 'bb-total', `${bbPlural(d.blocks.length, 'block')} · ${bbPlural(copies, 'copy', 'copies')} in ${bbPlural(d.scanned.files, 'file')} read`));
  const again = el('button', 'btn', BB.loading ? 'Checking…' : 'Check again');
  again.disabled = BB.loading;
  again.onclick = () => bbLoad();
  bar.appendChild(again);
  box.appendChild(bar);
  if (BB.error) box.appendChild(el('div', 'notice error', `The last check failed: ${BB.error}`));
  if (d.scanned.unreadable.length) box.appendChild(el('p', 'bb-unreadable', `Could not read: ${d.scanned.unreadable.join(', ')}`));
  if (!d.blocks.length) box.appendChild(el('p', 'bb-empty', 'No blocks yet.'));
  for (const b of d.blocks) box.appendChild(bbCard(b));
  c.appendChild(box);
}
