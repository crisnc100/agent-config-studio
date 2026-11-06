/**
 * One name per thing, nothing too small to read, focus you can see
 * (builds/ui-clarity, PR A; criteria 1 and 3, and R11's static guards).
 *
 * The sweep renders every view of the page (tests/fixtures/shell-page.mjs)
 * against a real `node server.js` in a temp HOME with stub CLIs, then reads
 * each view's visible text and its title / aria-label / placeholder
 * attributes. It fails on a retired name:
 *   - "harness" in any form, and "both harnesses" above all — the studio
 *     works with three CLIs, so it says "your CLIs" or names them;
 *   - "job" or "jobs" for a role — the skills say "ACS → Models → Roles";
 *   - "memory" for an instruction file (CLAUDE.md, AGENTS.md) — memory is
 *     only auto-memory, so it is allowed on Memory and on Home's memory
 *     cleanup line, nowhere else;
 *   - "Delete" for something that goes to Trash — "Delete" stays only on
 *     permanent actions (the ALLOW list below names them).
 * The static half reads public/styles.css: no font-size under 11px, the four
 * selects and the editor have a :focus-visible rule that draws something,
 * and every `outline: none` sits beside a focus style that replaces it.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { snapshotRealHomes, assertRealHomesUnchanged } from './real-home.mjs';
import { ROOT, sandbox, tests, track } from './fixtures/packs-sandbox.mjs';
import { bootPage, routesFor } from './fixtures/shell-page.mjs';

const realBefore = snapshotRealHomes();
const { ok, done } = tests();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── static: styles.css ──────────────────────────────────────────────── */
console.log('\nstyles.css: type size and focus');
const css = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].trim(), body: m[2] }));
{
  const small = [];
  for (const r of rules) {
    for (const m of r.body.matchAll(/font(?:-size)?\s*:\s*([^;]+)/g)) {
      for (const v of m[1].matchAll(/(\d*\.?\d+)(px|rem|em)\b/g)) {
        const px = v[2] === 'px' ? Number(v[1]) : Number(v[1]) * 14;
        // A `font:` shorthand's line-height after a slash is not a size.
        if (/\/\s*$/.test(m[1].slice(0, v.index))) continue;
        if (px < 11) small.push(`${r.sel} → ${v[0]}`);
      }
    }
  }
  ok('no CSS font-size under 11px (the 9px badge included)', small.length === 0, small.join(' | '));
}
{
  const draws = (body) => /outline\s*:\s*(?!none\b|0\b)[^;]+/.test(body) || /box-shadow\s*:\s*(?!none\b)[^;]+/.test(body)
    || /border-color\s*:/.test(body);
  const focusFor = (cls) => rules.filter((r) => r.sel.split(',').some((s) => s.includes(cls) && s.includes(':focus-visible')) && draws(r.body));
  for (const cls of ['.scope-select', '.assist-harness', '.assist-model', '.sess-select', '.editor']) {
    ok(`${cls} has a :focus-visible rule that draws an outline or a ring`, focusFor(cls).length > 0);
  }
  // Every `outline: none` must leave a visible focus: the rule is not a focus rule at all,
  // or the same selector has a :focus-visible rule that draws one.
  const bare = [];
  for (const r of rules) {
    if (!/outline\s*:\s*(none|0)\b/.test(r.body)) continue;
    for (const s of r.sel.split(',').map((x) => x.trim())) {
      // Off only when the browser would not show a ring anyway (mouse or script focus).
      if (s.includes(':not(:focus-visible)')) continue;
      const base = s.replace(/:focus(-visible|-within)?/g, '').trim();
      const replaced = rules.some((o) => o !== r && o.sel.split(',').some((x) => x.trim().replace(/:focus-visible/g, '').trim() === base && x.includes(':focus-visible')) && draws(o.body))
        || draws(r.body);
      if (!replaced) bare.push(s);
    }
  }
  ok('every `outline: none` has a replacement focus style', bare.length === 0, bare.join(' | '));
}

/* ── the sweep: every view, rendered against a real server ───────────── */
const sb = sandbox('words', { clis: ['claude', 'codex'] });
const H = sb.home;
const put = (rel, body) => { const f = path.join(H, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); };
put('.agent-config-studio/setup.json', JSON.stringify({ completed: 'done', at: new Date().toISOString() }));
put('.claude/CLAUDE.md', '# Global\n\nBe brief.\n');
put('.codex/AGENTS.md', '# Global\n\nBe brief.\n');
put('.claude/skills/alpha/SKILL.md', '---\nname: alpha\ndescription: a test skill\n---\n\nDo alpha.\n');
put('.claude/skills/scratch/SKILL.md', '---\nname: scratch\ndescription: goes to trash\n---\n\nScratch.\n');
put('Documents/Projects/app/CLAUDE.md', '# App\n\nRun the tests.\n');
put('Documents/Projects/app/AGENTS.md', '# App\n\nRun the tests.\n');
fs.mkdirSync(path.join(H, 'Documents/Projects/app/.git'), { recursive: true });
put('.claude/projects/-app/memory/MEMORY.md', '- [fact](fact.md) — a fact\n');
put('.claude/projects/-app/memory/fact.md', '---\nname: fact\ndescription: a fact\n---\n\nA fact.\n');

/* ── one status per CLI: Packs reads the detector Home and Setup use (A5) ── */
console.log('\nPacks: each CLI as Home and Setup see it');
{
  const { catalogView } = await import('../lib/packs-routes.js');
  const { machine } = await import('../lib/packs.js');
  const m = machine(sb.env);
  // Claude installed where the detector looks, but not on the studio's PATH; Codex on both; Grok nowhere.
  m.clis = { claude: null, codex: m.clis.codex, grok: null };
  m.present = { claude: true, codex: true, grok: false };
  const view = catalogView(m, { installedOf: (id) => id !== 'grok' });
  const cli = (id) => view.harnesses.find((h) => h.id === id);
  ok('installed but off the PATH: said once, in one plain sentence', cli('claude').installed && !cli('claude').cli
    && cli('claude').note === 'installed, but not on the PATH the studio sees', JSON.stringify(cli('claude')));
  ok('installed and on the PATH: nothing to add', cli('codex').installed && cli('codex').note === null, JSON.stringify(cli('codex')));
  ok('absent: "not installed", and its folder missing', !cli('grok').present && cli('grok').why === 'not installed, and no ~/.grok', JSON.stringify(cli('grok')));
  m.clis = { claude: null, codex: null, grok: null };
  const rg = catalogView(m, { installedOf: (id) => id === 'claude' }).packs.find((p) => p.id === 'review-gate');
  const need = rg.requirements.find((r) => r.id === 'cli');
  ok('the agent-CLI need agrees with Home: installed, not on the PATH — not "no agent CLI"',
    !need.ok && need.what === 'Claude Code is installed, but not on the PATH the studio sees' && !/no agent CLI/.test(need.what), JSON.stringify(need));
  const none = catalogView(m, { installedOf: () => false }).packs.find((p) => p.id === 'review-gate').requirements.find((r) => r.id === 'cli');
  ok('…and with no CLI anywhere, it says none is installed', !none.ok && /no agent CLI is installed/.test(none.what), JSON.stringify(none));
  const git = rg.requirements.find((r) => r.id === 'git');
  ok('a need that is met shows no full path', git.ok && git.what === 'git', JSON.stringify(git));

  // Review LOW (2026-11-06): Codex found off the studio's PATH, and no ~/.codex yet. Home and Setup say
  // "installed"; Packs must never answer "not installed" for it — on the machine line or the Install-for row.
  m.clis = { claude: m.clis.claude, codex: null, grok: null };
  m.present = { claude: true, codex: false, grok: false };
  const off = catalogView(m, { installedOf: (id) => id !== 'grok' });
  const cx = off.harnesses.find((h) => h.id === 'codex');
  const said = [cx.note, cx.why].filter(Boolean).join(' | ');
  ok('installed, off the PATH, no settings folder: never "not installed", and both real gaps named', cx.installed && !cx.present
    && !/not installed/.test(said) && /not on the PATH the studio sees/.test(cx.note) && /no settings folder yet \(~\/\.codex\)/.test(cx.note)
    && cx.why === cx.note, JSON.stringify(cx));
  const stub = routesFor({
    'GET /api/packs': () => off,
    'GET /api/packs/status': () => ({ job: { running: false, result: { packs: [], legacy: [], checkedAt: Date.now(), trust: false } } }),
  });
  const pg = await bootPage({ routes: stub, hash: '#packs' });
  for (let i = 0; i < 100 && !pg.$('content').querySelector('.pk-here'); i++) await sleep(20);
  const here = pg.text(pg.$('content').querySelector('.pk-here'));
  const rows = pg.$('content').querySelectorAll('.pk-harnesses').map((r) => pg.text(r)).join(' | ');
  ok('…and the page agrees: "✓ Codex" with the off-PATH note, no "not installed" for Codex anywhere on Packs',
    /✓ Codex/.test(here) && /Codexinstalled, but not on the PATH the studio sees/.test(here)
      && !/Codex:? ?not installed/.test(here) && !/Codex: not installed/.test(rows) && /no settings folder yet/.test(here), `${here} || ${rows}`);
  ok('…with no page errors', pg.errors.length === 0, pg.errors.join(' | '));
  pg.done();
}

/** A real server over a sandbox's HOME, and the page's fetch forwarded to it. */
async function serve(env) {
  const port = await new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
  track(spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env: { ...env, PORT: String(port) }, stdio: ['ignore', 'ignore', 'ignore'] }));
  const base = `http://localhost:${port}`;
  for (let i = 0; i < 150; i++) { try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {} await sleep(100); }
  return async (method, p, body, u) => {
    const r = await fetch(`${base}${p}${u?.search || ''}`, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
    const data = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
    if (!r.ok) throw { status: r.status, body: data };
    return data;
  };
}
const proxy = await serve(sb.env);
// Something in Trash, so the Trash view and Home's Recent have a row.
await proxy('POST', '/api/delete', { path: path.join(H, '.claude/skills/scratch') }).catch(() => {});

/** Visible words and the attributes a person meets (tooltips, screen-reader names, placeholders). */
function words(page) {
  const out = [];
  const walk = (n) => {
    if (!n.getAttribute) return;
    for (const a of ['title', 'aria-label', 'placeholder']) { const v = n.getAttribute(a); if (v) out.push(v); }
    for (const c of n.children || []) walk(c);
  };
  for (const id of ['content', 'title', 'title-path']) { const n = page.$(id); if (n) { out.push(page.text(n)); walk(n); } }
  return out.join('\n');
}

/** Each banned name, and where it is allowed. `except` strips allowed phrases before the test. */
const RULES = [
  { name: '"both harnesses"', re: /both harnesses/i },
  { name: '"harness"', re: /harness/i },
  { name: '"job" for a role', re: /\bjobs?\b/i },
  { name: '"memory" for an instruction file', re: /memory/i, allowIn: ['memory', 'home'],
    // "Auto-memory" is the auto-memory group, wherever it shows; the sidebar (PR C regroups it) is not swept.
    except: [/Auto-memory/gi, /\S*\/memory\b\S*/g] },
  { name: '"Delete" for something recoverable', re: /\bdelet/i,
    // Permanent actions keep the word: a role (no trash), an Assist session, a file gone outside the studio, and "never deleted" (a promise about history).
    except: [/Delete role/g, /Delete this session/g, /deleted outside the studio/g, /never deleted/g] },
];

const VIEWS = ['home', 'files', 'skills', 'packs', 'mcp', 'models', 'memory', 'context', 'worktrees', 'usage', 'scope', 'audit', 'trash', 'setup', 'folders'];
try {
  console.log('\nthe sweep: one name per thing, per view');
  for (const v of VIEWS) {
    const page = await bootPage({ routes: proxy, hash: `#${v}` });
    for (let i = 0; i < 60 && page.text(page.$('content')).length < 40; i++) await sleep(50);
    await sleep(v === 'packs' ? 1500 : 400);
    const text = words(page);
    const shown = page.eval('S.view');
    ok(`${v}: the view renders`, shown === v && text.length > 40, `${shown}: ${text.slice(0, 200)}`);
    for (const r of RULES) {
      if (r.allowIn?.includes(v)) continue;
      let t = text;
      for (const x of r.except || []) t = t.replace(x, '');
      const hits = t.split("\n").filter((l) => r.re.test(l)).map((l) => { const i = l.search(r.re); return l.slice(Math.max(0, i - 70), i + 70); });
      ok(`${v}: no ${r.name}`, hits.length === 0, hits.join(' | '));
    }
    ok(`${v}: no page errors`, page.errors.length === 0, page.errors.join(' | '));
    page.done();
  }

  console.log('\nPacks: needs checked once at the top, each card ready or its one missing need');
  {
    const waitFor = async (page, cond) => { for (let i = 0; i < 200 && !cond(); i++) await sleep(50); return cond(); };
    const page = await bootPage({ routes: proxy, hash: '#packs' });
    const c = () => page.$('content');
    await waitFor(page, () => c().querySelectorAll('.pk-card').length > 0);
    const cards = c().querySelectorAll('.pk-card');
    const ready = (k) => page.text(k.querySelector('.pk-ready'));
    ok('a machine with everything: no to-do box, and every card says "✓ Ready"…', !c().querySelector('.pk-todo')
      && cards.length > 0 && cards.filter((k) => k.dataset.pack !== 'build').every((k) => ready(k) === '✓ Ready'), cards.map((k) => page.text(k.querySelector('.pk-head'))).join(' | '));
    ok('…except a pack that needs another pack first, which names it', ready(c().querySelector('[data-pack="build"]')) === 'Needs the Review gate pack first');
    const rg = c().querySelector('[data-pack="review-gate"]');
    ok('the needs list is folded into the card\'s explain, not shown open', !!rg.querySelector('details.pk-explain .pk-reqs') && !rg.querySelector(':scope > .pk-reqs'));
    const metas = c().querySelectorAll('.pk-part-meta').map((n) => page.text(n));
    ok('no part id or part type on the cards, only who it is for and whether it is on', metas.length > 0
      && metas.every((m) => /^(For [A-Z][\w ]+ · )?(on by default|off unless you pick it)$/.test(m))
      && !metas.some((m) => /code-review ·|· skill|· guard|· instructions/.test(m)), metas.join(' | '));
    ok('each part says what it does in a sentence', rg.querySelectorAll('.pk-part-what').every((n) => /\.$/.test(page.text(n)) && page.text(n).length > 12));
    ok('no pack id chip in the head', !rg.querySelector('.pk-head .chip-mini'));
    page.done();

    // No model-id here: the one shared need, once at the top; each pack that needs it says so in one line.
    const sb2 = sandbox('words-needs', { clis: ['claude'], modelId: false });
    fs.mkdirSync(path.join(sb2.home, '.agent-config-studio'), { recursive: true });
    fs.writeFileSync(path.join(sb2.home, '.agent-config-studio', 'setup.json'), JSON.stringify({ completed: 'done', at: new Date().toISOString() }));
    const p2 = await bootPage({ routes: await serve(sb2.env), hash: '#packs' });
    const c2 = () => p2.$('content');
    await waitFor(p2, () => c2().querySelectorAll('.pk-card').length > 0);
    const todo = c2().querySelector('.pk-todo');
    const items = todo ? [...todo.querySelector('.pk-todo-list').children].map((li) => p2.text(li)) : [];
    ok('"To use packs": the missing tool is listed once, with its fix', !!todo && /^To use packs: do (this one thing|these \d+ things)$/.test(p2.text(todo.querySelector('.pk-todo-title')))
      && items.filter((x) => /^model-id/.test(x)).length === 1 && items.every((x) => /Fix: /.test(x)), items.join(' | ') || p2.text(c2()).slice(0, 600));
    const rg2 = c2().querySelector('[data-pack="review-gate"]');
    ok('…and the review gate card names its one missing need, not a list', /^Needs model-id/.test(p2.text(rg2.querySelector('.pk-ready.missing'))) && !rg2.querySelector('.pk-ready.ok'),
      p2.text(rg2.querySelector('.pk-head')));
    const prev = rg2.querySelectorAll('.pk-actions button').find((b) => /^Preview install/.test(p2.text(b)));
    rg2.querySelectorAll('.pk-part input').forEach((i) => { if (i.checked) i.click(); });
    await sleep(50);
    const rg3 = c2().querySelector('[data-pack="review-gate"]');
    const prev3 = rg3.querySelectorAll('.pk-actions button').find((b) => /^Preview install/.test(p2.text(b)));
    ok('a disabled Preview install says why, beside it', !!prev && prev3?.disabled && /Pick at least one part/.test(p2.text(rg3.querySelector('.pk-why'))) && /Pick at least one part/.test(prev3.title));
    ok('packs: no page errors', page.errors.length === 0 && p2.errors.length === 0, [...page.errors, ...p2.errors].join(' | '));
    p2.done();
  }
} finally {
  assertRealHomesUnchanged(realBefore, ok);
  done();
}
