#!/usr/bin/env node
/**
 * Criterion 2's oracle: what the three review scripts actually hand to the CLIs.
 *
 *   node builds/model-registry/inspect-scripts.mjs <out.json> [--home-file <models.json>]
 *
 * The scripts do not expose their lens list, so rather than change them this runs
 * each one for real against a throwaway git repo with stub `codex` and `claude`
 * binaries first on PATH. The stubs record their argv and return one canned
 * finding, which is what makes the verifier leaf run. Nothing reaches a model.
 *
 * Every scenario runs twice: with the live HOME (live configs) and with an empty
 * temp HOME (no configs). --home-file drops a registry user file into the temp
 * HOME instead — that is criterion 4's one-edit proof.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REAL_HOME = process.env.HOME || os.homedir();
const SKILLS = path.join(REAL_HOME, '.claude', 'skills');

export const SCRIPTS = {
  'review.mjs': path.join(SKILLS, 'code-review', 'review.mjs'),
  'review-loop.mjs': path.join(SKILLS, 'deep-review', 'review-loop.mjs'),
  'review-loop-claude.mjs': path.join(SKILLS, 'deep-review', 'review-loop-claude.mjs'),
};

export const SCENARIOS = {
  'review.mjs': [
    { name: 'default', env: {} },
    { name: 'claude-team', env: { REVIEW_REVIEWER: 'claude' } },
    { name: 'claude-fable-solo', env: { REVIEW_REVIEWER: 'claude', REVIEW_CLAUDE_MODEL: 'claude-fable-5-1' } },
  ],
  'review-loop.mjs': [
    { name: 'default', env: {}, args: ['--dry-run'] },
    { name: 'fixer-claude', env: { REVIEW_FIXER: 'claude' }, args: ['--dry-run'] },
  ],
  'review-loop-claude.mjs': [
    { name: 'default', env: {}, args: ['--dry-run'] },
    { name: 'fable-solo', env: { REVIEW_CLAUDE_MODEL: 'claude-fable-5-1' }, args: ['--dry-run'] },
  ],
};

const FINDING = { severity: 'high', issue: 'stub finding', file: 'a.txt', line: '1', suggestion: null };

function writeStubs(dir, log) {
  const node = process.execPath;
  const common = `const fs=require('fs');fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({bin:process.argv[1].split('/').pop(),argv:process.argv.slice(2)})+'\\n');`;
  fs.writeFileSync(path.join(dir, 'codex'),
    `#!${node}\n${common}const a=process.argv.slice(2);const o=a.indexOf('-o');` +
    `if(o!==-1)fs.writeFileSync(a[o+1],JSON.stringify({findings:[${JSON.stringify(FINDING)}]}));\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'claude'),
    `#!${node}\n${common}process.stdout.write(JSON.stringify({is_error:false,result:JSON.stringify({findings:[${JSON.stringify(FINDING)}]})}));\n`,
    { mode: 0o755 });
}

function gitRepo(dir, env) {
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: dir, env, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  };
  git('init', '-q', '-b', 'base');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  git('add', '-A'); git('commit', '-q', '-m', 'base');
  git('checkout', '-q', '-b', 'feature');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\n');
  git('add', '-A'); git('commit', '-q', '-m', 'change');
}

function summarize(calls, stdout) {
  const out = [];
  for (const { bin, argv } of calls) {
    if (bin === 'codex') {
      const c = argv.filter((_, i) => argv[i - 1] === '-c');
      const model = c.find((x) => x.startsWith('model='))?.slice(6) ?? null;
      const effort = c.find((x) => x.startsWith('model_reasoning_effort='))?.split('=')[1] ?? null;
      out.push({ bin, role: argv.includes('workspace-write') ? 'fixer' : 'codex', model, effort });
    } else {
      const at = (flag) => { const i = argv.indexOf(flag); return i === -1 ? null : argv[i + 1]; };
      const sys = at('--append-system-prompt') || '';
      const lens = sys.match(/precise (\S+) code reviewer/)?.[1] ?? null;
      out.push({ bin, role: lens ? `lens:${lens}` : 'verifier', model: at('--model'), effort: at('--effort') });
    }
  }
  out.sort((a, b) => `${a.bin}${a.role}`.localeCompare(`${b.bin}${b.role}`));
  const labels = stdout.split('\n').filter((l) => /^(▶|fixer:)/.test(l)).map((l) => l.replace(/ · (feature|base).*$/, ''));
  return { calls: out, labels };
}

export function inspect({ homeFile = null, modelIdDir = path.join(REAL_HOME, '.local', 'bin'), homes = ['live', 'none'] } = {}) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-inspect-'));
  const results = {};
  try {
    const stubs = path.join(work, 'stubs');
    fs.mkdirSync(stubs);
    const log = path.join(work, 'calls.jsonl');
    writeStubs(stubs, log);
    const PATH = [stubs, modelIdDir, path.dirname(process.execPath), '/usr/bin', '/bin'].join(':');
    for (const which of homes) {
      let home = REAL_HOME;
      if (which !== 'live') {
        home = fs.mkdtempSync(path.join(work, 'home-'));
        if (homeFile) {
          fs.mkdirSync(path.join(home, '.agent-config-studio'), { recursive: true });
          fs.copyFileSync(homeFile, path.join(home, '.agent-config-studio', 'models.json'));
        }
      }
      for (const [script, list] of Object.entries(SCENARIOS)) {
        if (!fs.existsSync(SCRIPTS[script])) continue;
        for (const sc of list) {
          const repo = fs.mkdtempSync(path.join(work, 'repo-'));
          const env = {
            PATH, HOME: home, TMPDIR: os.tmpdir(), REVIEW_BASE: 'base',
            GIT_AUTHOR_NAME: 'x', GIT_AUTHOR_EMAIL: 'x@x', GIT_COMMITTER_NAME: 'x', GIT_COMMITTER_EMAIL: 'x@x',
            GIT_CONFIG_NOSYSTEM: '1', ...sc.env,
          };
          gitRepo(repo, env);
          fs.writeFileSync(log, '');
          const r = spawnSync(process.execPath, [SCRIPTS[script], ...(sc.args || [])], {
            cwd: repo, env, encoding: 'utf8', timeout: 60_000,
          });
          const calls = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
          const entry = { exit: r.status, ...summarize(calls, r.stdout || '') };
          if (script === 'review.mjs') {
            const show = spawnSync(process.execPath, [SCRIPTS[script], '--show-config'], { cwd: repo, env, encoding: 'utf8' });
            try {
              const j = JSON.parse(show.stdout);
              entry.showConfig = { reviewer: j.reviewer, model: j.model, effort: j.effort, claudeModel: j.claudeModel };
            } catch { entry.showConfig = { error: show.stdout + show.stderr }; }
          }
          if (r.status !== 0 && r.status !== 2) entry.stderr = (r.stderr || '').slice(-800);
          results[`${which}/${script}/${sc.name}`] = entry;
        }
      }
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
  return results;
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const outPath = process.argv[2];
  const hf = process.argv.indexOf('--home-file');
  const res = inspect({ homeFile: hf === -1 ? null : process.argv[hf + 1] });
  const body = JSON.stringify({ capturedAt: new Date().toISOString(), scenarios: res }, null, 2) + '\n';
  if (outPath) fs.writeFileSync(outPath, body); else process.stdout.write(body);
  const bad = Object.entries(res).filter(([, v]) => v.exit !== 0 && v.exit !== 2);
  console.error(`${Object.keys(res).length} scenarios${bad.length ? `, ${bad.length} FAILED: ${bad.map(([k]) => k).join(', ')}` : ''}`);
  if (bad.length) process.exit(1);
}
