import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { tempDir } from './fixtures/cleanup.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const models = JSON.parse(fs.readFileSync(path.join(ROOT, 'models.default.json'), 'utf8')).models;
const source = (harness) => fs.readFileSync(path.join(ROOT, `packs/build/skills/${harness}/build/SKILL.md`), 'utf8');

function snippet(skill, prefix) {
  const blocks = [...skill.matchAll(/^```bash\n([\s\S]*?)\n^```$/gm)]
    .map((match) => match[1]).filter((block) => block.startsWith(prefix));
  assert.equal(blocks.length, 1, prefix);
  return blocks[0];
}

const tools = ['model-id', 'codex', 'claude', 'ask-model'];
const resolver = path.join(ROOT, 'bin/model-id.mjs');
const strictShells = [
  { name: 'Bash', command: '/bin/bash', options: ['-euo', 'pipefail'] },
  { name: 'zsh', command: '/bin/zsh', options: ['-f', '-euo', 'pipefail'] },
];
function fixture({ command = '/bin/bash', options = ['-e'] } = {}) {
  const root = fs.realpathSync(tempDir('acs-builder-skill-'));
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  const work = path.join(root, 'fixture worktree');
  const brief = path.join(work, 'phase brief.md');
  const plan = path.join(work, 'plan.md');
  const log = path.join(root, 'calls.jsonl');
  const review = path.join(bin, 'review.cjs');
  const roles = path.join(home, '.agent-config-studio', 'roles.json');
  for (const dir of [path.dirname(roles), bin, work]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(roles, JSON.stringify({
    version: 2,
    roles: { builder: { use: ['neon', { family: 'opus', effort: 'xhigh' }, { family: 'sol', effort: 'high' }], alt: 'terra' } },
  }));
  fs.writeFileSync(brief, 'Check the brief with spaces.\nSecond line.');
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  for (const tool of [...tools, 'review.cjs']) {
    fs.writeFileSync(path.join(bin, tool), `#!${process.execPath}
const fs = require('node:fs');
const [,, ...args] = process.argv;
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({tool:${JSON.stringify(tool)}, args, author:process.env.REVIEW_AUTHOR}) + '\\n');
if (${JSON.stringify(tool)} === 'model-id') {
  const responses = JSON.parse(process.env.MODEL_ID_FIXTURES || '{}');
  if (Object.hasOwn(responses, args[0])) {
    const response = responses[args[0]];
    fs.writeSync(1, response.stdout ?? '');
    fs.writeSync(2, response.stderr ?? '');
    process.exit(response.status);
  }
  if (args[0] !== '--pick' || process.env.REAL_PICK === '1') {
    const result = require('node:child_process').spawnSync(process.execPath, [${JSON.stringify(resolver)}, ...args], {stdio:'inherit'});
    process.exit(result.status ?? 1);
  }
  if (process.env.OLD_PICK === '1') {
    console.error('usage: model-id <family|raw-id>');
    console.log('MODEL-ID-UNRESOLVED---pick');
    process.exit(1);
  }
  console.log(process.env.PICK_FIXTURE);
  process.exit(JSON.parse(process.env.PICK_FIXTURE).error ? 2 : 0);
}
if (${JSON.stringify(tool)} === 'ask-model') {
  if (process.env.PARTIAL_BUILD === '1') {
    fs.writeFileSync('partial.txt', 'edits before a generic error');
    process.exit(4);
  }
  console.log(JSON.stringify({build:{execution:'native',completed:true},served:{verified:false}}));
}
`, { mode: 0o755 });
  }
  const env = {
    HOME: home,
    PATH: [bin, '/usr/bin', '/bin'].join(':'),
    BRIEF_FILE: brief,
    PHASE_RESULT: path.join(work, 'result.md'),
    REVIEW_SCRIPT: review,
    PLAN_FILE: plan,
    REVIEW_INTENT: 'Review the fixture phase',
  };
  const git = spawnSync('git', ['init', '--quiet', work], { env, encoding: 'utf8' });
  assert.equal(git.status, 0, git.stderr);

  function run(script, extra = {}, { cwd = work } = {}) {
    const shell = spawnSync(command, [...options, '-c', script], { cwd, env: { ...env, ...extra }, encoding: 'utf8', timeout: 10000 });
    assert.equal(shell.error, undefined, String(shell.error));
    return shell;
  }
  function calls(tool) {
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
    return calls.filter((call) => call.tool === tool);
  }
  function saveOwner(record) {
    fs.writeFileSync(plan, `# Fixture plan\n\n## Builder\n\n\`\`\`json\n${record}\n\`\`\`\n`);
    return fs.readFileSync(plan, 'utf8').match(/^```json\n([^\n]+)/m)[1];
  }
  return { work, brief, home, roles, run, calls, saveOwner };
}

const packet = (family, effort) => JSON.stringify({
  role: 'builder', mode: 'random', selectedBy: 'random', family, id: models[family], effort,
  effortSource: 'member', reason: 'uniform draw from eligible builders',
  eligible: ['neon', 'opus', 'sol'], skipped: [], usage: [],
});
const picks = (f) => f.calls('model-id').filter(({ args }) => args[0] === '--pick').map(({ args }) => args);
const flag = (argv, name) => argv[argv.indexOf(name) + 1];
const modelIdFixtures = (responses) => ({ MODEL_ID_FIXTURES: JSON.stringify(responses) });

for (const harness of ['codex', 'claude']) {
  const skill = source(harness);
  const pick = snippet(skill, 'builder_lineup_state() {');
  const override = snippet(skill, 'BUILDER_RECORD=$(jq -ce --arg effort');
  const restore = snippet(skill, 'BUILDER=$(jq -er');
  const availability = snippet(skill, 'if [ "$BUILDER_LINEUP_STATE" = paused ]');
  const review = snippet(skill, 'REVIEW_AUTHOR="$BUILDER"');
  const neon = snippet(skill, 'WORKTREE=$(git rev-parse');
  const prepare = `EXCLUDED=()\n${pick}`;
  const printRecord = 'printf "%s\\n" "$BUILDER_RECORD"';
  const native = harness === 'codex' ? 'Codex' : 'Claude';
  const cli = harness === 'codex' ? 'claude' : 'codex';
  const family = harness === 'codex' ? 'opus' : 'sol';
  const effort = harness === 'codex' ? 'xhigh' : 'high';
  const claudeDispatch = harness === 'codex' ? snippet(skill, 'if [ "${#CLAUDE_BASH_RULES[@]}" -eq 0 ]; then') : null;
  const cliDispatch = harness === 'codex'
    ? [snippet(skill, 'CLAUDE_BASH_RULES=('), claudeDispatch].join('\n')
    : [snippet(skill, 'EFFORT_FLAG=()'), snippet(skill, 'codex exec --skip-git-repo-check')].join('\n');
  const resumeDispatch = harness === 'codex'
    ? cliDispatch
    : [snippet(skill, 'EFFORT_FLAG=()'), snippet(skill, 'codex exec resume')].join('\n');
  const session = harness === 'codex' ? { CLAUDE_SESSION_ID: 'phase-worker-id' } : { THREAD_ID: 'phase-worker-id' };

  function checkTaskOwner(shell) {
    const f = fixture(shell);
    const picked = f.run(`${prepare}\n${printRecord}`, modelIdFixtures({
      '--pick': { status: 0, stdout: packet(family, effort) + '\n\n', stderr: 'picker diagnostic\n' },
    }));
    assert.equal(picked.status, 0, picked.stderr);
    assert.equal(picked.stderr, 'picker diagnostic\n');
    const record = f.saveOwner(picked.stdout.trim());
    assert.deepEqual(JSON.parse(record), { ...JSON.parse(packet(family, effort)), operatorNamed: false });
    const dispatch = (body, extra) => f.run(`${prepare}\n${restore}\n${availability}\n${body}\n${review}`, {
      BUILDER_RECORD: record,
      PICK_FIXTURE: packet('neon', 'medium'),
      ...extra,
    });
    // These are separate shell invocations loading the same plan, even when the
    // picker would now return a different family. Stubs exercise argv only.
    for (const [label, body, extra] of [
      ['first phase', cliDispatch],
      ['fresh later phase', cliDispatch],
      ['unfinished phase resume', resumeDispatch, session],
      ['fix', cliDispatch],
    ]) {
      const result = dispatch(body, extra);
      assert.equal(result.status, 0, `${label}: ${result.stderr}`);
    }
    assert.deepEqual(picks(f), [['--pick', 'builder', '--json']]);
    const workerCalls = f.calls(cli);
    assert.equal(workerCalls.length, 4);
    for (const [index, { args }] of workerCalls.entries()) {
      assert.equal(flag(args, cli === 'codex' ? '-m' : '--model'), models[family]);
      assert.equal(flag(args, cli === 'codex' ? '-c' : '--effort'), cli === 'codex' ? `model_reasoning_effort=${effort}` : effort);
      assert.ok(args.includes('Check the brief with spaces.\nSecond line.'));
      assert.equal(args.includes('phase-worker-id'), index === 2);
      if (cli === 'codex') assert.equal(args.includes('workspace-write'), index !== 2);
      else {
        const rules = args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--permission-mode'));
        assert.deepEqual(rules, [
          'Bash(node --test phase.test.mjs)', 'Bash(git add -- outcome.txt)', 'Bash(git commit -m builder-permission-smoke)',
        ]);
        assert.equal(flag(args, '--permission-mode'), 'acceptEdits');
        assert.ok(args.includes('--strict-mcp-config'));
        assert.equal(flag(args, '--mcp-config'), '{"mcpServers":{}}');
      }
    }
    assert.deepEqual(f.calls('review.cjs').map(({ author }) => author), [family, family, family, family]);
    assert.match(skill, new RegExp(`native ${native} subagent on the recorded model and effort`));
    assert.match(skill, /fresh worker.+phase|phase boundary/);
  }

  for (const shell of strictShells) {
    const scope = `${harness} with strict ${shell.name}`;
    test(`${scope}: one picked non-first family owns fresh phases, resume, fixes and review`, () => checkTaskOwner(shell));

    if (harness === 'claude') {
      test(`${scope}: empty resolved effort is omitted for fresh and resumed Codex dispatch`, () => {
        const f = fixture(shell);
        fs.writeFileSync(f.roles, JSON.stringify({
          version: 2, roles: { builder: { use: [family] } },
        }));
        const picked = f.run(`${prepare}\n${printRecord}`, { REAL_PICK: '1' });
        assert.equal(picked.status, 0, picked.stderr);
        const record = f.saveOwner(picked.stdout.trim());
        const owner = JSON.parse(record);
        assert.equal(owner.family, family);
        assert.equal(owner.effort, '');

        const dispatch = `${prepare}\n${restore}\n${availability}\n`;
        const fresh = f.run(dispatch + cliDispatch, { BUILDER_RECORD: record });
        const resumed = f.run(dispatch + resumeDispatch, { BUILDER_RECORD: record, ...session });
        assert.deepEqual([fresh.status, resumed.status], [0, 0], `fresh: ${fresh.stderr}resume: ${resumed.stderr}`);

        const output = ['-o', path.join(f.work, 'result.md'), fs.readFileSync(f.brief, 'utf8')];
        assert.deepEqual(f.calls('codex').map(({ args }) => args), [
          ['exec', '--skip-git-repo-check', '--sandbox', 'workspace-write', '-m', models[family], '--json', ...output],
          ['exec', 'resume', session.THREAD_ID, '--skip-git-repo-check', '-m', models[family], ...output],
        ]);
        assert.deepEqual(picks(f), [['--pick', 'builder', '--json']]);
      });
    }

    test(`${scope}: one and two exclusions preserve picker argument boundaries`, () => {
      const f = fixture(shell);
      for (const assignment of ['EXCLUDED=("one family")', 'EXCLUDED=("one family" other)']) {
        const result = f.run(`${assignment}\n${pick}\n${printRecord}`, { PICK_FIXTURE: packet(family, effort) });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(JSON.parse(result.stdout).family, family);
      }
      assert.deepEqual(picks(f), [
        ['--pick', 'builder', '--json', '--exclude', 'one family'],
        ['--pick', 'builder', '--json', '--exclude', 'one family', '--exclude', 'other'],
      ]);
    });

    test(`${scope}: picker failures never dispatch even with success-shaped stdout`, () => {
      const f = fixture(shell);
      const noEligible = JSON.stringify({ role: 'builder', error: 'no eligible builder' });
      const cases = [
        [2, noEligible, 2, noEligible + '\n'],
        [7, packet(family, effort), 7, packet(family, effort) + '\n'],
        [7, '{"role":"builder"', 2, 'Builder picker unavailable. Run acs install-model-id.\n'],
      ];
      for (const [pickerStatus, stdout, status, stderr] of cases) {
        const result = f.run(`${prepare}\n${restore}\n${availability}\n${cliDispatch}\n${review}`, modelIdFixtures({
          '--pick': { status: pickerStatus, stdout, stderr: 'picker diagnostic\n' },
        }));
        assert.equal(result.status, status, result.stderr);
        assert.equal(result.stdout, '');
        assert.equal(result.stderr, 'picker diagnostic\n' + stderr);
      }
      assert.deepEqual(picks(f), cases.map(() => ['--pick', 'builder', '--json']));
      assert.deepEqual(f.calls(cli), []);
      assert.deepEqual(f.calls('review.cjs'), []);
    });

    test(`${scope}: named effort bypasses lookup and default effort uses the builder without its alt`, () => {
      const f = fixture(shell);
      const report = JSON.stringify({ roles: { builder: { use: [family] }, advisor: { error: 'no eligible advisor' } } });
      const named = f.run(`${prepare}\n${printRecord}`, {
        NAMED_BUILDER: family,
        NAMED_EFFORT: 'medium',
        ...modelIdFixtures({ '--roles': { status: 2, stdout: report } }),
      });
      assert.equal(named.status, 0, named.stderr);
      assert.equal(JSON.parse(named.stdout).effort, 'medium');
      const inferred = f.run(`${prepare}\n${printRecord}`, { NAMED_BUILDER: family });
      assert.equal(inferred.status, 0, inferred.stderr);
      assert.equal(JSON.parse(inferred.stdout).effort, effort);
      const failed = f.run(`${prepare}\n${restore}\n${availability}\n${cliDispatch}\n${review}`, {
        NAMED_BUILDER: family,
        ...modelIdFixtures({ '--effort': { status: 7, stdout: 'medium\n', stderr: 'effort lookup failed\n' } }),
      });
      assert.equal(failed.status, 2, failed.stderr);
      assert.equal(failed.stdout, '');
      assert.equal(failed.stderr, 'effort lookup failed\n');
      assert.deepEqual(f.calls('model-id').map(({ args }) => args), [
        ['--roles', '--json'], [family],
        ['--roles', '--json'], [family], ['--effort', family, '--role', 'builder', '--no-alt'],
        ['--roles', '--json'], [family], ['--effort', family, '--role', 'builder', '--no-alt'],
      ]);
      assert.deepEqual(f.calls(cli), []);
      assert.deepEqual(f.calls('review.cjs'), []);
    });

    test(`${scope}: an empty or malformed role report rejects a named builder`, () => {
      const f = fixture(shell);
      for (const stdout of ['', '{"roles":{"builder":']) {
        const result = f.run(`${prepare}\n${restore}\n${availability}\n${cliDispatch}\n${review}`, {
          NAMED_BUILDER: family,
          ...modelIdFixtures({ '--roles': { status: 2, stdout } }),
        });
        assert.equal(result.status, 2, result.stderr);
        assert.equal(result.stdout, '');
        assert.match(result.stderr, /member of the configured builder lineup/);
      }
      assert.deepEqual(f.calls('model-id').map(({ args }) => args), [['--roles', '--json'], ['--roles', '--json']]);
      assert.deepEqual(f.calls(cli), []);
      assert.deepEqual(f.calls('review.cjs'), []);
    });
  }

  test(`${harness}: explicit builder in lineup wins, including while paused; effort override persists`, () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.home, '.agent-config-studio', 'paused.json'), JSON.stringify({
      version: 1, paused: ['neon', 'sol', 'opus'].map((name) => ({ name })),
    }));
    const named = f.run(`${prepare}\n${override}\n${printRecord}`, {
      NAMED_BUILDER: family, NAMED_EFFORT: 'medium', EFFORT_OVERRIDE: 'medium',
    });
    assert.equal(named.status, 0, named.stderr);
    const record = f.saveOwner(named.stdout.trim());
    assert.deepEqual(JSON.parse(record), {
      family, id: models[family], effort: 'medium', effortOverride: 'medium',
      mode: 'explicit', reason: 'operator named this builder', operatorNamed: true,
    });
    const resumed = f.run(`${prepare}\n${restore}\n${availability}\n${cliDispatch}\n${review}`, { BUILDER_RECORD: record });
    assert.equal(resumed.status, 0, resumed.stderr);
    const args = f.calls(cli)[0].args;
    assert.equal(flag(args, cli === 'codex' ? '-c' : '--effort'), cli === 'codex' ? 'model_reasoning_effort=medium' : 'medium');
    assert.equal(f.calls('review.cjs')[0].author, family);

    const alt = f.run(`${prepare}\n${restore}\n${availability}\n${cliDispatch}`, { NAMED_BUILDER: 'terra' });
    assert.equal(alt.status, 2);
    assert.match(alt.stderr, /member of the configured builder lineup/);
    assert.deepEqual(f.calls('model-id').map(({ args }) => args), [
      ['--roles', '--json'], [family], ['--roles', '--json'], [family], ['--roles', '--json'],
    ]);
    assert.equal(f.calls(cli).length, 1, 'an alt is never dispatched');
  });

  test(`${harness}: a reloaded record must match the lineup and current registry before dispatch or review`, () => {
    const f = fixture();
    const saved = { ...JSON.parse(packet(family, effort)), operatorNamed: false };
    const crossVendorId = models[harness === 'codex' ? 'sol' : 'opus'];
    const invalid = [
      [{ family: 'terra', id: models.terra }, /outside the configured builder lineup/],
      [{ id: crossVendorId }, /does not match the current registry/],
      [{ effort: 'medium\n' }, /effort is invalid/],
      [{ operatorNamed: 'true' }, /selection is invalid/],
      [{ operatorNamed: true }, /selection is invalid/],
    ];
    for (const [patch, diagnostic] of invalid) {
      const reloaded = f.run(`${prepare}\n${restore}\n${availability}\n${cliDispatch}\n${review}`, {
        BUILDER_RECORD: f.saveOwner(JSON.stringify({ ...saved, ...patch })),
      });
      assert.equal(reloaded.status, 2);
      assert.match(reloaded.stderr, diagnostic);
    }
    assert.deepEqual(picks(f), [], 'invalid saved records do not cause a fresh pick');
    assert.deepEqual(f.calls(cli), []);
    assert.deepEqual(f.calls('review.cjs'), []);
  });

  test(`${harness}: a paused automatic owner cannot dispatch or gain an explicit override`, () => {
    const f = fixture();
    const picked = f.run(`${prepare}\n${printRecord}`, { PICK_FIXTURE: packet(family, effort) });
    assert.equal(picked.status, 0, picked.stderr);
    const record = f.saveOwner(picked.stdout.trim());
    fs.writeFileSync(path.join(f.home, '.agent-config-studio', 'paused.json'), JSON.stringify({
      version: 1, paused: [{ name: family }],
    }));
    const paused = f.run(`${prepare}\n${restore}\n${availability}\n${cliDispatch}`, { BUILDER_RECORD: record });
    assert.equal(paused.status, 2);
    assert.match(paused.stderr, /automatic builder is paused/);
    assert.deepEqual(f.calls(cli), []);
    assert.deepEqual(picks(f), [['--pick', 'builder', '--json']], 'pause stops this dispatch before any replacement pick');

    const reviewed = f.run(`${prepare}\n${restore}\n${review}`, { BUILDER_RECORD: record });
    assert.equal(reviewed.status, 0, reviewed.stderr);
    assert.equal(f.calls('review.cjs')[0].author, family, 'the earlier work retains its author');
  });

  if (harness === 'codex') {
    test('codex: strict Bash starts and resumes Claude without empty arguments', () => {
      const f = fixture();
      const cases = [
        ['', undefined, []],
        ['medium', undefined, ['--effort', 'medium']],
        ['', 'phase-worker-id', ['--resume', 'phase-worker-id']],
        ['medium', 'phase-worker-id', ['--effort', 'medium', '--resume', 'phase-worker-id']],
      ];
      for (const [effort, sessionId] of cases) {
        const result = f.run(`set -euo pipefail\n${cliDispatch}`, {
          BUILDER_ID: models[family],
          EFFORT: effort,
          ...(sessionId ? { CLAUDE_SESSION_ID: sessionId } : {}),
        });
        assert.equal(result.status, 0, result.stderr);
      }
      assert.deepEqual(f.calls('claude').map(({ args }) => args), cases.map(([, , flags]) => [
        '-p', 'Check the brief with spaces.\nSecond line.', '--model', models[family],
        ...flags, '--allowedTools',
        'Bash(node --test phase.test.mjs)', 'Bash(git add -- outcome.txt)', 'Bash(git commit -m builder-permission-smoke)',
        '--permission-mode', 'acceptEdits', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--output-format', 'json',
      ]));
    });

    test('codex: headless Claude dispatch requires scoped Bash rules from the phase brief', () => {
      const f = fixture();
      const saved = { ...JSON.parse(packet(family, effort)), operatorNamed: false };
      const missing = f.run(`${prepare}\n${restore}\n${availability}\n${claudeDispatch}`, {
        BUILDER_RECORD: JSON.stringify(saved),
      });
      assert.equal(missing.status, 2);
      assert.match(missing.stderr, /headless builder Bash rules from the phase brief/);
      assert.deepEqual(f.calls('claude'), []);
    });
  }

  test(`${harness}: --design is explicit and the optional task summary is one argument`, () => {
    const f = fixture();
    for (const [decision, summary] of [['true', f.brief], ['false', '']]) {
      const result = f.run(`${prepare}\n${printRecord}`, {
        NEW_VISUAL_DESIGN: decision, TASK_SUMMARY: summary, PICK_FIXTURE: packet(family, effort),
      });
      assert.equal(result.status, 0, result.stderr);
    }
    assert.deepEqual(picks(f), [
      ['--pick', 'builder', '--json', '--design', '--task-file', f.brief],
      ['--pick', 'builder', '--json'],
    ]);
    assert.match(skill, /Frontend logic, implementation of a settled design, backend and database work use the regular strategy/);
  });

  test(`${harness}: legacy picker fails with the upgrade command before any dispatch`, () => {
    const f = fixture();
    const stale = f.run(`${prepare}\n${restore}\n${availability}\n${cliDispatch}`, { OLD_PICK: '1' });
    assert.equal(stale.status, 2);
    assert.match(stale.stderr, /acs install-model-id/);
    assert.deepEqual(picks(f), [['--pick', 'builder', '--json']]);
    assert.deepEqual(f.calls(cli), []);
  });

  test(`${harness}: Neon uses the canonical worktree, saved effort and explicit family`, () => {
    const f = fixture();
    const nested = path.join(f.work, 'nested');
    fs.mkdirSync(nested);
    const result = f.run(`${prepare}\n${restore}\n${availability}\n${neon}\n${review}`, {
      BUILDER_RECORD: JSON.stringify({ ...JSON.parse(packet('neon', '')), operatorNamed: false }),
    }, { cwd: nested });
    assert.equal(result.status, 0, result.stderr);
    const [call] = f.calls('ask-model');
    assert.deepEqual(call.args, ['--family', 'neon', '--build', '--cwd', f.work, '--effort', '', '--prompt-file', f.brief, '--json']);
    assert.equal(f.calls('review.cjs')[0].author, 'neon');
    assert.match(skill, /served\.verified: false/);
  });

  test(`${harness}: replacement uses cumulative exclusions and stops on the real picker's exhaustion`, () => {
    const f = fixture();
    const pickWith = (excluded) => f.run(`EXCLUDED=(${excluded.join(' ')})\n${pick}\n${printRecord}`, { REAL_PICK: '1' });
    const first = pickWith([]);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(JSON.parse(first.stdout).family, 'neon');

    // Generic errors may follow edits. The orchestration choice to inspect
    // and hand them off is in the skill; this is the shell-side consequence.
    const failed = f.run(`${prepare}\n${restore}\n${availability}\n${neon}`, {
      BUILDER_RECORD: first.stdout.trim(), PARTIAL_BUILD: '1',
    });
    assert.equal(failed.status, 4);
    assert.equal(fs.readFileSync(path.join(f.work, 'partial.txt'), 'utf8'), 'edits before a generic error');
    assert.deepEqual(picks(f), [['--pick', 'builder', '--json']], 'the generic error does not repick');
    assert.match(skill, /Generic errors, timeouts and cancellation can leave edits/);
    assert.match(skill, /Hand off completed commits, checks and results, remaining work and any partial changes \(including untracked files\)/);
    assert.match(skill, /confirmed pause, quota limit or startup failure before replacing/);

    const second = pickWith(['neon']);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(JSON.parse(second.stdout).family, 'opus');
    const third = pickWith(['neon', 'opus']);
    assert.equal(third.status, 0, third.stderr);
    assert.equal(JSON.parse(third.stdout).family, 'sol');
    const exhausted = pickWith(['neon', 'opus', 'sol']);
    assert.equal(exhausted.status, 2);
    assert.match(exhausted.stderr, /no eligible builder/);
    assert.match(exhausted.stderr, /explicitly excluded/);
    assert.doesNotMatch(exhausted.stderr, /acs install-model-id/);
    assert.deepEqual(picks(f), [
      ['--pick', 'builder', '--json'],
      ['--pick', 'builder', '--json', '--exclude', 'neon'],
      ['--pick', 'builder', '--json', '--exclude', 'neon', '--exclude', 'opus'],
      ['--pick', 'builder', '--json', '--exclude', 'neon', '--exclude', 'opus', '--exclude', 'sol'],
    ]);
  });
}
