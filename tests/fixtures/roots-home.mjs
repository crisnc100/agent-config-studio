/**
 * A project tree for the roots suites: instruction files, a symlinked
 * AGENTS.md, .mcp.json, .worktrees.conf, a git checkout and a project skill,
 * built under any folder. `legacyHome` lays two of them out as the hardcoded
 * ~/Documents/Projects (edit) and ~/Documents/Garman-Homes (read) used to be.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const put = (f, body) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); };
const skillMd = (name, desc) => `---\nname: ${name}\ndescription: ${desc}\n---\n\n# ${name}\n`;

/** One root's worth of files; `tag` keeps the bytes of two roots distinct. */
export function seedProjectTree(dir, tag) {
  const app = path.join(dir, `${tag}-app`);
  put(path.join(dir, 'CLAUDE.md'), `# ${tag} workspace\n`);
  put(path.join(app, 'CLAUDE.md'), `# ${tag} app\n\n## Rules\n\nbe kind\n`);
  fs.symlinkSync('CLAUDE.md', path.join(app, 'AGENTS.md'));
  put(path.join(app, '.mcp.json'), JSON.stringify({ mcpServers: { [`${tag}-srv`]: { command: 'true' } } }, null, 2) + '\n');
  put(path.join(app, '.worktrees.conf'), `TRUNK="${app}"\nCMD=\n`);
  put(path.join(app, '.claude', 'skills', `${tag}-skill`, 'SKILL.md'), skillMd(`${tag} skill`, `the ${tag} one`));
  put(path.join(app, '.cursor', 'rules', 'style.mdc'), `# ${tag} style\n`);
  put(path.join(app, 'notes.txt'), `${tag.toUpperCase()}-NOTES-MARKER\n`);
  execFileSync('git', ['init', '-q', app]);
  return { app };
}

/** The global homes every route reads, kept small. */
export function seedGlobals(home) {
  put(path.join(home, '.claude', 'CLAUDE.md'), '# global\n');
  put(path.join(home, '.claude', 'skills', 'alpha', 'SKILL.md'), skillMd('Alpha', 'global alpha'));
  put(path.join(home, '.codex', 'AGENTS.md'), '# codex global\n');
}

export function legacyHome(home) {
  seedGlobals(home);
  const projects = path.join(home, 'Documents', 'Projects');
  const garman = path.join(home, 'Documents', 'Garman-Homes');
  return { projects, garman, p: seedProjectTree(projects, 'proj'), g: seedProjectTree(garman, 'client') };
}

/**
 * `node server.js` as `acs` starts it (migration, history, watcher), on a free
 * port with `home` as its HOME. `stop()` waits for the exit.
 */
export async function startServer(home, { env = {}, root } = {}) {
  const { spawn } = await import('node:child_process');
  const net = await import('node:net');
  const port = await new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
  const base = `http://localhost:${port}`;
  let out = '', exited = null;
  const child = spawn(process.execPath, ['--no-warnings', path.join(root, 'server.js')], {
    cwd: root,
    env: { PATH: process.env.PATH, ...env, HOME: home, PORT: String(port), ACS_SUITE: 'offline' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (b) => { out += b; });
  child.stderr.on('data', (b) => { out += b; });
  child.on('exit', (code, signal) => { exited = { code, signal }; });
  let up = false;
  for (let i = 0; i < 200 && !exited && !up; i++) {
    try { up = (await fetch(`${base}/api/health`)).ok; } catch {}
    if (!up) await new Promise((r) => setTimeout(r, 100));
  }
  // The banner prints from listen's callback, which can trail the first answer.
  for (let i = 0; i < 20 && up && !/watching/.test(out); i++) await new Promise((r) => setTimeout(r, 50));
  const call = async (p, { method = 'GET', body } = {}) => {
    const r = await fetch(base + p, {
      method, headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, text };
  };
  return {
    base, up, call, log: () => out, exited: () => exited,
    stop: () => new Promise((r) => { if (exited) return r(); child.once('exit', r); child.kill('SIGINT'); }),
  };
}
