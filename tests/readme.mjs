/**
 * The README tells the truth (builds/ready-for-strangers criterion 1, B3, B10):
 *
 *   - its install and sign-in commands are commands.md's, character for
 *     character;
 *   - every command in a fenced block outside Get started exists (each `acs`
 *     subcommand is in `acs help`, each `model-id` flag in its usage line,
 *     each worktree command is defined by wt.zsh); Get started's own blocks
 *     are run by tests/stranger.mjs;
 *   - it makes no absolute privacy claim the code cannot keep, and it names
 *     each outbound call and credential read the code makes;
 *   - its concrete facts — port, containment flags, the CLIs' homes, the files
 *     an edit folder exposes, the session limit, where the Assist picker
 *     lives — are read from the code and compared.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCommands } from '../lib/setup-commands.js';
import { HARNESSES } from '../lib/harness.js';
import { EDIT_GRANTS } from '../lib/roots.js';
import { readme, blocks, section, getStartedCommands } from './fixtures/readme.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const text = readme();
const src = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

console.log('\nreadme: commands');
const table = readCommands();
const started = section('Get started', text);
for (const cli of ['claude', 'codex', 'grok']) {
  for (const kind of ['install', 'signin']) {
    const want = table[`${kind}.${cli}`]?.command;
    // In a table cell a pipe is written \| — the same escape commands.md uses.
    ok(`1 Get started shows commands.md's ${kind}.${cli} exactly`, !!want && started.includes(`\`${want.replace(/\|/g, '\\|')}\``), want);
  }
}
const cellCommands = [...started.matchAll(/^\s*\| [^|]+ \| `(.+?)` \| `(.+?)` \|$/gm)].flatMap((m) => [m[1], m[2]].map((c) => c.replace(/\\\|/g, '|')));
const known = new Set(Object.values(table).map((e) => e.command));
ok('1 every command in the CLI table is a commands.md command', cellCommands.length === 6 && cellCommands.every((c) => known.has(c)), cellCommands.join(' | '));
ok('B10 Get started has command blocks for tests/stranger.mjs to run', getStartedCommands().length >= 6, getStartedCommands().join(' | '));

const help = spawnSync('/bin/sh', [path.join(ROOT, 'bin', 'acs'), 'help'], { encoding: 'utf8', env: { ...process.env, ACS_NO_UPDATE: '1' } });
ok('acs help exits 0', help.status === 0, help.stderr);
const subs = new Set([...help.stdout.matchAll(/^\s+(?:usage: )?acs ([a-z-]+)/gm)].map((m) => m[1]));
const modelUsage = src('bin/model-id').match(/usage: model-id ([^']+)'/)?.[1] || '';
const wtFns = new Set([...src('tools/worktree/wt.zsh').matchAll(/^([a-z]+)\s*\(\)\s*\{/gm)].map((m) => m[1]));
const outside = blocks(text.replace(started, ''));
const unknown = [];
for (const { lines } of outside) {
  for (const line of lines) {
    const words = line.trim().split(/\s+/);
    if (words[0] === 'acs' || words[0] === './bin/acs') {
      if (words[1] && !words[1].startsWith('-') && !subs.has(words[1])) unknown.push(line);
    } else if (words[0] === 'model-id') {
      if (words[1]?.startsWith('--') && !modelUsage.includes(words[1])) unknown.push(line);
    } else if (!wtFns.has(words[0])) {
      unknown.push(line);
    }
  }
}
ok('1 every fenced command outside Get started exists (acs help, model-id usage, wt.zsh)', unknown.length === 0 && outside.length > 0, unknown.join(' | '));
ok('…and acs help lists what the README relies on', ['stop', 'install', 'uninstall', 'update', 'roots', 'usage', 'install-model-id', 'install-worktree', 'help'].every((s) => subs.has(s)), [...subs].join(','));
// Inline commands in prose (criterion 1, grade C1): every code span that
// starts with a command is run by tests/stranger.mjs (Get started's lines) or
// checked to exist here — each acs subcommand and flag against `acs help` and
// that subcommand's own usage text, model-id flags against its usage, the
// worktree commands against wt.zsh, the vendor CLI commands against
// commands.md or the probe record that ran their --help.
const prose = text.replace(/^```[\s\S]*?^```$/gm, '');
// A pipe in a table cell is written \| (as in commands.md).
const spans = [...new Set([...prose.matchAll(/`([^`]+)`/g)].map((m) => m[1].replace(/\s+/g, ' ').replace(/\\\|/g, '|').trim()))];
const CMD = /^(?:[A-Z_]+=\S+ )*(\.\/bin\/acs|acs|model-id|git|node|npm|curl|claude|codex|grok|gh|direnv|hash|wtinit|wnew|wls|wgo|wtrunk|wenv|wclean|wdev|wrm|wtreg)(?: |$)/;
const commands = spans.filter((sp) => CMD.test(sp) && sp !== 'node:sqlite');
const usageOf = {
  roots: src('bin/roots.mjs'), usage: src('bin/usage.mjs'), 'install-worktree': src('bin/install-worktree.mjs'),
  install: src('bin/acs-link.mjs'), uninstall: src('bin/acs-link.mjs'),
};
const executed = new Set(getStartedCommands());
const knownVendor = new Map([
  ...Object.values(table).map((e) => [e.command, 'commands.md']),
  ['claude', 'the CLI itself'], ['grok', 'the CLI itself'], ['gh', 'the CLI itself'],
  ['codex app-server', 'lib/usage/codex-limits.js runs it (argv pinned by guards.mjs)'],
  ['grok agent stdio', 'lib/usage/grok-billing.js runs it (argv pinned by guards.mjs)'],
  ['grok inspect', 'lib/harness.js inspectGrok runs it (argv pinned by guards.mjs)'],
  ['grok mcp disable <name>', '`grok mcp disable --help`, recorded in builds/ready-for-strangers/grok-mcp.md'],
  ['git show <sha>:<path>', 'git itself'], ['node --version', 'node itself'], ['node', 'node itself'], ['hash -r', 'a shell builtin'],
  ['direnv allow', 'direnv itself, run by wt.zsh'],
]);
// Why a span fails the audit, or null. A function so a planted bad span can
// prove the audit catches it (below).
function spanProblem(sp) {
  const unchecked = [];
  const words = sp.replace(/^(?:[A-Z_]+=\S+ )+/, '').split(' ');
  if (words[0] === 'acs' || words[0] === './bin/acs') {
    const sub = words[1] && !words[1].startsWith('-') ? words[1] : null;
    if (sub && !subs.has(sub)) return `${sp} (no such subcommand)`;
    // A sub-subcommand (`acs roots add`) must be one its own usage names.
    const verb = words[2];
    if (sub && usageOf[sub] && verb && !/^[-<\[~/.$]/.test(verb) && !new RegExp(`(^|[\\s|(])${verb.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([\\s|)]|$)`, 'm').test(usageOf[sub])) {
      return `${sp} (${sub} has no ${verb})`;
    }
    const flagsIn = sub ? (usageOf[sub] ?? help.stdout) : help.stdout;
    for (const f of words.filter((w) => /^-{1,2}[a-z]/.test(w.replace(/^\[/, '')))) {
      const flag = f.replace(/^\[|\]$/g, '');
      if (!flagsIn.includes(flag)) unchecked.push(`${sp} (flag ${flag} not in its usage)`);
    }
    const env = sp.match(/^((?:[A-Z_]+=\S+ )+)/)?.[1].trim().split(' ').map((a) => a.split('=')[0]) || [];
    for (const v of env) if (!help.stdout.includes(v)) unchecked.push(`${sp} (${v} not in acs help)`);
  } else if (words[0] === 'model-id') {
    if (words[1]?.startsWith('--') && !modelUsage.includes(words[1])) unchecked.push(sp);
  } else if (wtFns.has(words[0])) {
    for (const f of words.filter((w) => /^\[?--/.test(w))) {
      if (!src('tools/worktree/wt.zsh').includes(f.replace(/^\[|\]$/g, ''))) unchecked.push(`${sp} (flag not in wt.zsh)`);
    }
  } else if (!knownVendor.has(sp)) {
    unchecked.push(sp);
  }
  return unchecked.length ? unchecked.join(' | ') : null;
}
const unchecked = [];
for (const sp of commands) {
  if (executed.has(sp)) continue;
  const why = spanProblem(sp);
  if (why) unchecked.push(why);
}
ok('1 the inline audit catches a bad sub-subcommand (planted `acs roots surely-invalid`)', spanProblem('acs roots surely-invalid') !== null);
ok('1 …and passes real ones (`acs roots add`, `acs roots ls`)', spanProblem('acs roots add') === null && spanProblem('acs roots ls') === null);
ok(`1 every inline command in the README (${commands.length}) is run by the stranger test or checked to exist`, commands.length > 40 && unchecked.length === 0, unchecked.join(' | '));
ok('1 …the multi-line spans are read whole (`acs --no-open`, `acs help`, `wclean --json --no-fetch`)',
   ['acs --no-open', 'acs help', 'wclean --json --no-fetch'].every((c) => commands.includes(c)), commands.filter((c) => /no-open|^acs help|no-fetch/.test(c)).join(' | '));
for (const s of ['install', 'uninstall', 'install-worktree']) {
  const t = text.match(new RegExp(`\\bacs ${s}\\b`));
  ok(`the README names \`acs ${s}\``, !!t);
}

console.log('\nreadme: what it claims');
for (const [re, what] of [
  [/never reads? (?:a |any )?credential/i, 'never reads credentials'],
  [/never phones? home|phones? home/i, 'never phones home'],
  [/no outbound|makes no (?:network|outbound)|never (?:calls|contacts) (?:the )?(?:network|internet)/i, 'no outbound requests'],
  [/everything is editable/i, '"Everything is editable"'],
  [/these are all|all of its outbound/i, 'an exhaustive outbound list'],
  [/nothing else is reachable/i, '"Nothing else is reachable"'],
  [/lives in `?lib\/chat\.js`?/i, 'the model list lives in chat.js'],
]) ok(`B3/B10 no "${what}" claim`, !re.test(text), (text.match(re) || [])[0]);
for (const [re, what] of [
  [/no telemetry/i, 'no telemetry'],
  [/fetches git origin/i, 'acs fetches git origin on start'],
  [/Keychain/, 'the usage collector reads the Keychain'],
  [/\.credentials\.json/, '…or the credential file'],
  [/Codex and Grok `auth\.json`/, '…and the Codex and Grok auth files'],
  [/separate child process/i, '…in a separate child process'],
  [/`codex app-server` `model\/list`/, 'Check now runs codex app-server model/list'],
  [/Assist runs your CLI/i, 'Assist runs your CLI'],
  [/editable regardless of your folder choices/i, 'the built-in homes are editable regardless of folders'],
  [/Grok Assist is unavailable while grok has MCP servers configured/, 'Grok Assist refuses when grok has MCP servers'],
  [/runs `codex login`/, 'signing a Codex seat in runs codex login'],
  [/`~\/\.codex-seats\/`/, 'a second Codex seat creates ~/.codex-seats'],
  [/`~\/\.zshenv`/, 'Terminal shortcuts append to ~/.zshenv'],
  [/asks `gh`/, 'the Worktrees view asks gh'],
  [/runs `wtinit` there, which creates the project's\s+trunk checkout/, 'worktree setup creates a trunk checkout'],
  [/`acs install` links `~\/\.local\/bin\/acs`/, 'acs install writes ~/.local/bin/acs'],
  [/writes `~\/\.local\/bin\/model-id`/, 'install-model-id writes ~/.local/bin/model-id'],
  [/adds\s+one line to `~\/\.zshrc`/, 'install-worktree adds a line to ~/.zshrc'],
  [/Grok Assist\s+turn's prompt/, 'Grok prompt files in the temp folder'],
  [/a run file per port/, 'the run file acs stop uses'],
]) ok(`B3 the README says: ${what}`, re.test(text));

console.log('\nreadme: facts from the code');
const port = src('bin/acs').match(/PORT="\$\{ACS_PORT:-(\d+)\}"/)?.[1];
ok('B10 the port is bin/acs\'s default', port && text.includes(`localhost:${port}`) && !/localhost:(?!8787)\d+/.test(text), port);
ok('B10 the Claude containment flags are the descriptor\'s', text.includes(`\`${HARNESSES.claude.containment.join(' ')}\``), HARNESSES.claude.containment.join(' '));
ok('B10 the Grok read tool is the descriptor\'s', text.includes(`\`${HARNESSES.grok.containment.slice(0, 2).join(' ')}\``));
const builtins = src('lib/roots.js').match(/BUILTIN_NAMES = (\[.*\]);/)?.[1];
const homes = builtins ? JSON.parse(builtins.replace(/'/g, '"')).map((segs) => `\`~/${segs.join('/')}\``) : [];
ok('B10 the editable CLI homes are lib/roots.js\'s built-in homes', homes.length > 0 && homes.every((h) => text.includes(h)), homes.join(' '));
const granted = [...EDIT_GRANTS.matchAll(/\(([^)]+)\)/g)][0]?.[1].split(/,\s*/) || [];
ok('B10 the files an edit folder exposes are the ones the edit confirm names', granted.length === 4 && granted.every((f) => text.includes(`\`${f}\``)), granted.join(','));
const maxSessions = src('public/app.js').match(/const MAX_SESSIONS = (\d+);/)?.[1];
ok('B10 the session limit is the page\'s', text.includes(`Up to **${maxSessions}**`), maxSessions);
ok('B10 the Assist picker is said to live in the registry', /`assist\.claude` and `assist\.grok` in\s+`models\.default\.json`/.test(text) && /"assist"/.test(src('models.default.json')));
ok('B10 the Node minimum is package.json\'s and the launcher\'s', JSON.parse(src('package.json')).engines.node === '>=20' && /Node\.js 20 or newer/.test(text) && /"\$major" -lt 20/.test(src('bin/acs')));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
