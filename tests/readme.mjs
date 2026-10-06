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
