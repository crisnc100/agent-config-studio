/* Agent Config Studio — labels for lists of registry files, and the recently opened list */

/**
 * Pure, and loaded before app.js, so tests run it in a VM as the browser does.
 */

/**
 * The label each entry shows in its list: its own, unless another entry in
 * the same list has the same one. Then the colliding entries grow parent
 * context together (a label that is its folder's tail takes the next parent:
 * lib/production → web-app/lib/production → myapp-trunk/…) until every
 * pair in different folders differs. Entries still alike share a folder, so
 * the filename tells them apart instead.
 */
function shownLabels(entries) {
  const out = {};
  const parts = (p) => p.replace(/^~\//, '').split('/').filter(Boolean);
  const info = entries.map((e) => {
    const full = parts(e.display || '');
    const dir = e.where ? parts(e.where) : full.slice(0, -1);
    const own = e.label.split('/');
    return { e, dir, key: dir.join('/'), file: full[full.length - 1] || '', own, tail: dir.slice(-own.length).join('/') === e.label };
  });
  const at = (x, k) => (k === 0 ? x.e.label
    : x.tail ? x.dir.slice(-(x.own.length + k)).join('/') : `${x.e.label} · ${x.dir.slice(-k).join('/')}`);
  const groups = new Map();
  for (const x of info) groups.set(x.e.label, [...(groups.get(x.e.label) || []), x]);
  for (const group of groups.values()) {
    if (group.length === 1) { out[group[0].e.id] = group[0].e.label; continue; }
    const apart = (labels) => group.every((x, i) => group.every((y, j) => i === j || x.key === y.key || labels[i] !== labels[j]));
    const max = Math.max(...group.map((x) => x.dir.length));
    let k = 0;
    let labels = group.map((x) => at(x, 0));
    while (!apart(labels) && k < max) { k++; labels = group.map((x) => at(x, k)); }
    const seen = new Map();
    for (const l of labels) seen.set(l, (seen.get(l) || 0) + 1);
    group.forEach((x, i) => { out[x.e.id] = seen.get(labels[i]) > 1 ? `${labels[i]} · ${x.file}` : labels[i]; });
  }
  return out;
}

/** Recently opened, newest first, one row per path, at most `max`. */
function pushRecent(list, item, max = 8) {
  return [item, ...(Array.isArray(list) ? list : []).filter((x) => x && x.path !== item.path)].slice(0, max);
}
