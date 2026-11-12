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
  // Each declared size as [number, unit], skipping a `font:` shorthand's line-height after a slash.
  const sizes = (body) => [...body.matchAll(/font(?:-size)?\s*:\s*([^;]+)/g)].flatMap((m) => [...m[1].matchAll(/(\d*\.?\d+)(px|rem|em)\b/g)]
    .filter((v) => !/\/\s*$/.test(m[1].slice(0, v.index))).map((v) => [Number(v[1]), v[2], v[0]]));
  const compounds = (sel) => sel.trim().split(/\s*[>+~]\s*|\s+/).filter(Boolean);
  const classes = (compound) => [...compound.matchAll(/\.([\w-]+)/g)].map((m) => m[1]);
  /**
   * The smallest px size an em rule's parent can have: the nearest ancestor compound's classes, every class
   * that shares a compound with one of them anywhere in the sheet (.msg-text.md → msg-text), and the px
   * sizes rules give elements carrying any of those. The body's 14px when nothing says otherwise.
   */
  const parentPx = (sel) => {
    const parts = compounds(sel);
    if (parts.length < 2) return 14;
    const near = new Set(classes(parts.at(-2)));
    if (!near.size) return 14;
    const co = new Set(near);
    for (const r of rules) for (const part of r.sel.split(',')) for (const c of compounds(part)) {
      const cs = classes(c);
      if (cs.some((x) => near.has(x))) cs.forEach((x) => co.add(x));
    }
    const px = rules.flatMap((r) => r.sel.split(',').some((part) => classes(compounds(part).at(-1) || '').some((x) => co.has(x)))
      ? sizes(r.body).filter(([, u]) => u === 'px').map(([n]) => n) : []);
    return px.length ? Math.min(...px) : 14;
  };
  const small = [];
  for (const r of rules) {
    for (const part of r.sel.split(',')) {
      for (const [n, unit, raw] of sizes(r.body)) {
        const px = unit === 'px' ? n : unit === 'rem' ? n * 16 : n * parentPx(part);
        if (px < 11) small.push(`${part.trim()} → ${raw} (${px.toFixed(2)}px)`);
      }
    }
  }
  ok('no CSS font-size under 11px (the 9px badge included; an em resolved against its smallest parent)', small.length === 0, [...new Set(small)].join(' | '));
}
{
  // The value is read whole (no backtracking into the whitespace): "outline: none" and "outline: 0" draw nothing.
  const value = (body, prop) => [...body.matchAll(new RegExp(`(?:^|[;{\\s])${prop}\\s*:\\s*([^;]+)`, 'g'))].map((m) => m[1].trim());
  // "0", "0px", "0em" and "none" all draw nothing.
  const draws = (body) => value(body, 'outline').some((v) => !/^(none|0(?:\.0+)?(?:px|em|rem)?)(\s|$)/.test(v))
    || value(body, 'box-shadow').some((v) => !/^none\b/.test(v))
    || value(body, 'border-color').some((v) => !/^(transparent|inherit|initial|unset)\b/.test(v));
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

/* ── static: PR D visual nits ── */
console.log('\nstyles.css: PR D');
{
  const body = (sel) => rules.filter((r) => r.sel.split(',').map((x) => x.trim()).includes(sel)).map((r) => r.body).join(';');
  // PR G (no folds anywhere): the chevron style PR D added is gone with the last toggle that drew it.
  ok('no chevron toggle style is left (.chev)', !rules.some((r) => /\.chev\b/.test(r.sel)));
  ok('Models cards: the button row sits at the card bottom, so Edit / Reset line up across a row', /margin-top\s*:\s*auto/.test(body('.model-card > .model-card-buttons')));
  ok('a Files entry\'s file count sits right after its name (the name does not stretch)', !/flex\s*:\s*1\b/.test(body('.files-item-label')) && /margin-left/.test(body('.files-item-count')));
  // The diagram's encodings, one look each: off = a dashed tile; script = a solid outline chip.
  ok('script chips are solid outlines, not dashed (dashed means "off")', /border\s*:[^;]*solid/.test(body('.pk-flow .w.script')) && !/dashed/.test(body('.pk-flow .w.script'))
    && /border\s*:[^;]*solid/.test(body('.step-mark.script')) && !/dashed/.test(body('.step-mark.script')));
  ok('a script\'s strip segment and legend swatch are solid too (dashed means "off" everywhere)', /border\s*:[^;]*solid/.test(body('.pk-strip-seg.script')) && !/dashed/.test(body('.pk-strip-seg.script')));
  // f1: both Used-by states (the toggle and "Not used by any role") share one height, so the buttons above line up.
  const mh = (sel) => (body(sel).match(/min-height\s*:\s*([^;]+)/) || [])[1]?.trim();
  ok('Models cards: the "Used by" toggle and "Not used by any role" share one min-height', !!mh('.btn.model-used-toggle') && mh('.btn.model-used-toggle') === mh('.model-used-none')
    && /margin-top\s*:\s*0/.test(body('.model-used-none')));
  ok('an off step\'s mark is dashed, and so is its "off" word', /dashed/.test(body('.pk-flow .step.off .step-mark')) && /dashed/.test(body('.step-off')));
}

/* ── static: PR C QA at the real window (about 1343×679) ── */
console.log('\nstyles.css: PR C QA');
{
  const body = (sel) => rules.filter((r) => r.sel.split(',').map((x) => x.trim()).includes(sel)).map((r) => r.body).join(';');
  ok('each theme tells the browser its colour scheme, so native checkboxes and scrollbars match', /color-scheme\s*:\s*dark/.test(body(':root'))
    && /color-scheme\s*:\s*light/.test(body(':root[data-theme="light"]')));
  ok('checkboxes and radios take the accent colour', rules.some((r) => /input\[type="?checkbox"?\]/.test(r.sel) && /accent-color/.test(r.body)));
  ok('placeholders use the muted colour at full opacity (4.5:1)', /color\s*:\s*var\(--muted\)/.test(body('::placeholder')) && /opacity\s*:\s*1/.test(body('::placeholder')));
  ok('a disabled button looks disabled: a dashed, softer border', /border-style\s*:\s*dashed/.test(body('.btn:disabled')) || /border\s*:[^;]*dashed/.test(body('.btn:disabled')));
  ok('Usage\'s "82% left" stays on one line: no fixed narrow width, no wrap', /white-space\s*:\s*nowrap/.test(body('.usage-pct')) && !/(^|;)\s*width\s*:\s*[1-5]?\d px/.test(body('.usage-pct').replace(/px/g, ' px')));
  ok('Usage\'s stop-tracking × is fully visible when shown (no faded opacity), with a hit area', !/opacity\s*:\s*0?\.\d/.test(body('.usage-seat:hover .usage-drop'))
    && /width\s*:\s*2\dpx/.test(body('.usage-drop')));
  // PR G: a Files type is a plain heading, never a fold; its "+" keeps a visible box.
  ok('Files: no type-toggle chevron, and its "+" has a visible box', !rules.some((r) => /files-type-toggle/.test(r.sel)) && /border\s*:/.test(body('.files-add')));
  ok('a diagram step title never wraps', /white-space\s*:\s*nowrap/.test(body('.pk-flow .step-name')));
  ok('the steps are one list: each row a mark, the step, its line and who does it', /grid-template-columns\s*:\s*28px\s+\d+px\s+minmax\(0,\s*1fr\)\s+minmax\(0,\s*auto\)/.test(body('.pk-flow .step')));
  // PR F: Packs has no folds at all (Cris) — a part's explain lives in the card's "Files and undo" dialog, so no part fold style is left.
  ok('no .pk-part fold style is left: a part has no fold', !rules.some((r) => /\.pk-part[^,{]*summary\.fold|\.pk-part[^,{]*details/.test(r.sel)));
}

/* ── static: folds and buttons look like controls (Cris, 2026-11-06) ── */
console.log('\nstyles.css: a data fold is a styled control; buttons are clearly buttons');
{
  const has = (sel, re) => rules.some((r) => r.sel.split(',').map((x) => x.trim()).includes(sel) && re.test(r.body));
  // PR G (no folds anywhere): no fold is left to style.
  ok('no data-fold style is left (summary / details)', !rules.some((r) => /(^|[\s,>+~])(summary|details)\b/.test(r.sel)), rules.filter((r) => /(^|[\s,>+~])(summary|details)\b/.test(r.sel)).map((r) => r.sel).join(' | '));
  ok('a secondary button has a visible border (not the panel\'s own border colour)', has('.btn', /border\s*:[^;]*color-mix|border-color\s*:[^;]*color-mix/));
  ok('a quiet button has its own text colour and a hover background', has('.btn.ghost', /(^|;)\s*color\s*:/) && rules.some((r) => r.sel.includes('.btn.ghost:hover') && /background/.test(r.body)));
  const dis = rules.filter((r) => r.sel.split(',').some((x) => x.trim() === '.btn:disabled'));
  ok('a disabled button stays readable: no opacity under 0.7', dis.length > 0 && dis.every((r) => !/opacity\s*:\s*0?\.[0-6]/.test(r.body)), dis.map((r) => r.body.trim()).join(' | '));
}

/* ── static: Details folds and quiet meta (the Skills page bug, 2026-11-06) ── */
console.log('\nstyles.css: a Details fold never slides under the control above it; meta text is not code');
{
  // A Details fold after a page's toolbar (Skills' New skill, Audit's Run again) was pulled up 12px by a
  // negative top margin meant for a fold under an intro line, and sat behind the button. Only a fold that
  // follows an intro line (a sibling combinator in the selector) may pull itself up.
  const pulled = rules.filter((r) => r.sel.split(',').some((x) => /details\.more\s*$/.test(x.trim()) && !/[+~]/.test(x))
    && (/margin-top\s*:\s*-/.test(r.body) || /margin\s*:\s*-/.test(r.body)));
  ok('no bare details.more rule pulls the fold up with a negative top margin', pulled.length === 0, pulled.map((r) => `${r.sel} {${r.body.trim()}}`).join(' | '));
  // The top bar's subtitle is a sentence on every view, a path only on a file: monospace only for the path.
  const mono = (sel) => rules.filter((r) => r.sel.split(',').map((x) => x.trim()).includes(sel)).some((r) => /font(?:-family)?\s*:[^;]*var\(--mono\)/.test(r.body));
  ok('the top bar subtitle is not monospace, except as a file path (.title-path.is-path)', !mono('.title-path') && mono('.title-path.is-path'));
  ok('skill meta lines ("3 files · 12 KB", "11 invocations", "no recorded use") are not monospace',
    ['.sk-meta', '.sk-usage-count', '.sk-usage-none'].every((sel) => !mono(sel)), ['.sk-meta', '.sk-usage-count', '.sk-usage-none'].filter(mono).join(', '));
}

/* ── static: tinted states in the light theme, from the CSS values ───── */
// Review 2026-11-06-15-12-50 f1: states the seeded QA never showed (a search hit, a new-CLI part badge, an
// added line in a Describe preview, the Claude tag, installed/update badges) sat at 4.17–4.49:1 in light.
// Each text colour over its own color-mix tint, laid on the light surfaces they appear on, must reach 4.6:1.
console.log('\nlight theme: text on its own tint, computed from styles.css');
{
  const raw = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const block = (sel) => {
    const i = raw.indexOf(`${sel} {`);
    return Object.fromEntries([...raw.slice(i, raw.indexOf('}', i)).matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
  };
  const light = { ...block(':root'), ...block(':root[data-theme="light"]') };
  const resolve = (v, seen = 0) => { const m = /^var\(--([\w-]+)\)$/.exec(v.trim()); return m && seen < 5 ? resolve(light[m[1]], seen + 1) : v.trim(); };
  /** #rgb, #rgba, #rrggbb or #rrggbbaa as [r, g, b]; anything else throws, so it can never pass silently. */
  const rgb = (h) => {
    const v = resolve(h);
    const m = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(v || '');
    if (!m) throw new Error(`unparseable colour "${h}" → "${v}"`);
    const d = m[1].length <= 4 ? [...m[1]].map((c) => c + c).join('') : m[1];
    const [r, g, b, a = 255] = d.match(/../g).map((x) => parseInt(x, 16));
    // A translucent colour depends on what is under it: fail loudly rather than guess.
    if (a !== 255) throw new Error(`translucent colour "${h}" → "${v}": blend it before measuring`);
    return [r, g, b];
  };
  const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const lum = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const rule = (sel) => rules.filter((r) => r.sel.split(',').map((s) => s.trim()).includes(sel)).map((r) => r.body).join(';');
  // [selector for the text colour, selector for the tint] — the same rule unless the text sits in a child.
  const PAIRS = [
    ['.result-line b', '.result-line b'],
    ['.harness-tag.claude', '.harness-tag.claude'],
    ['.harness-tag.codex', '.harness-tag.codex'],
    ['.diff-line.add', '.diff-line.add'],
    ['.diff-line.add .t', '.diff-line.add'],
  ];
  const low = [];
  for (const [fgSel, bgSel] of PAIRS) {
    // The cascade: a later rule for the same selector wins, so take the last declaration.
    const fg = [...rule(fgSel).matchAll(/(?:^|;)\s*color:\s*([^;]+)/g)].at(-1)?.[1];
    const tint = [...rule(bgSel).matchAll(/background:\s*color-mix\(in srgb,\s*([^\s]+)\s+(\d+)%,\s*transparent\)/g)].at(-1);
    if (!fg || !tint) { low.push(`${fgSel}: no color or tint found`); continue; }
    let c, t;
    try { c = rgb(fg); t = rgb(tint[1]); } catch (e) { low.push(`${fgSel}: ${e.message}`); continue; }
    const p = Number(tint[2]) / 100;
    for (const surface of ['bg', 'panel', 'panel-2']) {
      let s;
      try { s = rgb(`var(--${surface})`); } catch (e) { low.push(`--${surface}: ${e.message}`); continue; }
      const r = ratio(c, t.map((v, i) => v * p + s[i] * (1 - p)));
      if (!(r >= 4.6)) low.push(`${fgSel} on ${surface}: ${r.toFixed(2)}`);
    }
  }
  ok('every tinted state reaches 4.6:1 on bg, panel and panel-2 (search hits, part badges, Describe diffs, CLI tags)', low.length === 0, low.join(' | '));
}

/* ── static: orange and amber controls, both themes, text AND edge (PR H) ── */
// Cris, 2026-11-09: orange/amber buttons were hard to see in light. Every orange or amber button and badge,
// in light and dark, on bg, panel and panel-2: its text reaches 4.5:1 against what is behind it, and its edge —
// its border, or its fill when it has no border — reaches 3:1 against the page. Text-only (quiet) controls have
// no edge to measure; their text still must pass.
console.log('\norange and amber controls: text 4.5:1 and edge 3:1, light and dark, from styles.css');
{
  const raw = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const tokens = (sel) => {
    const i = raw.indexOf(`${sel} {`);
    return Object.fromEntries([...raw.slice(i, raw.indexOf('}', i)).matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
  };
  const THEMES = { dark: tokens(':root'), light: { ...tokens(':root'), ...tokens(':root[data-theme="light"]') } };
  const hex = (h) => { const d = h.length <= 4 ? [...h.slice(1)].map((c) => c + c).join('') : h.slice(1); return d.match(/../g).slice(0, 3).map((x) => parseInt(x, 16)); };
  /** A colour as [r,g,b,a] over nothing yet: hex, var(), color-mix(in srgb, A p%, B|transparent), transparent. */
  const parse = (v, t, depth = 0) => {
    v = String(v || '').trim();
    if (depth > 8) throw new Error(`too deep: ${v}`);
    if (v === 'transparent' || v === 'none') return [0, 0, 0, 0];
    let m;
    if ((m = /^var\(--([\w-]+)\)$/.exec(v))) return parse(t[m[1]], t, depth + 1);
    if (/^#[0-9a-f]{3,8}$/i.test(v)) return [...hex(v), 1];
    if ((m = /^color-mix\(in srgb,\s*(.+?)\s+(\d+(?:\.\d+)?)%,\s*(.+)\)$/.exec(v))) {
      const a = parse(m[1], t, depth + 1), b = parse(m[3], t, depth + 1), p = Number(m[2]) / 100;
      // Mixing with transparent keeps the colour and scales its alpha; otherwise a plain mix.
      if (b[3] === 0) return [a[0], a[1], a[2], a[3] * p];
      return [0, 1, 2].map((i) => a[i] * p + b[i] * (1 - p)).concat(a[3] * p + b[3] * (1 - p));
    }
    throw new Error(`unparseable colour "${v}"`);
  };
  const over = (c, under) => [0, 1, 2].map((i) => c[i] * c[3] + under[i] * (1 - c[3]));
  const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const lum = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  /** The declarations a chain of selectors gives, later ones winning (base rule first, then the variant). */
  const decl = (chain) => {
    const out = {};
    for (const sel of chain) {
      for (const r of rules.filter((x) => x.sel.split(',').map((y) => y.trim()).includes(sel))) {
        for (const m of r.body.matchAll(/(?:^|;)\s*(color|background|background-color|border|border-color)\s*:\s*([^;]+)/g)) {
          const [, k, v] = m;
          if (k === 'background' || k === 'background-color') out.bg = v.trim();
          else if (k === 'color') out.color = v.trim();
          else if (k === 'border-color') out.edge = v.trim();
          else if (k === 'border') { const c = v.trim().replace(/^\S+\s+\S+\s+/, ''); out.edge = /^(none|0)$/.test(v.trim()) ? 'transparent' : c; }
        }
      }
    }
    return out;
  };
  // Every orange or amber button and badge: [name, selector chain, text-only?].
  const CONTROLS = [
    ['primary button', ['.btn', '.btn.primary']],
    ['quiet button', ['.btn', '.btn.ghost'], true],
    ['picked model', ['.btn', '.btn.roles-pick', '.btn.roles-pick.on']],
    ['picked model number', ['.roles-pick-n']],
    ['Assist chip, active', ['.assist-chip', '.assist-chip.active']],
    ['Setup step, current', ['.setup-step-btn', '.setup-step-btn.active']],
    ['wizard step link', ['.sw-step-btn'], true],
    ['sidebar count', ['.nav-badge']],
    ['warn badge', ['.item-badge', '.item-badge.warn']],
    ['retiring alert', ['.models-alert', '.models-alert.retiring']],
    ['memory warn badge', ['.mem-badge', '.mem-badge.warn']],
    ['memory folders-missing badge', ['.mem-badge', '.mem-badge.folders-missing']],
    ['Home "needs you"', ['.home-needs']],
    ['Home warn chip', ['.home-chip', '.home-chip.warn']],
    ['guide out-of-date chip', ['.guide-chip', '.guide-chip.stale']],
    ['Model ids alert count', ['.ids-count']],
    // A pack's status is a dot and a word, no box: its text is what must read.
    ['pack "Needs setup", "Edited", "Update ready"', ['.pk-st', '.pk-st.warn'], true],
    ['pack "Installed", "On"', ['.pk-st', '.pk-st.ok'], true],
    ['pack "Not working"', ['.pk-st', '.pk-st.err'], true],
    ['pack "Not installed", "Off"', ['.pk-st', '.pk-st.off'], true],
    ['agent merge "needs the gh CLI" line', ['.pk-set-warn'], true],
    ['audit synced class', ['.audit-class', '.audit-class.synced']],
    ['audit warn', ['.audit-sev', '.audit-sev.warn']],
    ['account offline tag', ['.usage-offline-tag']],
    ['changed-from-default mark', ['.changed-mark']],
    ['default model chip', ['.job-chip', '.job-chip.first']],
  ];
  const bad = [];
  for (const [theme, t] of Object.entries(THEMES)) {
    for (const surface of ['bg', 'panel', 'panel-2']) {
      const page = parse(`var(--${surface})`, t);
      for (const [name, chain, textOnly] of CONTROLS) {
        const d = decl(chain);
        if (!d.color) { bad.push(`${name}: no colour found`); continue; }
        let fg, fill, edge;
        try { fg = parse(d.color, t); fill = parse(d.bg || 'transparent', t); edge = parse(d.edge || 'transparent', t); } catch (e) { bad.push(`${name}: ${e.message}`); continue; }
        const behind = over(fill, page);
        const tr = ratio(over(fg, behind), behind);
        if (!(tr >= 4.5)) bad.push(`${theme}/${surface} ${name} text ${tr.toFixed(2)}`);
        if (textOnly) continue;
        // The edge: the border if it shows, else the fill.
        const e = edge[3] > 0 ? over(edge, page) : fill[3] > 0 ? behind : null;
        const er = e ? ratio(e, page) : 0;
        if (!(er >= 3)) bad.push(`${theme}/${surface} ${name} edge ${er.toFixed(2)}`);
      }
    }
  }
  ok('every orange or amber button and badge: text ≥4.5:1 and edge ≥3:1 on bg, panel and panel-2, light and dark', bad.length === 0, bad.join(' | '));
}

/* ── static: words the views never render on their own ───────────────── */
console.log('\nindex.html and the server\'s errors: no "harness"');
{
  // index.html's own buttons: their text, and every title / aria-label / placeholder.
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const said = [...html.matchAll(/\b(?:title|aria-label|placeholder)="([^"]*)"/g)].map((m) => m[1])
    .concat([...html.matchAll(/>([^<>]*[A-Za-z][^<>]*)</g)].map((m) => m[1]));
  ok('index.html: no "harness" in any button text, title, aria-label or placeholder', !said.some((s) => /harness/i.test(s)),
    said.filter((s) => /harness/i.test(s)).join(' | '));
  // Every message the server throws at a request: the string literal inside `new Error(…)`.
  const thrown = [];
  // server.js, and the one lib/harness.js message a request reaches (an unknown CLI id); the rest are internal guards.
  for (const f of ['server.js', 'lib/harness.js']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const m of src.matchAll(/new Error\(\s*(['`])((?:\\.|(?!\1).)*)\1/g)) {
      if (f === 'lib/harness.js' && !/^unknown /.test(m[2])) continue;
      if (/harness/i.test(m[2].replace(/\$\{[^}]*\}/g, ''))) thrown.push(`${f}: ${m[2]}`);
    }
  }
  ok('server.js and lib/harness.js: no error a request can see says "harness"', thrown.length === 0, thrown.join(' | '));
}

/* ── the sweep: every view, rendered against a real server ───────────── */
const sb = sandbox('words', { clis: ['claude', 'codex'] });
const H = sb.home;
const put = (rel, body) => { const f = path.join(H, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); };
put('.agent-config-studio/setup.json', JSON.stringify({ completed: 'done', at: new Date().toISOString() }));
put('.claude/CLAUDE.md', '# Global\n\nBe brief.\n');
put('.codex/AGENTS.md', '# Global\n\nBe brief.\n');
put('.claude/skills/alpha/SKILL.md', '---\nname: alpha\ndescription: a test skill\n---\n\nDo alpha.\n');
// A skill that holds three files, so Files shows a per-entry count and the card header must add it up.
put('.claude/skills/beta/SKILL.md', '---\nname: beta\ndescription: a skill with helper files\n---\n\nDo beta.\n');
put('.claude/skills/beta/helper.md', 'Helper notes.\n');
put('.claude/skills/beta/run.sh', 'echo beta\n');
// PR G: a skill the Audit flags (a model-id call with no fallback), so Audit's cards render in the sweep.
put('.claude/skills/gamma/SKILL.md', '---\nname: gamma\ndescription: calls a model\n---\n\n```bash\ncodex exec -m $(model-id sol) "review"\n```\n');
// A skill carrying a block copy, so Building blocks shows a real copy row in the sweep.
put('.claude/skills/delta/SKILL.md', '---\nname: delta\ndescription: carries a block\n---\n\nNever merge a PR or enable auto-merge. Only the operator merges.\n');
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
  // Home and Setup say "installed" for a CLI the detector finds; so does Packs' machine line. The PATH
  // gap is said only where it blocks something: in the one Packs need, as what to do.
  ok('installed but off the PATH: the machine line says only "installed" — no off-PATH note there', cli('claude').installed && !cli('claude').cli
    && cli('claude').note === null && cli('claude').why === null, JSON.stringify(cli('claude')));
  ok('installed and on the PATH: nothing to add', cli('codex').installed && cli('codex').note === null, JSON.stringify(cli('codex')));
  ok('absent: "not installed", and its folder missing', !cli('grok').present && cli('grok').why === 'not installed, and no ~/.grok', JSON.stringify(cli('grok')));
  m.clis = { claude: null, codex: null, grok: null };
  const rg = catalogView(m, { installedOf: (id) => id === 'claude' }).packs.find((p) => p.id === 'review-gate');
  const need = rg.requirements.find((r) => r.id === 'cli');
  ok('the agent-CLI need agrees with Home and is worded as what to do: put Claude Code on the studio\'s PATH',
    !need.ok && need.group === 'path' && need.name === 'Claude Code' && need.what === 'Put Claude Code on the studio\'s PATH'
      && !/no agent CLI|not installed/.test(need.what), JSON.stringify(need));
  const none = catalogView(m, { installedOf: () => false }).packs.find((p) => p.id === 'review-gate').requirements.find((r) => r.id === 'cli');
  ok('…and with no CLI anywhere, it says none is installed, outside the PATH fix', !none.ok && /no agent CLI is installed/.test(none.what) && !none.group, JSON.stringify(none));
  const git = rg.requirements.find((r) => r.id === 'git');
  ok('a need that is met shows no full path', git.ok && git.what === 'git', JSON.stringify(git));
  const tools = rg.requirements.filter((r) => ['model-id', 'ask-model'].includes(r.id) && !r.ok);
  ok('model-id and ask-model missing from the PATH belong to the same PATH fix as the CLIs', tools.length === 0 || tools.every((r) => r.group === 'path' && r.name === r.id),
    JSON.stringify(rg.requirements));

  // Review LOW (2026-11-06): Codex found off the studio's PATH, and no ~/.codex yet. Home and Setup say
  // "installed"; Packs must never answer "not installed" for it — on the machine line or the Install-for row.
  m.clis = { claude: m.clis.claude, codex: null, grok: null };
  m.present = { claude: true, codex: false, grok: false };
  const off = catalogView(m, { installedOf: (id) => id !== 'grok' });
  const cx = off.harnesses.find((h) => h.id === 'codex');
  ok('installed, no settings folder: never "not installed"; the Install-for reason says what to do', cx.installed && !cx.present && cx.note === null
    && cx.why === 'installed, but ~/.codex doesn\'t exist yet — run Codex once, then refresh' && !/not installed/.test(cx.why), JSON.stringify(cx));
  const stub = routesFor({
    'GET /api/packs': () => off,
    'GET /api/packs/status': () => ({ job: { running: false, result: { packs: [], legacy: [], checkedAt: Date.now(), trust: false } } }),
  });
  const pg = await bootPage({ routes: stub, hash: '#packs' });
  for (let i = 0; i < 100 && !pg.$('content').querySelector('.pk-clis'); i++) await sleep(20);
  const codex = pg.$('content').querySelectorAll('.pk-cli').find((n) => /Codex/.test(pg.text(n)));
  const here = pg.text(pg.$('content').querySelector('.pk-clis'));
  pg.navigate('#packs/review-gate');
  await sleep(20);
  pg.$('content').querySelector('.pk-page-actions').querySelectorAll('button').find((b) => pg.text(b) === 'Install').click();
  for (let i = 0; i < 100 && !pg.$('content').querySelector('.pk-harnesses'); i++) await sleep(20);
  const rows = pg.$('content').querySelectorAll('.pk-harnesses').map((r) => pg.text(r)).join(' | ');
  ok('…and the page agrees: Codex shown installed on the machine line with nothing after it, the reason on the install preview\'s Install-for row, no "not installed" for Codex',
    !!codex && codex.classList.contains('on') && pg.text(codex) === 'Codex' && codex.getAttribute('title') === 'Codex: installed' && !/not on the PATH|doesn.t exist/.test(here)
      && /Codex: installed, but ~\/\.codex doesn.t exist yet/.test(rows) && !/Codex:? ?not installed/.test(`${here} ${rows}`), `${here} || ${rows}`);
  ok('…with no page errors', pg.errors.length === 0, pg.errors.join(' | '));
  pg.done();
}

/* ── Packs: the top block holds only what every pack needs; cards never repeat it ── */
console.log('\nPacks: shared needs once, each pack its single most important need');
{
  const req = (id, ok, extra = {}) => ({ id, ok, what: extra.what || `${id} need`, fix: extra.fix || `fix ${id}`, dep: extra.dep || null, ...extra });
  const pack = (id, title, requirements) => ({ id, title, version: '1.0.0', summary: `${title} does a thing.`,
    explain: { what: `${title} is a pack.`, does: 'd', changes: ['c'], undo: 'u' }, requires: { packs: [] },
    parts: [{ id: `${id}-skill`, title: `${title} skill`, default: true, kind: 'skill', harnesses: ['claude'], explain: { what: `${title} skill does it.`, does: 'd', changes: ['c'], undo: 'u' } }],
    requirements, installed: null });
  const path = (id, name) => req(id, false, { group: 'path', name, what: `${name} is not on PATH`, fix: `link ${name}` });
  const catalog = (packs) => ({ packs, harnesses: [{ id: 'claude', label: 'Claude Code', present: true, installed: true, cli: true, home: '~/.claude', note: null, why: null }],
    legacy: [], words: { status: { installed: 'installed', absent: 'not installed' }, symbol: {}, what: {} } });
  const boot = async (cat) => {
    const p = await bootPage({ routes: routesFor({ 'GET /api/packs': () => cat,
      'GET /api/packs/status': () => ({ job: { running: false, result: { packs: [], legacy: [], checkedAt: Date.now(), trust: false } } }) }), hash: '#packs' });
    for (let i = 0; i < 100 && !p.$('content').querySelector('.pk-card'); i++) await sleep(20);
    return p;
  };
  // git is missing for both packs (shared); only "gate" also lacks model-id and ask-model (one PATH fix) and valid roles.
  const p = await boot(catalog([
    pack('gate', 'Gate', [req('node', true), req('git', false, { what: 'git is not on PATH', fix: 'install git' }), path('model-id', 'model-id'), path('ask-model', 'ask-model'), req('roles', false)]),
    pack('plain', 'Plain', [req('node', true), req('git', false, { what: 'git is not on PATH', fix: 'install git' })]),
  ]));
  const pc = () => p.$('content');
  ok('the grid says once how many things to set up, with Show me', /^2 things to set up before packs run/.test(p.text(pc().querySelector('.pk-shared'))), p.text(pc().querySelector('.pk-shared')));
  const status = (id) => p.text(pc().querySelector(`.pk-card[data-pack="${id}"] .pk-st`));
  const cardText = (id) => p.text(pc().querySelector(`.pk-card[data-pack="${id}"]`));
  // A card says Needs setup only for a need of its own; the shared ones are said once, above the grid.
  ok('a card never repeats the shared need: gate "Needs setup" (its own roles need), plain "Not installed"', status('gate') === 'Needs setup' && status('plain') === 'Not installed'
    && !/git|search path/.test(cardText('gate') + cardText('plain')), `${status('gate')} | ${status('plain')}`);
  p.navigate('#packs/setup');
  await sleep(20);
  const todo = pc().querySelector('.pk-todo');
  const items = todo ? [...todo.querySelector('.pk-todo-list').children].map((li) => p.text(li)) : [];
  // PR F (critique P2-2): the search-path fix is one machine fix — said once, with how many packs it blocks, never per pack.
  ok('#packs/setup lists what every pack needs (git), then the one search-path fix, saying it blocks 1 of 2 packs', items.length === 2 && /^git is not on PATH/.test(items[0])
    && /search path, so agents can.t run them: model-id, ask-model/.test(items[1]) && /Needed by 1 of 2 packs/.test(items[1]), items.join(' | '));
  ok('…the PATH problems as ONE item naming only the missing tools, and its one fix', /Fix: run acs install-model-id/.test(items[1]) && !/Claude Code|Grok/.test(items[1]) && /restart the studio/.test(items[1]), items[1]);
  p.navigate('#packs/gate');
  await sleep(20);
  const head = p.text(pc().querySelector('.pk-page-head'));
  ok('the gate page says its own most important need (valid roles) and its fix, not the shared ones', /Needs valid ACS roles/.test(p.text(pc().querySelector('.pk-page-meta .pk-need')))
    && /Fix: fix roles/.test(head) && !/git|search path|model-id/.test(head), head);
  p.navigate('#packs/plain');
  await sleep(20);
  const meta = pc().querySelector('.pk-page-meta');
  ok('a page whose only gap is the shared need is not called Ready: "Not ready", and a way to what to set up', /Not ready/.test(p.text(meta)) && !meta.querySelector('.pk-ready')
    && !!meta.querySelectorAll('button').find((b) => p.text(b) === 'See what to set up'), p.text(meta));
  meta.querySelectorAll('button').find((b) => p.text(b) === 'See what to set up').click();
  await sleep(20);
  ok('…which opens #packs/setup', p.location.hash === '#packs/setup' && !!pc().querySelector('.pk-todo'));
  p.done();

  // The PATH fix shared by every pack: one item, not three.
  const q = await boot(catalog([
    pack('a', 'A', [path('model-id', 'model-id'), path('ask-model', 'ask-model'), req('cli', false, { group: 'path', name: 'Claude Code and Grok', what: 'Put Claude Code and Grok on the studio\'s PATH' })]),
    pack('b', 'B', [path('model-id', 'model-id'), path('ask-model', 'ask-model'), req('cli', false, { group: 'path', name: 'Claude Code and Grok', what: 'Put Claude Code and Grok on the studio\'s PATH' })]),
  ]));
  ok('…and every card then has nothing of its own to add', q.$('content').querySelectorAll('.pk-card .pk-st').every((n) => q.text(n) === 'Not installed'));
  // No "Details" folds (Cris, 2026-11-06): the status is one quiet line — when it was checked and Refresh — never a raw disclosure.
  const sl = q.$('content').querySelector('#pk-status');
  ok('Packs: the status is one quiet line, not inside any fold, with a quiet Refresh', !!sl && !sl.closest('details') && !sl.querySelector('details, input')
    && /^(Checked at .+|Not checked yet)Refresh$/.test(q.text(sl)) && sl.querySelector('button')?.classList.contains('ghost'), q.text(sl || { textContent: '' }));
  q.navigate('#packs/setup');
  await sleep(20);
  const qi = [...(q.$('content').querySelector('.pk-todo-list')?.children || [])].map((li) => q.text(li));
  ok('model-id, ask-model and the CLIs off the PATH are one item, with one fix', qi.length === 1
    && /^Some commands aren.t on your shell.s search path, so agents can.t run them: model-id, ask-model, Claude Code, Grok/.test(qi[0]) && /acs install-model-id/.test(qi[0])
    && /each CLI's folder/.test(qi[0]) && /restart the studio/.test(qi[0]), qi.join(' | '));
  q.navigate('#packs/a');
  await sleep(20);
  ok('…and a pack\'s page does not repeat it: Not ready, with the way to it', /Not ready/.test(q.text(q.$('content').querySelector('.pk-page-meta'))) && !/search path/.test(q.text(q.$('content').querySelector('.pk-page-head'))));
  ok('…with no page errors', p.errors.length === 0 && q.errors.length === 0, [...p.errors, ...q.errors].join(' | '));
  q.done();
}

/* ── one word for a subscription account, and Codex's usage explained where its CLI is missing ── */
console.log('\nHome: "account" everywhere, and Codex not installed beside live Codex accounts');
{
  const clis = { clis: [
    { id: 'claude', label: 'Claude Code', installed: true, binary: '~/.local/bin/claude', version: '2.1.0', signIn: { state: 'verified', label: 'verified' }, fix: {} },
    { id: 'codex', label: 'Codex', installed: false, binary: null, version: null, signIn: { state: 'none', label: 'not signed in' }, fix: {} },
    { id: 'grok', label: 'Grok', installed: false, binary: null, version: null, signIn: { state: 'none', label: 'not signed in' }, fix: {} },
  ] };
  const usage = { seats: [{ seatId: 'codex', label: 'Codex (main)', vendor: 'codex', home: '/h/.codex', ok: true, observedAt: Date.now(),
    windows: [{ label: 'Weekly', usedPercent: 20, resetsAt: Date.now() + 86_400_000 }] }] };
  const h = await bootPage({ routes: routesFor({ 'GET /api/setup/clis': () => clis, 'GET /api/usage': () => usage, 'GET /api/roots': () => ({ roots: [{ id: 'p', label: 'Projects', status: 'ok', access: 'edit' }] }) }), hash: '#home' });
  for (let i = 0; i < 100 && !/Codex/.test(h.text(h.$('content'))); i++) await sleep(20);
  await sleep(200);
  const t = h.text(h.$('content'));
  ok('Home says once why Codex reports usage without its CLI', (t.match(/Codex isn.t installed here, but these accounts still report usage from their Codex folders\./g) || []).length === 1, t.slice(0, 900));
  ok('Home names them accounts: "Codex accounts", never "seat"', /Codex accounts/.test(t) && !/\bseats?\b/i.test(t), t.slice(0, 900));
  ok('Home\'s folder count is in plain words, not "(edit) · (read)"', !/\((edit|read)\)/.test(t) && h.eval('folderCountText({ roots: [{ status: "ok", access: "edit" }, { status: "ok", access: "read" }, { status: "ok", access: "read" }] })') === 'Project folders: 1 you can edit, 2 read-only', h.eval('folderCountText({ roots: [] })'));
  ok('Worktrees: env states in plain words', h.eval('envWords("missing:1")') === '1 env file missing'
    && h.eval('envWords("copy:1,missing:2")') === '1 env file copied, 2 missing' && h.eval('envWords("linked")') === 'env files linked to the trunk',
    `${h.eval('envWords("missing:1")')} / ${h.eval('envWords("copy:1,missing:2")')} / ${h.eval('envWords("linked")')}`);
  ok('Usage: the "Codex reports quota only after a turn" caveat is not on the hint (the row\'s reason already says it)', !/quota/.test(h.eval('waitingHint().textContent')), h.eval('waitingHint().textContent'));
  ok('…with no page errors', h.errors.length === 0, h.errors.join(' | '));
  h.done();
}

/* ── the editor's Save and Skills' bar: a disabled button says why ───── */
console.log('\nDisabled buttons say why: the editor\'s Save, Skills\' Clear and Download');
{
  const { PATHS } = await import('./fixtures/shell-page.mjs');
  const e = await bootPage({ hash: `#file=${encodeURIComponent(PATHS.claudeMd)}` });
  for (let i = 0; i < 100 && e.eval('S.view') !== 'entry'; i++) await sleep(20);
  await sleep(100);
  const save = e.$('btn-save');
  ok('an unchanged file: Save is disabled and says "No changes to save"', save.disabled && save.title === 'No changes to save', `${save.disabled} ${save.title}`);
  e.eval("S.tab = 'edit'; renderContent(); renderStatus()");
  const ta = e.$('content').querySelector('textarea');
  ok('the editor names its way out: Esc leaves it (Tab still types spaces)', ta?.getAttribute('aria-keyshortcuts') === 'Escape', ta?.getAttribute('aria-keyshortcuts'));
  e.done();
  const s = await bootPage({ hash: '#skills' });
  for (let i = 0; i < 100 && !s.$('sk-download'); i++) await sleep(20);
  ok('Skills, nothing selected: Clear and Download are disabled and say why', s.$('sk-download').disabled && s.$('sk-clear').disabled
    && /select/i.test(s.$('sk-download').title) && /select/i.test(s.$('sk-clear').title), `${s.$('sk-download').title} | ${s.$('sk-clear').title}`);
  s.done();
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
  // Home may say "memory" only in its auto-memory cleanup lines (public/home.js memoryItems).
  { name: '"memory" for an instruction file', re: /memory/i, allowIn: ['memory'],
    // "Auto-memory" is the auto-memory group, wherever it shows; the sidebar (PR C regroups it) is not swept.
    except: [/Auto-memory/gi, /\S*\/memory\b\S*/g,
      /\d+ memory files? missing from (?:its|their) index/g, /\d+ memory index(?:es)? over the length Claude Code reads/g,
      // …and Home's all-clear line, which names the Memory page among the sources it checked.
      /checked: models, memory, worktrees and context/g, /Models, memory, worktrees and context all checked/g,
      // …and its loading line while those sources are read ("Checking models, memory, worktrees, context…").
      /Checking (?:[a-z]+, )*memory(?:, [a-z]+)*…/g] },
  { name: '"Delete" for something recoverable', re: /\bdelet/i,
    // Permanent actions keep the word: a role (no trash), an Assist session, a file gone outside the studio, and "never deleted" (a promise about history).
    except: [/Delete role/g, /Delete this session/g, /deleted outside the studio/g, /never deleted/g],
    // Building blocks quotes rule text word for word: the never-weaken-tests block's own phrase, inside a rendered block text only.
    quoteIn: { view: 'blocks', within: '.bb-text', phrases: ['Do not delete, skip, weaken, or narrow tests or checks'] } },
  // One word for a subscription account: "account", as Home's "Accounts & usage" says.
  { name: '"seat" for an account', re: /\bseats?\b/i },
  // PR F (final critique P1-1, P2-1, P2-2): words a newcomer can't act on. "Trunk" is explained (ⓘ) on Worktrees only.
  // …and in the Worktree setup pack's own explain, which defines it ("Each project gets a trunk: a checkout parked on …").
  { name: '"trunk" outside Worktrees', re: /\btrunks?\b/i, allowIn: ['worktrees'],
    except: [/Each project gets a trunk:/g, /beside the trunk/g, /conf file at the trunk/g, /from the trunk so it runs/g, /their trunks/g] },
  { name: '"drifted"', re: /\bdrifted\b/i },
  { name: '"headroom"', re: /headroom/i },
  { name: '"Route to"', re: /\bRoute to\b/i },
  { name: '"Orphans"', re: /\borphans?\b/i },
  { name: '"Operations" for recent cleanups', re: /\bOperations\b/ },
  { name: '"frontmatter"', re: /frontmatter/i },
  { name: '"invocations"', re: /invocations?/i },
  { name: '"PATH fix"', re: /PATH fix/i },
];

/**
 * Where a rule fires on a view: its global exceptions stripped, and a quoted
 * phrase (quoteIn) stripped only as many times as it appears inside the
 * elements it is allowed in — the same words in a button, label or heading
 * still fire.
 */
function ruleHits(page, v, r, text) {
  let t = text;
  if (r.quoteIn?.view === v) {
    // Outermost allowed elements only, so a nested one never counts its quote twice; each loses the phrase
    // from its own text, in place, so the same words anywhere else on the view stay in.
    const cls = r.quoteIn.within.replace(/^\./, '');
    const inAllowed = (n) => { for (let p = n.parentElement; p; p = p.parentElement) if (p.classList?.contains(cls)) return true; return false; };
    for (const n of page.$('content').querySelectorAll(r.quoteIn.within).filter((x) => !inAllowed(x))) {
      const own = page.text(n);
      const at = t.indexOf(own);
      if (!own || at === -1) continue;
      const kept = r.quoteIn.phrases.reduce((x, phrase) => x.split(phrase).join(''), own);
      t = t.slice(0, at) + kept + t.slice(at + own.length);
    }
  }
  for (const x of r.except || []) t = t.replace(x, '');
  return t.split('\n').filter((l) => r.re.test(l)).map((l) => { const i = l.search(r.re); return l.slice(Math.max(0, i - 70), i + 70); });
}

/** A view's empty state ("No MCP servers configured yet.", "No registered projects. …"): not an intro. */
const EMPTY_STATE = /^No [^.—]*?\b(yet|configured|tracked|registered|apply here|found)\b/;

console.log('\nBuilding blocks: a quoted rule may say "delete" only inside its block text');
{
  const DELETE = RULES.find((r) => r.name === '"Delete" for something recoverable');
  const QUOTE = 'Do not delete, skip, weaken, or narrow tests or checks to make something pass.';
  const view = (over) => ({ blocks: [{ id: 'never-weaken-tests', name: 'Never weaken tests', summary: 'Keep every test.', text: `${QUOTE}\n`,
    marker: '', counts: { same: 0, reworded: 0, differs: 0 }, copies: [], ...over }], scanned: { files: 1, unreadable: [] } });
  const hitsFor = async (data, v = 'blocks', alter = null) => {
    const pg = await bootPage({ routes: routesFor({ 'GET /api/blocks': () => data }), hash: `#${v}` });
    for (let i = 0; i < 60 && !pg.$('content').querySelector('.bb-card'); i++) await sleep(10);
    if (alter) alter(pg);
    const h = ruleHits(pg, v, DELETE, words(pg));
    pg.done();
    return h;
  };
  ok('the phrase inside the rendered block text passes', (await hitsFor(view())).length === 0);
  ok('…the same phrase in the block\'s heading still fails', (await hitsFor(view({ name: QUOTE }))).length > 0);
  // The page cuts a summary that only repeats the rule's text, so this summary carries the quote beside other text.
  ok('…and in its summary line', (await hitsFor(view({ summary: QUOTE, text: 'Keep every test whole, and say when one could not run.\n' }))).length > 0);
  ok('…and a second "delete" beside the quote fails', (await hitsFor(view({ text: `${QUOTE}\n\nDelete this block.\n` }))).length > 0);
  // One body quote inside nested block-text elements counts once: the heading's quote still fails.
  const nest = (pg) => {
    const outer = pg.$('content').querySelector('.bb-text');
    const inner = outer.ownerDocument.createElement('div');
    inner.className = 'bb-text';
    while (outer.childNodes.length) inner.appendChild(outer.childNodes[0]);
    outer.appendChild(inner);
  };
  ok('…a quote in nested block-text elements counts once, so the same quote in the heading still fails',
    (await hitsFor(view({ name: QUOTE }), 'blocks', nest)).length > 0);
  ok('…while nested block text alone still passes', (await hitsFor(view(), 'blocks', nest)).length === 0);
  ok('…and nothing is allowed on another view', DELETE.quoteIn.view === 'blocks');
}

const VIEWS = ['home', 'files', 'skills', 'blocks', 'packs', 'packs/review-gate', 'packs/build', 'packs/handoff', 'packs/setup', 'mcp', 'models', 'memory', 'context', 'worktrees', 'usage', 'scope', 'audit', 'trash', 'setup', 'folders'];
try {
  console.log('\nthe sweep: one name per thing, per view');
  for (const v of VIEWS) {
    const page = await bootPage({ routes: proxy, hash: `#${v}` });
    for (let i = 0; i < 60 && page.text(page.$('content')).length < 40; i++) await sleep(50);
    await sleep(v.startsWith('packs') ? 1500 : 400);
    const text = words(page);
    const shown = page.eval('S.view');
    // A pack's own page (#packs/<id>) is the "pack" view.
    ok(`${v}: the view renders`, shown === (v.startsWith('packs/') ? 'pack' : v) && text.length > 40, `${shown}: ${text.slice(0, 200)}`);
    for (const r of RULES) {
      if (r.allowIn?.includes(v)) continue;
      const hits = ruleHits(page, v, r, text);
      ok(`${v}: no ${r.name}`, hits.length === 0, hits.join(' | '));
    }
    // One intro per page: the page never says again what the top bar's subtitle says (any 4 words in a row).
    const sub = page.text(page.$('title-path')).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean);
    const body = ` ${page.text(page.$('content')).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ')} `;
    const again = sub.slice(0, -3).map((_, i) => sub.slice(i, i + 4).join(' ')).filter((g) => body.includes(` ${g} `));
    ok(`${v}: one intro — the page does not repeat the top bar's subtitle`, again.length === 0, again.join(' | '));
    // …nor says it again in other words: a page line that shares 2+ content words with the subtitle
    // ("each step optional" / "Four steps, each optional") repeats it.
    const STOP = new Set('a an and the of to in on for with by at from or not no is are be it its this that these those every each your you what which where when how only any all one'.split(' '));
    const stems = (t) => new Set(t.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)).map((w) => w.replace(/(ies|es|s)$/, '')));
    const subStems = stems(page.text(page.$('title-path')));
    // The page's intro: the first line of its root box after any headings — not an empty state ("No …").
    const root = page.$('content').children[0];
    const first = root ? [...root.children].find((n) => !(n.localName === 'h2' || /(^|-)head\b|\bvh\b/.test(n.className || ''))) : null;
    const intros = first && /\bscope-sub\b/.test(first.className || '') && !EMPTY_STATE.test(page.text(first)) ? [page.text(first)] : [];
    const echoes = intros.map((t) => [t, [...stems(t)].filter((w) => subStems.has(w))]).filter(([, shared]) => shared.length >= 2);
    ok(`${v}: no intro line restates the subtitle in other words`, echoes.length === 0, echoes.map(([t, w]) => `${t.slice(0, 80)} [${w}]`).join(' | '));
    // Every (i) sits on its word: no bare icon, no two side by side.
    const tips = page.$('content').querySelectorAll('.tip');
    ok(`${v}: every (i) tip names its word`, tips.every((t) => !!t.querySelector('.tip-term') && page.text(t.querySelector('.tip-term')).trim().length > 0),
      tips.map((t) => page.text(t)).join(' | '));
    // Cris: no triangles anywhere (PR G) — no <details>, no summary, no chevron toggle, in any view.
    const folds = page.$('content').querySelectorAll('details, summary, .chev, .fold, [aria-expanded].files-type-toggle');
    ok(`${v}: no fold — no <details>, summary or chevron toggle`, folds.length === 0,
      folds.map((d) => `${d.localName}.${d.className}: ${page.text(d).slice(0, 30)}`).join(' | '));
    // …and no arrow glyph standing in for one, anywhere on the page (Packs' full ban, now app-wide).
    const glyph = /[▸▾▶▼◂◀›⌄]/;
    ok(`${v}: no fold or arrow glyph anywhere (▸ ▾ ▶ ▼ ◂ ◀ › ⌄)`, !glyph.test(page.text(page.$('content'))),
      (page.text(page.$('content')).match(new RegExp(`.{0,30}${glyph.source}.{0,30}`)) || [''])[0]);
    // Every button is one of three kinds — primary, secondary (.btn) or quiet (.btn.ghost) — or a named
    // non-button control: a tab, a row in the Files tree, an (i) tip, or an icon with a title.
    const KINDS = /\bbtn\b/;
    const NAMED = ['pk-tab', 'tab', 'files-item', 'files-type-toggle', 'files-add', 'tip-btn', 'usage-drop'];
    const loose = page.$('content').querySelectorAll('button').filter((b) => !KINDS.test(b.className || '') && !NAMED.some((c) => b.classList.contains(c)));
    ok(`${v}: every button is primary, secondary or quiet (or a tab, tree row or titled icon)`, loose.length === 0,
      loose.map((b) => `${b.className || '(no class)'}: ${page.text(b).slice(0, 24)}`).join(' | '));
    if (v === 'audit') {
      // The seeded gamma skill has a finding, so the sweep sees real Audit cards, not only the empty state.
      ok('audit: the seeded findings render as cards', page.$('content').querySelectorAll('.audit-file').length > 0, page.text(page.$('content')).slice(0, 200));
    }
    if (v === 'models') {
      const rows = page.$('content').querySelectorAll('.roles-row');
      ok('models: each role row\'s Edit is a real button (secondary), not a text label', rows.length > 0
        && rows.every((r) => r.querySelectorAll('button').some((b) => /\bbtn\b/.test(b.className) && /^(Edit|Close)$/.test(page.text(b)))), `${rows.length} rows`);
    }
    const icons = page.$('content').querySelectorAll('button').filter((b) => page.text(b).replace(/[^\p{L}\p{N}]/gu, '').length === 0);
    // PR D: no text glyph stands in for a fold arrow; a toggle draws its chevron in CSS (.chev).
    const glyphs = page.$('content').querySelectorAll('button, summary').filter((b) => /[▸▾▶▼◂◀›⌄]/.test(page.text(b)));
    ok(`${v}: no button or fold uses a text arrow (▸ ▾ ▶ ▼ › ⌄)`, glyphs.length === 0, glyphs.map((b) => page.text(b).slice(0, 30)).join(' | '));
    // PR D: a Files entry's extra files are said plainly ("2 files"), right after its name — no bare "+N".
    const plus = page.$('content').querySelectorAll('.files-item .item-badge, .files-item-count').filter((n) => /^\+\d+$/.test(page.text(n).trim()));
    ok(`${v}: no bare "+N" count on a file entry`, plus.length === 0, plus.map((n) => page.text(n)).join(' | '));
    if (v === 'files') {
      // f2: a tool card's header counts files in the same unit as its rows (an entry with no count is one file).
      const cards = page.$('content').querySelectorAll('.files-tool');
      const sums = cards.map((c) => {
        const head = Number((page.text(c.querySelector('.files-count')).match(/\d+/) || [NaN])[0]);
        const rows = c.querySelectorAll('.files-item').reduce((n, b) => {
          const k = b.querySelector('.files-item-count');
          return n + (k ? Number(page.text(k).match(/\d+/)[0]) : 1);
        }, 0);
        return [head, rows];
      });
      ok('files: some entry holds more than one file (the seed exercises the count)', page.$('content').querySelectorAll('.files-item-count').length > 0);
      ok('files: each tool card\'s header file count equals the sum of its rows\' file counts', cards.length > 0 && sums.every(([h, r]) => h === r),
        sums.map(([h, r]) => `${h} vs ${r}`).join(' | '));
    }
    ok(`${v}: every icon-only button has a title and an accessible name`, icons.every((b) => b.getAttribute('title') && (b.getAttribute('aria-label') || b.getAttribute('title'))),
      icons.filter((b) => !b.getAttribute('title')).map((b) => b.className).join(' | '));
    ok(`${v}: no page errors`, page.errors.length === 0, page.errors.join(' | '));
    page.done();
  }

  console.log('\nPacks: shared needs once on #packs/setup, each pack ready or its one missing need');
  {
    const waitFor = async (page, cond) => { for (let i = 0; i < 200 && !cond(); i++) await sleep(50); return cond(); };
    const page = await bootPage({ routes: proxy, hash: '#packs' });
    const c = () => page.$('content');
    await waitFor(page, () => c().querySelectorAll('.pk-card').length > 0);
    const cards = c().querySelectorAll('.pk-card');
    const status = (k) => page.text(k.querySelector('.pk-st'));
    // Nothing is installed in this home, so a ready pack's card says exactly "Not installed".
    const expected = Object.fromEntries(cards.map((k) => [k.dataset.pack, k.dataset.pack === 'build' ? 'Needs setup' : 'Not installed']));
    ok('a machine with everything: no shared-fixes notice, and each card\'s exact status: "Not installed", nothing needs setup…', !c().querySelector('.pk-shared')
      && cards.length === 8 && cards.every((k) => status(k) === expected[k.dataset.pack]), cards.map((k) => `${k.dataset.pack}: ${status(k)}`).join(' | '));
    ok('…except a pack that needs another pack first: its card "Needs setup"', status(c().querySelector('.pk-card[data-pack="build"]')) === 'Needs setup');
    page.navigate('#packs/build');
    await waitFor(page, () => c().querySelector('.pk-page'));
    ok('…and its page names the pack', page.text(c().querySelector('.pk-page-meta .pk-need')) === 'Needs the Review gate pack first', page.text(c().querySelector('.pk-page-meta')));
    page.navigate('#packs/review-gate');
    await waitFor(page, () => c().querySelector('.pk-page[data-pack="review-gate"]'));
    const rg = c().querySelector('.pk-page');
    ok('a ready pack that is not installed says "Ready to install", with no tick and no list of needs', page.text(rg.querySelector('.pk-page-meta .pk-ready')) === 'Ready to install' && !rg.querySelector('.pk-page-meta .pk-ready svg') && !rg.querySelector('.pk-reqs'));
    const parts = rg.querySelectorAll('.pk-part');
    ok('no part id or part type on the page: each part row is its title, a line, a status word and one action', parts.length > 0
      && parts.every((r) => /^(On|Off|Edited|Update ready|Not working|New CLI here)$/.test(page.text(r.querySelector('.pk-st'))) && r.querySelectorAll('.pk-part-act button').length === 1)
      && !parts.some((r) => /code-review ·|· skill|· guard|· instructions/.test(page.text(r))), parts.map((r) => page.text(r)).join(' | '));
    ok('each part says what it does in a sentence', rg.querySelectorAll('.pk-part-what').every((n) => /\.$/.test(page.text(n)) && page.text(n).length > 12));
    ok('no pack id chip in the head', !rg.querySelector('.pk-page-head .chip-mini'));
    page.done();

    // No model-id here: the one shared need, once on #packs/setup; each pack that needs it points there.
    const sb2 = sandbox('words-needs', { clis: ['claude'], modelId: false });
    fs.mkdirSync(path.join(sb2.home, '.agent-config-studio'), { recursive: true });
    fs.writeFileSync(path.join(sb2.home, '.agent-config-studio', 'setup.json'), JSON.stringify({ completed: 'done', at: new Date().toISOString() }));
    const p2 = await bootPage({ routes: await serve(sb2.env), hash: '#packs/setup' });
    const c2 = () => p2.$('content');
    await waitFor(p2, () => c2().querySelector('.pk-todo'));
    const todo = c2().querySelector('.pk-todo');
    const items = todo ? [...todo.querySelector('.pk-todo-list').children].map((li) => p2.text(li)) : [];
    // PR F (critique P2-2): not every pack needs model-id (Worktree setup does not), yet it is one machine fix —
    // said once with how many packs it blocks; no pack repeats it.
    ok('"Before packs run": a tool only some packs need is listed once, saying how many packs need it',
      !!todo && items.filter((x) => /model-id/.test(x)).length === 1 && items.some((x) => /model-id/.test(x) && /Needed by \d+ of \d+ packs/.test(x)), items.join(' | '));
    p2.navigate('#packs/review-gate');
    await waitFor(p2, () => c2().querySelector('.pk-page'));
    const meta2 = c2().querySelector('.pk-page-meta');
    ok('…and the review gate\'s page points there instead of repeating it', /Not ready/.test(p2.text(meta2)) && !meta2.querySelector('.pk-need') && !meta2.querySelector('.pk-ready'),
      p2.text(meta2));
    c2().querySelector('.pk-page-actions').querySelectorAll('button').find((b) => p2.text(b) === 'Install').click();
    // The CLI boxes are locked while a preview is being worked out: wait for it.
    await waitFor(p2, () => c2().querySelector('.pk-preview .pk-preview-head'));
    const plansBefore = p2.requests.filter((r) => r.path === '/api/packs/plan').length;
    c2().querySelector('.pk-preview .pk-harnesses').querySelectorAll('input').filter((i) => i.checked).forEach((i) => i.click());
    await sleep(50);
    const pv = c2().querySelector('.pk-preview');
    ok('unticking every CLI in the install preview says why, in place, and asks for no plan', /Pick at least one CLI to install for\./.test(p2.text(pv.querySelector('.pk-why')))
      && !pv.querySelector('.pk-apply') && p2.requests.filter((r) => r.path === '/api/packs/plan').length === plansBefore, p2.text(pv));
    ok('packs: no page errors', page.errors.length === 0 && p2.errors.length === 0, [...page.errors, ...p2.errors].join(' | '));
    p2.done();
  }
} catch (e) {
  // A block that throws skips every check after it: that is a failure, never a pass.
  ok(`no test block threw (${e?.message || e})`, false, e?.stack || String(e));
} finally {
  assertRealHomesUnchanged(realBefore, ok);
  done();
}
