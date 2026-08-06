import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveSafe, kindOf, tilde, HOME, PROJECTS, STUDIO_HOME } from './lib/paths.js';
import { buildRegistry, scopeChain } from './lib/registry.js';
import { validate } from './lib/validate.js';
import * as history from './lib/history.js';
import { runAssist, listActions } from './lib/assist.js';

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
  'GET /api/registry': async () => ({
    ...buildRegistry(),
    history: await history.repoStats(),
    assistActions: listActions(),
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

    await fsp.writeFile(abs, content, 'utf8');
    const sha = await history.record(abs, `edit ${tilde(abs)}`);
    const after = await fsp.stat(abs);
    return { saved: true, sha, mtime: after.mtimeMs, ...check };
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
    const { path: p, sha } = await readBody(req);
    const abs = resolveSafe(p);
    if (!/^[0-9a-f]{7,40}$/.test(sha || '')) throw Object.assign(new Error('bad sha'), { status: 400 });
    const content = await history.contentAt(abs, sha);
    await fsp.writeFile(abs, content, 'utf8');
    const newSha = await history.record(abs, `restore ${tilde(abs)} to ${sha.slice(0, 8)}`);
    const stat = await fsp.stat(abs);
    return { restored: true, content, sha: newSha, mtime: stat.mtimeMs };
  },

  'POST /api/snapshot': async () => history.snapshotAll('manual snapshot'),

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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // Local-only tool: refuse anything that did not originate from this machine.
  const host = (req.headers.host || '').split(':')[0];
  if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(host)) {
    res.writeHead(403).end('agent-config-studio only serves localhost');
    return;
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
`);
});

process.on('SIGINT', () => { console.log('\n  stopped.'); process.exit(0); });
