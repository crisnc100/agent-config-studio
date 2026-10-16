/**
 * The skill wizard, one skill for every harness (builds/skill-wizard, all
 * harnesses): the Where step's defaults (installed harnesses on, the shared
 * folder off, the Codex/shared overlap), a name taken in one destination,
 * and Create writing the same bytes to each with per-destination results and
 * a Retry that creates only what is missing. In-process against a temp HOME
 * with stubbed CLI detection, then the two changed routes through a real
 * server with a stub `codex` on PATH. No model is called.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshotRealHomes, assertRealHomesUnchanged } from './real-home.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const realBefore = snapshotRealHomes();
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acs-wizard-multi-')));
const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acs-wizard-multi-out-')));
process.env.HOME = home;
process.env.ACS_SUITE = 'offline';
delete process.env.CODEX_HOME;

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const put = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
const exists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };
const read = (f) => fs.readFileSync(f, 'utf8');
const draftFor = (name, body = 'Do the thing.') => `---\nname: ${name}\ndescription: Releases a build. Use when the user says "cut a release".\n---\n\n${body}\n`;

const projects = path.join(home, 'Projects');
const studio = path.join(home, '.agent-config-studio');
put(path.join(studio, 'roots.json'), JSON.stringify({ version: 1, roots: [{ id: 'projects', label: 'Projects', access: 'edit', path: projects }] }));
put(path.join(studio, 'setup.json'), JSON.stringify({ completed: 'done', at: new Date().toISOString() }));
const repoA = path.join(projects, 'repo-a');
const repoB = path.join(projects, 'repo-b');
fs.mkdirSync(path.join(repoA, '.git'), { recursive: true });
fs.mkdirSync(path.join(repoA, '.codex'), { recursive: true });
fs.mkdirSync(path.join(repoB, '.git'), { recursive: true });
put(path.join(home, '.claude', 'skills', 'ship', 'SKILL.md'), draftFor('ship'));

const W = await import('../lib/skill-wizard.js');
const { listProjects } = await import('../lib/skills.js');
await (await import('../lib/history.js')).ensureRepo();
const scripted = { info: () => ({ ready: true }), start: () => { throw new Error('no model in this suite'); } };
const recorded = [];
const hist = { record: async (real, msg) => { recorded.push({ real, msg }); return 'sha-' + recorded.length; } };
const pid = (real) => listProjects().find((p) => p.real === real).id;

try {
  console.log('\nwhere: what is checked by default');
  {
    const t = W.wizardTargets({ installed: () => true });
    const g = Object.fromEntries(t.global.map((x) => [x.key, x]));
    ok('both CLIs found → Claude and Codex checked, both enabled', g.claude.on && g.codex.on && g.claude.installed && g.codex.installed && g.claude.available && g.codex.available);
    ok('the shared ~/.agents/skills is offered but not checked', g.shared.available && g.shared.installed && g.shared.on === false);
    const d = Object.fromEntries(t.dirInfo.map((x) => [x.dir, x]));
    ok('project folders: .claude and .codex checked, .agents not', d['.claude'].on && d['.codex'].on && d['.agents'].on === false && d['.agents'].installed);
    ok('the old fields are unchanged: three folders, all available, dirs as before', t.global.map((x) => x.key).join() === 'claude,codex,shared' && t.global.every((x) => x.available) && t.dirs.join() === '.claude,.codex,.agents');
    const ov = t.overlaps.find((o) => o.global.includes('codex') && o.global.includes('shared'));
    ok('the Codex/shared overlap is named, for global and project folders', !!ov && ov.dirs.join() === '.codex,.agents' && /Codex loads this skill twice/.test(ov.why));
  }
  {
    const t = W.wizardTargets({ installed: () => false });
    const g = Object.fromEntries(t.global.map((x) => [x.key, x]));
    ok('Codex not detected and no ~/.codex → not installed, unchecked, with the reason', !exists(path.join(home, '.codex')) && g.codex.installed === false && g.codex.on === false && /Codex is not installed: no codex CLI was found and there is no ~\/\.codex/.test(g.codex.why));
    ok('…while a Claude whose ~/.claude exists still counts, CLI or not', g.claude.installed && g.claude.on && g.claude.why === null);
    const d = Object.fromEntries(t.dirInfo.map((x) => [x.dir, x]));
    ok('…and the project .codex folder follows: unchecked with the reason', d['.codex'].installed === false && d['.codex'].on === false && /Codex is not installed/.test(d['.codex'].why) && d['.claude'].on);
    const t2 = W.wizardTargets({ installed: (id) => id === 'codex' });
    ok('a codex CLI with no ~/.codex yet → Codex checked', t2.global.find((x) => x.key === 'codex').on === true);
  }

  console.log('\nwhere: the name must be free in every checked place');
  {
    const dests = [{ scope: 'global', key: 'claude' }, { scope: 'global', key: 'codex' }];
    const pv = W.previewTarget({ dests, name: 'ship' });
    ok('one result per destination, each with its exact path', pv.targets.length === 2 && pv.targets[0].display === '~/.claude/skills/ship/SKILL.md' && pv.targets[1].display === '~/.codex/skills/ship/SKILL.md');
    ok('taken in ~/.claude only: that one is named taken, the other free', pv.targets[0].taken === true && pv.targets[1].taken === false);
    const free = W.previewTarget({ dests, name: 'release' });
    ok('a new name is free in both', free.targets.every((x) => x.taken === false));
    ok('the single-destination shape still answers as before', JSON.stringify(W.previewTarget({ dest: dests[0], name: 'ship' })) === '{"display":"~/.claude/skills/ship/SKILL.md","taken":true}');
    const err = (f) => { try { f(); return null; } catch (e) { return e; } };
    ok('no destination → refused', err(() => W.previewTarget({ dests: [], name: 'x' }))?.status === 400);
    ok('the same destination twice → refused', /picked twice/.test(err(() => W.previewTarget({ dests: [dests[0], dests[0]], name: 'x' }))?.message || ''));
    ok('a bad destination in the list → refused', err(() => W.previewTarget({ dests: [dests[0], { scope: 'global', key: 'ssh' }], name: 'x' }))?.status === 400);
  }

  console.log('\ncreate: the same bytes to every checked place');
  {
    const wz = W.createSkillWizard({ backend: scripted, hist });
    const content = draftFor('release', 'Tag, build, publish.');
    const r = await wz.create({ dests: [{ scope: 'global', key: 'claude' }, { scope: 'global', key: 'codex' }], name: 'release', content });
    ok('both created, in order', r.results.length === 2 && r.results.every((x) => x.ok && x.created) && r.results[0].display === '~/.claude/skills/release/SKILL.md' && r.results[1].display === '~/.codex/skills/release/SKILL.md');
    ok('…byte for byte the reviewed SKILL.md, in each', read(path.join(home, '.claude', 'skills', 'release', 'SKILL.md')) === content && read(path.join(home, '.codex', 'skills', 'release', 'SKILL.md')) === content);
    ok('…~/.codex created on the way', fs.statSync(path.join(home, '.codex', 'skills')).isDirectory());
    ok('history records each', recorded.length === 2 && /create ~\/\.claude\/skills\/release/.test(recorded[0].msg) && /create ~\/\.codex\/skills\/release/.test(recorded[1].msg) && r.results.every((x, i) => x.sha === `sha-${i + 1}`));
    const bad = await wz.create({ dests: [{ scope: 'global', key: 'claude' }, { scope: 'global', key: 'shared' }], name: 'nulled', content: '---\nname: nulled\ndescription: null\n---\nbody\n' }).catch((e) => e);
    ok('a SKILL.md that does not validate is refused once, before any write', bad.status === 422 && !exists(path.join(home, '.claude', 'skills', 'nulled')) && !exists(path.join(home, '.agents')));
  }
  {
    // Project mode: .claude and .codex in a repo that has neither.
    const wz = W.createSkillWizard({ backend: scripted, hist });
    const content = draftFor('lint-all');
    const r = await wz.create({ dests: [{ scope: 'project', project: pid(repoB), dir: '.claude' }, { scope: 'project', project: pid(repoB), dir: '.codex' }], name: 'lint-all', content });
    ok('project: .claude/skills and .codex/skills both created where there were none', r.results.every((x) => x.ok && x.created) && read(path.join(repoB, '.claude', 'skills', 'lint-all', 'SKILL.md')) === content && read(path.join(repoB, '.codex', 'skills', 'lint-all', 'SKILL.md')) === content);
    ok('…shown at their exact paths', r.results.map((x) => x.display).join() === '~/Projects/repo-b/.claude/skills/lint-all/SKILL.md,~/Projects/repo-b/.codex/skills/lint-all/SKILL.md');
  }
  {
    // Partial failure: .codex/skills in repo-a is a link out; .claude is fine.
    fs.mkdirSync(path.join(outside, 'elsewhere'));
    fs.symlinkSync(path.join(outside, 'elsewhere'), path.join(repoA, '.codex', 'skills'));
    const wz = W.createSkillWizard({ backend: scripted, hist });
    const content = draftFor('partial');
    const dests = [{ scope: 'project', project: pid(repoA), dir: '.claude' }, { scope: 'project', project: pid(repoA), dir: '.codex' }];
    const before = recorded.length;
    const r = await wz.create({ dests, name: 'partial', content });
    ok('one refused, the other created: per-destination results', r.results[0].ok && r.results[0].created && r.results[1].ok === false && r.results[1].status === 403 && r.results[1].display === '~/Projects/repo-a/.codex/skills/partial/SKILL.md' && !!r.results[1].error, JSON.stringify(r.results[1]));
    ok('…the created one stays, nothing was written through the link', read(path.join(repoA, '.claude', 'skills', 'partial', 'SKILL.md')) === content && fs.readdirSync(path.join(outside, 'elsewhere')).length === 0);
    ok('…and history records only the one created', recorded.length === before + 1);
    fs.unlinkSync(path.join(repoA, '.codex', 'skills'));
    const again = await wz.create({ dests: [dests[1]], name: 'partial', content, retry: true });
    ok('Retry with only the failed one creates just it', again.results.length === 1 && again.results[0].created && read(path.join(repoA, '.codex', 'skills', 'partial', 'SKILL.md')) === content && recorded.length === before + 2);
    const all = await wz.create({ dests, name: 'partial', content, retry: true });
    ok('a Retry that re-sends both: the existing ones come back "already created", nothing rewritten', all.results.every((x) => x.ok && x.alreadyCreated && !x.created) && recorded.length === before + 2);
    const other = await wz.create({ dests, name: 'partial', content: draftFor('partial', 'different'), retry: true });
    ok('…other bytes at the same name are still collisions, at each', other.results.every((x) => !x.ok && x.status === 409));
  }

  console.log('\nthe routes: strict same-origin, both shapes');
  {
    const { startServer } = await import('./fixtures/roots-home.mjs');
    const bin = path.join(home, 'bin');
    put(path.join(bin, 'codex'), '#!/bin/sh\necho "codex-cli 0.0.0"\n');
    fs.chmodSync(path.join(bin, 'codex'), 0o755);
    fs.rmSync(path.join(home, '.codex'), { recursive: true, force: true });
    const srv = await startServer(home, { root: ROOT, env: { PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`, TMPDIR: os.tmpdir() } });
    const call = async (method, route, body, headers = {}) => {
      const r = await fetch(`${srv.base}${route}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await r.text();
      let json = null;
      try { json = JSON.parse(text); } catch {}
      return { status: r.status, body: json, text };
    };
    try {
      const info = (await call('GET', '/api/skill-wizard')).body;
      const codex = info.targets.global.find((g) => g.key === 'codex');
      ok('a codex CLI on PATH (no ~/.codex) → Codex installed and checked', codex.installed === true && codex.on === true);
      const dests = [{ scope: 'global', key: 'claude' }, { scope: 'global', key: 'codex' }];
      for (const [route, body] of [['/api/skill-wizard/target', { dests, name: 'x' }], ['/api/skill-wizard/create', { dests, name: 'evil', content: draftFor('evil') }]]) {
        const r = await call('POST', route, body, { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' });
        ok(`a foreign origin: POST ${route} with dests → 403`, r.status === 403);
      }
      ok('…and nothing was written', !exists(path.join(home, '.claude', 'skills', 'evil')) && !exists(path.join(home, '.codex')));
      const pv = await call('POST', '/api/skill-wizard/target', { dests, name: 'ship' });
      ok('target with dests answers per destination', pv.status === 200 && pv.body.targets.map((x) => x.taken).join() === 'true,false');
      const content = draftFor('routed');
      const cr = await call('POST', '/api/skill-wizard/create', { dests, name: 'routed', content });
      ok('create with dests writes each, through the server', cr.status === 200 && cr.body.results.every((x) => x.ok && x.created) && read(path.join(home, '.claude', 'skills', 'routed', 'SKILL.md')) === content && read(path.join(home, '.codex', 'skills', 'routed', 'SKILL.md')) === content);
    } finally { await srv.stop?.(); }
  }
} finally {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
}

assertRealHomesUnchanged(realBefore, ok);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
