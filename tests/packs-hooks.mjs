/**
 * acs packs and the machine-wide parts (plan.md C5, C6, C8 for these kinds,
 * and status "installed but not working"): the agent guard, the push gate and
 * its worktree-projects option, and Codex log access. Temp HOME, temp
 * CODEX_HOME and GIT_CONFIG_GLOBAL, stub CLIs; the codex stub answers the
 * guard's hooks/list from its own home's files. No model CLI is ever run.
 */
import fs from 'node:fs';
import path from 'node:path';
import { snapshotRealHomes, assertRealHomesUnchanged } from './real-home.mjs';
import { sandbox, tests } from './fixtures/packs-sandbox.mjs';

const realBefore = snapshotRealHomes();
const { ok, done } = tests();
const boxes = [];
const box = (...a) => { const b = sandbox(...a); boxes.push(b); return b; };
const partOf = (st, pack, part) => st.data.packs.find((p) => p.id === pack).parts.find((p) => p.id === part);

console.log('\nC6 the agent guard');
{
  const sb = box('guard', { clis: ['claude', 'codex'] });
  const settings = path.join(sb.home, '.claude/settings.json');
  const original = '{\n  "theme": "dark"\n}\n';
  fs.writeFileSync(settings, original);
  const pre = sb.json(['status', '--no-trust-check']);
  ok('C6 before install the guard is "not installed"', partOf(pre, 'review-gate', 'agent-guard').statuses.join() === 'not installed');
  const p = sb.json(['install', 'review-gate', '--part', 'agent-guard', '--dry-run']);
  ok('C6 the preview names settings.json, the Codex home\'s hooks.json and config.toml', ['.claude/settings.json', '.codex/hooks.json', '.codex/config.toml'].every((f) => p.data.preview.some((r) => r.path.endsWith(f))), p.out);
  const r = sb.packs(['install', 'review-gate', '--part', 'agent-guard', '--yes']);
  const s = JSON.parse(sb.read(settings));
  ok('C6 install adds the guard hooks to Claude settings, keeping what was there', r.code === 0 && s.theme === 'dark' && s.hooks.PreToolUse.some((g) => g.matcher === 'Bash'), r.out);
  ok('C6 …and to the Codex home, with its trust block', /"\^Bash\$"/.test(sb.read(path.join(sb.env.CODEX_HOME, 'hooks.json'))) && /# review-gate agent guard begin/.test(sb.read(path.join(sb.env.CODEX_HOME, 'config.toml'))));
  const st = sb.json(['status']);
  const g = partOf(st, 'review-gate', 'agent-guard');
  ok('C6 status: claude active, codex active', g.harness.claude === 'active' && g.harness['codex ~/.codex'] === 'active' && g.statuses.join() === 'installed', JSON.stringify(g));
  const un = sb.json(['status'], { STUB_UNTRUSTED: '1' });
  const gu = partOf(un, 'review-gate', 'agent-guard');
  ok('C6 status: a Codex home whose hook is not trusted is "installed but not trusted"', gu.harness['codex ~/.codex'] === 'installed but not trusted' && gu.statuses.includes('installed but not working'), JSON.stringify(gu));
  fs.mkdirSync(sb.env.GROK_HOME, { recursive: true });
  fs.writeFileSync(path.join(sb.home, '.grok/config.toml'), '[compat.claude]\nhooks = false\n');
  const gk = partOf(sb.json(['status']), 'review-gate', 'agent-guard');
  ok('C6 a Grok compat setting that is off is reported loudly', gk.details.some((d) => /Grok ignores Claude hooks/.test(d)), JSON.stringify(gk));
  fs.rmSync(path.join(sb.home, '.grok'), { recursive: true });
  const u = sb.packs(['uninstall', 'review-gate', '--part', 'agent-guard', '--yes']);
  ok('C8 guard, unchanged since install: settings.json gets its exact pre-install bytes back', u.code === 0 && sb.read(settings) === original, `${u.out}\n${sb.read(settings)}`);
  ok('C8 …and the runtime goes with its last reference', !fs.existsSync(path.join(sb.home, '.agent-config-studio/review-gate')) && sb.state().runtime === null);
  // The edited branch.
  sb.packs(['install', 'review-gate', '--part', 'agent-guard', '--yes']);
  const edited = JSON.parse(sb.read(settings));
  edited.model = 'mine';
  fs.writeFileSync(settings, `${JSON.stringify(edited, null, 2)}\n`);
  const u2 = sb.packs(['uninstall', 'review-gate', '--part', 'agent-guard', '--yes']);
  const after = JSON.parse(sb.read(settings));
  ok('C8 guard, edited since install: your edit stays and only the guard entries go', u2.code === 0 && after.model === 'mine' && after.theme === 'dark' && !JSON.stringify(after).includes('agent-guard'), sb.read(settings));
  const sb2 = box('guard-claude', { clis: ['claude'] });
  const r2 = sb2.packs(['install', 'review-gate', '--part', 'agent-guard', '--yes']);
  ok('C6 on a Claude-only machine nothing is created for Codex', r2.code === 0 && !fs.existsSync(sb2.env.CODEX_HOME) && /agent-guard/.test(sb2.read(path.join(sb2.home, '.claude/settings.json'))), r2.out);
  const g2 = partOf(sb2.json(['status']), 'review-gate', 'agent-guard');
  ok('C6 …and status reports only the harness that is there', Object.keys(g2.harness).join() === 'claude' && g2.harness.claude === 'active', JSON.stringify(g2));
  ok('C6 …and the codex stub was never started', sb2.callsOf('codex').length === 0);
}

console.log('\nC6 Codex log access');
{
  const sb = box('logaccess', { clis: ['codex'], dirs: ['codex'] });
  const extra = path.join(sb.root, 'seat');
  fs.mkdirSync(extra);
  fs.mkdirSync(path.join(sb.home, '.agent-config-studio/review-gate'), { recursive: true });
  fs.writeFileSync(path.join(sb.home, '.agent-config-studio/review-gate/config.json'), JSON.stringify({ codexHomes: [extra] }));
  // The main config.toml is a link into a dotfiles folder: the real file gets the entry.
  const dot = path.join(sb.root, 'dotfiles');
  fs.mkdirSync(dot);
  const original = 'model = "x"\n\n[sandbox_workspace_write]\nnetwork_access = true\n';
  fs.writeFileSync(path.join(dot, 'config.toml'), original);
  fs.symlinkSync(path.join(dot, 'config.toml'), path.join(sb.env.CODEX_HOME, 'config.toml'));
  const root = path.join(sb.home, '.agent-config-studio/review-log');
  const r = sb.packs(['install', 'review-gate', '--part', 'codex-log-access', '--yes']);
  ok('C6 the entry lands in the real file behind the link, and the link stays a link', r.code === 0 && sb.read(path.join(dot, 'config.toml')).includes(`writable_roots = [${JSON.stringify(root)}]`) && fs.lstatSync(path.join(sb.env.CODEX_HOME, 'config.toml')).isSymbolicLink(), `${r.out}\n${sb.read(path.join(dot, 'config.toml'))}`);
  ok('C6 …and in each codexHomes entry from the review-gate config', sb.read(path.join(extra, 'config.toml')) === `[sandbox_workspace_write]\nwritable_roots = [${JSON.stringify(root)}]\n`, sb.read(path.join(extra, 'config.toml')));
  ok('C6 …with a backup of the existing file', fs.readdirSync(path.join(sb.home, '.agent-config-studio/backups')).length === 1);
  const st = partOf(sb.json(['status', '--no-trust-check']), 'review-gate', 'codex-log-access');
  ok('C6 status: installed', st.statuses.join() === 'installed', JSON.stringify(st));
  fs.writeFileSync(path.join(dot, 'config.toml'), sb.read(path.join(dot, 'config.toml')).replace(/writable_roots = \[[^\]]*\]\n/, ''));
  const st2 = partOf(sb.json(['status', '--no-trust-check']), 'review-gate', 'codex-log-access');
  ok('C6 status: an entry someone removed shows as not working', st2.statuses.includes('installed but not working'), JSON.stringify(st2));
  fs.writeFileSync(path.join(dot, 'config.toml'), original.replace('network_access = true\n', `writable_roots = [${JSON.stringify(root)}]\nnetwork_access = true\n`) + '\n[profile]\nname = "mine"\n');
  fs.writeFileSync(path.join(extra, 'config.toml'), `[sandbox_workspace_write]\nwritable_roots = [${JSON.stringify(root)}]\n`);
  const u = sb.packs(['uninstall', 'review-gate', '--yes']);
  ok('C8 log access, edited since install: only the writable_roots entry goes, the rest stays', u.code === 0 && sb.read(path.join(dot, 'config.toml')) === `${original}\n[profile]\nname = "mine"\n`, sb.read(path.join(dot, 'config.toml')));
  ok('C8 log access, unchanged since install: the file that did not exist is gone again', !fs.existsSync(path.join(extra, 'config.toml')));
  ok('C8 …and the link is still a link', fs.lstatSync(path.join(sb.env.CODEX_HOME, 'config.toml')).isSymbolicLink());
  sb.packs(['install', 'review-gate', '--part', 'codex-log-access', '--yes']);
  const u2 = sb.packs(['uninstall', 'review-gate', '--yes']);
  ok('C8 log access, unchanged: exact pre-install bytes back through the link', u2.code === 0 && sb.read(path.join(dot, 'config.toml')) === `${original}\n[profile]\nname = "mine"\n`);
  const sb2 = box('logaccess-claude', { clis: ['claude'] });
  const r2 = sb2.json(['install', 'review-gate', '--part', 'codex-log-access', '--dry-run']);
  ok('C6 with no Codex home the part is skipped and nothing would be written', r2.code === 0 && r2.data.notes.some((n) => /codex-log-access: .*skipped/.test(n)) && r2.data.preview.length === 0, r2.out);
}

console.log('\nC5 the push gate');
{
  const sb = box('pushgate', { clis: ['claude'] });
  const projects = path.join(sb.root, 'projects');
  fs.mkdirSync(projects);
  fs.mkdirSync(path.join(sb.home, '.agent-config-studio'), { recursive: true });
  fs.writeFileSync(path.join(sb.home, '.agent-config-studio/roots.json'), JSON.stringify({ version: 1, roots: [{ id: 'p', path: projects, label: 'P', access: 'edit' }] }));
  const original = sb.read(sb.gitconfig);
  // Another hook manager's global hooksPath: refused, with what to do, and nothing written.
  sb.git(sb.root, 'config', '--global', 'core.hooksPath', '/somewhere/husky');
  const refused = sb.packs(['install', 'review-gate', '--part', 'push-gate', '--yes']);
  ok('C5 a different global core.hooksPath refuses the install and says what to do', refused.code === 1 && /already sets core\.hooksPath = \/somewhere\/husky/.test(refused.out) && /git config --global --unset core\.hooksPath/.test(refused.out), refused.out);
  ok('C5 …and nothing was written', !fs.existsSync(path.join(sb.home, '.agent-config-studio/review-gate')) && /husky/.test(sb.read(sb.gitconfig)));
  fs.writeFileSync(sb.gitconfig, original);
  const r = sb.packs(['install', 'review-gate', '--part', 'push-gate', '--yes']);
  const hooks = path.join(sb.home, '.agent-config-studio/review-gate/hooks/global');
  ok('C5 install sets the global core.hooksPath to the runtime hooks', r.code === 0 && sb.git(sb.root, 'config', '--global', 'core.hooksPath').stdout.trim() === fs.realpathSync(hooks), r.out);
  const mk = (name) => {
    const repo = path.join(projects, name), remote = path.join(sb.root, `${name}.git`);
    fs.mkdirSync(repo);
    sb.git(repo, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'a.js'), 'x\n');
    sb.git(repo, 'add', '.'); sb.git(repo, 'commit', '-qm', 'one');
    sb.git(sb.root, 'init', '-q', '--bare', remote);
    sb.git(repo, 'remote', 'add', 'origin', remote);
    return repo;
  };
  const marker = path.join(sb.root, 'own-hooks');
  const own = (repo, name) => { fs.writeFileSync(path.join(repo, '.git/hooks', name), `#!/bin/sh\necho ${name} >> '${marker}'\n`, { mode: 0o755 }); };
  const plain = mk('plain');
  own(plain, 'pre-commit'); own(plain, 'pre-push');
  fs.writeFileSync(path.join(plain, 'b.js'), 'y\n'); sb.git(plain, 'add', '.');
  const c = sb.git(plain, 'commit', '-qm', 'two');
  const p = sb.git(plain, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
  ok('C5 an ordinary repo commits and pushes normally', c.code === 0 && p.code === 0, `${c.out}${p.out}`);
  ok('C5 …and its own executable pre-commit and pre-push still run', sb.read(marker) === 'pre-commit\npre-push\n', sb.read(marker));
  const gated = mk('gated');
  sb.git(gated, 'config', 'reviewgate.enabled', 'true');
  const refusedPush = sb.git(gated, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
  ok('C5 an opted-in repo refuses an unreviewed push', refusedPush.code !== 0 && /Push blocked/.test(refusedPush.out), refusedPush.out);
  const head = sb.git(gated, 'rev-parse', 'HEAD').stdout.trim();
  const log = path.join(sb.home, '.agent-config-studio/review-log/review-log.jsonl');
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.writeFileSync(log, [{ type: 'review', kind: 'review', id: 'fixture', head, family: 'fixture', model: 'fixture-only', findingDetails: [] }, { type: 'close', review: 'fixture', closeHead: head, status: 'complete', statuses: {} }].map((x) => JSON.stringify(x)).join('\n') + '\n');
  const closedPush = sb.git(gated, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
  ok('C5 …and lets a closed one through', closedPush.code === 0, closedPush.out);
  const wt = mk('wtproject');
  fs.writeFileSync(path.join(wt, '.worktrees.conf'), 'base=main\n');
  const wp = sb.git(wt, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
  ok('C5 a worktree project is not gated while the worktree-projects option is off', wp.code === 0, wp.out);
  const opt = sb.packs(['install', 'review-gate', '--part', 'push-gate-worktree-projects', '--yes']);
  fs.writeFileSync(path.join(wt, 'c.js'), 'z\n'); sb.git(wt, 'add', 'c.js'); sb.git(wt, 'commit', '-qm', 'more');
  const wp2 = sb.git(wt, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
  ok('C5 …and is gated once it is on', opt.code === 0 && wp2.code !== 0 && /Push blocked/.test(wp2.out), `${opt.out}\n${wp2.out}`);
  const husky = mk('husky');
  sb.git(husky, 'config', 'core.hooksPath', '.husky');
  const st = sb.json(['status', '--no-trust-check']);
  const pg = partOf(st, 'review-gate', 'push-gate');
  ok('C5 a repo with its own core.hooksPath shows as not gated in status', pg.notGated?.includes(husky) && pg.details.some((d) => /not gated: .*husky sets its own core\.hooksPath/.test(d)), JSON.stringify(pg));
  ok('C5 status: the hook works from env -i (no PATH): installed', pg.statuses.join() === 'installed', JSON.stringify(pg));
  const nodePath = path.join(sb.home, '.agent-config-studio/review-gate/hooks/node-path');
  fs.writeFileSync(nodePath, '/nonexistent/node\n');
  const pg2 = partOf(sb.json(['status', '--no-trust-check']), 'review-gate', 'push-gate');
  // Which node a hook finds with no PATH: git's own default PATH (its exec path plus the system folders).
  const bareNode = sb.run('/usr/bin/env', ['-i', `HOME=${sb.home}`, '/usr/bin/git', '-c', 'alias.n=!command -v node', 'n']).stdout.trim();
  if (bareNode) console.log(`  SKIP C5 broken node-path — git's bare PATH finds a node here (${bareNode}); NOT checked`);
  else ok('C5 status: when the hook cannot find node from env -i, it is installed but not working', pg2.statuses.includes('installed but not working') && pg2.details.some((d) => /env -i/.test(d)), JSON.stringify(pg2));
  // A pinned node that cannot run the hook (here: one that only fails) shows the same way on every machine.
  const broken = path.join(sb.root, 'broken-node');
  fs.writeFileSync(broken, '#!/bin/sh\necho "broken node" >&2\nexit 1\n', { mode: 0o755 });
  fs.writeFileSync(nodePath, `${broken}\n`);
  const pg3 = partOf(sb.json(['status', '--no-trust-check']), 'review-gate', 'push-gate');
  ok('C5 status: a hook that fails from env -i is installed but not working, with the reason', pg3.statuses.includes('installed but not working') && pg3.details.some((d) => /env -i/.test(d) && /broken node|Push blocked/.test(d)), JSON.stringify(pg3));
  fs.writeFileSync(nodePath, `${process.execPath}\n`);
  // Uninstall: exact bytes when unchanged (the option first, then the gate), surgical when edited.
  const u1 = sb.packs(['uninstall', 'review-gate', '--part', 'push-gate-worktree-projects', '--yes']);
  ok('C8 worktree-projects, unchanged: the global config gets its exact pre-option bytes', u1.code === 0 && !/worktreeProjects/.test(sb.read(sb.gitconfig)) && /hooksPath/.test(sb.read(sb.gitconfig)), sb.read(sb.gitconfig));
  const u2 = sb.packs(['uninstall', 'review-gate', '--yes']);
  ok('C8 push gate, unchanged: the global config gets its exact pre-install bytes back', u2.code === 0 && sb.read(sb.gitconfig) === original, `${u2.out}\n${sb.read(sb.gitconfig)}`);
  ok('C8 …and the runtime is gone with the last part', !fs.existsSync(path.join(sb.home, '.agent-config-studio/review-gate')));
  sb.packs(['install', 'review-gate', '--part', 'push-gate,push-gate-worktree-projects', '--yes']);
  sb.git(sb.root, 'config', '--global', 'alias.st', 'status');
  const u3 = sb.packs(['uninstall', 'review-gate', '--part', 'push-gate', '--yes']);
  const cfg = sb.read(sb.gitconfig);
  ok('C8 push gate, edited since install: only core.hooksPath and the option go; your alias stays', u3.code === 0 && /st = status/.test(cfg) && !/hooksPath/.test(cfg) && !/worktreeProjects/.test(cfg) && /name = Sandbox/.test(cfg), `${u3.out}\n${cfg}`);
  ok('C8 …and uninstalling the push gate took its worktree-projects option with it', /also removes review-gate\/push-gate-worktree-projects/.test(u3.out));
}

for (const b of boxes) b.cleanup();
assertRealHomesUnchanged(realBefore, ok);
done();
