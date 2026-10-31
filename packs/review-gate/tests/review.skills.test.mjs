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
  if (doc) put(join(HOME, '.agent-config-studio/roles.json'), J({ version: 1, ...doc }))
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
