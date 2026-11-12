#!/usr/bin/env node
/**
 * review.skills.test.mjs — the shipped skills' model commands, run as written. Code blocks are taken from each
 * SKILL.md, their placeholders filled in, and run in bash (and zsh when the machine has it). The skills ask through
 * this package's own ask-model, which runs stub CLIs that record their arguments, so what is checked is the argv
 * the model CLI finally gets. model-id is this package's own resolver on a temp HOME, so its output has the real
 * shapes, fresh defaults included. jq is the system's, as the skills' commands use it. No real model is called.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, beforeEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const PACKS = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const PACKAGE = resolve(PACKS, '..')
const ROOT = mkdtempSync(join(tmpdir(), 'review-skills-test-'))
const HOME = join(ROOT, 'home'), BIN = join(ROOT, 'bin'), ARGV = join(ROOT, 'argv'), WORK = join(ROOT, 'work')
const J = JSON.stringify
after(() => rmSync(ROOT, { recursive: true, force: true }))

const put = (path, body, mode) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, body)
  if (mode) chmodSync(path, mode)
}
put(join(BIN, 'model-id'), `#!/bin/sh\nexec ${J(process.execPath)} ${J(join(PACKAGE, 'bin/model-id.mjs'))} "$@"\n`, 0o755)
put(join(BIN, 'ask-model'), `#!/bin/sh\nexec ${J(process.execPath)} ${J(join(PACKAGE, 'tools/ask-model.mjs'))} "$@"\n`, 0o755)
// ask-model's MCP checks (codex mcp list, grok inspect) find no server and are not recorded; every other call is,
// and answers the way ask-model accepts, naming the model it was given.
for (const name of ['claude', 'codex', 'grok'])
  put(join(BIN, name), `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path')
const a = process.argv.slice(2)
if (${J(name)} === 'codex' && a[0] === 'mcp') { console.log('[]'); process.exit(0) }
if (${J(name)} === 'grok' && a[0] === 'inspect') { console.log(JSON.stringify({ mcpServers: [], plugins: [] })); process.exit(0) }
const seq = fs.readdirSync(${J(ARGV)}).length
fs.writeFileSync(path.join(${J(ARGV)}, '${name}-' + String(seq).padStart(3, '0') + '.json'), JSON.stringify(a))
const model = a[a.indexOf(${J(name)} === 'claude' ? '--model' : '-m') + 1]
console.log(${J(name)} === 'codex' ? 'stub answer' : JSON.stringify({ type: 'result', is_error: false, result: 'stub answer', text: 'stub answer', modelUsage: { [model]: {} } }))
`, 0o755)
// jq is linked in by itself, never its folder, which may hold real model CLIs.
const jq = String(process.env.PATH || '').split(':').filter((dir) => dir.startsWith('/')).map((dir) => join(dir, 'jq')).find((path) => existsSync(path))
if (jq) symlinkSync(jq, join(BIN, 'jq'))
const PATH = [BIN, '/usr/bin', '/bin'].join(':')
const SHELLS = ['/bin/bash', '/bin/zsh'].filter((shell) => existsSync(shell))
const { models } = JSON.parse(readFileSync(join(PACKAGE, 'models.default.json'), 'utf8'))

beforeEach(() => {
  for (const path of [HOME, WORK]) rmSync(path, { recursive: true, force: true })
  mkdirSync(HOME, { recursive: true }); mkdirSync(WORK, { recursive: true })
  put(join(HOME, '.claude/skills/advisor/advisor-contract.md'), 'THE CONTRACT')
  put(join(HOME, '.codex/skills/advisor/advisor-contract.md'), 'THE CONTRACT')
  for (const harness of ['claude', 'codex']) put(join(HOME, `.${harness}/skills/build/grade.schema.json`), readFileSync(join(PACKS, 'build/skills', harness, 'build/grade.schema.json'), 'utf8'))
  // A roles.json from before roles were chosen at install: the shipped roles fill every role it leaves out.
  put(join(HOME, '.agent-config-studio/roles.json'), J({ version: 1 }))
})

const skill = (path) => readFileSync(join(PACKS, path), 'utf8')
/** Every fenced code block of a markdown file, its fence indentation removed. */
function blocks(markdown) {
  return [...markdown.matchAll(/^([ \t]*)```[a-z]*\n([\s\S]*?)\n\1```$/gm)]
    .map(([, indent, body]) => body.split('\n').map((line) => (line.startsWith(indent) ? line.slice(indent.length) : line)).join('\n'))
}
function block(markdown, pattern) {
  const found = blocks(markdown).filter((body) => pattern.test(body))
  assert.equal(found.length, 1, `exactly one code block matches ${pattern}`)
  return found[0]
}
const fill = (code, values = {}) =>
  Object.entries({ '<slug>': 's', '<N>': '2', '<thread_id>': 'thread-1', '<absolute path>': WORK, '<absolute path of the folder holding advisor-brief.md>': WORK, ...values })
    .reduce((text, [placeholder, value]) => text.split(placeholder).join(value), code)
const roles = (doc) => {
  rmSync(join(HOME, '.agent-config-studio'), { recursive: true, force: true })
  put(join(HOME, '.agent-config-studio/roles.json'), J({ version: 1, ...doc }))
}

/** Runs the snippet in a shell; returns each stub CLI's recorded argv, in call order. */
function run(shell, script) {
  rmSync(ARGV, { recursive: true, force: true }); mkdirSync(ARGV)
  const file = join(ROOT, 'snippet.sh')
  writeFileSync(file, script)
  const r = spawnSync(shell, [file], { cwd: WORK, env: { HOME, PATH, TMPDIR: ROOT }, encoding: 'utf8', timeout: 30_000 })
  assert.equal(r.error, undefined, String(r.error))
  assert.doesNotMatch(r.stderr, /jq: error|command not found|bad substitution|parse error|unknown (role|model family)/, `${shell}:\n${r.stderr}`)
  const calls = { claude: [], codex: [], grok: [] }
  for (const name of readdirSync(ARGV).sort()) calls[name.split('-')[0]].push(JSON.parse(readFileSync(join(ARGV, name), 'utf8')))
  return calls
}
/** The effort an argv passes: its value, null when the flag is left out. An empty value is returned as ''. */
function effortIn(cli, argv) {
  if (cli === 'codex') {
    const setting = argv.find((a) => a.startsWith('model_reasoning_effort'))
    if (setting !== undefined) assert.equal(argv[argv.indexOf(setting) - 1], '-c', argv.join(' '))
    return setting === undefined ? null : setting.replace(/^model_reasoning_effort=?/, '')
  }
  const flag = cli === 'claude' ? '--effort' : '--reasoning-effort'
  return argv.includes(flag) ? argv[argv.indexOf(flag) + 1] ?? '' : null
}
const modelIn = (cli, argv) => argv[argv.indexOf(cli === 'claude' ? '--model' : '-m') + 1]
/** The CLI an id runs on: its prefix, the rule ask-model uses. */
const cliOf = (id) => ({ claude: 'claude', gpt: 'codex', grok: 'grok' })[id.split('-')[0]]
/** The one model call a snippet made: on `cli`, and on no other CLI. */
function onlyCall(calls, cli, label) {
  for (const name of ['claude', 'codex', 'grok']) assert.equal(calls[name].length, name === cli ? 1 : 0, `${label}: ${name} calls`)
  return calls[cli][0]
}

test('fixture: bash, the stub CLIs, model-id and jq are on the test PATH', () => {
  assert.ok(SHELLS.includes('/bin/bash'), 'bash runs the skills\' snippets')
  assert.ok(jq, 'jq is on PATH: the skills\' commands use it')
  const r = spawnSync('/bin/sh', ['-c', 'model-id --role builder --json | jq -r .role'], { env: { HOME, PATH }, encoding: 'utf8' })
  assert.equal(r.stdout.trim(), 'builder', r.stderr)
})

// ── build: each gate reads its own prompt; the builder's effort is never empty ──
test('build (codex): the Bounce runs on bounce-prompt.md and the Grade on grade-prompt.md, each on its role\'s model', () => {
  const codexSkill = skill('build/skills/codex/build/SKILL.md')
  const setup = block(codexSkill, /^GATE=bounce/m)
  const asks = block(codexSkill, /^ask-model --role advisor/m).split('\n')
  assert.doesNotMatch(codexSkill, /cat builds\/<slug>\/grade-prompt\.md/, 'no gate reads the Grade prompt by a fixed name')
  // Fresh defaults, then roles that put the two gates on the other two CLIs.
  for (const doc of [null, { roles: { advisor: { use: ['sol'] }, judge: { use: ['grok'] } } }]) {
    roles(doc)
    for (const shell of SHELLS) {
      for (const [gate, role, own, other] of [['bounce', 'advisor', 'THE BOUNCE PROMPT', 'THE GRADE PROMPT'], ['grade', 'judge', 'THE GRADE PROMPT', 'THE BOUNCE PROMPT']]) {
        put(join(WORK, 'builds/s/bounce-prompt.md'), 'THE BOUNCE PROMPT')
        put(join(WORK, 'builds/s/grade-prompt.md'), 'THE GRADE PROMPT')
        const id = models[JSON.parse(spawnSync(join(BIN, 'model-id'), ['--role', role, '--json'], { env: { HOME, PATH }, encoding: 'utf8' }).stdout).family]
        const ask = asks.find((line) => line.includes(`--role ${role} `))
        assert.match(ask, new RegExp(`# GATE=${gate}$`), `the ${role} line is the ${gate}`)
        const argv = onlyCall(run(shell, `${fill(setup.replace(/^GATE=bounce/m, `GATE=${gate}`))}\n${fill(ask)}\n`), cliOf(id), `${shell} ${gate} ${J(doc)}`)
        assert.ok(argv.includes(own), `${shell} ${gate} sends its own prompt: ${argv.join(' ')}`)
        assert.ok(!argv.includes(other), `${shell} ${gate} never sends the other gate's prompt`)
        assert.equal(modelIn(cliOf(id), argv), id, `${shell} ${gate} runs the ${role} role's model`)
      }
    }
  }
})

test('build (claude): its gates send their own prompt files through ask-model, so the Bounce cannot get the Grade\'s', () => {
  const claudeSkill = skill('build/skills/claude/build/SKILL.md')
  assert.doesNotMatch(claudeSkill, /\$\(cat [^)]*-prompt\.md/)
  const asks = block(claudeSkill, /^ask-model --role advisor/m).split('\n')
  for (const doc of [null, { roles: { advisor: { use: ['sol'] }, judge: { use: ['grok'] } } }]) {
    roles(doc)
    for (const shell of SHELLS) {
      for (const [gate, role, own, other] of [['Bounce', 'advisor', 'THE BOUNCE PROMPT', 'THE GRADE PROMPT'], ['Grade', 'judge', 'THE GRADE PROMPT', 'THE BOUNCE PROMPT']]) {
        put(join(WORK, 'builds/s/bounce-prompt.md'), 'THE BOUNCE PROMPT')
        put(join(WORK, 'builds/s/grade-prompt.md'), 'THE GRADE PROMPT')
        const id = models[JSON.parse(spawnSync(join(BIN, 'model-id'), ['--role', role, '--json'], { env: { HOME, PATH }, encoding: 'utf8' }).stdout).family]
        const ask = asks.find((line) => line.startsWith(`ask-model --role ${role} `))
        assert.match(ask, new RegExp(`# ${gate}$`), `the ${role} line is the ${gate}`)
        const argv = onlyCall(run(shell, `${fill(ask)}\n`), cliOf(id), `${shell} ${gate} ${J(doc)}`)
        assert.ok(argv.includes(own) && !argv.includes(other), `${shell} ${gate} sends its own prompt only: ${argv.join(' ')}`)
        assert.equal(modelIn(cliOf(id), argv), id, `${shell} ${gate} runs the ${role} role's model`)
      }
    }
  }
})

test('build (claude): both builder calls take the builder\'s effort from its role, else its flavor, and never pass it empty', () => {
  const claudeSkill = skill('build/skills/claude/build/SKILL.md')
  const setup = block(claudeSkill, /^BUILDER=<family>/m)
  const effort = block(claudeSkill, /EFFORT_FLAG=\(\)/)
  const phase1 = block(claudeSkill, /--sandbox workspace-write/)
  const resume = block(claudeSkill, /^codex exec resume/m)
  const memberEffort = { roles: { builder: { use: [{ family: 'opus', effort: 'xhigh' }, 'sol'] } } }
  const cases = [
    ['fresh defaults: the first builder family takes the role effort', null, 'opus', '', 'medium'],
    ['fresh defaults: the second builder family takes the role effort too', null, 'sol', '', 'medium'],
    ['a member effort in the role wins', memberEffort, 'opus', '', 'xhigh'],
    ['the other member keeps the role effort', memberEffort, 'sol', '', 'medium'],
    ['a role effort beats the flavor effort', { flavor: { sol: { effort: 'low' } } }, 'sol', '', 'medium'],
    ['no role effort: a later member takes its flavor effort', { roles: { builder: { effort: null } }, flavor: { sol: { effort: 'high' } } }, 'sol', '', 'high'],
    ['no role effort and no flavor effort: the flag is left out', { roles: { builder: { effort: null } } }, 'sol', '', null],
    ['a family outside the role takes its flavor effort', { flavor: { terra: { effort: 'low' } } }, 'terra', '', 'low'],
    ['a family outside the role with no flavor effort: the flag is left out', null, 'terra', '', null],
    ['an effort the user named wins', null, 'sol', 'max', 'max'],
  ]
  for (const shell of SHELLS) {
    for (const [label, doc, family, named, expected] of cases) {
      roles(doc)
      const script = [fill(setup, { '<family>': family, '<effort>': named }), effort, fill(phase1), fill(resume)].join('\n')
      const { codex } = run(shell, `${script}\n`)
      assert.equal(codex.length, 2, `${shell} ${label}: phase 1 and the resume`)
      for (const argv of codex) {
        assert.equal(effortIn('codex', argv), expected, `${shell} ${label}: ${argv.join(' ')}`)
        assert.equal(modelIn('codex', argv), models[family], `${shell} ${label}`)
      }
    }
  }
})

// ── second-opinion and advisor: a role member's effort from its role, any other family's from its flavor ──
/** The family's one model call, on its id's CLI, at the expected effort (null: no effort flag). Returns its argv. */
function expectEfforts(shell, label, calls, family, expected) {
  const cli = cliOf(models[family])
  const argv = onlyCall(calls, cli, `${shell} ${label}`)
  assert.equal(effortIn(cli, argv), expected, `${shell} ${label}: ${cli} ${argv.join(' ')}`)
  assert.equal(modelIn(cli, argv), models[family], `${shell} ${label}: ${cli} model`)
  return argv
}

for (const harness of ['claude', 'codex']) {
  test(`second-opinion (${harness}): each family's effort comes from its role, else its flavor; none set leaves the flag out`, () => {
    const body = skill(`second-opinion/skills/${harness}/second-opinion/SKILL.md`)
    assert.doesNotMatch(body, /effort with `model-id --flavor <family>`/)
    // The block resolves the effort and asks; the test writes the prompt into the file it names, as the skill says.
    const ask = block(body, /^family=<family>/m).replace(/^ask-model /m, `printf 'THE PROMPT' > "$PROMPT_FILE"\nask-model `)
    const cases = [
      ['fresh defaults: the advisor role family', null, 'fable', 'high'],
      ['fresh defaults: the advisor role second opinion', null, 'astra', 'high'],
      ['fresh defaults: a family in no role, with no flavor effort', null, 'opus', null],
      ['a reviewer member effort', { roles: { reviewer: { use: ['astra', { family: 'grok', effort: 'xhigh' }] } } }, 'grok', 'xhigh'],
      ['a later reviewer family takes the role effort over its flavor', { roles: { reviewer: { use: ['astra', 'sol'], effort: 'medium' } }, flavor: { sol: { effort: 'low' } } }, 'sol', 'medium'],
      ['a later reviewer family with no role effort takes its flavor', { roles: { reviewer: { use: ['astra', 'sol'], effort: null } }, flavor: { sol: { effort: 'low' } } }, 'sol', 'low'],
      ['the second opinion\'s own effort', { roles: { advisor: { alt: { family: 'astra', effort: 'xhigh' } } } }, 'astra', 'xhigh'],
      ['a family in no role takes its flavor effort', { flavor: { terra: { effort: 'max' } } }, 'terra', 'max'],
      ['no effort anywhere: the flag is left out', { roles: { advisor: { effort: null } } }, 'fable', null],
    ]
    for (const shell of SHELLS) {
      for (const [label, doc, family, expected] of cases) {
        roles(doc)
        const argv = expectEfforts(shell, label, run(shell, `${fill(ask, { '<family>': family })}\n`), family, expected)
        assert.ok(argv.includes('THE PROMPT'), `${shell} ${label}: the prompt file is what the model gets`)
      }
    }
  })

  test(`advisor (${harness}): advisor, second and a named family each get their own effort; none set leaves the flag out`, () => {
    const body = skill(`advisor/skills/${harness}/advisor/SKILL.md`)
    assert.doesNotMatch(body, /effort from `model-id --flavor <family>`\)/)
    const invoke = block(body, /^METHOD=advisor/m)
    const own = { roles: { advisor: { use: [{ family: 'fable', effort: 'max' }], alt: { family: 'astra', effort: 'medium' } } } }
    const cases = [
      ['fresh defaults: advisor', null, 'advisor', 'fable', 'high'],
      ['fresh defaults: second', null, 'second', 'astra', 'high'],
      ['fresh defaults: a named family with no flavor effort', null, 'opus', 'opus', null],
      ['a named family with a flavor effort', { flavor: { opus: { effort: 'low' } } }, 'opus', 'opus', 'low'],
      ['advisor with its own member effort', own, 'advisor', 'fable', 'max'],
      ['second with its own effort', own, 'second', 'astra', 'medium'],
      ['no effort anywhere: the flag is left out', { roles: { advisor: { effort: null } } }, 'advisor', 'fable', null],
    ]
    for (const shell of SHELLS) {
      for (const [label, doc, method, family, expected] of cases) {
        roles(doc)
        const calls = run(shell, `${fill(invoke).replace(/^METHOD=advisor/m, `METHOD=${method}`)}\n`)
        const argv = expectEfforts(shell, label, calls, family, expected)
        assert.ok(argv.some((a) => a.includes('THE CONTRACT')), `${shell} ${label}: the contract is in the prompt`)
      }
    }
  })
}

// ── build: the Grade on the advisor role's second opinion, when the grader swap picks it ──
for (const harness of ['claude', 'codex']) {
  test(`build (${harness}): the swapped Grade runs the second opinion at its effort, and with none set passes no --effort`, () => {
    const body = skill(`build/skills/${harness}/build/SKILL.md`)
    const swap = block(body, /^ask-model --second --role advisor/m)
    // The codex copy's command reads $PROMPT_FILE, which its gate setup sets for GATE=grade.
    const setup = harness === 'codex' ? `${fill(block(body, /^GATE=bounce/m).replace(/^GATE=bounce/m, 'GATE=grade'))}\n` : ''
    const cases = [
      ['fresh defaults: the second opinion\'s own effort', null, 'high'],
      ['no effort set for the second opinion: no --effort at all', { roles: { advisor: { effort: null } } }, null],
    ]
    for (const shell of SHELLS) {
      for (const [label, doc, expected] of cases) {
        roles(doc)
        put(join(WORK, 'builds/s/bounce-prompt.md'), 'THE BOUNCE PROMPT')
        put(join(WORK, 'builds/s/grade-prompt.md'), 'THE GRADE PROMPT')
        const role = JSON.parse(spawnSync(join(BIN, 'model-id'), ['--role', 'advisor', '--json'], { env: { HOME, PATH }, encoding: 'utf8' }).stdout)
        assert.equal(role.altEffort, expected ?? '', `${label}: the roles give this altEffort`)
        const id = models[role.alt]
        const argv = onlyCall(run(shell, `${setup}${fill(swap)}\n`), cliOf(id), `${shell} ${label}`)
        assert.equal(effortIn(cliOf(id), argv), expected, `${shell} ${label}: ${argv.join(' ')}`)
        assert.equal(modelIn(cliOf(id), argv), id, `${shell} ${label}: the second opinion's model`)
        assert.ok(argv.includes('THE GRADE PROMPT') && !argv.includes('THE BOUNCE PROMPT'), `${shell} ${label}: the Grade's prompt only`)
      }
    }
  })
}

// ── the advisor's second opinion with no effort set asks the way build's swapped Grade does ──
for (const harness of ['claude', 'codex']) {
  test(`advisor (${harness}): the second opinion with no effort set passes no --effort, the same as build's swapped Grade`, () => {
    const advisor = fill(block(skill(`advisor/skills/${harness}/advisor/SKILL.md`), /^METHOD=advisor/m).replace(/^METHOD=advisor/m, 'METHOD=second'))
    const build = skill(`build/skills/${harness}/build/SKILL.md`)
    const gradeSetup = harness === 'codex' ? `${fill(block(build, /^GATE=bounce/m).replace(/^GATE=bounce/m, 'GATE=grade'))}\n` : ''
    const grade = `${gradeSetup}${fill(block(build, /^ask-model --second --role advisor/m))}`
    // ask-model's own argv, as the skill passed it: an empty --effort and no --effort look the same to the CLI.
    const asked = join(ROOT, 'ask-model.argv')
    const record = `ask-model() { printf '%s\\0' "$@" > ${J(asked)}; command ask-model "$@"; }\n`
    roles({ roles: { advisor: { effort: null } } })   // build's case: no effort set for the second opinion
    const role = JSON.parse(spawnSync(join(BIN, 'model-id'), ['--role', 'advisor', '--json'], { env: { HOME, PATH }, encoding: 'utf8' }).stdout)
    assert.equal(role.altEffort, '', 'no own, role or flavor effort: the resolver gives an empty altEffort')
    for (const shell of SHELLS) {
      const result = {}
      for (const [name, script] of [['advisor', advisor], ['build', grade]]) {
        put(join(WORK, 'builds/s/bounce-prompt.md'), 'THE BOUNCE PROMPT')
        put(join(WORK, 'builds/s/grade-prompt.md'), 'THE GRADE PROMPT')
        rmSync(asked, { force: true })
        const argv = expectEfforts(shell, `${name}: no effort set for the second opinion`, run(shell, `${record}${script}\n`), role.alt, null)
        const askArgv = readFileSync(asked, 'utf8').split('\0').slice(0, -1)
        result[name] = { askModelEffort: askArgv.includes('--effort') ? askArgv[askArgv.indexOf('--effort') + 1] : null, cliEffort: effortIn(cliOf(models[role.alt]), argv) }
      }
      assert.deepEqual(result.advisor, { askModelEffort: null, cliEffort: null }, `${shell}: the advisor passes no --effort at all, not an empty one`)
      assert.deepEqual(result.advisor, result.build, `${shell}: the advisor's second opinion asks as build's swapped Grade does`)
    }
  })
}

// ── the shared effort rule gives the answers the skills' own jq gave before it (39fc63d) ──
// The second-opinion skill's lookup as it was, the oracle: the family's effort in the advisor role, else the reviewer
// role, else (ask-model with no --effort) its flavor effort.
const OLD_SECOND_OPINION_EFFORT = `role_effort() {
  model-id --role "$1" --json | jq -r --arg f "$2" '
    [(.members // [])[] | select(.family == $f) | .effort][0]
    // (if .alt == $f then .altEffort
        elif .family == $f or ((.provenance.effort == "default" or .provenance.effort == "user") and any(.use[]; . == $f))
        then .effort else null end) // empty'
}
effort=$(role_effort advisor "$family"); [ -n "$effort" ] || effort=$(role_effort reviewer "$family")
[ -n "$effort" ] || effort=$(model-id --flavor "$family" --json | jq -r '.flavor.effort // empty')
printf '%s' "$effort"`
for (const harness of ['claude', 'codex']) {
  test(`second-opinion (${harness}): --effort-from gives the effort the old jq gave, a cleared advisor effort included`, () => {
    const ask = block(skill(`second-opinion/skills/${harness}/second-opinion/SKILL.md`), /^family=<family>/m).replace(/^ask-model /m, `printf 'THE PROMPT' > "$PROMPT_FILE"\nask-model `)
    const cases = [
      [null, ['fable', 'astra', 'opus', 'sol', 'terra']],
      [{ roles: { reviewer: { use: ['astra', { family: 'grok', effort: 'xhigh' }] } } }, ['grok', 'astra']],
      [{ roles: { reviewer: { use: ['astra', 'sol'], effort: 'medium' } }, flavor: { sol: { effort: 'low' } } }, ['sol', 'astra']],
      [{ roles: { reviewer: { use: ['astra', 'sol'], effort: null } }, flavor: { sol: { effort: 'low' } } }, ['sol', 'astra']],
      [{ roles: { advisor: { alt: { family: 'astra', effort: 'xhigh' } } } }, ['astra', 'fable']],
      [{ flavor: { terra: { effort: 'max' } } }, ['terra']],
      [{ roles: { advisor: { effort: null } } }, ['fable', 'astra']],
      // The overlap: advisor's effort cleared, so its alt astra has none there, and the reviewer role's applies.
      [{ roles: { advisor: { effort: null }, reviewer: { use: ['astra', 'sol'], effort: 'low' } } }, ['astra', 'sol', 'fable']],
    ]
    for (const shell of SHELLS) {
      for (const [doc, families] of cases) {
        roles(doc)
        for (const family of families) {
          const old = spawnSync(shell, ['-c', OLD_SECOND_OPINION_EFFORT], { env: { HOME, PATH, family }, encoding: 'utf8' })
          assert.equal(old.status, 0, old.stderr)
          const label = `${J(doc)} ${family}`
          expectEfforts(shell, label, run(shell, `${fill(ask, { '<family>': family })}\n`), family, old.stdout || null)
        }
      }
    }
    roles({ roles: { advisor: { effort: null } } })
    expectEfforts(SHELLS[0], 'the cleared-advisor overlap', run(SHELLS[0], `${fill(ask, { '<family>': 'astra' })}\n`), 'astra', 'high')
  })
}

test('build (claude): the builder effort counts only the builder role\'s members, never its alt, as before', () => {
  const claudeSkill = skill('build/skills/claude/build/SKILL.md')
  const setup = block(claudeSkill, /^BUILDER=<family>/m)
  const effort = block(claudeSkill, /EFFORT_FLAG=\(\)/)
  const phase1 = block(claudeSkill, /--sandbox workspace-write/)
  for (const shell of SHELLS) {
    roles({ roles: { builder: { alt: 'terra' } }, flavor: { terra: { effort: 'low' } } })
    const { codex } = run(shell, `${[fill(setup, { '<family>': 'terra', '<effort>': '' }), effort, fill(phase1)].join('\n')}\n`)
    assert.equal(codex.length, 1, `${shell}: phase 1`)
    assert.equal(effortIn('codex', codex[0]), 'low', `${shell}: terra as the builder role's alt takes its flavor effort: ${codex[0].join(' ')}`)
  }
})

// ── build: both Grade calls ask for the shipped verdict schema, through each CLI's own structured-output flag ──
for (const harness of ['claude', 'codex']) {
  test(`build (${harness}): the Grade and the swapped Grade ask with --schema, the grade.schema.json installed beside the skill`, () => {
    const body = skill(`build/skills/${harness}/build/SKILL.md`)
    const shipped = readFileSync(join(PACKS, 'build/skills', harness, 'build/grade.schema.json'), 'utf8')
    assert.equal(shipped, readFileSync(join(PACKS, 'build/skills', harness === 'claude' ? 'codex' : 'claude', 'build/grade.schema.json'), 'utf8'), 'both twins ship the same schema')
    const schema = JSON.parse(shipped)
    // The shape --log-grade accepts: these keys and no others; vendor, effort and severity are left to it.
    assert.deepEqual(Object.keys(schema.properties).sort(), ['criteria', 'family', 'findings', 'model'])
    assert.deepEqual(Object.keys(schema.properties.criteria.items.properties).sort(), ['criterion', 'evidence', 'id', 'verdict'])
    assert.deepEqual(schema.properties.criteria.items.properties.verdict.enum, ['PASS', 'FAIL'])
    assert.deepEqual(Object.keys(schema.properties.findings.items.properties).sort(), ['evidence', 'file', 'impact', 'issue', 'likelihood', 'line', 'protected', 'trigger'])
    const installed = join(HOME, harness === 'claude' ? '.claude' : '.codex', 'skills/build/grade.schema.json')
    const judge = block(body, /^ask-model --role advisor/m).split('\n').find((line) => line.includes('--role judge '))
    const swap = block(body, /^ask-model --second --role advisor/m)
    const setup = harness === 'codex' ? `${fill(block(body, /^GATE=bounce/m).replace(/^GATE=bounce/m, 'GATE=grade'))}\n` : ''
    // Fresh defaults put the judge on claude; these roles put it on codex and grok, and the second opinion on each.
    for (const doc of [null, { roles: { judge: { use: ['sol'] }, advisor: { alt: 'fable' } } }, { roles: { judge: { use: ['grok'] } } }]) {
      roles(doc)
      put(installed, shipped)
      put(join(WORK, 'builds/s/grade-prompt.md'), 'THE GRADE PROMPT')
      for (const [name, line, role] of [['the Grade', judge, 'judge'], ['the swapped Grade', swap, 'advisor']]) {
        const resolved = JSON.parse(spawnSync(join(BIN, 'model-id'), ['--role', role, '--json'], { env: { HOME, PATH }, encoding: 'utf8' }).stdout)
        const id = role === 'advisor' ? resolved.altId : resolved.id
        for (const shell of SHELLS) {
          const label = `${shell} ${name} ${J(doc)}`
          const argv = onlyCall(run(shell, `${setup}${fill(line)}\n`), cliOf(id), label)
          assert.equal(modelIn(cliOf(id), argv), id, `${label}: the role's model`)
          assert.ok(argv.includes('THE GRADE PROMPT'), `${label}: the Grade's prompt`)
          if (cliOf(id) === 'codex') assert.equal(argv[argv.indexOf('--output-schema') + 1], installed, `${label}: codex gets the file`)
          else assert.deepEqual(JSON.parse(argv[argv.indexOf('--json-schema') + 1]), schema, `${label}: the schema's JSON`)
        }
      }
    }
  })
}

// ── the merge and cross-vendor settings, said one way in every shipped text ──
const MERGE_RULE = "Agents merge only through merge.mjs, which follows the review gate's merge policy (default off: the operator merges). Never gh pr merge, auto-merge or the merge button."
const CROSS_RULE = "Cross-vendor checks follow the review gate's crossFamily setting (default prefer: another vendor when available, never a blocker; the run names who checked and why)."
const shipped = (path) => readFileSync(join(PACKAGE, path), 'utf8')
const SKILLS = (name, pack = 'review-gate') => ['claude', 'codex'].map((h) => `packs/${pack}/skills/${h}/${name}/SKILL.md`)

test('text: every shipped text that speaks of merging or cross-vendor checks says it the one way, and none forbids what the settings allow', () => {
  const mergeFiles = [...SKILLS('code-review'), ...SKILLS('pr-review'), ...SKILLS('build', 'build'), 'packs/review-gate/instructions/review-gate.md']
  const crossFiles = [...SKILLS('code-review'), ...SKILLS('build', 'build'), 'packs/review-gate/instructions/review-gate.md']
  for (const f of mergeFiles) assert.ok(shipped(f).includes(MERGE_RULE), `${f}: the merge wording`)
  for (const f of crossFiles) assert.ok(shipped(f).includes(CROSS_RULE), `${f}: the cross-vendor wording`)
  for (const f of new Set([...mergeFiles, ...crossFiles])) {
    const text = shipped(f).split(MERGE_RULE).join('')
    for (const banned of [/driver alone merges/i, /only the operator merges/i, /never merge, never push/i, /the operator merges/i, /operator's merge is the approval/i,
      /must .{0,40}another vendor/i, /different family always/i])
      assert.doesNotMatch(text, banned, `${f}: ${banned}`)
  }
  // The codex pr-review runs the agent merge step, as the claude one does.
  for (const f of SKILLS('pr-review')) assert.match(shipped(f), /node ~\/\.agent-config-studio\/review-gate\/merge\.mjs/, f)
  // Rule 5 is the same line in both code-review skills.
  const rule5 = (text) => text.split('\n').find((l) => l.startsWith('5. The PR body'))
  const [claude5, codex5] = SKILLS('code-review').map((f) => rule5(shipped(f)))
  assert.ok(claude5, 'claude code-review: rule 5')
  assert.equal(codex5, claude5, 'codex code-review: rule 5 matches claude')
})

test('build: the Grade reads the review gate\'s crossFamily, prefer when no review gate answers', () => {
  if (!existsSync(join(BIN, 'node'))) symlinkSync(process.execPath, join(BIN, 'node'))
  for (const harness of ['claude', 'codex']) {
    const code = block(skill(`build/skills/${harness}/build/SKILL.md`), /--cross-family/)
    const probe = `${fill(code)}\necho "CROSS=$CROSS_FAMILY" >&2\n`
    const cross = (shell) => {
      writeFileSync(join(ROOT, 'snippet.sh'), probe)
      const r = spawnSync(shell, [join(ROOT, 'snippet.sh')], { cwd: WORK, env: { HOME, PATH, TMPDIR: ROOT }, encoding: 'utf8', timeout: 30_000 })
      return /CROSS=(\S*)/.exec(r.stderr)?.[1]
    }
    for (const shell of SHELLS) {
      rmSync(join(HOME, '.agent-config-studio/review-gate'), { recursive: true, force: true })
      assert.equal(cross(shell), 'prefer', `${harness} ${shell}: no review gate installed`)
      put(join(HOME, '.agent-config-studio/review-gate/review.mjs'), readFileSync(join(PACKS, 'review-gate/runtime/review.mjs'), 'utf8'))
      put(join(HOME, '.agent-config-studio/review-gate/config.json'), J({ crossFamily: 'off' }))
      assert.equal(cross(shell), 'off', `${harness} ${shell}: the home config's off`)
      put(join(HOME, '.agent-config-studio/review-gate/config.json'), J({}))
      assert.equal(cross(shell), 'prefer', `${harness} ${shell}: the default`)
    }
  }
})

// A stand-in runtime: an older copy that ignores unknown flags and runs a review, or one that answers.
const fakeRuntime = (path, body) => put(path, `const a = process.argv.slice(2)\n${body}\n`)
const runSnippet = (shell, code) => {
  writeFileSync(join(ROOT, 'snippet.sh'), code)
  return spawnSync(shell, [join(ROOT, 'snippet.sh')], { cwd: WORK, env: { HOME, PATH, TMPDIR: ROOT }, encoding: 'utf8', timeout: 30_000 })
}

test('build: CROSS_FAMILY is prefer unless the runtime supports --cross-family and answers prefer or off', () => {
  if (!existsSync(join(BIN, 'node'))) symlinkSync(process.execPath, join(BIN, 'node'))
  const runtime = join(HOME, '.agent-config-studio/review-gate/review.mjs')
  const cases = [
    ['an older copy that ignores the flag and reviews', "console.log('▶ reviewer · sol — pick=first'); console.log('off')", 'prefer'],
    ['a copy that supports it but answers something else', "if (a[0] === '--supports') process.exit(0); console.log('maybe')", 'prefer'],
    ['a copy that supports it and answers off', "if (a[0] === '--supports') process.exit(a[1] === '--cross-family' ? 0 : 1); console.log('off')", 'off'],
    ['a copy that does not support it', "if (a[0] === '--supports') process.exit(1); console.log('off')", 'prefer'],
  ]
  for (const harness of ['claude', 'codex']) {
    const code = block(skill(`build/skills/${harness}/build/SKILL.md`), /--cross-family/)
    for (const shell of SHELLS)
      for (const [what, body, want] of cases) {
        fakeRuntime(runtime, body)
        const r = runSnippet(shell, `${fill(code)}\necho "CROSS=$CROSS_FAMILY" >&2\n`)
        assert.equal(/CROSS=(.*)/.exec(r.stderr)?.[1], want, `${harness} ${shell}: ${what}\n${r.stderr}`)
      }
  }
})

test('pr-review: the agent merge step runs merge.mjs unless --tier-json says the policy is off, older runtimes included', () => {
  if (!existsSync(join(BIN, 'node'))) symlinkSync(process.execPath, join(BIN, 'node'))
  const runtime = join(ROOT, 'runtime.mjs'), marker = join(ROOT, 'merge-ran')
  put(join(HOME, '.agent-config-studio/review-gate/merge.mjs'), `import { writeFileSync } from 'node:fs'\nwriteFileSync(${J(marker)}, 'ran'); console.log('none')\n`)
  const cases = [
    ['policy off', { covered: true, tier: 'low', policy: 'off' }, false],
    ['policy standard', { covered: true, tier: 'low', policy: 'standard' }, true],
    ['an older runtime with no policy field', { covered: true, tier: 'low' }, true],
  ]
  for (const harness of ['claude', 'codex']) {
    const code = block(skill(`review-gate/skills/${harness}/pr-review/SKILL.md`), /review-gate\/merge\.mjs/)
    for (const shell of SHELLS)
      for (const [what, tier, ran] of cases) {
        rmSync(marker, { force: true })
        fakeRuntime(runtime, `if (a[0] === '--tier-json') console.log(${J(J(tier))})`)
        const r = runSnippet(shell, `SCRIPT=${J(runtime)}\n${fill(code)}\n`)
        assert.equal(existsSync(marker), ran, `${harness} ${shell}: ${what}\n${r.stderr}`)
      }
  }
})
