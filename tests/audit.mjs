/**
 * The audit in-process (builds/skills-audit A1, A2, A3 and R1–R4, R7–R13,
 * R15): the rules as a fixture table, byte-exact fixes that still run, the
 * propose → accept path and its class policy, the contained reads, the
 * physical inventory, the bounded walk and the hardened writer. HOME is a
 * temp dir, set before any studio module loads; nothing outside it (and one
 * temp read root beside it) is written.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { snapshotRealHomes, assertRealHomesUnchanged } from './real-home.mjs';

const realBefore = snapshotRealHomes();
const temps = [];
const mkdir = (tag) => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `acs-audit-${tag}-`))); temps.push(d); return d; };
const home = mkdir('home');
const ext = mkdir('ext');
process.env.HOME = home;

const A = await import('../lib/audit.js');
const P = await import('../lib/proposals.js');
const { lint } = await import('../lib/models.js');
const history = await import('../lib/history.js');
const { renderBlock } = await import('../lib/model-guide.js');

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const rejects = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
const quiet = { recordBaseline: async () => null, record: async () => null };
const put = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); return f; };
const studio = path.join(home, '.agent-config-studio');
const writeModels = (doc) => put(path.join(studio, 'models.json'), JSON.stringify(doc));
const fence = (...lines) => ['```bash', ...lines, '```'].join('\n');

// The registry this suite audits against: sol moved on to gpt-6.1-sol.
writeModels({ version: 1, models: { sol: 'gpt-6.1-sol' } });
const policy = () => A.auditPolicy({ home });
const scan = (text, name = 'SKILL.md', extra = {}) => A.analyze(text, { ref: 'r0', name, policy: policy(), ...extra });
const only = (fs_, rule) => fs_.filter((f) => f.rule === rule);

try {
  console.log('\naudit: A1 — the rules');
  {
    const t = (name, text, file, check) => { const f = scan(text, file); ok(name, check(f), JSON.stringify(f.map((x) => [x.rule, x.match, Boolean(x.fix), x.stale ?? null]))); };
    t('a stale id after -m in a bash fence → D2, stale, fixable', fence('codex exec -m gpt-6-sol "hi"'), 'SKILL.md',
      (f) => f.length === 1 && f[0].rule === 'D2' && f[0].stale && f[0].family === 'sol' && f[0].current === 'gpt-6.1-sol' && f[0].fix);
    t('the current id after -m → D2, not stale, still fixable', fence('codex exec -m gpt-6.1-sol "hi"'), 'SKILL.md',
      (f) => f.length === 1 && f[0].rule === 'D2' && !f[0].stale && f[0].fix);
    t('`$(model-id sol || echo MODEL-ID-UNRESOLVED-sol)` is NOT flagged', fence('codex exec -m "$(model-id sol || echo MODEL-ID-UNRESOLVED-sol)" x'), 'SKILL.md', (f) => f.length === 0);
    t('`|| echo gpt-6-sol` IS flagged, with no fix', fence('codex exec -m "$(model-id sol || echo gpt-6-sol)" x'), 'SKILL.md',
      (f) => f.length === 1 && f[0].rule === 'D1' && f[0].match === 'gpt-6-sol' && !f[0].fix);
    t('a current id in prose → D1 info, fixed to the family name', 'Use claude-opus-5-5 for builds.', 'SKILL.md',
      (f) => f.length === 1 && f[0].rule === 'D1' && f[0].severity === 'info' && f[0].fix?.replacement === 'opus');
    t('a stale id in prose by shape → D1 warn, stale, no fix (mapping not exact)', 'Use claude-opus-4-1 for builds.', 'SKILL.md',
      (f) => f.length === 1 && f[0].stale && f[0].family === 'opus' && f[0].severity === 'warn' && !f[0].fix);
    t('a retired id is stale and exact → prose fix to the family', 'We used claude-fable-5 then.', 'SKILL.md',
      (f) => f.length === 1 && f[0].stale && f[0].family === 'fable' && f[0].fix?.replacement === 'fable');
    t('an inline-code command starting with codex → fixable', 'Run `codex exec -m gpt-6-sol "go"` now.', 'SKILL.md', (f) => f.length === 1 && f[0].fix);
    t('inline code that is not a claude/codex/grok command → no fix', 'Set `-m gpt-6-sol` somewhere.', 'SKILL.md', (f) => f.length === 1 && f[0].rule === 'D2' && !f[0].fix);
    t('single quotes → no fix', fence("codex exec -m 'gpt-6-sol' x"), 'SKILL.md', (f) => f.length === 1 && !f[0].fix);
    t('a .js file → finding, no fix', "spawn('codex', ['exec', '-m', 'gpt-6-sol']);\nconst s = `codex -m gpt-6-sol`;", 'run.mjs', (f) => f.length === 2 && f.every((x) => !x.fix));
    t('a .py file → finding, no fix', 'cmd = "codex exec -m gpt-6-sol"', 'run.py', (f) => f.length === 1 && !f[0].fix);
    t('a JSON model key → D2, no fix', '{ "model": "gpt-6-sol" }', 'config.json', (f) => f.length === 1 && f[0].rule === 'D2' && !f[0].fix && /family name/.test(f[0].message));
    t('a TOML model key → D2, no fix', 'model = "gpt-6-sol"', 'config.toml', (f) => f.length === 1 && f[0].rule === 'D2' && !f[0].fix);
    t('a .sh file → fixable, unquoted or double-quoted', 'codex exec -m gpt-6-sol a\nclaude --model "claude-fable-5-1" b', 'run.sh',
      (f) => f.length === 2 && f[0].fix.replacement === '"$(model-id sol || echo MODEL-ID-UNRESOLVED-sol)"' && f[1].fix.replacement === '$(model-id fable || echo MODEL-ID-UNRESOLVED-fable)');
    t('an inline-code command in a table row → finding, no fix (the fallback\'s || would split the cell)', '| build | `codex exec -m gpt-6-sol x` |', 'AGENTS.md', (f) => f.length === 1 && f[0].rule === 'D2' && !f[0].fix && /table row/.test(f[0].message));
    t('--model=<id> → fixable', 'claude --model=claude-fable-5-1 x', 'run.sh', (f) => f.length === 1 && f[0].rule === 'D2' && f[0].fix);
    t('D3 bare $(model-id sol) → fallback appended', 'M=$(model-id sol)', 'run.sh', (f) => f.length === 1 && f[0].rule === 'D3' && f[0].fix.replacement === '$(model-id sol || echo MODEL-ID-UNRESOLVED-sol)');
    t('D3 --role → a role fallback', 'M=$(model-id --role reviewer)', 'run.sh', (f) => f[0]?.fix.replacement === '$(model-id --role reviewer || echo MODEL-ID-UNRESOLVED-role-reviewer)');
    t('D3 --json --role → a role fallback', 'M=$(model-id --json --role reviewer)', 'run.sh', (f) => f[0]?.fix.replacement === '$(model-id --json --role reviewer || echo MODEL-ID-UNRESOLVED-role-reviewer)');
    t('D3 an unsupported form → flagged, no fix', 'M=$(model-id --flavor sol)', 'run.sh', (f) => f.length === 1 && f[0].rule === 'D3' && !f[0].fix);
    t('D3 in prose → flagged, no fix', 'Call $(model-id sol) to get it.', 'SKILL.md', (f) => f.length === 1 && f[0].rule === 'D3' && !f[0].fix);
    t('D4 an effort a role uses for that family → not flagged', fence('codex exec -m "$(model-id astra || echo MODEL-ID-UNRESOLVED-astra)" -c model_reasoning_effort=high x'), 'SKILL.md', (f) => only(f, 'D4').length === 0);
    t('D4 an effort no role uses for that family → info', fence('codex exec -m "$(model-id astra || echo MODEL-ID-UNRESOLVED-astra)" -c model_reasoning_effort=xhigh x'), 'SKILL.md',
      (f) => only(f, 'D4').length === 1 && only(f, 'D4')[0].severity === 'info' && !only(f, 'D4')[0].fix && /astra/.test(only(f, 'D4')[0].message));
    t('D4 role-specific: builder at high (builder uses medium) → info', fence('claude -p --model "$(model-id --role builder || echo MODEL-ID-UNRESOLVED-role-builder)" --effort high'), 'SKILL.md', (f) => only(f, 'D4').length === 1 && only(f, 'D4')[0].role === 'builder');
    t('D4 role-specific: builder at medium → not flagged', fence('claude -p --model "$(model-id --role builder || echo MODEL-ID-UNRESOLVED-role-builder)" --effort medium'), 'SKILL.md', (f) => only(f, 'D4').length === 0);
    t('D4 a reviewer claim at the builder\'s effort is still flagged for the reviewer', fence('codex exec -m "$(model-id --role reviewer || echo MODEL-ID-UNRESOLVED-role-reviewer)" --effort medium'), 'SKILL.md', (f) => only(f, 'D4').length === 1);
    t('D4 an indirect value (a config default) → not flagged', "const EFFORT = cfg('REVIEW_EFFORT', 'effort', 'xhigh');", 'review-loop.mjs', (f) => f.length === 0);
    t('D4 effort: "<e>" beside a resolver → flagged when unused', 'run({ model: "$(model-id sol || echo MODEL-ID-UNRESOLVED-sol)", effort: "max" })', 'cfg.mjs', (f) => only(f, 'D4').length === 1 && only(f, 'D4')[0].family === 'sol');
    t('the word "model" in prose is not flagged', 'Pick a model: whichever fits.\nThe model is fast. model = big', 'NOTES.md', (f) => f.length === 0);
    t('a model name with a version in prose → D1 info, no fix', 'Opus 5 is good; GPT-6 too.', 'SKILL.md', (f) => f.length === 2 && f.every((x) => x.rule === 'D1' && x.severity === 'info' && !x.fix));
    t('full tokens, every occurrence: two ids on one line', fence('codex -m gpt-6-sol && codex -m gpt-6-astra'), 'SKILL.md', (f) => f.map((x) => x.match).join() === 'gpt-6-sol,gpt-6-astra');
    t('a longer id is one token, not its prefix', 'claude-fable-5-1.', 'SKILL.md', (f) => f.length === 1 && f[0].match === 'claude-fable-5-1' && !f[0].stale);
    t('grok: an exact registry id names its family', 'grok-4.6 and grok-4.7', 'SKILL.md', (f) => f[0]?.family === 'grok-prev' && f[1]?.family === 'grok' && !f[0].stale && !f[1].stale);
    t('grok: an id that fits both grok and grok-prev is ambiguous, with no fix', fence('grok -m grok-4.5 x'), 'SKILL.md', (f) => f.length === 1 && !f[0].family && !f[0].fix && /grok or grok-prev/.test(f[0].message));
    t('an id with no family in the registry → flagged, no fix', fence('codex -m gpt-5 x'), 'SKILL.md', (f) => f.length === 1 && !f[0].family && !f[0].fix);
    t('D2 a family name on a codex command line → info, no fix', fence('codex exec -m sol "x"'), 'SKILL.md', (f) => f.length === 1 && f[0].rule === 'D2' && f[0].severity === 'info' && !f[0].fix);
    t('-m on another tool is not a model flag', fence('git commit -m fix && python -m venv x'), 'SKILL.md', (f) => f.length === 0);

    const block = renderBlock('## Model guide\n\nUse sol.\n', 1);
    const withGuide = `# Mine\n\n## Model lanes\nhand-written\n\n${block}\n`;
    const d5 = A.analyze(withGuide, { ref: 'r0', name: 'CLAUDE.md', instruction: true, policy: policy() });
    ok('D5 a lanes heading outside the generated block → info', d5.length === 1 && d5[0].rule === 'D5' && d5[0].line === 3 && d5[0].severity === 'info', JSON.stringify(d5));
    ok('D5 no block → no finding', A.analyze('# x\n## Routing\n', { ref: 'r0', name: 'CLAUDE.md', instruction: true, policy: policy() }).length === 0);
    const inside = renderBlock('## Model lanes\n\nUse gpt-6-sol.\n', 1);
    const g = A.analyze(`# x\n\n${inside}\n`, { ref: 'r0', name: 'CLAUDE.md', instruction: true, policy: policy() });
    ok('R2 a heading inside the block is not D5; an id inside it points to Models → Model guide, with no fix',
      g.length === 1 && g[0].rule === 'D1' && g[0].guide && !g[0].fix && /Models → Model guide/.test(g[0].message), JSON.stringify(g));
    const marker = `# x\n${renderBlock('Use opus.\n', 1)}\n`;
    const e = await rejects(() => A.applyFixes(Buffer.from(marker), marker, [{ line: 2, fix: { start: 0, end: 4, replacement: 'XXXX' } }]));
    ok('R2 an edit crossing a marker is refused', e?.status === 409 && /model guide/.test(e.message), e?.message);
    const e2 = await rejects(() => A.applyFixes(Buffer.from(marker), marker, [{ line: 3, fix: { start: 4, end: 8, replacement: 'sol' } }]));
    ok('R2 an edit inside the block is refused', e2?.status === 409, e2?.message);
    const broken = `# x\n<!-- acs:model-guide v1 sep=1 sha256:${'0'.repeat(64)} -->\n${fence('codex -m gpt-6-sol x')}\n`;
    const b = A.analyze(broken, { ref: 'r0', name: 'CLAUDE.md', instruction: true, policy: policy() });
    ok('R2 broken markers → findings, no fixes anywhere in the file', b.length === 1 && !b[0].fix && /markers in this file are broken/.test(b[0].message), JSON.stringify(b));

    // R7: stable ids.
    const text = `${fence('codex -m gpt-6-sol a', 'codex -m gpt-6-sol a', 'codex -m gpt-6-sol b gpt-6-sol')}\n`;
    const r1 = scan(text), r2 = scan(text);
    ok('R7 ids are the same across runs', JSON.stringify(r1.map((f) => f.id)) === JSON.stringify(r2.map((f) => f.id)));
    ok('R7 identical lines and repeated tokens get distinct ids', new Set(r1.map((f) => f.id)).size === r1.length && r1.length === 4, JSON.stringify(r1.map((f) => [f.line, f.id])));
    const r3 = scan(text.replace('gpt-6-sol b', 'gpt-6-sol c'));
    ok('R7 an id changes when its line changes (and only then)', r3[0].id === r1[0].id && r3[1].id === r1[1].id && r3[2].id !== r1[2].id);
    ok('R7 ids depend on the file ref', A.analyze(text, { ref: 'r1', name: 'SKILL.md', policy: policy() })[0].id !== r1[0].id);
    ok('R7 D1 and D2 on one token are one finding', scan(fence('codex -m gpt-6-sol')).length === 1);

    // R12: an invalid registry switches the policy rules off.
    writeModels({ version: 1, models: { nobody: 'x-1' } });
    const off = scan(`${fence('codex -m gpt-6-sol -c model_reasoning_effort=xhigh', 'M=$(model-id sol)')}\nUse claude-opus-5-5.`);
    ok('R12 a registry error is reported', /models:/.test(policy().error));
    ok('R12 …D1, D2 and D3 still report, without stale and without fixes; D4 is off',
      off.map((f) => f.rule).join() === 'D2,D3,D1' && off.every((f) => !f.fix && !f.stale && !f.family), JSON.stringify(off.map((f) => [f.rule, f.stale, Boolean(f.fix)])));
    writeModels({ version: 1, models: { sol: 'gpt-6.1-sol' } });
    put(path.join(studio, 'roles.json'), '{"version":1,"roles":{"reviewer":{"use":"nobody"}}}');
    ok('R12 invalid roles switch the policy rules off too', /roles:/.test(policy().error) && scan(fence('codex -m gpt-6-sol')).every((f) => !f.fix && !f.stale));
    fs.rmSync(path.join(studio, 'roles.json'));
  }

  console.log('\naudit: A2 — fixes');
  {
    const crlf = '﻿#!/bin/sh\r\ncodex exec -m gpt-6-sol "a"\r\nclaude -p --model "claude-fable-5-1" x\r\nR=$(model-id --role reviewer)\r\ncodex exec -m gpt-6-sol "b"\r\nS=$(model-id sol)';
    const buf = Buffer.from(crlf);
    const all = scan(crlf, 'run.sh');
    ok('(the fixture has five fixable findings)', all.length === 5 && all.every((f) => f.fix), JSON.stringify(all.map((f) => f.rule)));
    const fixed = A.applyFixes(buf, crlf, all);
    const expect = crlf
      .replace('-m gpt-6-sol "a"', '-m "$(model-id sol || echo MODEL-ID-UNRESOLVED-sol)" "a"')
      .replace('"claude-fable-5-1"', '"$(model-id fable || echo MODEL-ID-UNRESOLVED-fable)"')
      .replace('$(model-id --role reviewer)', '$(model-id --role reviewer || echo MODEL-ID-UNRESOLVED-role-reviewer)')
      .replace('-m gpt-6-sol "b"', '-m "$(model-id sol || echo MODEL-ID-UNRESOLVED-sol)" "b"')
      .replace('$(model-id sol)', '$(model-id sol || echo MODEL-ID-UNRESOLVED-sol)');
    ok('bytes outside the replaced spans are preserved (BOM, CRLF, no trailing newline)', fixed.equals(Buffer.from(expect)) && fixed[0] === 0xef && !fixed.toString().endsWith('\n'));
    const fixedText = fixed.toString('utf8');
    ok('the fixed file has no D1–D3 findings left', scan(fixedText, 'run.sh').length === 0, JSON.stringify(scan(fixedText, 'run.sh')));
    const file = put(path.join(mkdir('lint'), 'run.sh'), fixed);
    const l = lint([file], { home });
    ok('…and model-id --lint reports 0 hits for it', l.files === 1 && l.hits.length === 0, JSON.stringify(l.hits));
    // One by one: re-scan after each fix, take the first fixable finding.
    let cur = buf;
    for (let i = 0; i < 10; i++) {
      const f = scan(cur.toString('utf8'), 'run.sh').find((x) => x.fix);
      if (!f) break;
      cur = A.applyFixes(cur, cur.toString('utf8'), [f]);
    }
    ok('several fixes at once give the same bytes as one at a time', cur.equals(fixed));
    const amb = scan(fence('grok -m grok-4.5 x', 'codex -m gpt-5 y'));
    ok('a fix is never offered when the family mapping is ambiguous or unknown', amb.length === 2 && amb.every((f) => !f.fix));

    // The fixed command line still runs, and expands to the right ids.
    const lf = 'codex exec -m gpt-6-sol "a b"\nclaude -p --model "claude-fable-5-1" x\nR=$(model-id --role reviewer)\necho "role=$R"\n';
    const out = A.applyFixes(Buffer.from(lf), lf, scan(lf, 'run.sh')).toString();
    const stubs = mkdir('stubs');
    const resolver = mkdir('resolver');
    put(path.join(resolver, 'model-id'), '#!/bin/sh\ncase "$1" in sol) echo gpt-6.1-sol;; fable) echo claude-fable-5-1;; --role) echo gpt-6-astra;; *) exit 1;; esac\n');
    for (const c of ['codex', 'claude']) put(path.join(stubs, c), `#!/bin/sh\nprintf '${c}:'; printf '[%s]' "$@"; echo\n`);
    for (const d of [stubs, resolver]) for (const f of fs.readdirSync(d)) fs.chmodSync(path.join(d, f), 0o755);
    const script = put(path.join(stubs, 'fixed.sh'), out);
    const syn = spawnSync('sh', ['-n', script], { encoding: 'utf8' });
    ok('the fixed script passes sh -n', syn.status === 0, syn.stderr);
    const ran = spawnSync('sh', [script], { encoding: 'utf8', env: { PATH: `${stubs}:${resolver}:/usr/bin:/bin` } });
    ok('…and run with a stub model-id, each flag gets the resolved id', ran.stdout === 'codex:[exec][-m][gpt-6.1-sol][a b]\nclaude:[-p][--model][claude-fable-5-1][x]\nrole=gpt-6-astra\n', JSON.stringify(ran.stdout + ran.stderr));
    const missing = spawnSync('sh', [script], { encoding: 'utf8', env: { PATH: `${stubs}:/usr/bin:/bin` } });
    ok('…and without model-id on PATH, the fallback names the family, never an empty -m', missing.stdout.startsWith('codex:[exec][-m][MODEL-ID-UNRESOLVED-sol][a b]\nclaude:[-p][--model][MODEL-ID-UNRESOLVED-fable][x]\n'), JSON.stringify(missing.stdout));
  }

  console.log('\naudit: A3, R3, R4, R9, R11 — the inventory, proposals and the class policy');
  const proj = path.join(home, 'Projects');
  {
    put(path.join(studio, 'roots.json'), JSON.stringify({ version: 1, roots: [
      { id: 'projects', label: 'Projects', access: 'edit', path: proj },
      { id: 'client', label: 'Client', access: 'read', path: ext },
    ] }));
    const skill = (dir, body = fence('codex exec -m gpt-6-sol "x"')) => put(path.join(dir, 'SKILL.md'), `---\nname: ${path.basename(dir)}\n---\n${body}\n`);
    const S = path.join(home, '.claude', 'skills');
    skill(path.join(S, 'alpha'));
    put(path.join(S, 'alpha', 'scripts', 'run.sh'), 'codex exec -m gpt-6-sol "y"\n');
    put(path.join(home, 'outside.md'), 'secret gpt-6-sol\n');
    fs.symlinkSync(path.join(home, 'outside.md'), path.join(S, 'alpha', 'notes.md'));
    put(path.join(home, 'other.md'), 'gpt-6-sol\n');
    fs.linkSync(path.join(home, 'other.md'), path.join(S, 'alpha', 'hard.md'));
    put(path.join(S, 'alpha', 'auth.json'), '{"model":"gpt-6-sol"}\n');
    put(path.join(S, 'alpha', 'logo.png'), 'gpt-6-sol');
    put(path.join(S, 'alpha', 'SKILL.md.bak-1'), 'gpt-6-sol');
    skill(path.join(S, 'synced', 'u1', 'beta'));
    skill(path.join(S, '.system', 'vend'));
    skill(path.join(home, '.codex', 'skills', '.system', 'vend2'));
    skill(path.join(home, '.agents', 'skills', 'gamma'));
    const cache = path.join(home, '.claude', 'plugins', 'cache', 'mkt');
    skill(path.join(cache, 'plug', '1.2.0', 'skills', 'old'));
    skill(path.join(cache, 'plug', '1.10.0', 'skills', 'p1'));
    skill(path.join(cache, 'off', '1.0.0', 'skills', 'disabled'));
    put(path.join(home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'plug@mkt': true, 'off@mkt': false, 'gone@mkt': true } }));
    fs.symlinkSync(path.join(cache, 'plug', '1.10.0', 'skills', 'p1'), path.join(S, 'linkp'));
    skill(path.join(ext, '.claude', 'skills', 'ro'));
    fs.symlinkSync(path.join(ext, '.claude', 'skills', 'ro'), path.join(S, 'linkr'));
    fs.symlinkSync(path.join(S, 'synced', 'u1', 'beta'), path.join(home, '.agents', 'skills', 'links'));
    put(path.join(ext, 'CLAUDE.md'), 'Builds use claude-opus-5-5.\n');
    put(path.join(home, '.claude', 'CLAUDE.md'), '# Global\nUse claude-opus-5-5 here.\n');
    put(path.join(proj, 'app', 'CLAUDE.md'), 'Builds: claude-opus-5-5.\n');
    put(path.join(proj, 'app-wt', 'feature', 'CLAUDE.md'), 'Builds: claude-opus-5-5.\n');
    fs.symlinkSync('CLAUDE.md', path.join(proj, 'app', 'AGENTS.md'));
    skill(path.join(proj, 'app', '.claude', 'skills', 'delta'));

    const audit = A.createAudit({ home, hist: quiet });
    ok('before any run, Home has nothing to show', audit.cached().state === 'not-audited');
    const res = await audit.run();
    if (process.env.AUDIT_DEBUG) console.log(JSON.stringify(res, null, 1));
    const by = (d) => res.files.find((f) => f.display === d);
    const all = JSON.stringify(res);
    ok('R15 no raw absolute path anywhere in the result', !all.includes(home) && !all.includes(ext) && !all.includes(os.tmpdir()), all.match(new RegExp(`${home}[^"]*|${ext}[^"]*`))?.[0]);
    ok('R15 a read root outside HOME shows as <label>/…', !!by('Client/CLAUDE.md') && by('Client/CLAUDE.md').cls === 'readonly');
    ok('R11 a user skill, its script, the global CLAUDE.md and the edit-root skill are scanned as user',
      ['~/.claude/skills/alpha/SKILL.md', '~/.claude/skills/alpha/scripts/run.sh', '~/.claude/CLAUDE.md', '~/Projects/app/.claude/skills/delta/SKILL.md', '~/.agents/skills/gamma/SKILL.md'].every((d) => by(d)?.cls === 'user'),
      JSON.stringify(res.files.map((f) => [f.display, f.cls])));
    ok('R11 synced/ is synced, .system/ is vendor (both homes)', by('~/.claude/skills/synced/u1/beta/SKILL.md')?.cls === 'synced'
      && by('~/.claude/skills/.system/vend/SKILL.md')?.cls === 'vendor' && by('~/.codex/skills/.system/vend2/SKILL.md')?.cls === 'vendor');
    ok('R11 an enabled plugin at its newest cached version only; a disabled or missing one is not scanned',
      by('~/.claude/plugins/cache/mkt/plug/1.10.0/skills/p1/SKILL.md')?.cls === 'plugin' && !all.includes('1.2.0') && !all.includes('disabled'));
    ok('R3 a user-skills link into the plugin cache is classed plugin, and shown once, as the target',
      res.files.filter((f) => /p1\/SKILL\.md$/.test(f.display)).length === 1 && !all.includes('linkp'));
    ok('R3 a link into a read root is readonly', by('Client/.claude/skills/ro/SKILL.md')?.cls === 'readonly' && !all.includes('linkr'));
    ok('R3 a link into synced is synced', by('~/.claude/skills/synced/u1/beta/SKILL.md')?.cls === 'synced' && !all.includes('links/'));
    const refused = JSON.stringify(res.refusals);
    ok('R4 an internal symlink, a hard link and a credential-named file are refused and reported, never read',
      /alpha\/notes\.md.*symlink/.test(refused) && /alpha\/hard\.md.*hard-linked/.test(refused) && /alpha\/auth\.json.*protected/.test(refused)
      && !by('~/.claude/skills/alpha/notes.md') && !by('~/.claude/skills/alpha/hard.md') && !by('~/.claude/skills/alpha/auth.json') && res.counts.refused >= 3, refused);
    ok('R4 …and none of them leaks into a finding', !all.includes('secret'));
    ok('binaries are skipped and counted', res.counts.skipped.binary >= 1 && !by('~/.claude/skills/alpha/logo.png'));
    ok('backups are skipped and counted, as model-id --lint skips them', res.counts.skipped.backup === 1 && !all.includes('.bak'));
    const app = by('~/Projects/app/CLAUDE.md');
    ok('R9 identical copies are one card, "also in" the other copy', app && app.copies.length === 1 && app.copies[0].display === '~/Projects/app-wt/feature/CLAUDE.md' && !by('~/Projects/app-wt/feature/CLAUDE.md'));
    ok('R9 a symlink alias is counted, not listed', app.aliases === 1 && !all.includes('app/AGENTS.md'));
    ok('R9 counts are of physical files: both copies are counted', res.counts.files === Object.values(res.counts.byClass).reduce((n, c) => n + c.files, 0)
      && res.counts.files >= res.files.length + res.files.reduce((n, f) => n + f.copies.length, 0));
    ok('counts by class', res.counts.byClass.vendor.files === 2 && res.counts.byClass.plugin.files === 1 && res.counts.byClass.readonly.files === 2, JSON.stringify(res.counts.byClass));
    ok('plugin findings are not fixable', by('~/.claude/plugins/cache/mkt/plug/1.10.0/skills/p1/SKILL.md').findings.every((f) => !f.fixable));
    ok('Home sees the cached counts', audit.cached().state === 'ok' && audit.cached().fixable === res.counts.fixable && res.counts.fixable > 0);

    // A3: propose and accept.
    const alpha = by('~/.claude/skills/alpha/SKILL.md');
    const file = path.join(S, 'alpha', 'SKILL.md');
    const before = fs.readFileSync(file);
    const p = audit.propose({ fileRef: alpha.ref, findingIds: alpha.findings.map((f) => f.id) });
    ok('propose returns the full before and after, and writes nothing', p.current === before.toString() && p.proposed.includes('$(model-id sol || echo MODEL-ID-UNRESOLVED-sol)') && fs.readFileSync(file).equals(before));
    ok('R15 …with no absolute path', !JSON.stringify(p).includes(home));
    const r = await audit.accept({ id: p.id });
    ok('accept writes exactly the reviewed bytes', r.saved && fs.readFileSync(file, 'utf8') === p.proposed);
    ok('the id is spent (410)', (await rejects(() => audit.accept({ id: p.id })))?.status === 410);
    ok('an accept makes Home\'s count stale', audit.cached().stale === true);
    ok('a made-up id → 410', (await rejects(() => audit.accept({ id: 'f'.repeat(32) })))?.status === 410);

    const res2 = await audit.run();
    ok('the cache was dropped by the accept: a new run', res2.run === res.run + 1);
    const script = res2.files.find((f) => f.display === '~/.claude/skills/alpha/scripts/run.sh');
    const sfile = path.join(S, 'alpha', 'scripts', 'run.sh');
    const q = audit.propose({ fileRef: script.ref, findingIds: [script.findings[0].id] });
    fs.appendFileSync(sfile, '# typed in an editor\n');
    const after = fs.readFileSync(sfile);
    ok('a base that moved → 409, nothing written', (await rejects(() => audit.accept({ id: q.id })))?.status === 409 && fs.readFileSync(sfile).equals(after));
    fs.writeFileSync(sfile, 'codex exec -m gpt-6-sol "z"\n');
    ok('a finding id no longer in the file → 409', (await rejects(() => audit.propose({ fileRef: script.ref, findingIds: [script.findings[0].id] })))?.status === 409);

    let clock = 1_000;
    const timed = A.createAudit({ home, hist: quiet, now: () => clock });
    const t1 = await timed.run();
    const tg = t1.files.find((f) => f.display === '~/.agents/skills/gamma/SKILL.md');
    const tp = timed.propose({ fileRef: tg.ref, findingIds: [tg.findings[0].id] });
    clock += A.AUDIT_LIMITS.proposalTtlMs + 1;
    ok('an expired id → 410', (await rejects(() => timed.accept({ id: tp.id })))?.status === 410);

    // Identity: the same bytes under a new inode.
    const gfile = path.join(home, '.agents', 'skills', 'gamma', 'SKILL.md');
    const g1 = audit.propose({ fileRef: tg.ref, findingIds: [tg.findings[0].id] });
    const gb = fs.readFileSync(gfile);
    put(`${gfile}.swap`, gb); fs.renameSync(`${gfile}.swap`, gfile);
    ok('the same bytes under a new inode → 409', (await rejects(() => audit.accept({ id: g1.id })))?.status === 409 && fs.readFileSync(gfile).equals(gb));

    // A hard link made after propose.
    const g2 = audit.propose({ fileRef: tg.ref, findingIds: [tg.findings[0].id] });
    fs.linkSync(gfile, path.join(home, 'gamma-hard.md'));
    ok('a hard link made after propose → refused at accept, nothing written', (await rejects(() => audit.accept({ id: g2.id })))?.status === 409 && fs.readFileSync(gfile).equals(gb));
    ok('…and propose refuses a hard-linked file outright', (await rejects(() => audit.propose({ fileRef: tg.ref, findingIds: [tg.findings[0].id] })))?.status === 409);
    fs.rmSync(path.join(home, 'gamma-hard.md'));

    // A symlinked instruction file is written in place: link kept, inode kept.
    const gclaude = path.join(home, '.claude', 'CLAUDE.md');
    const target = put(path.join(home, '.agents', 'CLAUDE-real.md'), '# Global\nUse claude-opus-5-5 here.\n');
    fs.rmSync(gclaude); fs.symlinkSync(target, gclaude);
    const ino = fs.statSync(target).ino;
    const res3 = await audit.run({ refresh: true });
    const gl = res3.files.find((f) => f.display === '~/.agents/CLAUDE-real.md');
    ok('a linked global instruction file shows as its target', !!gl && gl.aliases === 0 && gl.kind === 'instruction', JSON.stringify(res3.files.map((f) => f.display)));
    const lp = audit.propose({ fileRef: gl.ref, findingIds: [gl.findings[0].id] });
    await audit.accept({ id: lp.id });
    ok('a symlinked target is written in place: link kept, inode kept', fs.lstatSync(gclaude).isSymbolicLink() && fs.statSync(target).ino === ino && fs.readFileSync(target, 'utf8') === '# Global\nUse opus here.\n');

    // The class policy.
    const res4 = await audit.run({ refresh: true });
    const of = (d) => res4.files.find((f) => f.display === d);
    for (const [what, d, reason] of [
      ['plugin', '~/.claude/plugins/cache/mkt/plug/1.10.0/skills/p1/SKILL.md', 'plugin'],
      ['vendor', '~/.claude/skills/.system/vend/SKILL.md', 'vendor'],
      ['readonly', 'Client/.claude/skills/ro/SKILL.md', 'readonly'],
    ]) {
      const f = of(d);
      const e = await rejects(() => audit.propose({ fileRef: f.ref, findingIds: [f.findings[0].id] }));
      ok(`${what} → 403 at propose`, e?.status === 403 && e.payload.reason === reason, e?.message);
    }
    const syn = of('~/.claude/skills/synced/u1/beta/SKILL.md');
    const se = await rejects(() => audit.propose({ fileRef: syn.ref, findingIds: [syn.findings[0].id] }));
    ok('synced without ackSync → 409 naming the reason', se?.status === 409 && se.payload.reason === 'synced' && /next sync overwrites/.test(se.message), se?.message);
    const sp = audit.propose({ fileRef: syn.ref, findingIds: [syn.findings[0].id], ackSync: true });
    ok('synced with ackSync → a proposal, carrying the acknowledgement', sp.cls === 'synced' && (await audit.accept({ id: sp.id })).saved);

    // R3: the class changes between propose and accept.
    const res5 = await audit.run({ refresh: true });
    const ga = res5.files.find((f) => f.display === '~/.agents/skills/gamma/SKILL.md');
    const cp = audit.propose({ fileRef: ga.ref, findingIds: [ga.findings[0].id] });
    const sys = path.join(home, '.codex', 'skills', '.system');
    fs.renameSync(sys, `${sys}.moved`);
    fs.symlinkSync(path.join(home, '.agents', 'skills'), sys);
    const gnow = fs.readFileSync(gfile);
    const ce = await rejects(() => audit.accept({ id: cp.id }));
    ok('R3 a file that became vendor after propose → 403 at accept, nothing written', ce?.status === 403 && ce.payload.reason === 'vendor' && fs.readFileSync(gfile).equals(gnow), ce?.message);
    fs.unlinkSync(sys); fs.renameSync(`${sys}.moved`, sys);

    // R9: Fix changes the one physical copy it names.
    const res6 = await audit.run({ refresh: true });
    const card = res6.files.find((f) => f.display === '~/Projects/app/CLAUDE.md');
    const copyBytes = fs.readFileSync(path.join(proj, 'app-wt', 'feature', 'CLAUDE.md'));
    const cpp = audit.propose({ fileRef: card.ref, findingIds: [card.findings[0].id] });
    ok('R9 the proposal says how many other copies there are', cpp.copies === 1);
    await audit.accept({ id: cpp.id });
    ok('R9 …and only the chosen copy changes', fs.readFileSync(path.join(proj, 'app', 'CLAUDE.md'), 'utf8') === 'Builds: opus.\n' && fs.readFileSync(path.join(proj, 'app-wt', 'feature', 'CLAUDE.md')).equals(copyBytes));

    // Dismiss: persisted in the studio folder, survives a new service.
    const res7 = await audit.run({ refresh: true });
    const d = res7.files.find((f) => f.display === '~/Projects/app-wt/feature/CLAUDE.md');
    audit.dismiss({ id: d.findings[0].id });
    ok('dismiss writes ~/.agent-config-studio/audit-dismissed.json', JSON.parse(fs.readFileSync(path.join(studio, 'audit-dismissed.json'), 'utf8')).dismissed[d.findings[0].id] > 0);
    ok('…and makes Home\'s count stale', audit.cached().stale === true);
    const fresh = A.createAudit({ home, hist: quiet });
    const res8 = await fresh.run();
    const d2 = res8.files.find((f) => f.display === '~/Projects/app-wt/feature/CLAUDE.md');
    ok('a dismissed finding stays dismissed in a new service, and is not counted', d2.findings[0].dismissed === true && res8.counts.byClass.user.findings === res7.counts.byClass.user.findings - 1);
    fresh.dismiss({ id: d.findings[0].id, undo: true });
    ok('undismiss brings it back', (await fresh.run()).files.find((f) => f.display === '~/Projects/app-wt/feature/CLAUDE.md').findings[0].dismissed === false);
    ok('a dismiss id that is not a finding id → 400', (await rejects(() => fresh.dismiss({ id: '../x' })))?.status === 400);

    // History holds the accepted bytes.
    await history.ensureRepo();
    const hist = A.createAudit({ home });
    const res9 = await hist.run();
    const hc = res9.files.find((f) => f.display === '~/Projects/app-wt/feature/CLAUDE.md');
    const hp = hist.propose({ fileRef: hc.ref, findingIds: [hc.findings[0].id] });
    const hr = await hist.accept({ id: hp.id });
    ok('history holds the accepted bytes', hr.sha && (await history.contentAt(path.join(proj, 'app-wt', 'feature', 'CLAUDE.md'), hr.sha)) === hp.proposed, JSON.stringify(hr));
  }

  console.log('\naudit: R10 — the bounded walk and the cache');
  {
    const small = A.createAudit({ home, hist: quiet, limits: { ...A.AUDIT_LIMITS, files: 5 } });
    const r = await small.run();
    ok('a file cap stops the walk and says so', r.partial && r.counts.files === 5 && r.partialReasons.some((x) => /5 files/.test(x)), JSON.stringify(r.partialReasons));
    ok('Home shows partial', small.cached().state === 'partial');
    const shallow = await A.createAudit({ home, hist: quiet, limits: { ...A.AUDIT_LIMITS, depth: 2 } }).run();
    ok('a depth cap is enforced and reported', shallow.partial && shallow.partialReasons.some((x) => /deeper than 2/.test(x)) && !shallow.files.some((f) => /synced\/u1/.test(f.display)));
    const tiny = await A.createAudit({ home, hist: quiet, limits: { ...A.AUDIT_LIMITS, totalBytes: 200 } }).run();
    ok('a total-bytes budget is enforced and reported', tiny.partial && tiny.partialReasons.some((x) => /MB read/.test(x)));
    const big = put(path.join(home, '.claude', 'skills', 'huge', 'SKILL.md'), `${'x'.repeat(2 * 1024 * 1024)}\n`);
    const full = A.createAudit({ home, hist: quiet });
    const [a, b] = await Promise.all([full.run(), full.run()]);
    ok('concurrent runs share one scan', a === b && a.run === 1);
    ok('a file over 1 MB is skipped and counted', a.counts.skipped.tooLarge >= 1 && !a.files.some((f) => /huge/.test(f.display)));
    ok('within a minute the result is cached', (await full.run()).run === 1);
    ok('refresh rescans', (await full.run({ refresh: true })).run === 2);
    fs.rmSync(path.dirname(big), { recursive: true });
    const roots = JSON.parse(fs.readFileSync(path.join(studio, 'roots.json'), 'utf8'));
    put(path.join(studio, 'roots.json'), JSON.stringify({ version: 1, roots: roots.roots.filter((x) => x.id !== 'client') }));
    ok('a roots change makes Home\'s count stale and the next run rescans', full.cached().stale === true && (await full.run()).run === 3);
    put(path.join(studio, 'roots.json'), JSON.stringify(roots));
  }

  console.log('\naudit: grade fixes — ids, shell state, effort attribution, copies, limits, the create path');
  {
    // 1. Two different tokens of one rule on one line get two ids, and both can be fixed at once.
    const two = 'codex -m gpt-6-sol a && codex -m gpt-6-astra b';
    const f2 = scan(two, 'run.sh');
    ok('R7 two different ids on one line are two findings with two ids', f2.length === 2 && f2[0].id !== f2[1].id, JSON.stringify(f2.map((f) => [f.match, f.id])));

    // 2. Quoting carried across lines, and here-documents.
    const multi = scan("codex exec 'first line\n-m gpt-6-sol still quoted'\ncodex exec -m gpt-6-sol x", 'run.sh');
    ok('R1 an id inside a single-quoted string that spans lines gets no fix; after it closes, it does', multi.length === 2 && !multi[0].fix && multi[1].fix, JSON.stringify(multi.map((f) => [f.line, Boolean(f.fix)])));
    for (const [what, open] of [["<<'EOF'", "cat <<'EOF' > out.sh"], ['<<"EOF"', 'cat <<"EOF" > out.sh'], ['<<\\EOF', 'cat <<\\EOF > out.sh']]) {
      const q = scan(`${open}\ncodex -m gpt-6-sol x\nEOF\ncodex -m gpt-6-sol y`, 'run.sh');
      ok(`R1 a quoted here-document (${what}) is literal: no fix inside it, a fix after it`, q.length === 2 && !q[0].fix && q[1].fix, JSON.stringify(q.map((f) => [f.line, Boolean(f.fix)])));
    }
    const fenced = scan(fence("cat <<'EOF'", 'codex -m gpt-6-sol x', 'EOF'));
    ok('R1 …in a bash fence too', fenced.length === 1 && !fenced[0].fix);
    const dash = scan("cat <<-'EOF'\n\tcodex -m gpt-6-sol x\n\tEOF\ncodex -m gpt-6-sol y", 'run.sh');
    ok('R1 <<- ends at a tab-indented terminator', dash.length === 2 && !dash[0].fix && dash[1].fix);
    const d3q = scan("cat <<'EOF'\nM=$(model-id sol)\nEOF", 'run.sh');
    ok('R1 a bare $(model-id …) in a quoted here-document gets no fallback fix', d3q.length === 1 && d3q[0].rule === 'D3' && !d3q[0].fix);
    const heredoc = 'cat <<EOF\ncodex -m gpt-6-sol x\nEOF\n';
    const uq = scan(heredoc, 'run.sh');
    ok('R1 an unquoted here-document expands $(…): fixable, with no added quotes (they would be literal there)', uq.length === 1 && uq[0].fix?.replacement === '$(model-id sol || echo MODEL-ID-UNRESOLVED-sol)', JSON.stringify(uq));
    const hd = mkdir('heredoc');
    put(path.join(hd, 'model-id'), '#!/bin/sh\n[ "$1" = sol ] && echo gpt-6.1-sol\n');
    fs.chmodSync(path.join(hd, 'model-id'), 0o755);
    const hs = put(path.join(hd, 'h.sh'), A.applyFixes(Buffer.from(heredoc), heredoc, uq));
    const hr = spawnSync('sh', [hs], { encoding: 'utf8', env: { PATH: `${hd}:/usr/bin:/bin` } });
    ok('R1 …and the fixed here-document prints the resolved id', hr.stdout === 'codex -m gpt-6.1-sol x\n', JSON.stringify(hr.stdout + hr.stderr));

    // 3. Each effort belongs to the model of its own command.
    const pair = scan(fence('codex -m gpt-6-sol --effort medium && codex -m gpt-6-astra --effort high'));
    ok('R8 two commands on one line: each effort is checked against its own model', only(pair, 'D4').length === 0, JSON.stringify(only(pair, 'D4').map((f) => f.message)));
    const subs = scan(fence('codex -m "$(model-id sol || echo MODEL-ID-UNRESOLVED-sol)" --effort medium; codex -m "$(model-id astra || echo MODEL-ID-UNRESOLVED-astra)" --effort high'));
    ok('R8 …a fallback\'s || inside $(…) does not split the command', only(subs, 'D4').length === 0, JSON.stringify(only(subs, 'D4').map((f) => f.message)));
    const wrong = scan(fence('codex -m gpt-6-sol --effort high | codex -m gpt-6-astra --effort high'));
    ok('R8 …and a real mismatch is still reported, for the right model', only(wrong, 'D4').length === 1 && only(wrong, 'D4')[0].family === 'sol', JSON.stringify(only(wrong, 'D4')));

    // 4, 5, 8: the inventory.
    const svc = path.join(proj, 'svc');
    put(path.join(svc, 'CLAUDE.md'), 'Use claude-opus-5-5.\n');
    put(path.join(svc, 'AGENTS.md'), 'Use claude-opus-5-5.\n');
    put(path.join(svc, '.claude', 'skills', 'pair', 'SKILL.md'), `${fence('codex -m gpt-6-sol a && codex -m gpt-6-astra b')}\n`);
    put(path.join(home, '.claude', 'skills', 'synced', 'u2', 'deep', 'SKILL.md'), 'Use claude-sonnet-5 here.\n');
    const deep = put(path.join(home, '.claude', 'skills', 'synced', 'u2', 'deep', 'refs', 'x.md'), 'Use claude-haiku-4-5-20251001.\n');
    const audit = A.createAudit({ home, hist: quiet });
    const res = await audit.run();
    const by = (d) => res.files.find((f) => f.display === d);
    const card = by('~/Projects/svc/AGENTS.md') || by('~/Projects/svc/CLAUDE.md');
    ok('R9 byte-identical CLAUDE.md and AGENTS.md are one card, the other named as a copy', card && card.copies.length === 1 && [card.display, card.copies[0].display].sort().join() === '~/Projects/svc/AGENTS.md,~/Projects/svc/CLAUDE.md', JSON.stringify(res.files.filter((f) => /svc\/[A-Z]/.test(f.display)).map((f) => [f.display, f.copies.length])));
    if (card?.copies.length) {
      const other = path.join(svc, card.copies[0].display.endsWith('AGENTS.md') ? 'AGENTS.md' : 'CLAUDE.md');
      const otherBytes = fs.readFileSync(other);
      await audit.accept({ id: audit.propose({ fileRef: card.ref, findingIds: [card.findings[0].id] }).id });
      ok('R9 …and Fix changes only the chosen file', fs.readFileSync(other).equals(otherBytes) && fs.readFileSync(path.join(svc, card.display.split('/').pop()), 'utf8') === 'Use opus.\n');
    } else ok('R9 …and Fix changes only the chosen file', false, 'no grouped card');
    const pf = by('~/Projects/svc/.claude/skills/pair/SKILL.md');
    const pe = await rejects(async () => {
      const pp = audit.propose({ fileRef: pf.ref, findingIds: pf.findings.map((f) => f.id) });
      audit.reject({ id: pp.id });
      if ((pp.proposed.match(/\$\(model-id/g) || []).length !== 2) throw new Error('not both fixed');
    });
    ok('R7 …and both findings on that line can be fixed in one proposal', pf.findings.length === 2 && !pe, pe?.message);
    const d3 = await A.createAudit({ home, hist: quiet, limits: { ...A.AUDIT_LIMITS, depth: 3 } }).run();
    const shown = (r, re) => r.files.some((f) => re.test(f.display) || f.copies.some((c) => re.test(c.display)));
    ok('R10 depth counts from the inventory root, through a skill\'s own folders', !shown(d3, /u2\/deep\/refs\/x\.md/) && shown(d3, /u2\/deep\/SKILL\.md/) && shown(res, /u2\/deep\/refs\/x\.md/),
      JSON.stringify([shown(d3, /u2\/deep\/refs\/x\.md/), shown(d3, /u2\/deep\/SKILL\.md/), shown(res, /u2\/deep\/refs\/x\.md/)]));
    fs.rmSync(path.dirname(path.dirname(deep)), { recursive: true });

    // A file that grows between its size check and its read is held to the cap on the bytes read.
    const grow = put(path.join(home, '.claude', 'skills', 'grower', 'SKILL.md'), 'small\n');
    const ginstr = put(path.join(proj, 'grow', 'CLAUDE.md'), 'small\n');
    A._setWalkHook((abs) => { if (abs === grow || abs === ginstr) fs.appendFileSync(abs, 'x'.repeat(2 * 1024 * 1024)); });
    const g = await A.createAudit({ home, hist: quiet }).run();
    A._setWalkHook(null);
    ok('R10 a file that grows past 1 MB after its size check is skipped as too large, never read whole', !g.files.some((f) => /grower|Projects\/grow\//.test(f.display)) && g.counts.skipped.tooLarge >= 2, JSON.stringify(g.counts.skipped));
    fs.rmSync(path.dirname(grow), { recursive: true }); fs.rmSync(path.dirname(ginstr), { recursive: true });
    const late = put(path.join(home, '.claude', 'skills', 'late', 'SKILL.md'), 'small\n');
    const capped = A.createAudit({ home, hist: quiet, limits: { ...A.AUDIT_LIMITS, totalBytes: 2048 } });
    A._setWalkHook((abs) => { if (abs === late) fs.appendFileSync(abs, 'y'.repeat(4096)); });
    const c = await capped.run();
    A._setWalkHook(null);
    ok('R10 the total budget is enforced on bytes read, not on sizes stat\'d before', c.partial && c.partialReasons.some((x) => /MB read/.test(x)) && !c.files.some((f) => /skills\/late\//.test(f.display)));
    fs.rmSync(path.dirname(late), { recursive: true });

    // 8. A fix that would take a file over the read limit is refused at propose.
    const near = put(path.join(proj, 'near', 'CLAUDE.md'), `${'#'.repeat(250)}\n${fence('codex -m gpt-6-sol x')}\n`);
    const small = A.createAudit({ home, hist: quiet, limits: { ...A.AUDIT_LIMITS, fileBytes: 300 } });
    const sr = await small.run();
    const nf = sr.files.find((f) => f.display === '~/Projects/near/CLAUDE.md');
    const nbytes = fs.readFileSync(near);
    const ne = await rejects(() => small.propose({ fileRef: nf.ref, findingIds: [nf.findings[0].id] }));
    ok('a fix that would grow a file past the read limit is refused at propose (413), nothing written', nf && ne?.status === 413 && ne.payload.reason === 'too-large' && fs.readFileSync(near).equals(nbytes), ne?.message);
    fs.rmSync(path.dirname(near), { recursive: true });

    // 6. Creating a file goes through the same write, verify and restore.
    const dir = mkdir('create');
    const target = path.join(dir, 'new.md');
    const rec = { real: target, ident: 'absent', bytes: Buffer.from('fresh contents\n') };
    const faulty = (writeSync) => ({ ...fs, writeSync });
    let n = 0;
    const midway = faulty((fd, buf, off, len, pos) => { if (n++ === 0) { fs.writeSync(fd, buf, off, Math.floor(len / 2), pos); throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' }); } return fs.writeSync(fd, buf, off, len, pos); });
    const c1 = await rejects(() => P.writeInPlace(rec, null, { io: midway }));
    ok('R13 a create that fails partway removes the partial file, and says so', c1?.status === 500 && c1.payload.restored === true && /partial file was removed/.test(c1.message) && !fs.existsSync(target), c1?.message);
    n = 0;
    const wrongBytes = faulty((fd, buf, off, len, pos) => { fs.writeSync(fd, Buffer.alloc(len, 0x41), 0, len, pos); return len; });
    const c2 = await rejects(() => P.writeInPlace(rec, null, { io: wrongBytes }));
    ok('R13 a created file that does not read back as written is removed', c2?.status === 500 && /did not read back/.test(c2.message) && !fs.existsSync(target), c2?.message);
    const c3 = await rejects(() => P.writeInPlace(rec, null, { io: faulty(() => 0) }));
    ok('R13 a zero-byte write on create is an error, and the empty file is removed', c3?.status === 500 && /short write/.test(c3.message) && !fs.existsSync(target), c3?.message);
    P.writeInPlace(rec, null);
    ok('R13 without faults the created file holds the bytes', fs.readFileSync(target, 'utf8') === 'fresh contents\n');
    ok('R13 an existing file is never created over', (await rejects(() => P.writeInPlace(rec, null)))?.code === 'EEXIST' && fs.readFileSync(target, 'utf8') === 'fresh contents\n');
  }

  console.log('\naudit: R13 — the writer, under faults');
  {
    const dir = mkdir('faults');
    const f = put(path.join(dir, 'x.md'), 'original bytes\n');
    const st = () => fs.statSync(f);
    const rec = () => ({ real: f, ident: `${st().dev}:${st().ino}`, bytes: Buffer.from('the new, longer contents\n') });
    const pre = fs.readFileSync(f);
    const faulty = (writeSync) => ({ ...fs, openSync: fs.openSync, fstatSync: fs.fstatSync, closeSync: fs.closeSync, ftruncateSync: fs.ftruncateSync, writeFileSync: fs.writeFileSync, writeSync });
    let n = 0;
    const midway = faulty((fd, buf, off, len, pos) => { if (n++ === 0) { fs.writeSync(fd, buf, off, Math.floor(len / 2), pos); throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' }); } return fs.writeSync(fd, buf, off, len, pos); });
    const e1 = await rejects(() => P.writeInPlace(rec(), pre, { io: midway }));
    ok('an error partway through the write → the preimage is put back, and the error says so', e1?.status === 500 && e1.payload.restored === true && /EIO/.test(e1.message) && fs.readFileSync(f).equals(pre), e1?.message);
    n = 0;
    const short = faulty((fd, buf, off, len, pos) => (n++ === 0 ? 0 : fs.writeSync(fd, buf, off, len, pos)));
    const e2 = await rejects(() => P.writeInPlace(rec(), pre, { io: short }));
    ok('a zero-byte write is an error, never a loop; the preimage is put back', e2?.status === 500 && /short write/.test(e2.message) && fs.readFileSync(f).equals(pre), e2?.message);
    n = 0;
    const wrong = faulty((fd, buf, off, len, pos) => { if (n++ === 0) { fs.writeSync(fd, Buffer.alloc(len, 0x41), 0, len, pos); return len; } return fs.writeSync(fd, buf, off, len, pos); });
    const e3 = await rejects(() => P.writeInPlace(rec(), pre, { io: wrong }));
    ok('bytes that do not read back as written → the preimage is put back', e3?.status === 500 && /did not read back/.test(e3.message) && fs.readFileSync(f).equals(pre), e3?.message);
    const broken = faulty(() => { throw Object.assign(new Error('ENOSPC: no space'), { code: 'ENOSPC' }); });
    const e4 = await rejects(() => P.writeInPlace(rec(), pre, { io: broken }));
    ok('when the restore fails too, the error says to restore from History', e4?.status === 500 && e4.payload.restored === false && /History/.test(e4.message), e4?.message);
    put(f, 'original bytes\n');
    P.writeInPlace(rec(), pre);
    ok('without faults the bytes land', fs.readFileSync(f, 'utf8') === 'the new, longer contents\n');
  }
} finally {
  for (const d of temps) fs.rmSync(d, { recursive: true, force: true });
  assertRealHomesUnchanged(realBefore, ok);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
