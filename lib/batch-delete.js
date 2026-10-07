/**
 * Delete several files in one request — the Context view's multi-select.
 * Memory does not come here: its facts go through the trash-fact operation
 * (lib/memory-ops.js), which also removes and restores their index links.
 *
 * Each item goes to the studio trash exactly as POST /api/delete does
 * (mutate.trashResolved, with assertWritable immediately before the move).
 * What is added is a PREFLIGHT over the whole batch, run before anything
 * moves, that refuses it outright when any path:
 *   - fails resolveSafe (outside the roots, a read root, a denied name);
 *   - does not exist;
 *   - is an allowed root, or a folder holding one;
 *   - is, or is inside, or holds, the plugin cache;
 *   - is, or holds, a file the registry calls protected (protectedFiles);
 *   - is, or holds, a credential or a hard-linked file.
 * The last three go beyond single delete on purpose: there a protected file
 * is guarded by a typed confirm in the UI, which a batch has no room for.
 *
 * Paths are canonicalised (resolveSafe's real path) and de-duplicated, and
 * a folder swallows anything selected inside it, before the limit applies.
 *
 * Once preflight passes the answer is always 200 with one result per item,
 * in order. The first item that fails stops the batch; the rest are
 * `not-attempted`. A failure after the data moved is `moved-but-unfinished`
 * — restorable from Trash — never `failed`.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  CLAUDE_HOME, assertNotHardLinked, assertWritable, isCredential, isDenied, resolveSafe, safeRoots, tilde,
} from './paths.js';
import { protectedFiles } from './registry.js';
import * as mutate from './mutate.js';

export const BATCH_LIMIT = 200;
// Before de-duplication: a bound on the work preflight does, not the limit.
const RAW_LIMIT = 1000;

const refuse = (msg, input = null) => Object.assign(new Error(msg), { status: 400, payload: { path: input } });
/** Separator-aware: /a/b holds /a/b/c, never /a/bc. */
const within = (child, parent) => child === parent || child.startsWith(parent + path.sep);
const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };

function walkFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkFiles(abs));
    else if (e.isFile()) out.push(abs);
  }
  return out;
}

/** The batch as it will run — `[{abs, input}]` — or a 400 naming the first path refused. Changes nothing. */
export function preflight(body) {
  const paths = body?.paths;
  if (!body || typeof body !== 'object' || !Array.isArray(paths)) throw refuse('paths must be an array of paths');
  if (!paths.length) throw refuse('paths is empty');
  if (paths.length > RAW_LIMIT) throw refuse(`too many paths (the limit is ${BATCH_LIMIT})`);
  const blank = paths.find((p) => typeof p !== 'string' || !p.trim());
  if (blank !== undefined) throw refuse('every path must be a non-empty string', typeof blank === 'string' ? blank : null);

  const inputOf = new Map();
  for (const input of paths) {
    let abs;
    try { abs = resolveSafe(input); }
    catch (e) { throw refuse(`${input}: ${e.message} — nothing was deleted`, input); }
    if (!inputOf.has(abs)) inputOf.set(abs, input);
  }
  const byDepth = [...inputOf.keys()].sort((a, b) => a.length - b.length);
  const kept = new Set();
  for (const abs of byDepth) if (![...kept].some((k) => within(abs, k))) kept.add(abs);
  if (kept.size > BATCH_LIMIT) throw refuse(`too many paths: ${kept.size} after de-duplication (the limit is ${BATCH_LIMIT})`);

  const roots = safeRoots().map(real);
  const plugins = real(path.join(CLAUDE_HOME, 'plugins'));
  const guarded = [...protectedFiles()];
  const items = [...inputOf.keys()].filter((abs) => kept.has(abs)).map((abs) => ({ abs, input: inputOf.get(abs) }));
  for (const { abs, input } of items) {
    const no = (why) => refuse(`${tilde(abs)} ${why} — nothing was deleted`, input);
    let st;
    try { st = fs.lstatSync(abs); } catch { throw no('does not exist'); }
    if (roots.some((r) => within(r, abs))) throw no('is a project or agent folder itself, or holds one');
    if (within(abs, plugins) || within(plugins, abs)) throw no('is managed by the plugin system');
    const held = guarded.find((p) => within(p, abs));
    if (held) {
      throw no(held === abs
        ? 'is loaded on every session — delete it on its own, where its name is typed to confirm'
        : `holds ${tilde(held)}, which is loaded on every session`);
    }
    for (const f of st.isDirectory() ? walkFiles(abs) : [abs]) {
      const where = f === abs ? 'is' : `holds ${tilde(f)}, which is`;
      if (isDenied(f) || isCredential(f)) throw no(`${where} a credential`);
      try { assertNotHardLinked(f); } catch { throw no(`${where} hard-linked`); }
    }
  }
  return items;
}

export async function removeBatch(body) {
  const items = preflight(body);
  const results = [];
  const historyWarnings = [];
  let stopped = false;
  for (const { abs, input } of items) {
    const display = tilde(abs);
    if (stopped) { results.push({ path: input, display, status: 'not-attempted' }); continue; }
    // Allocated up front, so a throw after the move can still find its entry.
    const id = mutate.newTrashId(path.basename(abs));
    try {
      const r = await mutate.trashResolved(abs, { id, beforeMove: () => assertWritable(abs) });
      results.push({ path: input, display, status: 'trashed', trashId: r.id, files: r.files });
      if (r.historyError) historyWarnings.push({ display, error: r.historyError });
    } catch (e) {
      stopped = true;
      results.push({ path: input, display, ...await outcome(abs, id, e) });
    }
  }
  return { results, historyWarnings };
}

/** What a throw from the trash really left: judged from the disk and the trash records, not the error. */
async function outcome(abs, id, e) {
  const entry = (await mutate.listTrash()).find((t) => t.id === id);
  let present = true;
  try { fs.lstatSync(abs); } catch { present = false; }
  if (entry?.moved && !present) return { status: 'moved-but-unfinished', trashId: id, error: e.message };
  return { status: 'failed', error: entry?.moved ? `${e.message} (a copy is in Trash)` : e.message };
}
