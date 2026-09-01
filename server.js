import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveSafe, kindOf, tilde, HOME, PROJECTS, STUDIO_HOME, CODEX_HOME } from './lib/paths.js';
import { buildRegistry, scopeChain } from './lib/registry.js';
import { validate } from './lib/validate.js';
import * as history from './lib/history.js';
import * as worktree from './lib/worktree.js';
import * as mutate from './lib/mutate.js';
import { runAssist, listActions } from './lib/assist.js';
import { streamTurn, parseEdits, resolveMentions, modelList, DEFAULT_MODEL } from './lib/chat.js';
import { createWatcher, snapshotOf, diffSnapshots } from './lib/watch.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 8787);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

const json = (res, code, body) => {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(s) });
  res.end(s);
};

async function readBody(req, limit = 8 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw Object.assign(new Error('body too large'), { status: 413 });
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('invalid JSON body'), { status: 400 }); }
}

const ROUTES = {
  /** Identity probe so the launcher never kills an unrelated process on this port. */
  'GET /api/health': async () => ({ app: 'agent-config-studio', pid: process.pid }),

  /**
   * Read-only view of configured MCP servers. Global servers live in
   * ~/.claude.json next to oauth tokens, API-key responses and 44 projects of
   * history — so only the mcpServers key is extracted, and that file is never
   * exposed through the file API.
   */
  'GET /api/mcp': async () => {
    const out = { global: [], codex: [], note: null };

    try {
      const raw = JSON.parse(await fsp.readFile(path.join(HOME, '.claude.json'), 'utf8'));
      out.global = Object.entries(raw.mcpServers || {}).map(([name, cfg]) => ({
        name, transport: cfg.type || (cfg.command ? 'stdio' : 'unknown'),
        target: cfg.url || cfg.command || '', scope: 'global',
      }));
      for (const [proj, cfg] of Object.entries(raw.projects || {})) {
        for (const [name, s] of Object.entries(cfg.mcpServers || {})) {
          out.global.push({
            name, transport: s.type || (s.command ? 'stdio' : 'unknown'),
            target: s.url || s.command || '', scope: tilde(proj),
          });
        }
      }
      out.note = 'Global MCP is defined in ~/.claude.json, which also holds credentials — shown read-only. Use `claude mcp add/remove` to change it.';
    } catch (e) {
      out.note = `Could not read ~/.claude.json: ${e.message}`;
    }

    try {
      const toml = await fsp.readFile(path.join(CODEX_HOME, 'config.toml'), 'utf8');
      for (const m of toml.matchAll(/^\[mcp_servers\.([A-Za-z0-9_-]+)\]/gm)) {
        out.codex.push({ name: m[1], scope: '~/.codex/config.toml' });
      }
    } catch { /* codex config is optional */ }

    return out;
  },

  'GET /api/registry': async () => ({
    ...buildRegistry(),
    history: await history.repoStats(),
    assistActions: listActions(),
    models: modelList(),
  }),

  'GET /api/file': async (_req, url) => {
    const abs = resolveSafe(url.searchParams.get('path'));
    const stat = await fsp.stat(abs);
    if (!stat.isFile()) throw Object.assign(new Error('not a file'), { status: 400 });
    if (stat.size > 4 * 1024 * 1024) throw Object.assign(new Error('file too large to edit here'), { status: 413 });
    const content = await fsp.readFile(abs, 'utf8');
    return {
      path: abs, display: tilde(abs), kind: kindOf(abs),
      content, size: stat.size, mtime: stat.mtimeMs,
      lines: content.split('\n').length,
    };
  },

  'PUT /api/file': async (req) => {
    const { path: p, content, mtime } = await readBody(req);
    const abs = resolveSafe(p);
    if (typeof content !== 'string') throw Object.assign(new Error('content required'), { status: 400 });

    const stat = await fsp.stat(abs);
    // Refuse to clobber a change made outside the studio since this editor loaded.
    if (mtime && Math.abs(stat.mtimeMs - mtime) > 1) {
      throw Object.assign(
        new Error('This file changed on disk since you opened it. Reload before saving.'),
        { status: 409 }
      );
    }

    const kind = kindOf(abs);
    const check = validate(abs, content, kind);
    if (!check.ok) return { saved: false, ...check };

    const before = await fsp.readFile(abs, 'utf8');
    if (before === content) {
      return { saved: false, unchanged: true, ...check };
    }

    // Capture whatever is on disk right now before replacing it, so there is
    // always a version to diff and restore against.
    await history.recordBaseline(abs, `state of ${tilde(abs)} before edit`).catch(() => {});

    await fsp.writeFile(abs, content, 'utf8');
    const after = await fsp.stat(abs);

    // The write succeeded; a history failure must not be reported as a failed
    // save, or the UI would claim the file is unchanged when it is not.
    let sha = null, historyError = null;
    try {
      sha = await history.record(abs, `edit ${tilde(abs)}`);
    } catch (e) {
      historyError = e.message;
    }
    return { saved: true, sha, historyError, mtime: after.mtimeMs, ...check };
  },

  'POST /api/validate': async (req) => {
    const { path: p, content } = await readBody(req);
    const abs = resolveSafe(p);
    return validate(abs, content ?? '', kindOf(abs));
  },

  'GET /api/history': async (_req, url) => {
    const abs = resolveSafe(url.searchParams.get('path'));
    return { commits: await history.logFor(abs) };
  },

  'GET /api/history/version': async (_req, url) => {
    const abs = resolveSafe(url.searchParams.get('path'));
    const sha = url.searchParams.get('sha');
    if (!/^[0-9a-f]{7,40}$/.test(sha || '')) throw Object.assign(new Error('bad sha'), { status: 400 });
    return { content: await history.contentAt(abs, sha), sha };
  },

  'POST /api/history/restore': async (req) => {
    const { path: p, sha, mtime } = await readBody(req);
    const abs = resolveSafe(p);
    if (!/^[0-9a-f]{7,40}$/.test(sha || '')) throw Object.assign(new Error('bad sha'), { status: 400 });

    const stat = await fsp.stat(abs);
    if (mtime && Math.abs(stat.mtimeMs - mtime) > 1) {
      throw Object.assign(
        new Error('This file changed on disk since you opened it. Reload before restoring.'),
        { status: 409 }
      );
    }

    const content = await history.contentAt(abs, sha);
    // Preserve the current contents before overwriting, so a restore is itself
    // reversible even if the current version was never saved through the studio.
    await history.recordBaseline(abs, `state of ${tilde(abs)} before restore`).catch(() => {});

    await fsp.writeFile(abs, content, 'utf8');
    const after = await fsp.stat(abs);
    let newSha = null, historyError = null;
    try {
      newSha = await history.record(abs, `restore ${tilde(abs)} to ${sha.slice(0, 8)}`);
    } catch (e) {
      historyError = e.message;
    }
    return { restored: true, content, sha: newSha, historyError, mtime: after.mtimeMs };
  },

  'POST /api/snapshot': async () => history.snapshotAll('manual snapshot'),

  'GET /api/worktree': async () => ({
    registered: worktree.listRegistered(),
    candidates: await worktree.listCandidates(),
  }),
  'GET /api/worktree/bases': async (_req, url) =>
    worktree.listBases(url.searchParams.get('repo') || ''),
  'POST /api/worktree/init': async (req) => {
    const body = await readBody(req);
    const r = await worktree.initProject(body);
    await history.snapshotAll(`register worktree project ${body.key}`);
    return r;
  },

  'POST /api/create': async (req) => mutate.create(await readBody(req)),
  'POST /api/create-file': async (req) => mutate.addFile(await readBody(req)),
  'POST /api/delete': async (req) => mutate.remove(await readBody(req)),
  'GET /api/trash': async () => ({ items: await mutate.listTrash() }),
  'POST /api/trash/restore': async (req) => mutate.restoreTrash(await readBody(req)),

  'GET /api/scope': async (_req, url) => {
    const dir = url.searchParams.get('dir') || PROJECTS;
    const abs = resolveSafe(dir);
    return { dir: abs, display: tilde(abs), chain: scopeChain(abs) };
  },

  'GET /api/scope/dirs': async () => {
    // Candidate directories worth checking a scope chain for.
    const out = new Set([PROJECTS]);
    const walk = (root, depth) => {
      if (depth > 2) return;
      let ents;
      try { ents = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
        const d = path.join(root, e.name);
        out.add(d);
        walk(d, depth + 1);
      }
    };
    walk(PROJECTS, 0);
    return { dirs: [...out].sort().map((d) => ({ path: d, display: tilde(d) })) };
  },

  'GET /api/search': async (_req, url) => {
    const q = (url.searchParams.get('q') || '').trim();
    if (q.length < 2) return { hits: [] };
    const needle = q.toLowerCase();
    const { groups } = buildRegistry();
    const hits = [];
    for (const g of groups) {
      for (const e of g.entries) {
        for (const f of e.files) {
          if (f.size > 1024 * 1024) continue;
          let text;
          try { text = await fsp.readFile(f.path, 'utf8'); } catch { continue; }
          const lines = text.split('\n');
          const matches = [];
          for (let i = 0; i < lines.length && matches.length < 4; i++) {
            if (lines[i].toLowerCase().includes(needle)) {
              matches.push({ line: i + 1, text: lines[i].trim().slice(0, 220) });
            }
          }
          if (matches.length) {
            hits.push({
              group: g.title, entryId: e.id, entryLabel: e.label,
              file: f.name, path: f.path, display: f.display,
              harness: e.harness, matches,
              total: lines.filter((l) => l.toLowerCase().includes(needle)).length,
            });
          }
        }
      }
    }
    hits.sort((a, b) => b.total - a.total);
    return { hits: hits.slice(0, 60), query: q };
  },

  'POST /api/assist': async (req) => {
    const { path: p, content, action, instruction, model } = await readBody(req);
    const abs = resolveSafe(p);
    return runAssist({ action, instruction, filePath: abs, content: content ?? '', model });
  },
};

/**
 * Streaming chat turn. Emits newline-delimited JSON so the browser can render
 * tokens as they arrive — a 100s wait behind a spinner reads as a hang.
 */
async function handleChat(req, res) {
  let body;
  try { body = await readBody(req); }
  catch (e) { return json(res, e.status || 400, { error: e.message }); }

  let mentions;
  try { mentions = resolveMentions(body.mentions); }
  catch (e) { return json(res, e.status || 400, { error: e.message }); }

  const message = String(body.message || '').trim();
  if (!message) return json(res, 400, { error: 'message required' });

  res.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-cache',
    'x-accel-buffering': 'no',
  });
  const send = (obj) => { if (!res.writableEnded) res.write(JSON.stringify(obj) + '\n'); };

  const turn = streamTurn({
    message,
    mentions,
    sessionId: body.sessionId || null,
    seed: body.seed || null,
    model: body.model || DEFAULT_MODEL,
    cwd: mentions.length ? path.dirname(mentions[0]) : HOME,
  }, (text) => send({ t: 'delta', text }));

  // If the browser aborts, kill the child rather than leaving it running.
  req.on('close', () => { if (!res.writableEnded) turn.kill(); });

  try {
    const { text, sessionId, stats, rateLimit } = await turn.done;
    const proposals = parseEdits(text, mentions).map((p) => {
      let mtime = null;
      try { mtime = p.path ? fs.statSync(p.path).mtimeMs : null; } catch {}
      return {
        path: p.path, display: p.display, kind: p.kind,
        error: p.error, edits: p.edits || 1, mtime,
        current: p.current, proposed: p.proposed,
      };
    });
    send({ t: 'done', sessionId, proposals, stats, rateLimit });
  } catch (e) {
    send({ t: 'error', message: e.message });
  }
  res.end();
}

/* ── live file events ─────────────────────────────────────────────────── */

const sseClients = new Set();
let lastSnapshot = snapshotOf(buildRegistry());

function broadcast(payload) {
  const frame = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    try { res.write(frame); } catch { sseClients.delete(res); }
  }
}

function handleEvents(req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write('retry: 2000\n\n');
  sseClients.add(res);

  // Keep intermediaries from closing an idle stream.
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25_000);
  req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
}

/** Rebuild, diff, and tell every open tab what actually changed. */
async function onFilesChanged() {
  let registry;
  try { registry = buildRegistry(); } catch { return; }
  const next = snapshotOf(registry);
  const delta = diffSnapshots(lastSnapshot, next);
  lastSnapshot = next;

  if (!delta.added.length && !delta.removed.length && !delta.changed.length) return;

  broadcast({
    type: 'files',
    added: delta.added.map(tilde),
    removed: delta.removed.map(tilde),
    changed: delta.changed.map(tilde),
    addedPaths: delta.added,
    removedPaths: delta.removed,
    changedPaths: delta.changed,
    total: next.size,
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // Local-only tool: refuse anything that did not originate from this machine.
  const host = (req.headers.host || '').split(':')[0];
  if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(host)) {
    res.writeHead(403).end('agent-config-studio only serves localhost');
    return;
  }

  // These stream their own responses rather than returning a JSON body.
  if (req.method === 'POST' && url.pathname === '/api/chat') {
    return void handleChat(req, res);
  }
  if (req.method === 'GET' && url.pathname === '/api/events') {
    return void handleEvents(req, res);
  }

  if (url.pathname.startsWith('/api/')) {
    const handler = ROUTES[`${req.method} ${url.pathname}`];
    if (!handler) return json(res, 404, { error: 'no such endpoint' });
    try {
      json(res, 200, await handler(req, url));
    } catch (e) {
      json(res, e.status || 500, { error: e.message });
    }
    return;
  }

  // Static files
  let rel = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = path.join(PUBLIC, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(PUBLIC)) return void res.writeHead(403).end('nope');
  try {
    const buf = await fsp.readFile(file);
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  } catch {
    res.writeHead(404).end('not found');
  }
});

await history.ensureRepo();
// Catch up on anything edited outside the studio since last run, so the
// history repo is an honest record rather than only of studio-made edits.
await history.snapshotAll('external changes since last run').catch(() => {});

const watcher = createWatcher(onFilesChanged);

server.listen(PORT, '127.0.0.1', () => {
  const { groups } = buildRegistry();
  const total = groups.reduce((n, g) => n + g.entries.reduce((m, e) => m + e.files.length, 0), 0);
  console.log(`
  Agent Config Studio
  ───────────────────────────────────────────────
  →  http://localhost:${PORT}

  tracking   ${total} files across ${groups.length} groups
  history    ${tilde(STUDIO_HOME)}/history
  roots      ~/.claude  ~/.codex  ${tilde(PROJECTS)}
  watching   ${watcher.count} directories for live changes
`);
});

process.on('SIGINT', () => {
  watcher.close();
  console.log('\n  stopped.');
  process.exit(0);
});
