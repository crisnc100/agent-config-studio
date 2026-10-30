/**
 * acs packs install (builds/skill-packs plan.md P2): C1, C2, C4 through the
 * installer, C11, C12, C16, the requirement check, the role fix-up, harness
 * selection and the earlier-install report. Every run is a temp HOME with stub
 * CLIs (tests/fixtures/packs-sandbox.mjs); no model CLI is ever run.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { snapshotRealHomes, assertRealHomesUnchanged } from './real-home.mjs';
import { PACKS, ROOT, changed, reviewRepo, sandbox, tests, tree } from './fixtures/packs-sandbox.mjs';

const realBefore = snapshotRealHomes();
const { ok, done } = tests();
const boxes = [];
const box = (...a) => { const b = sandbox(...a); boxes.push(b); return b; };
const review = (sb, repo, extra = {}) => sb.run(process.execPath, [path.join(sb.home, '.agent-config-studio/review-gate/review.mjs'), 'fix the loop'], { cwd: repo, extra: { REVIEW_BASE: 'main', ...extra } });
const logLines = (sb) => (sb.read(path.join(sb.home, '.agent-config-studio/review-log/review-log.jsonl')) || '').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

console.log('\npacks install: nothing is written without a yes');
{
  const sb = box('noyes', { clis: ['claude'] });
  const before = tree(sb.home);
  const r = sb.packs(['install', 'handoff']);
  ok('without --yes (and no terminal) the preview prints and the run exits non-zero', r.code === 1 && /Will change:/.test(r.out) && /re-run with --yes/.test(r.out), r.out);
  ok('…and not one file in HOME changed', changed(before, tree(sb.home)).length === 0, changed(before, tree(sb.home)).join(' '));
  const d = sb.packs(['install', 'handoff', '--dry-run']);
  ok('--dry-run shows the preview, exits 0 and writes nothing', d.code === 0 && /SKILL\.md/.test(d.out) && changed(before, tree(sb.home)).length === 0, d.out);
}

console.log('\nC1 a Claude-only machine');
{
  const sb = box('c1', { clis: ['claude'] });
  sb.roles({ roles: { reviewer: { use: ['opus', 'sol', 'grok'] } } });
  const r = sb.packs(['install', 'review-gate', '--yes']);
  ok('C1 review-gate installs its skill for claude only', r.code === 0 && fs.existsSync(path.join(sb.home, '.claude/skills/code-review/SKILL.md')) && !fs.existsSync(sb.env.CODEX_HOME), r.out);
  ok('C1 …and the shared runtime lands once in ~/.agent-config-studio/review-gate', fs.existsSync(path.join(sb.home, '.agent-config-studio/review-gate/review.mjs')) && fs.lstatSync(path.join(sb.home, '.agent-config-studio/review-gate/hooks/global/pre-push')).isSymbolicLink());
  ok('C1 …with the pinned node path for the hooks', sb.read(path.join(sb.home, '.agent-config-studio/review-gate/hooks/node-path')) === `${process.execPath}\n`);
  const { repo } = reviewRepo(sb);
  const rv = review(sb, repo);
  const skips = rv.stderr.split('\n').filter((l) => /skipped/.test(l));
  ok('C1 a review runs on a claude-family reviewer', rv.code === 0 && /▶ reviewer · opus \(claude · /.test(rv.stdout), rv.out);
  ok('C1 …printing one line that names sol and grok as skipped', skips.length === 1 && /skipped sol \(codex CLI not on PATH\), grok \(grok CLI not on PATH\)/.test(skips[0]), skips.join(' | '));
  ok('C1 …and the codex and grok stubs are never invoked', sb.callsOf('claude').length === 1 && sb.callsOf('codex').length === 0 && sb.callsOf('grok').length === 0);
  ok('C1 …and the review is logged in ~/.agent-config-studio/review-log', logLines(sb)[0]?.family === 'opus');
}

console.log('\nrole fix-up: the shipped default reviewer has no CLI on a Claude-only machine');
{
  const sb = box('roles', { clis: ['claude'] });
  const p = sb.json(['install', 'review-gate', '--dry-run']);
  const prob = p.data?.roles?.find((x) => x.role === 'reviewer');
  ok('the preview names the reviewer role as unusable here and suggests installed families', prob && prob.use.join() === 'astra' && prob.suggestion.length > 0 && prob.suggestion.every((f) => ['fable', 'opus', 'sonnet', 'haiku'].includes(f)), JSON.stringify(p.data?.roles));
  ok('…and warns, naming --fix-roles and --set-role', p.data?.warnings?.some((w) => /reviewer role \(astra\)/.test(w) && /--fix-roles/.test(w) && /--set-role/.test(w)), JSON.stringify(p.data?.warnings));
  const r = sb.packs(['install', 'review-gate', '--yes', '--set-role', 'reviewer=opus']);
  ok('--set-role reviewer=opus installs and sets the role through ACS\'s roles write path', r.code === 0 && JSON.parse(sb.read(path.join(sb.home, '.agent-config-studio/roles.json'))).roles.reviewer.use.join() === 'opus', r.out);
  ok('…which records it in ACS\'s history', fs.existsSync(path.join(sb.home, '.agent-config-studio/history/.git')));
  const { repo } = reviewRepo(sb);
  const rv = review(sb, repo);
  ok('…and the first review then runs on that claude family (no fallback, no codex)', rv.code === 0 && /▶ reviewer · opus \(claude/.test(rv.stdout) && sb.callsOf('codex').length === 0, rv.out);
  const keep = JSON.parse(sb.read(path.join(sb.home, '.agent-config-studio/roles.json'))).roles.reviewer;
  ok('…and the role keeps its other fields (only use changed)', Object.keys(keep).join() === 'use', JSON.stringify(keep));
  const sb2 = box('roles2', { clis: ['claude'] });
  const f = sb2.packs(['install', 'review-gate', '--yes', '--fix-roles']);
  const set = JSON.parse(sb2.read(path.join(sb2.home, '.agent-config-studio/roles.json'))).roles.reviewer.use;
  ok('--fix-roles sets the reviewer role to the suggested installed families', f.code === 0 && set.length > 0 && set.every((x) => ['fable', 'opus', 'sonnet', 'haiku'].includes(x)), f.out);
  const st = sb2.json(['status', '--no-trust-check']);
  ok('…and status no longer reports the role as broken', !JSON.stringify(st.data).includes('role'), JSON.stringify(st.data?.packs?.[0]?.parts?.[0]));
}

console.log('\nC2 a Codex-only machine');
{
  const sb = box('c2', { clis: ['codex'], dirs: ['codex'] });
  const r = sb.packs(['install', 'review-gate', '--yes']);
  ok('C2 the skill lands in $CODEX_HOME/skills', r.code === 0 && fs.existsSync(path.join(sb.env.CODEX_HOME, 'skills/code-review/SKILL.md')), r.out);
  ok('C2 …and no ~/.claude is created', !fs.existsSync(path.join(sb.home, '.claude')));
  const { repo } = reviewRepo(sb);
  const rv = review(sb, repo);
  ok('C2 a review runs from ~/.agent-config-studio (the default reviewer is a codex family)', rv.code === 0 && /▶ reviewer · astra \(codex/.test(rv.stdout) && sb.callsOf('codex').length === 1, rv.out);
  ok('C2 …and logs under ~/.agent-config-studio/review-log', logLines(sb).length === 1 && logLines(sb)[0].vendor === 'codex');
  ok('C2 …and still no ~/.claude', !fs.existsSync(path.join(sb.home, '.claude')));
  const cfg = path.join(sb.home, '.agent-config-studio/review-gate/config.json');
  fs.writeFileSync(cfg, JSON.stringify({ effort: 'low' }));
  const sc = sb.run(process.execPath, [path.join(sb.home, '.agent-config-studio/review-gate/review.mjs'), '--show-config'], { cwd: repo });
  ok('C2 …and the config is read from ~/.agent-config-studio/review-gate/config.json', sc.code === 0 && sc.out.includes(cfg), sc.out);
}

console.log('\nC4 through the installer: the loud stops still stop');
{
  const sb = box('c4', { clis: ['claude'], modelId: false });
  const r = sb.packs(['install', 'review-gate', '--yes']);
  ok('C4 no model-id: install refuses, names the fix, writes nothing', r.code === 1 && /model-id is not on PATH — fix: run: acs install-model-id/.test(r.out) && !fs.existsSync(path.join(sb.home, '.agent-config-studio/packs')), r.out);
  const sb2 = box('c4b', { clis: [], dirs: [] });
  const r2 = sb2.packs(['install', 'advisor', '--yes']);
  ok('C4 no agent CLI: install refuses and names the fix', r2.code === 1 && /no agent CLI on PATH .* fix: install one of: claude, codex, grok/.test(r2.out), r2.out);
  const sb3 = box('c4c', { clis: ['claude'] });
  sb3.packs(['install', 'review-gate', '--yes']);
  const { repo } = reviewRepo(sb3);
  const rv = review(sb3, repo);
  ok('C4 every reviewer CLI missing (default astra, claude only, fix-up declined): the review stops with the fix and runs no model', rv.code !== 0 && /Fix/.test(rv.stderr) && sb3.callsOf('claude').length === 0 && sb3.callsOf('codex').length === 0, rv.out);
  const rn = review(sb3, repo, { REVIEW_REVIEWER: 'grok' });
  ok('C4 a named reviewer with no CLI: stops, names the fix, no other vendor tried', rn.code !== 0 && /Fix|not on PATH/.test(rn.stderr) && sb3.callsOf('claude').length === 0, rn.out);
  sb3.roles({ roles: { reviewer: null } });
  const rr = review(sb3, repo);
  ok('C4 no reviewer role: stops with the fix', rr.code !== 0 && /reviewer role/.test(rr.stderr) && sb3.callsOf('claude').length === 0, rr.out);
}

console.log('\nharnesses: only those present, unless forced');
{
  const sb = box('harness', { clis: ['claude'] });
  const p = sb.json(['install', 'advisor', '--dry-run', '--harness', 'codex']);
  ok('naming an absent harness refuses and says how to force it', p.code === 1 && p.data.refusals.some((x) => /codex is not installed here .* --force/.test(x)), p.out);
  const f = sb.packs(['install', 'advisor', '--yes', '--harness', 'claude,codex', '--force']);
  ok('--force installs for it anyway', f.code === 0 && fs.existsSync(path.join(sb.env.CODEX_HOME, 'skills/advisor/SKILL.md')) && fs.existsSync(path.join(sb.home, '.claude/skills/advisor/advisor-contract.md')), f.out);
  const g = box('grok-only', { clis: ['grok'], dirs: ['grok'] });
  const gr = g.packs(['install', 'handoff', '--yes']);
  ok('a Grok-only machine gets the claude skill folder, which Grok reads', gr.code === 0 && fs.existsSync(path.join(g.home, '.claude/skills/handoff/SKILL.md')) && !fs.existsSync(g.env.CODEX_HOME), gr.out);
  ok('a second install of the same part says nothing to do', /already installed/.test(sb.packs(['install', 'advisor', '--yes']).out));
  const sb2 = box('newh', { clis: ['claude'] });
  sb2.packs(['install', 'handoff', '--yes']);
  fs.writeFileSync(path.join(sb2.bin, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const st = sb2.json(['status', '--no-trust-check']);
  const row = st.data.packs.find((x) => x.id === 'handoff').parts[0];
  ok('status reports a new harness the part is not installed for', row.statuses.includes('new harness detected, not installed for it') && /codex is here now/.test(row.details.join()), JSON.stringify(row));
  const again = sb2.packs(['install', 'handoff', '--yes']);
  ok('…and installing again adds just that harness', again.code === 0 && fs.existsSync(path.join(sb2.env.CODEX_HOME, 'skills/handoff/SKILL.md')) && sb2.state().packs.handoff.parts.handoff.harnesses.join() === 'claude,codex', again.out);
}

console.log('\nC12 build needs review-gate');
{
  const sb = box('c12', { clis: ['claude'] });
  const r = sb.packs(['install', 'build', '--yes']);
  ok('C12 without review-gate, build refuses with the reason', r.code === 1 && /needs the review-gate pack: its Grade and close run the review gate's review\.mjs/.test(r.out), r.out);
  ok('C12 …and installs no build skill', !fs.existsSync(path.join(sb.home, '.claude/skills/build')));
  const w = sb.packs(['install', 'build', '--yes', '--with-deps']);
  ok('C12 --with-deps (consent) adds review-gate\'s skill part in the same install', w.code === 0 && fs.existsSync(path.join(sb.home, '.claude/skills/code-review/SKILL.md')) && fs.existsSync(path.join(sb.home, '.claude/skills/build/SKILL.md')) && fs.existsSync(path.join(sb.home, '.agent-config-studio/review-gate/review.mjs')), w.out);
  const st = sb.state();
  ok('C12 …recorded as two packs, the runtime referenced by the code-review part', st.packs['review-gate']?.parts['code-review'] && st.packs.build?.parts.build && st.runtime.refs.join() === 'review-gate/code-review', JSON.stringify(st.runtime?.refs));
  const u = sb.packs(['uninstall', 'review-gate', '--yes']);
  ok('C12 uninstalling review-gate while build needs it is refused', u.code === 1 && /Build loop is installed and needs Review gate/.test(u.out), u.out);
  const sb2 = box('c12b', { clis: ['claude'] });
  sb2.packs(['install', 'review-gate', '--yes']);
  const b2 = sb2.packs(['install', 'build', '--yes']);
  ok('C12 with review-gate installed first, build installs on its own', b2.code === 0 && fs.existsSync(path.join(sb2.home, '.claude/skills/build/SKILL.md')), b2.out);
}

console.log('\nC11 the preview lists exactly what is written');
{
  // Every kind but the guard's and push gate's (packs-hooks.mjs) and worktree's (packs-update.mjs), on a machine with both harnesses.
  const sb = box('c11', { clis: ['claude', 'codex'] });
  fs.writeFileSync(path.join(sb.home, '.claude/CLAUDE.md'), '# mine\n');
  fs.mkdirSync(path.join(sb.home, '.claude/skills/code-review'), { recursive: true });
  fs.writeFileSync(path.join(sb.home, '.claude/skills/code-review/SKILL.md'), 'my own older skill\n');
  fs.writeFileSync(path.join(sb.env.CODEX_HOME, 'config.toml'), 'model = "x"\n');
  const opts = ['install', 'review-gate', '--part', 'code-review,instructions,codex-log-access', '--set-role', 'reviewer=opus'];
  const p = sb.json([...opts, '--dry-run']);
  const before = tree(sb.home);
  const r = sb.packs([...opts, '--yes']);
  const after = tree(sb.home);
  const written = changed(before, after).filter((f) => after.get(f) !== 'dir' && before.get(f) !== 'dir');
  const listed = p.data.preview.filter((x) => x.path && !x.dir).map((x) => x.path);
  const dirs = p.data.preview.filter((x) => x.dir).map((x) => x.dir + path.sep);
  const covered = (f) => listed.includes(f) || dirs.some((d) => f.startsWith(d));
  ok('C11 the install ran', r.code === 0, r.out);
  ok('C11 every file written is in the preview (or under a folder it names)', written.length > 40 && written.every(covered), written.filter((f) => !covered(f)).join(' '));
  const exact = p.data.preview.filter((x) => x.path && !x.dir && !['record', 'maybe'].includes(x.action)).map((x) => x.path);
  ok('C11 every file the preview says changes, changed', exact.every((f) => written.includes(f) || written.includes(fs.realpathSync(f))), exact.filter((f) => !written.includes(f)).join(' '));
  ok('C11 the replaced skill is shown as a replace, and its old bytes are in the backup', p.data.preview.find((x) => x.path.endsWith('.claude/skills/code-review/SKILL.md'))?.action === 'replace'
    && fs.readdirSync(path.join(sb.home, '.agent-config-studio/backups')).some((d) => d.includes('packs-install')));
  ok('C11 the settings are named: the role and the writable_roots entry', p.data.preview.some((x) => /reviewer role → opus/.test(x.note || '')) && p.data.preview.some((x) => /writable_roots \+=/.test(x.note || '')));
  // A preview that went stale is refused rather than applied.
  const sb2 = box('c11b', { clis: ['claude'] });
  const script = path.join(sb2.root, 'stale.mjs');
  fs.writeFileSync(script, `
    import fs from 'node:fs';
    const P = await import(${JSON.stringify(path.join(ROOT, 'lib/packs.js'))});
    const m = P.machine(); const plan = P.planInstall('handoff', {}, m);
    fs.mkdirSync(${JSON.stringify(path.join(sb2.home, '.claude/skills/handoff'))}, { recursive: true });
    fs.writeFileSync(${JSON.stringify(path.join(sb2.home, '.claude/skills/handoff/SKILL.md'))}, 'appeared\\n');
    try { await P.apply(plan, { m }); console.log('applied'); } catch (e) { console.log('refused:', e.message); }
  `);
  const r2 = sb2.run(process.execPath, [script]);
  ok('C11 a file that changed between preview and apply refuses the run', /refused: what this would change is different from the preview/.test(r2.out) && sb2.read(path.join(sb2.home, '.claude/skills/handoff/SKILL.md')) === 'appeared\n', r2.out);
}

console.log('\nrequirements: each missing piece named with its fix');
{
  const sb = box('req', { clis: ['claude'] });
  const r = sb.json(['install', 'review-gate', '--dry-run']);
  const ids = r.data.requirements.map((x) => x.id);
  ok('node, git, model-id, roles and the CLI are all checked for review-gate', ['node', 'git', 'model-id', 'roles', 'cli'].every((i) => ids.includes(i)), ids.join());
  const nogit = sb.json(['install', 'review-gate', '--dry-run'], { PATH: [sb.bin, path.join(sb.home, '.local/bin'), path.join(sb.root, 'node-bin')].join(':') });
  ok('no git: refused, with the fix', nogit.code === 1 && nogit.data.refusals.some((x) => /git is not on PATH — fix: install git/.test(x)), nogit.out);
  fs.writeFileSync(path.join(sb.home, '.agent-config-studio/roles.json'), '{ not json');
  const bad = sb.json(['install', 'advisor', '--dry-run']);
  ok('unreadable roles: refused, naming where to fix them', bad.code === 1 && bad.data.refusals.some((x) => /roles cannot be read: .* — fix: fix roles\.json in ACS → Models → Roles/.test(x)), bad.out);
  const unk = sb.packs(['install', 'nope']);
  ok('an unknown pack names the real ones', unk.code === 1 && /no pack "nope" \(packs: review-gate, build/.test(unk.out), unk.out);
  const up = sb.packs(['install', 'review-gate', '--part', 'nope', '--dry-run']);
  ok('an unknown part names the real ones', up.code === 1 && /has no part "nope"/.test(up.out), up.out);
}

console.log('\nan earlier review-gate install is reported, never migrated');
{
  const sb = box('legacy', { clis: ['claude'] });
  fs.mkdirSync(path.join(sb.home, '.claude/review-log'), { recursive: true });
  fs.writeFileSync(path.join(sb.home, '.claude/review-log/review-log.jsonl'), '{"type":"review"}\n');
  fs.mkdirSync(path.join(sb.home, '.agent-config-studio'), { recursive: true });
  fs.writeFileSync(path.join(sb.home, '.agent-config-studio/review-gate-installed'), 'x\n');
  const p = sb.json(['install', 'review-gate', '--dry-run']);
  ok('the install preview names both markers and says it does not migrate', p.data.warnings.some((w) => /review-gate-installed/.test(w) && /review-log/.test(w) && /does not migrate/.test(w)), JSON.stringify(p.data.warnings));
  const r = sb.packs(['install', 'review-gate', '--yes']);
  const s = sb.packs(['status', '--no-trust-check']);
  ok('status reports it too', /An earlier review-gate install is here/.test(s.out), s.out);
  ok('…and the old log is untouched and still where it was', r.code === 0 && sb.read(path.join(sb.home, '.claude/review-log/review-log.jsonl')) === '{"type":"review"}\n' && !fs.existsSync(path.join(sb.home, '.agent-config-studio/review-log')));
}

console.log('\nC16 two installs at once leave a valid state.json');
{
  const sb = box('c16', { clis: ['claude', 'codex'] });
  const start = (pack) => new Promise((resolve) => {
    const c = spawn(process.execPath, [PACKS, 'install', pack, '--yes'], { env: sb.env, cwd: sb.root });
    let out = '';
    c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; });
    c.on('exit', (code) => resolve({ code, out }));
  });
  for (let round = 0; round < 3; round++) {
    const results = await Promise.all(['advisor', 'handoff', 'second-opinion'].map(start));
    if (round === 0) ok('C16 three simultaneous installs all succeed', results.every((x) => x.code === 0), results.map((x) => x.out).join('\n---\n'));
    let st = null;
    try { st = sb.state(); } catch {}
    if (round === 0) ok('C16 …and state.json is valid JSON recording all three', st && ['advisor', 'handoff', 'second-opinion'].every((id) => st.packs[id]?.parts), JSON.stringify(Object.keys(st?.packs || {})));
    if (round === 0) ok('C16 …and no lock is left behind', !fs.existsSync(path.join(sb.home, '.agent-config-studio/packs/state.json.lock')));
    const un = await Promise.all(['advisor', 'handoff', 'second-opinion'].map((p) => new Promise((resolve) => {
      const c = spawn(process.execPath, [PACKS, 'uninstall', p, '--yes'], { env: sb.env, cwd: sb.root });
      c.on('exit', (code) => resolve(code));
    })));
    if (round === 0) ok('C16 three simultaneous uninstalls succeed and leave an empty, valid state', un.every((c) => c === 0) && Object.keys(sb.state().packs).length === 0, JSON.stringify(sb.state()));
  }
  // A lock left by a crashed writer (its pid is gone) is taken over.
  fs.writeFileSync(path.join(sb.home, '.agent-config-studio/packs/state.json.lock'), '999999\n');
  const r = sb.packs(['install', 'handoff', '--yes']);
  ok('C16 a crashed writer\'s lock is taken over', r.code === 0 && sb.state().packs.handoff, r.out);
}

for (const b of boxes) b.cleanup();
assertRealHomesUnchanged(realBefore, ok);
done();
