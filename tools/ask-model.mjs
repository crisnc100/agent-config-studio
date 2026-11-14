#!/usr/bin/env node
/**
 * ask-model — ask another model, read-only, and print its answer.
 *
 *   ask-model (--role <role> [--second] | --family <family> [--effort-from <role>[,<role>…]])
 *             [--effort <e>] --prompt-file <path> [--schema <file.json>] [--investigate | --no-tools | --min-tools | --x-search] [--json] [--cwd <dir>]
 *
 * The mechanical half of "ask model X", in one place instead of in every
 * skill: the family, id and effort from the resolver (lib/models.js and
 * lib/roles.js, the code model-id runs), the CLI from the id's prefix, that
 * CLI's read-only and no-MCP flags, and proof that the model asked for is the
 * one that answered. An empty effort passes no effort flag at all: codex
 * rejects `model_reasoning_effort=` with nothing after it.
 *
 * --second asks the role's second opinion (its alt, at its altEffort). --effort-from takes a family's effort from
 * the first listed role that gives it one, else its flavor (lib/roles.js familyEffort, the rule model-id --effort uses).
 * An --effort given wins over both.
 *
 * --schema passes the CLI's own structured-output flag (claude and grok --json-schema with the schema's JSON, codex
 * --output-schema with the file), checks the answer against it, and prints only the JSON. ask-model checks the subset
 * of JSON Schema in SCHEMA_KEYWORDS and refuses a schema with any other keyword rather than half-check it.
 *
 * grok runs with an empty temporary HOME (so nothing it borrows from ~/.claude or ~/.cursor, plugin MCP servers
 * included, starts) and the real GROK_HOME (so its login is the usual one), and only when `grok inspect` under that
 * same env shows no MCP server, plugin MCP or project hook that would start, and leader mode is off. grokMcpAllow in
 * the review gate's home config lists servers from grok's own config.toml that may start anyway; MCP tools stay denied.
 *
 * --investigate adds a shell (claude's Bash; grok's run_terminal_cmd, with
 * shell commands allowed; codex's read-only sandbox already runs commands) and
 * compares the git work tree before and after the call. Anything that changed
 * is named on stderr and the exit is 5. Nothing is ever reverted. Submodules
 * that are checked out are compared the same way. A change to the work tree's
 * .git (folder or gitfile), the git dir's commondir, or a config file or any
 * file it includes is exit 5 too, and git is not run after the call. Every
 * snapshot reads the repository found before the call through git confined to
 * a config ask-model writes, so no config the repository or the shell controls
 * (no fsmonitor, filter or include) is read. The shell runs
 * inside the CLI's own OS sandbox: claude's Bash sandbox through --settings
 * (CLAUDE_SANDBOX: writes to the cwd and the temp folder only, no network host,
 * no unsandboxed fallback, and claude exits if the sandbox cannot start), with no
 * user, project or local settings file loaded, your own included, so none of them
 * widens it (managed settings still apply); grok's
 * `--sandbox strict` on Linux (reads the cwd, system paths and ~/.grok, writes the
 * cwd and temp folders, no network), codex's read-only one. For claude or grok
 * off macOS and Linux, for grok on macOS (where its sandbox can't block a
 * command's network), or on Linux without Landlock for grok, --investigate exits
 * 4 and the model is not run; codex runs anywhere.
 * --json then carries `shellSandbox`, naming the sandbox the shell ran in.
 *
 * --no-tools asks with no tools at all: claude with `--tools ""` (its documented "no tools"). grok has no such mode
 * (a --tools entry that names no tool leaves the others available) and codex has no switch that removes every tool,
 * so for those two it refuses with exit 4 rather than run with tools.
 *
 * --min-tools asks with as few tools as each CLI allows, from --cwd: claude exactly as --no-tools (mode no-tools,
 * tools "none"); grok with list_dir as its only built-in tool, MCP tools denied, web search and subagents off and a
 * low turn cap; codex with every tool feature in CODEX_TOOL_FEATURES switched off, web search disabled and the
 * read-only sandbox (mode min-tools, tools "restricted"). --json then carries `tools` and a
 * `toolsNote` naming what the CLI still allows.
 *
 * --x-search asks grok what people on X are saying. What it is left is grok's built-in X tools, x_keyword_search,
 * x_semantic_search, x_user_search and x_thread_fetch: every other built-in in GROK_X_DENY is disallowed, permission
 * rules deny Bash, Read, Edit, Write, Grep, Glob, WebFetch and MCP tools whatever grant GROK_HOME holds, subagents are
 * off and the turn cap is low. Web search is not switched off, since the X tools go with it. open_page and
 * open_page_with_find, which come with web_search, can't be disallowed by name; with web_search disallowed grok 1.0.77
 * offered neither. Only for a family grok runs (any other exits 64), not with --investigate, --no-tools, --min-tools or
 * --schema, and only when `grok inspect` reports GROK_X_VERSION (exit 4 otherwise, nothing run).
 *
 * Exit: 0 answered · 2 another model answered · 3 the CLI (or node) is not
 * installed · 4 the call failed or returned an error · 5 files changed under
 * --investigate · 6 the answer is not JSON or does not match --schema · 64 a
 * usage error (an unusable --schema included), or a role or family that does
 * not resolve to a model a known CLI runs.
 *
 * It lives in tools/, not bin/: it runs model CLIs, which nothing under bin/
 * or lib/ may do (tests/guards.mjs). `model-id --install` copies it beside the
 * resolver as bin/ask-model.mjs, so `../lib/` resolves in both places.
 */
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EFFORTS, loadRegistry, resolveModel } from '../lib/models.js';
import { familyEffort, pauseLine, resolveFlavor, resolveRole } from '../lib/roles.js';

const SELF = fileURLToPath(import.meta.url);
const USAGE = 'usage: ask-model (--role <role> [--second] | --family <family> [--effort-from <role>[,<role>…]]) [--effort <e>] --prompt-file <path> [--schema <file.json>] [--investigate | --no-tools | --min-tools | --x-search] [--json] [--cwd <dir>]'
  + '\n  --x-search: grok only; leaves x_keyword_search, x_semantic_search, x_user_search and x_thread_fetch; open_page and open_page_with_find '
  + 'cannot be disallowed by name, and the grok it was checked against offers neither';
const VALUE_FLAGS = { '--role': 'role', '--family': 'family', '--effort': 'effort', '--effort-from': 'effortFrom', '--prompt-file': 'promptFile', '--schema': 'schemaFile', '--cwd': 'cwd' };

// What each CLI may use. Claude and grok are read-only by these allowlists alone
// (their plan modes and denylists were observed to still write); codex by its sandbox.
const TOOLS = {
  claude: { 'read-only': 'Read,Grep,Glob', investigate: 'Read,Grep,Glob,Bash', 'no-tools': '' },
  // min-tools: one tool, since a --tools entry that names no tool leaves every tool available; list_dir shows names only.
  grok: { 'read-only': 'read_file,list_dir,grep', investigate: 'read_file,list_dir,grep,run_terminal_cmd', 'min-tools': 'list_dir' },
};
// The --investigate shell runs inside each CLI's own OS sandbox. claude: Claude Code's Bash sandbox, per call through
// --settings (only user, managed and --settings sources may set strictAllowlist). Without strictAllowlist, a skipped
// permission prompt lets a command reach any host; failIfUnavailable makes claude exit rather than run Bash unconfined.
// Writes stay in the cwd and the temp folder Claude Code allows by default.
const CLAUDE_SANDBOX = { sandbox: { enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false,
  network: { allowedDomains: [], strictAllowlist: true } } };
// grok: `strict`, its most restrictive built-in profile, which still reads the cwd; Linux only. A built-in profile that
// fails to apply runs unenforced, with only a warning, so sandboxProblem checks for Landlock first. On macOS grok's
// sandbox leaves a command's network open (its docs: a no-op there), so grok gets no shell on macOS.
const GROK_SANDBOX = 'strict';
const SHELL_SANDBOX = {
  claude: 'claude sandbox: commands write only to the work tree and the temp folder, reach no network host, and never run outside it',
  grok: `grok --sandbox ${GROK_SANDBOX}: commands read the work tree, system paths and ~/.grok, write the work tree and temp folders, `
    + 'and reach no network (Linux only)',
  codex: 'codex --sandbox read-only',
};
// The review runtime's grok turn cap (packs/review-gate/runtime/review.mjs); min-tools needs few turns.
const GROK_MAX_TURNS = '40';
const GROK_MIN_TURNS = '5';
// --x-search: a denylist, because a --tools allowlist ignores the X tool names (grok warns they name no tool and leaves
// every tool available). A tool a later grok adds would not be on it, so the mode runs only on GROK_X_VERSION, the grok
// this list was taken from (every client tool its sessions' tool_definitions.json named, with run_terminal_cmd, the name
// --investigate allows, beside run_terminal_command). The deny rules are the second wall: a write or command a name
// misses is still refused, and deny wins over any allow grant or always-approve setting in GROK_HOME. Under them a
// session's tool_definitions.json was empty and a `write` left off the list was refused ("deny rule on edit").
// 8 turns returned real posts.
const GROK_X_DENY = ['run_terminal_command', 'run_terminal_cmd', 'search_replace', 'write', 'read_file', 'list_dir', 'grep', 'kill_command_or_subagent', 'todo_write',
  'get_command_or_subagent_output', 'spawn_subagent', 'scheduler_create', 'scheduler_delete', 'scheduler_list', 'monitor', 'search_tool', 'use_tool', 'workflow',
  'enter_plan_mode', 'exit_plan_mode', 'ask_user_question', 'send_feedback', 'web_fetch', 'image_gen', 'image_edit', 'image_to_video', 'reference_to_video', 'web_search'];
const GROK_X_RULES = ['MCPTool', 'Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob', 'WebFetch'];
const GROK_X_VERSION = '1.0.77';
const GROK_X_TURNS = '8';
// codex features that give the model a tool (`codex features list`), all off under --min-tools; web search has no
// feature of its own (`web_search` in config.toml: live, indexed, cached or disabled).
const CODEX_TOOL_FEATURES = ['shell_tool', 'unified_exec', 'view_image', 'image_generation', 'multi_agent', 'browser_use', 'browser_use_external', 'computer_use',
  'in_app_browser', 'apps', 'plugins', 'remote_plugin', 'goals', 'sleep_tool', 'skill_search', 'tool_suggest'];
// What --min-tools leaves each CLI, for --json's `tools` and `toolsNote`.
const MIN_TOOLS = {
  claude: { tools: 'none', toolsNote: 'no tools (claude --tools "")' },
  grok: { tools: 'restricted', toolsNote: 'list_dir only (it lists any folder it is given a path to); MCP tools denied, web search and subagents off; grok has no switch that removes every tool' },
  codex: { tools: 'restricted', toolsNote: 'shell, exec, image, browser, computer-use, sub-agent, app, plugin, goal, sleep, skill-search and tool-suggest tools off, web search disabled; '
      + 'apply_patch (writes refused by the read-only sandbox), update_plan, and whatever these features still on may add, remain: '
      + 'code_mode_host, in_app_local_automation, workspace_dependencies, worktrees' },
};
const X_SEARCH_TOOLS = { tools: 'restricted', toolsNote: 'x_keyword_search, x_semantic_search, x_user_search and x_thread_fetch only; every other built-in disallowed, '
    + 'Bash, Read, Edit, Write, Grep, Glob, WebFetch and MCP tools denied by rule, subagents off. open_page and open_page_with_find come with '
    + 'web search and cannot be disallowed by name; grok ' + GROK_X_VERSION + ' offered neither with web_search disallowed' };
// grok's own switches for the MCP servers and hooks it borrows from Claude Code's and Cursor's configs, set for
// its preflight and its run alike (the studio's GROK_ASSIST_ENV, lib/containment.js). Its own MCP servers have
// none, and its own .grok/hooks have none short of turning folder trust off (see grokHookFolders).
const GROK_ENV = { GROK_CLAUDE_MCPS_ENABLED: '0', GROK_CURSOR_MCPS_ENABLED: '0', GROK_CLAUDE_HOOKS_ENABLED: '0', GROK_CURSOR_HOOKS_ENABLED: '0' };

// GROK_HOME made absolute once, at start: grok runs with --cwd, which would read a relative one from somewhere else.
const GROK_HOME = path.resolve(process.env.GROK_HOME || path.join(os.homedir(), '.grok'));

/**
 * Grok's environment for one call: an empty temporary HOME, so what grok borrows from ~/.claude and ~/.cursor
 * (plugin MCP servers and hooks, ~/.claude.json) finds nothing, and the real GROK_HOME, so the login, its in-place
 * refresh and folder trust are a normal session's. `done()` removes the temporary HOME.
 */
function grokCallEnv() {
  const grokHome = GROK_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-model-grok-home-'));
  return { env: { ...process.env, ...GROK_ENV, HOME: home, GROK_HOME: grokHome }, grokHome, done: () => fs.rmSync(home, { recursive: true, force: true }) };
}

/**
 * grokMcpAllow: grok-native MCP server names the operator lets start (MCP tools stay denied). Read from the review
 * gate's home config files only, the first that exists: never a repository's file, and empty when unset.
 */
function grokMcpAllow() {
  for (const file of [path.join(os.homedir(), '.agent-config-studio', 'review-gate', 'config.json'), path.join(os.homedir(), '.claude', 'review-config.json')]) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') continue; return { error: `${file}: ${e.code || e.message}` }; }
    let doc;
    try { doc = JSON.parse(text); } catch { return { error: `${file} is not JSON` }; }
    const value = doc?.grokMcpAllow;
    if (value === undefined) return { names: [] };
    if (!Array.isArray(value) || value.some((n) => typeof n !== 'string' || !n.trim())) return { error: `grokMcpAllow in ${file} must be a list of server names` };
    return { names: value.map((n) => n.trim()) };
  }
  return { names: [] };
}

// The entry lists whose settings patch a grok config file.
const PATCHES = ['experiments', 'version_overrides', 'campaigns'];

/**
 * What one grok TOML file sets cli.use_leader to: { value } (true, false, or undefined when unset, with patch naming
 * the PATCHES list of an entry that sets it true), or { unclear }.
 * A small TOML reader, not a whole one: bare, quoted and dotted keys, [cli] headers and inline tables, comments and
 * every string form, so `"use_leader" = true # on` and `cli.use_leader = true` both count. What it can't read is
 * unclear, which refuses grok.
 */
function tomlUseLeader(source) {
  const text = source.replace(/^﻿/, '');
  let i = 0, found, patch;
  const fail = (why) => { throw new Error(`${why} (line ${text.slice(0, i).split('\n').length})`); };
  const ws = () => { while (text[i] === ' ' || text[i] === '\t') i++; };
  const blank = () => { // spaces, comments and line ends
    for (;;) {
      ws();
      if (text[i] === '#') while (i < text.length && text[i] !== '\n') i++;
      if (text[i] === '\n' || text[i] === '\r') i++; else return;
    }
  };
  const endLine = () => {
    ws();
    if (text[i] === '#') while (i < text.length && text[i] !== '\n') i++;
    if (text[i] === '\r') i++;
    if (i < text.length && text[i] !== '\n') fail('more on a line than one key and value');
    i++;
  };
  const ESC = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', e: '\x1b', '"': '"', '\\': '\\' };
  const str = () => {
    const q = text[i], multi = text.startsWith(q.repeat(3), i);
    i += multi ? 3 : 1;
    if (multi && text[i] === '\n') i++;
    else if (multi && text.startsWith('\r\n', i)) i += 2;
    let out = '';
    for (;;) {
      if (i >= text.length) fail('a string that never closes');
      if (multi ? text.startsWith(q.repeat(3), i) : text[i] === q) {
        if (multi) for (let k = 0; k < 2 && text[i + 3] === q; k++) { out += q; i++; }
        i += multi ? 3 : 1;
        return out;
      }
      const c = text[i];
      if (!multi && (c === '\n' || c === '\r')) fail('a string that runs past its line');
      if (q === '"' && c === '\\') {
        const n = text[i + 1];
        if (multi && /[ \t\r\n]/.test(n)) {
          let j = i + 1;
          while (text[j] === ' ' || text[j] === '\t') j++;
          if (text[j] === '\r') j++;
          if (text[j] !== '\n') fail('a backslash that is not an escape');
          i = j;
          while (/[ \t\r\n]/.test(text[i] || '')) i++;
          continue;
        }
        if (ESC[n] !== undefined) { out += ESC[n]; i += 2; continue; }
        const hex = { x: 2, u: 4, U: 8 }[n] || 0, digits = text.slice(i + 2, i + 2 + hex);
        if (!hex || !/^[0-9a-fA-F]+$/.test(digits) || digits.length !== hex) fail('an escape it does not know');
        out += String.fromCodePoint(parseInt(digits, 16));
        i += 2 + hex;
        continue;
      }
      out += c;
      i++;
    }
  };
  const key = () => {
    const parts = [];
    for (;;) {
      ws();
      if (text[i] === '"' || text[i] === "'") {
        if (text.startsWith(text[i].repeat(3), i)) fail('a multi-line string as a key');
        parts.push(str());
      } else {
        const m = /[A-Za-z0-9_-]+/y;
        m.lastIndex = i;
        const bare = m.exec(text);
        if (!bare) fail('a key it cannot read');
        parts.push(bare[0]);
        i = m.lastIndex;
      }
      ws();
      if (text[i] !== '.') return parts;
      i++;
    }
  };
  // Where `at` names cli.use_leader: at the top, or anywhere in an [[experiments]], [[version_overrides]] or
  // [[campaigns]] entry, each a patch to the file on the machines (arm, CLI version, campaign) it picks. Whether this
  // machine is picked is not worked out: any entry counts.
  const leaderAt = (at) => {
    if (!at) return -1;
    for (let k = 0; k + 1 < at.length; k++) if (at[k] === 'cli' && at[k + 1] === 'use_leader' && (k === 0 || PATCHES.includes(at[0]))) return k + 1;
    return -1;
  };
  // `at` is the value's full key, or null inside an array outside those entry lists, where nothing can be cli.use_leader.
  const set = (at, v) => {
    const k = leaderAt(at);
    if (k < 0) return;
    if (at.length > k + 1 || typeof v !== 'boolean') fail('cli.use_leader set to something other than true or false');
    if (k > 1) { if (v) patch ??= at[0]; return; }
    if (found !== undefined) fail('cli.use_leader set twice');
    found = v;
  };
  const value = (at) => {
    ws();
    const c = text[i];
    if (c === '"' || c === "'") { str(); return set(at, 'a string'); }
    if (c === '[') {
      i++;
      for (;;) {
        blank();
        if (text[i] === ']') { i++; return set(at, 'an array'); }
        // `experiments = [{ cli = { use_leader = true } }]` is the same entry list.
        value(at && PATCHES.includes(at[0]) ? at : null);
        blank();
        if (text[i] === ',') i++;
        else if (text[i] !== ']') fail('an array it cannot read');
      }
    }
    if (c === '{') {
      i++;
      set(at, 'a table');
      for (;;) {
        blank();
        if (text[i] === '}') { i++; return; }
        const k = key();
        ws();
        if (text[i] !== '=') fail('an inline table it cannot read');
        i++;
        value(at && [...at, ...k]);
        blank();
        if (text[i] === ',') i++;
        else if (text[i] !== '}') fail('an inline table it cannot read');
      }
    }
    const m = /[A-Za-z0-9_+\-.:]+(?: [0-9]{2}:[A-Za-z0-9_+\-.:]+)?/y;
    m.lastIndex = i;
    const scalar = m.exec(text);
    if (!scalar) fail('a value it cannot read');
    i = m.lastIndex;
    return set(at, scalar[0] === 'true' ? true : scalar[0] === 'false' ? false : 'a non-boolean');
  };
  try {
    let table = [];
    for (;;) {
      blank();
      if (i >= text.length) return { value: found, patch };
      if (text[i] === '[') {
        const many = text[i + 1] === '[';
        i += many ? 2 : 1;
        table = key();
        if (!text.startsWith(many ? ']]' : ']', i)) fail('a table header it cannot read');
        i += many ? 2 : 1;
        if (leaderAt(table) >= 0) fail('cli.use_leader as a table');
      } else {
        const k = key();
        if (text[i] !== '=') fail('a line that is not a key and value');
        i++;
        value([...table, ...k]);
      }
      endLine();
    }
  } catch (e) {
    return { unclear: e.message };
  }
}

/**
 * The requirements.toml macOS device management hands grok: the requirements_toml_base64 string in a forced ai.x.grok
 * preference. { text }, null when there is none, or { unclear }. GROK_TEST_MANAGED_PREFS adds a folder to look in
 * (the tests'); it never replaces the system one.
 */
function grokMdmRequirements() {
  let user = process.env.USER;
  try { user = os.userInfo().username; } catch { /* USER stands */ }
  const dirs = ['/Library/Managed Preferences', ...(process.env.GROK_TEST_MANAGED_PREFS ? [process.env.GROK_TEST_MANAGED_PREFS] : [])];
  const out = [];
  for (const file of dirs.flatMap((d) => [...(user ? [path.join(d, user, 'ai.x.grok.plist')] : []), path.join(d, 'ai.x.grok.plist')])) {
    try { fs.statSync(file); } catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') continue; out.push({ file, unclear: `unreadable (${e.code || e.message})` }); continue; }
    const plutil = (args) => spawnSync('/usr/bin/plutil', [...args, '-o', '-', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 });
    let doc = null, v;
    const all = plutil(['-convert', 'json']);
    if (!all.error && all.status === 0) try { doc = JSON.parse(all.stdout); } catch { doc = null; }
    if (isObject(doc)) v = doc.requirements_toml_base64;
    else {
      // A plist JSON can't hold (a date or data value) still gives up the one key.
      const one = plutil(['-extract', 'requirements_toml_base64', 'json']);
      try { if (one.error || one.status !== 0) throw new Error(); v = JSON.parse(one.stdout); } catch { out.push({ file, unclear: 'plutil could not read it' }); continue; }
    }
    if (v === undefined) continue;
    const where = `${file} (requirements_toml_base64)`;
    if (typeof v !== 'string' || !/^[A-Za-z0-9+/\s]*={0,2}\s*$/.test(v)) { out.push({ file: where, unclear: 'not a base64 string' }); continue; }
    try { out.push({ file: where, text: new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(v, 'base64')) }); } catch { out.push({ file: where, unclear: 'not UTF-8' }); }
  }
  return out;
}

/**
 * Whether grok's leader mode is on: { file } for the layer setting cli.use_leader = true, { file, patch } for one
 * whose [[experiments]], [[version_overrides]] or [[campaigns]] entry may, { file, unclear } for one that can't be read far enough to tell, or null. A leader session runs with the leader's own HOME, so the borrowed
 * servers a temporary HOME keeps out could start where inspect does not look. `cli.use_leader` is a pin: the user,
 * managed and requirements files and the macOS device-management payload all count.
 */
function grokLeader(grokHome) {
  const files = ['config.toml', 'managed_config.toml', 'requirements.toml'].map((f) => path.join(grokHome, f))
    .concat(['/etc/grok/managed_config.toml', '/etc/grok/requirements.toml']);
  const layers = [];
  for (const file of files) {
    try { layers.push({ file, text: fs.readFileSync(file, 'utf8') }); } catch (e) {
      if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') layers.push({ file, unclear: `unreadable (${e.code || e.message})` });
    }
  }
  for (const layer of [...layers, ...grokMdmRequirements()]) {
    if (layer.unclear) return layer;
    const r = tomlUseLeader(layer.text);
    if (r.unclear) return { file: layer.file, unclear: r.unclear };
    if (r.value === true) return { file: layer.file };
    if (r.patch) return { file: layer.file, patch: r.patch };
  }
  return null;
}

/**
 * Why the --investigate shell could not be sandboxed for this vendor here, or null. claude's sandbox runs on macOS and
 * Linux; grok's on Linux only, and there it needs Landlock, which the kernel lists among its active security modules.
 */
function sandboxProblem(vendor) {
  if (vendor === 'codex') return null;
  if (process.platform !== 'darwin' && process.platform !== 'linux') return `${vendor}'s shell sandbox does not run on ${process.platform}`;
  if (vendor !== 'grok') return null;
  if (process.platform === 'darwin') return "grok's sandbox can't block a command's network on macOS";
  let lsm;
  try { lsm = fs.readFileSync('/sys/kernel/security/lsm', 'utf8'); } catch (e) {
    return `the kernel's security modules could not be read (/sys/kernel/security/lsm: ${e.code || e.message}), so grok's Landlock sandbox could not be confirmed`;
  }
  return lsm.trim().split(',').includes('landlock') ? null : 'Landlock is not active in this kernel, and grok would run its sandbox unenforced';
}

/** Which CLI runs an id: its prefix, the rule ACS and the review runtime use. */
function vendorOf(id) {
  if (id.startsWith('claude-')) return 'claude';
  if (id.startsWith('gpt-')) return 'codex';
  if (id.startsWith('grok-')) return 'grok';
  return null;
}

/** The argv for one call. `mcpOff` is codex's overrides that switch its MCP servers off (codexMcpOff). */
function argvFor(vendor, { id, effort, prompt, cwd, mode, mcpOff = [], schema = null }) {
  // The structured-output flags review.mjs passes: the schema's JSON for claude and grok, its file for codex.
  const json = schema ? ['--json-schema', JSON.stringify(schema.doc)] : [];
  if (vendor === 'claude') {
    return ['-p', prompt, '--model', id, ...(effort ? ['--effort', effort] : []), '--output-format', 'json', ...json,
      // --tools decides which tools exist, so skipping the prompts is safe; --strict-mcp-config with
      // no --mcp-config loads no MCP server. Without the skip, a deny rule or hook blocks a read silently.
      // --setting-sources: a headless run honours the repo's .claude settings, hooks included, so only your own
      // settings load; your login is not a settings file and is still read. --investigate loads none of them
      // (`--setting-sources=`, the empty list): array settings merge across sources, so a user allowedDomains,
      // WebFetch(domain:…) grant or excludedCommands entry would reopen what CLAUDE_SANDBOX closes.
      '--dangerously-skip-permissions', '--tools', TOOLS.claude[mode], '--strict-mcp-config',
      ...(mode === 'investigate' ? ['--setting-sources=', '--settings', JSON.stringify(CLAUDE_SANDBOX)] : ['--setting-sources', 'user'])];
  }
  if (vendor === 'codex') {
    const min = mode === 'min-tools' ? [...CODEX_TOOL_FEATURES.flatMap((f) => ['--disable', f]), '-c', 'web_search="disabled"'] : [];
    return ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '-m', id,
      ...(effort ? ['-c', `model_reasoning_effort=${effort}`] : []), ...min, ...mcpOff, ...(schema ? ['--output-schema', schema.file] : []), prompt];
  }
  // --disallowed-tools and --deny MCPTool keep configured MCP servers out of reach (grok has no strict-MCP flag).
  // Headless grok refuses any call that needs approval and still exits 0, so --investigate allows the shell
  // (an allow rule approves the call; deny rules still win).
  if (mode === 'x-search') {
    return ['-p', prompt, '-m', id, ...(effort ? ['--reasoning-effort', effort] : []), '--cwd', cwd,
      '--disallowed-tools', GROK_X_DENY.join(','), ...GROK_X_RULES.flatMap((r) => ['--deny', r]), '--no-subagents', '--max-turns', GROK_X_TURNS, '--output-format', 'json'];
  }
  return ['-p', prompt, '-m', id, ...(effort ? ['--reasoning-effort', effort] : []), '--cwd', cwd,
    '--tools', TOOLS.grok[mode], '--disallowed-tools', 'search_tool,use_tool', '--deny', 'MCPTool',
    ...(mode === 'investigate' ? ['--allow', 'Bash', '--sandbox', GROK_SANDBOX] : []),
    '--disable-web-search', '--no-subagents', '--max-turns', mode === 'min-tools' ? GROK_MIN_TURNS : GROK_MAX_TURNS, '--output-format', 'json', ...json];
}

// The JSON Schema ask-model checks: what the gate's schemas use. Annotations check nothing; anything else is refused.
const SCHEMA_KEYWORDS = ['type', 'properties', 'required', 'items', 'enum', 'additionalProperties', 'minimum', 'maximum', 'minItems', 'description', 'title', '$schema'];
const SCHEMA_TYPES = ['object', 'array', 'string', 'integer', 'number', 'boolean', 'null'];
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Why a schema can't be checked as written, or null. Walks every nested schema. */
function schemaProblem(s, at = 'the schema') {
  if (!isObject(s)) return `${at} must be an object`;
  const other = Object.keys(s).find((k) => !SCHEMA_KEYWORDS.includes(k));
  if (other !== undefined) return `${at} uses "${other}", which ask-model does not check (it checks ${SCHEMA_KEYWORDS.join(', ')})`;
  if (Object.hasOwn(s, 'type')) {
    const types = [].concat(s.type);
    if (!types.length || types.some((t) => !SCHEMA_TYPES.includes(t))) return `${at}.type must be one of ${SCHEMA_TYPES.join(', ')}, or a list of them`;
    const twice = types.find((t, i) => types.indexOf(t) !== i);
    if (twice !== undefined) return `${at}.type names "${twice}" twice`;
  }
  if (Object.hasOwn(s, 'properties')) {
    if (!isObject(s.properties)) return `${at}.properties must be an object`;
    for (const [k, v] of Object.entries(s.properties)) {
      const p = schemaProblem(v, `${at}.properties.${k}`);
      if (p) return p;
    }
  }
  if (Object.hasOwn(s, 'required') && (!Array.isArray(s.required) || s.required.some((k) => typeof k !== 'string'))) return `${at}.required must be a list of names`;
  const twice = (s.required || []).find((k, i) => s.required.indexOf(k) !== i);
  if (twice !== undefined) return `${at}.required names "${twice}" twice`;
  if (Object.hasOwn(s, 'items')) {
    const p = schemaProblem(s.items, `${at}.items`);
    if (p) return p;
  }
  if (Object.hasOwn(s, 'enum') && (!Array.isArray(s.enum) || !s.enum.length)) return `${at}.enum must be a non-empty list`;
  if (Object.hasOwn(s, 'additionalProperties') && typeof s.additionalProperties !== 'boolean') return `${at}.additionalProperties must be true or false`;
  for (const k of ['minimum', 'maximum']) if (Object.hasOwn(s, k) && !Number.isFinite(s[k])) return `${at}.${k} must be a number`;
  if (Object.hasOwn(s, 'minItems') && !(Number.isSafeInteger(s.minItems) && s.minItems >= 0)) return `${at}.minItems must be a whole number`;
  return null;
}

/** JSON equality by value: an object's key order does not count, an array's does. */
function sameValue(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => sameValue(x, b[i]));
  if (isObject(a) || isObject(b)) {
    if (!isObject(a) || !isObject(b)) return false;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((k) => Object.hasOwn(b, k) && sameValue(a[k], b[k]));
  }
  return a === b;
}

/** Where an answer holds a number JSON cannot hold (1e400 parses as Infinity and would print as null), or null. */
function nonFinite(v, at = '$') {
  if (typeof v === 'number') return Number.isFinite(v) ? null : at;
  if (Array.isArray(v)) for (let i = 0; i < v.length; i++) { const w = nonFinite(v[i], `${at}[${i}]`); if (w) return w; }
  else if (isObject(v)) for (const [k, x] of Object.entries(v)) { const w = nonFinite(x, `${at}.${k}`); if (w) return w; }
  return null;
}

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);

/** The first way `v` fails schema `s`, as `$.path: why`, or null. */
function schemaError(v, s, at = '$') {
  if (Object.hasOwn(s, 'type')) {
    const types = [].concat(s.type), t = typeOf(v);
    if (!types.includes(t) && !(t === 'integer' && types.includes('number'))) return `${at}: ${t} where the schema wants ${types.join(' or ')}`;
  }
  if (Object.hasOwn(s, 'enum') && !s.enum.some((e) => sameValue(e, v))) {
    return `${at}: ${JSON.stringify(v)} is not one of ${s.enum.map((e) => JSON.stringify(e)).join(', ')}`;
  }
  if (typeof v === 'number') {
    if (Object.hasOwn(s, 'minimum') && v < s.minimum) return `${at}: ${v} is below the minimum ${s.minimum}`;
    if (Object.hasOwn(s, 'maximum') && v > s.maximum) return `${at}: ${v} is above the maximum ${s.maximum}`;
  }
  if (Array.isArray(v)) {
    if (Object.hasOwn(s, 'minItems') && v.length < s.minItems) return `${at}: ${v.length} item(s) where the schema wants at least ${s.minItems}`;
    if (s.items) for (let i = 0; i < v.length; i++) {
      const e = schemaError(v[i], s.items, `${at}[${i}]`);
      if (e) return e;
    }
  }
  if (isObject(v)) {
    const props = s.properties || {};
    const missing = (s.required || []).find((k) => !Object.hasOwn(v, k));
    if (missing !== undefined) return `${at}: "${missing}" is required`;
    if (s.additionalProperties === false) {
      const extra = Object.keys(v).find((k) => !Object.hasOwn(props, k));
      if (extra !== undefined) return `${at}: "${extra}" is not allowed`;
    }
    for (const [k, sub] of Object.entries(props)) {
      if (!Object.hasOwn(v, k)) continue;
      const e = schemaError(v[k], sub, `${at}.${k}`);
      if (e) return e;
    }
  }
  return null;
}

/** The --schema file, read and checked: { file, doc }, or why it can't be used. */
function loadSchema(file) {
  let doc;
  try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return { error: `--schema ${file}: ${e instanceof SyntaxError ? `not JSON (${e.message})` : `cannot read it (${e.code || e.message})`}` }; }
  const problem = schemaProblem(doc);
  return problem ? { error: `--schema ${file}: ${problem}` } : { file: path.resolve(file), doc };
}

/**
 * The MCP servers a grok run in `cwd` would still start, from `grok inspect
 * --json` with the run's env. grok starts every configured server on every
 * run whatever --deny says, and nothing turns one off for a single call, so
 * any left means grok is not run. The parse is lib/containment.js
 * grokMcpFromInspect's, copied to keep this file standalone: output of any
 * other shape is an error, never "no servers". `projectHooks` names the
 * enabled hooks inspect says come from the project (none when it lists no
 * hooks at all).
 */
function grokMcpLeft(bin, cwd, env, { allow = [], grokHome = null } = {}) {
  const r = spawnSync(bin, ['inspect', '--json'], {
    cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024,
  });
  if (r.error || r.status !== 0) return { error: `grok inspect failed: ${tail(r.error?.message || r.stderr || `exit ${r.status}`)}` };
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const bad = (what) => ({ error: `grok inspect --json: ${what}` });
  let doc;
  try { doc = JSON.parse(r.stdout); } catch { return bad(`not JSON: ${tail(r.stdout)}`); }
  if (!isObj(doc) || !Array.isArray(doc.mcpServers) || !Array.isArray(doc.plugins)) return bad('no mcpServers and plugins lists');
  const left = [];
  for (const s of doc.mcpServers) {
    if (!isObj(s) || typeof s.name !== 'string' || !s.name) return bad('an mcpServers entry has no name');
    if (s.enabled !== undefined && typeof s.enabled !== 'boolean') return bad(`mcpServers ${s.name}: enabled is not a boolean`);
    if (s.compatibilityStatus !== undefined && typeof s.compatibilityStatus !== 'string') return bad(`mcpServers ${s.name}: compatibilityStatus is not a string`);
    if (s.compatibilityStatus === 'disabled' || s.enabled === false) continue;
    // A listed server may start only from grok's own config.toml: the same name from a project file still refuses.
    if (grokHome && allow.includes(s.name) && isObj(s.source) && s.source.type === 'configToml' && typeof s.source.path === 'string'
      && samePath(s.source.path, path.join(grokHome, 'config.toml'))) continue;
    left.push(s.name);
  }
  for (const pl of doc.plugins) {
    if (!isObj(pl) || typeof pl.name !== 'string' || !pl.name) return bad('a plugins entry has no name');
    if (pl.enabled !== undefined && typeof pl.enabled !== 'boolean') return bad(`plugin ${pl.name}: enabled is not a boolean`);
    const n = isObj(pl.provides) ? pl.provides.mcpServers : undefined;
    // Absent is not zero: only a stated whole-number count clears a plugin.
    if (!(Number.isInteger(n) && n >= 0)) return bad(`plugin ${pl.name}: provides.mcpServers is not a whole number`);
    if (pl.enabled !== false && n > 0) left.push(`${pl.name} (plugin)`);
  }
  const projectHooks = (Array.isArray(doc.hooks) ? doc.hooks : [])
    .filter((h) => isObj(h) && isObj(h.source) && h.source.type === 'project' && h.disabled !== true && h.compatibilityStatus !== 'disabled')
    .map((h) => `${h.source.path ?? '(project)'}: ${h.event ?? 'hook'}`);
  return { left, projectHooks, version: typeof doc.grokVersion === 'string' ? doc.grokVersion : null };
}

/**
 * Grok runs a trusted folder's own .grok/hooks/*.json on every call, and no
 * switch turns them off except turning folder trust off, which lets project
 * hooks run untrusted instead (GROK_FOLDER_TRUST=0, never used). So any
 * .grok/hooks entry from `cwd` up to the top of its repository keeps grok
 * from running, ~/.grok/hooks included when HOME is part of that repository.
 */
const samePath = (a, b) => {
  const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  return real(a) === real(b);
};

function grokHookFolders(cwd) {
  const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  const git = which('git');
  const top = git ? spawnSync(git, ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }) : null;
  const inRepo = top?.status === 0 && !!top.stdout.trim();
  const root = inRepo ? real(top.stdout.trim()) : real(cwd);
  // Outside a repository ~/.grok/hooks are your own hooks. Inside one (a repository at HOME, or one holding it)
  // they are the checkout's, like any other folder on the way up.
  const home = real(os.homedir());
  const found = [];
  for (let dir = real(cwd); ; dir = path.dirname(dir)) {
    const hooks = path.join(dir, '.grok', 'hooks');
    if (inRepo || dir !== home) {
      try { if (!fs.statSync(hooks).isDirectory() || fs.readdirSync(hooks).length) found.push(hooks); }
      catch (e) { if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') found.push(hooks); } // unreadable: assume it holds hooks
    }
    if (dir === root || path.dirname(dir) === dir) break;
  }
  return found;
}

/**
 * Codex has no strict-MCP flag, and `-c mcp_servers={}` is merged into the
 * table rather than replacing it. So each server `codex mcp list` reports for
 * this folder (project servers included) is switched off with one inline
 * table: a dotted -c path cannot quote a name holding '.', ':', '@' or '/'.
 * A server a plugin provides has no mcp_servers entry, so the override makes
 * one with no transport and codex refuses the whole config. When that check
 * fails, plugins go off as a whole (`features.plugins=false`, what `codex
 * --disable plugins` sets), and the override covers only the servers still
 * listed. Either way a last `mcp list` under the final overrides must show
 * every server disabled, or codex is not run. None of these calls reaches a model.
 */
function codexMcpOff(bin, cwd) {
  const list = (extra) => {
    const r = spawnSync(bin, ['mcp', 'list', '--json', ...extra], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
    if (r.error || r.status !== 0) return { error: `codex mcp list failed: ${tail(r.error?.message || r.stderr || r.stdout)}` };
    try {
      const servers = JSON.parse(r.stdout);
      if (Array.isArray(servers)) return { servers };
    } catch {}
    return { error: `codex mcp list printed no server list: ${tail(r.stdout)}` };
  };
  const names = (servers) => servers.map((s) => s?.name).filter((n) => typeof n === 'string');
  // JSON's string escapes are valid TOML basic-string escapes.
  const off = (servers) => ['-c', `mcp_servers={${names(servers).map((n) => `${JSON.stringify(n)}={enabled=false}`).join(',')}}`];
  const allOff = (args, check) => {
    const on = check.servers.filter((s) => s?.enabled !== false).map((s) => s?.name ?? '(unnamed)');
    return on.length ? { error: `codex MCP servers still enabled under the override: ${on.join(', ')}` } : { args };
  };
  const found = list([]);
  if (found.error) return found;
  if (!found.servers.length) return { args: [] };
  const check = list(off(found.servers));
  if (!check.error) return allOff(off(found.servers), check);

  const PLUGINS_OFF = ['-c', 'features.plugins=false'];
  const rest = list(PLUGINS_OFF);
  if (rest.error) return check;
  const left = new Set(names(rest.servers));
  const fromPlugins = names(found.servers).filter((n) => !left.has(n));
  // Only a server that leaves with the plugins explains the refusal; otherwise the first error stands.
  if (!fromPlugins.length) return check;
  const args = [...PLUGINS_OFF, ...(rest.servers.length ? off(rest.servers) : [])];
  const final = list(args);
  if (final.error) return { error: `${final.error} (with plugins off for ${fromPlugins.join(', ')})` };
  return allOff(args, final);
}

function parse(argv) {
  const o = { investigate: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') return { help: true };
    if (a === '--investigate' || a === '--json' || a === '--second') { o[a.slice(2)] = true; continue; }
    if (a === '--no-tools') { o.noTools = true; continue; }
    if (a === '--min-tools') { o.minTools = true; continue; }
    if (a === '--x-search') { o.xSearch = true; continue; }
    const key = VALUE_FLAGS[a];
    if (!key) return { error: `unexpected argument ${JSON.stringify(a)}` };
    const v = argv[++i];
    // An empty effort is allowed and means none; any other value must be there and not a flag.
    if (v === undefined || v.startsWith('-') || (v === '' && key !== 'effort')) return { error: `${a} needs a value` };
    if (o[key] !== undefined) return { error: `${a} given twice` };
    o[key] = v;
  }
  if ((o.role === undefined) === (o.family === undefined)) return { error: 'name exactly one of --role and --family' };
  if (o.second && o.role === undefined) return { error: '--second asks a role\'s second opinion; it needs --role' };
  if (o.effortFrom !== undefined) {
    if (o.family === undefined) return { error: '--effort-from needs --family (a role already has its effort)' };
    o.effortFrom = o.effortFrom.split(',').map((n) => n.trim());
    if (o.effortFrom.some((n) => !n)) return { error: '--effort-from takes role names separated by commas' };
  }
  if (o.promptFile === undefined) return { error: '--prompt-file is required' };
  if (o.noTools && o.investigate) return { error: '--no-tools and --investigate cannot both be given' };
  if (o.minTools && (o.investigate || o.noTools)) return { error: `--min-tools and ${o.investigate ? '--investigate' : '--no-tools'} cannot both be given` };
  if (o.xSearch) {
    const other = o.investigate ? '--investigate' : o.noTools ? '--no-tools' : o.minTools ? '--min-tools' : o.schemaFile !== undefined ? '--schema' : null;
    if (other) return { error: `--x-search and ${other} cannot both be given` };
  }
  if (o.effort && !EFFORTS.has(o.effort)) return { error: `--effort ${JSON.stringify(o.effort)} is not one of ${[...EFFORTS].join('/')} (or empty for none)` };
  return o;
}

/** family, id and effort ('' = none), or why not. A flag effort wins over the role's and the flavor's. */
function resolve(o) {
  if (o.role !== undefined) {
    const r = resolveRole(o.role);
    if (r.pauseError) process.stderr.write(`ask-model: ${r.pauseError} — nothing is paused until it is fixed\n`);
    if (r.error) return { error: r.error };
    const line = pauseLine(r);
    if (line) process.stderr.write(`ask-model: ${line}\n`);
    if (o.second) {
      if (r.altSkipped) return { error: `role "${o.role}"'s second opinion (${r.altSkipped.family}) is paused; resume ${r.altSkipped.by}, or name a family with --family` };
      if (!r.alt) return { error: `role "${o.role}" has no second opinion (alt); set one in ACS → Models → Roles` };
      return { family: r.alt, id: r.altId, effort: o.effort ?? r.altEffort ?? '' };
    }
    return { family: r.family, id: r.id, effort: o.effort ?? r.effort ?? '' };
  }
  const { registry, error } = loadRegistry();
  if (error) return { error: `model registry is invalid — ${error}` };
  // A family, never a raw id: the registry is where ids live.
  if (!Object.hasOwn(registry.models, o.family)) {
    return { error: `"${o.family}" is not a model family (known: ${Object.keys(registry.models).join(', ')})` };
  }
  const m = resolveModel(o.family);
  if (m.error) return { error: m.error };
  if (o.effort !== undefined) return { family: o.family, id: m.id, effort: o.effort };
  if (o.effortFrom !== undefined) {
    const e = familyEffort(o.family, o.effortFrom);
    if (e.error) return { error: e.error };
    return { family: o.family, id: m.id, effort: e.effort };
  }
  const f = resolveFlavor(o.family);
  if (f.error) return { error: f.error };
  return { family: o.family, id: m.id, effort: f.flavor.effort || '' };
}

/** The executable `name` on PATH, absolute entries only, so a repo's ./claude is never picked. */
function which(name) {
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!path.isAbsolute(dir)) continue;
    const p = path.join(dir, name);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      if (fs.statSync(p).isFile()) return p;
    } catch {}
  }
  return null;
}

/**
 * Every file whose state the after-call check compares: the work tree's .git (a folder, or a linked worktree's
 * gitfile), the git dir's commondir, the config and config.worktree of the git dir and common dir, and each file those
 * configs include (include.path, and every includeIf.*.path whatever its condition, up to git's 10 levels). The
 * after-call git never reads any of them, so a change here cannot make the check run a command; it is reported
 * because the caller's next git would read it. `git` is the confined git (confinedGit), which reads only the file it is given.
 */
function guardFiles(repo, git) {
  const files = [path.join(repo.root, '.git'), path.join(repo.gitDir, 'commondir'),
    ...[repo.gitDir, repo.commonDir].flatMap((d) => [path.join(d, 'config'), path.join(d, 'config.worktree')])];
  const seen = new Set();
  const walk = (file, depth) => {
    if (seen.has(file)) return;
    seen.add(file);
    // git stops at 10 levels of includes.
    if (depth > 10 || !fs.existsSync(file)) return;
    const r = git('config', '--file', file, '--no-includes', '--null', '--type=path', '--get-regexp', '^include(if\\..*)?\\.path$');
    for (const entry of String(r.stdout || '').split('\0')) {
      const value = entry.slice(entry.indexOf('\n') + 1);
      if (entry.includes('\n') && value) walk(path.resolve(path.dirname(file), value), depth + 1);
    }
  };
  for (const f of files) walk(f, 0);
  return [...seen];
}

/** Each file's state: missing, a folder, its sha256, or a symlink's target with the sha256 of what it points at. */
function gitGuard(files) {
  const hash = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  return new Map(files.map((f) => {
    let state = 'missing';
    try {
      const s = fs.lstatSync(f);
      if (s.isSymbolicLink()) {
        let to = 'missing';
        try { to = fs.statSync(f).isDirectory() ? 'dir' : hash(f); } catch (e) { if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') to = `unreadable ${e.code || e.message}`; }
        state = `link ${fs.readlinkSync(f)} ${to}`;
      } else state = s.isDirectory() ? 'dir' : `file ${hash(f)}`;
    } catch (e) { if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') state = `unreadable ${e.code || e.message}`; }
    return [f, state];
  }));
}

/**
 * Where the repository holding `cwd` is, or null outside a git work tree. This runs the caller's git as they would,
 * before the call, when the config is still theirs; rev-parse reads no index and runs no configured command. `env` is
 * the caller's, or for a submodule the caller's without the variables that route git to a repository (localEnv).
 */
function locateRepo(bin, cwd, env = process.env) {
  const where = spawnSync(bin, ['--no-optional-locks', 'rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir', '--show-object-format'],
    { cwd, env, encoding: 'utf8' });
  if (where.error || where.status !== 0) return null;
  const [root, gitDir, common, format] = where.stdout.split('\n');
  if (!root || !gitDir || !common) return null;
  const repo = { root, gitDir, commonDir: path.resolve(cwd, common), format: format || 'sha1' };
  // The ignore rules the caller's git uses outside the work tree, read now so the after-call git sees the same ones.
  const xf = spawnSync(bin, ['config', '--type=path', '--get', 'core.excludesFile'], { cwd: root, env, encoding: 'utf8' });
  const global = xf.status === 0 && xf.stdout.trim()
    ? xf.stdout.trim() : path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'git', 'ignore');
  // One file, so a later pattern wins: the global rules first, then info/exclude, which git ranks above them.
  repo.excludes = [global, path.join(repo.commonDir, 'info', 'exclude')]
    .map((f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } }).join('\n');
  return repo;
}

/**
 * The caller's env without the variables `rev-parse --local-env-vars` lists, so a GIT_DIR or GIT_WORK_TREE meant for
 * the superproject cannot answer for a submodule. GIT_CONFIG_PARAMETERS and GIT_CONFIG_COUNT are on that list but
 * kept, as git keeps them when it runs in a submodule: a caller's `git -c` or env-only settings apply there too.
 */
const KEPT_IN_SUBMODULES = ['GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT'];
function localEnv(bin) {
  const r = spawnSync(bin, ['rev-parse', '--local-env-vars'], { encoding: 'utf8' });
  const names = (r.status === 0 && r.stdout.trim() ? r.stdout.split('\n').filter(Boolean)
    : ['GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG', 'GIT_OBJECT_DIRECTORY', 'GIT_DIR',
      'GIT_WORK_TREE', 'GIT_IMPLICIT_WORK_TREE', 'GIT_GRAFT_FILE', 'GIT_INDEX_FILE', 'GIT_NO_REPLACE_OBJECTS', 'GIT_REPLACE_REF_BASE', 'GIT_PREFIX',
      'GIT_SHALLOW_FILE', 'GIT_COMMON_DIR']).filter((n) => !KEPT_IN_SUBMODULES.includes(n));
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !names.includes(k)));
}

/**
 * git confined to the data of `repo`: GIT_DIR and GIT_COMMON_DIR are a fresh temp folder holding a config ask-model
 * writes (no include, no filter or fsmonitor, no excludes or attributes file), a copy of HEAD, the pinned ignore rules,
 * and links to the repository's refs; the index and objects are the repository's, named by GIT_INDEX_FILE and
 * GIT_OBJECT_DIRECTORY. No GIT_* variable is inherited, the system and global configs are off, so no config git reads
 * is one the repository or the shell controls. What the shell can still write (.gitattributes, the index, refs,
 * objects) is data: an attribute names a filter, and no filter is defined. Status, ls-files and rev-parse run no
 * command but what config names.
 */
function confinedGit(bin, repo) {
  if (fs.existsSync(path.join(repo.commonDir, 'reftable'))) return { error: `${repo.root} keeps its refs in reftable, which the change check cannot read` };
  let dir;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-model-git-'));
    const sha256 = repo.format === 'sha256';
    fs.writeFileSync(path.join(dir, 'config'), `[core]\n\trepositoryformatversion = ${sha256 ? 1 : 0}\n\tbare = false\n\tfsmonitor = false\n`
      + `\tuntrackedCache = false\n\texcludesFile = ${os.devNull}\n\tattributesFile = ${os.devNull}\n${sha256 ? '[extensions]\n\tobjectFormat = sha256\n' : ''}`);
    fs.writeFileSync(path.join(dir, 'HEAD'), fs.readFileSync(path.join(repo.gitDir, 'HEAD')));
    fs.symlinkSync(path.join(repo.commonDir, 'refs'), path.join(dir, 'refs'));
    if (fs.existsSync(path.join(repo.commonDir, 'packed-refs'))) fs.symlinkSync(path.join(repo.commonDir, 'packed-refs'), path.join(dir, 'packed-refs'));
    // A split index keeps its shared part beside the index, and git looks for it in GIT_DIR.
    for (const f of fs.readdirSync(repo.gitDir)) if (f.startsWith('sharedindex.')) fs.symlinkSync(path.join(repo.gitDir, f), path.join(dir, f));
    fs.mkdirSync(path.join(dir, 'info'));
    fs.writeFileSync(path.join(dir, 'info', 'exclude'), repo.excludes ?? '');
  } catch (e) {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    return { error: `git could not be confined for ${repo.root} (${e.code || e.message})` };
  }
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
  Object.assign(env, { GIT_DIR: dir, GIT_COMMON_DIR: dir, GIT_WORK_TREE: repo.root, GIT_INDEX_FILE: path.join(repo.gitDir, 'index'),
    GIT_OBJECT_DIRECTORY: path.join(repo.commonDir, 'objects'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull, GIT_ATTR_NOSYSTEM: '1' });
  const git = (...a) => spawnSync(bin, ['--no-optional-locks', ...a], { cwd: repo.root, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { git, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** The guarded files of `repo` and its pinned submodules that changed, relative to `top`. */
function guardChanges(repo, top) {
  const now = gitGuard([...repo.guard.keys()]);
  return [...[...repo.guard.keys()].filter((f) => repo.guard.get(f) !== now.get(f)).map((f) => path.relative(top, f) || f),
    ...repo.subs.flatMap((s) => (s.repo ? guardChanges(s.repo, top) : []))];
}

/**
 * One repository's state through confined git, its submodules' folded in under their paths. `pinning` is the
 * before-call read: it fingerprints the guarded files and finds each submodule's repository (locateRepo); after the
 * call only the repositories pinned then are read, and a submodule that had none is compared by its folder listing.
 */
function readRepo(bin, repo, pinning) {
  const c = confinedGit(bin, repo);
  if (c.error) return c;
  try {
    const { git } = c;
    if (pinning) repo.guard = gitGuard(guardFiles(repo, git));
    const fail = (what, r) => ({ error: `git ${what} failed in ${repo.root}: ${(r.stderr || r.error?.message || '').trim() || `exit ${r.status}`}` });
    const commit = git('rev-parse', '--verify', '-q', 'HEAD');
    const branch = git('symbolic-ref', '-q', '--short', 'HEAD');
    const heads = new Map([['', `${commit.status === 0 ? commit.stdout.trim().slice(0, 12) : '(no commit)'} (${branch.status === 0 ? branch.stdout.trim() : 'detached'})`]]);
    // Submodules are read below, each through its own confined git: git's own recursion would run a git that reads
    // the submodule's config.
    const st = git('status', '--porcelain=v2', '-z', '--untracked-files=all', '--ignore-submodules=all');
    if (st.error || st.status !== 0) return fail('status', st);
    const seen = new Map();
    const fields = st.stdout.split('\0');
    for (let i = 0; i < fields.length; i++) {
      const e = fields[i];
      // v2 entries: `1 XY sub mH mI mW hH hI path`, `2 … score path` then the old path, `u …` (10 fields before
      // the path), `? path`. A path may hold spaces, so it is everything after the fixed fields.
      let file, fixed;
      if (e[0] === '?') { fixed = '??'; file = e.slice(2); }
      else if (e[0] === '1' || e[0] === '2' || e[0] === 'u') {
        const words = e.split(' ');
        const at = { 1: 8, 2: 9, u: 10 }[e[0]];
        fixed = words.slice(1, at).join(' ');
        file = words.slice(at).join(' ');
        if (e[0] === '2') i++;
      } else continue;
      let stamp = 'missing';
      try { const s = fs.lstatSync(path.join(repo.root, file)); stamp = `${s.mode}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`; } catch {}
      seen.set(file, `${fixed} ${stamp}`);
    }
    // The index's submodule entries, so a staged submodule commit shows though status leaves submodules out.
    const ls = git('ls-files', '--stage', '-z');
    if (ls.error || ls.status !== 0) return fail('ls-files', ls);
    const links = [];
    for (const e of ls.stdout.split('\0')) {
      if (!e.startsWith('160000 ')) continue;
      const tab = e.indexOf('\t');
      const p = e.slice(tab + 1);
      // Every stage of a conflicted entry, after the status line status may have given it.
      seen.set(p, `${seen.has(p) ? `${seen.get(p)} ` : ''}submodule ${e.slice(7, tab)}`);
      if (!links.includes(p)) links.push(p);
    }
    if (pinning) {
      const env = links.length ? localEnv(bin) : null;
      repo.subs = links.map((p) => {
        const root = path.join(repo.root, p);
        const sub = fs.existsSync(path.join(root, '.git')) ? locateRepo(bin, root, env) : null;
        return { path: p, repo: sub && fs.realpathSync(sub.root) === fs.realpathSync(root) ? sub : null };
      });
    }
    for (const p of new Set([...repo.subs.map((s) => s.path), ...links])) {
      const pinned = repo.subs.find((s) => s.path === p)?.repo;
      if (!pinned) {
        let names = 'missing';
        try { names = fs.readdirSync(path.join(repo.root, p)).sort().join('\0'); } catch {}
        seen.set(`${p}/`, `not checked out: ${names}`);
        continue;
      }
      const sub = readRepo(bin, pinned, pinning);
      if (sub.error) return sub;
      for (const [k, v] of sub.heads) heads.set(k ? `${p}/${k}` : p, v);
      for (const [k, v] of sub.paths) seen.set(`${p}/${k}`, v);
    }
    return { heads, paths: seen, repo };
  } finally { c.done(); }
}

/**
 * The work tree's state, null outside a git work tree, or { error } when git is not on PATH (absolute entries only) or
 * the repository can't be read: HEAD (its commit and branch), so a checkout that leaves the status clean still shows,
 * and every path `git status` reports with its porcelain fields (status, modes, and the HEAD and index object names,
 * so a change to the index shows) and the file's mode, size, mtime and ctime (so a write or chmod to a file that was
 * already dirty shows); each checked-out submodule the same way, under its path. Ignored files and anything outside
 * the repository are not seen. --no-optional-locks: reading must not write the index.
 * Before the call git runs once as the caller would, to find the repository (locateRepo); every read runs confined
 * git (confinedGit). `pin`, the before-snapshot, is checked first: when a guarded file changed, git is not run at all
 * and the result is { tampered }, naming them. A repository that can't be read after the call gives null.
 */
function snapshot(cwd, pin = null) {
  // git from an absolute PATH entry only (which), so a repo's ./git never answers for the work tree.
  const bin = which('git');
  if (!bin) return { error: 'git is not on PATH' };
  if (pin) {
    const tampered = guardChanges(pin.repo, pin.repo.root);
    if (tampered.length) return { tampered: tampered.sort() };
    const after = readRepo(bin, pin.repo, false);
    return after?.error ? null : after;
  }
  const repo = locateRepo(bin, cwd);
  return repo && readRepo(bin, repo, true);
}

/** What differs: each moved HEAD first (the work tree's, then a submodule's under its path), naming both commits, then each path. */
function changedPaths(before, after) {
  const moved = [...new Set([...before.heads.keys(), ...after.heads.keys()])].filter((k) => before.heads.get(k) !== after.heads.get(k))
    .map((k) => `${k ? `${k}: ` : ''}HEAD ${before.heads.get(k) ?? '(none)'} → ${after.heads.get(k) ?? '(none)'}`);
  const { paths: b } = before;
  const { paths: a } = after;
  return [...moved, ...[...new Set([...b.keys(), ...a.keys()])].filter((p) => b.get(p) !== a.get(p)).sort()];
}

/** Run the CLI with stdin from /dev/null; a signal to ask-model goes on to the CLI. */
function run(bin, argv, cwd, env) {
  return new Promise((done) => {
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    let child;
    let finished = false;
    const forward = (sig) => { try { child.kill(sig); } catch {} };
    const finish = (r) => {
      if (finished) return;
      finished = true;
      for (const s of signals) process.off(s, forward);
      done(r);
    };
    try {
      child = spawn(bin, argv, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      finish({ error: e });
      return;
    }
    for (const s of signals) process.on(s, forward);
    const out = [];
    const err = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', (e) => finish({ error: e }));
    child.on('close', (code, signal) => finish({
      code, signal, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'),
    }));
  });
}

const tail = (s) => String(s || '').trim().slice(-500) || '(no output)';

/**
 * Grok labels the usage of a model it was asked for by id as `<id>-build`, so that row alone proves nothing; grok's
 * own record of the session does. null when <GROK_HOME>/sessions/<URL-encoded real cwd>/<sessionId>/ has a
 * summary.json for that session whose current_model_id is `id`, and an events.jsonl whose every model_id is `id`;
 * else why not.
 */
function grokBuildProof(id, sessionId, cwd, grokHome) {
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(sessionId)) return 'grok reported no session id to look it up by';
  let real;
  try { real = fs.realpathSync(cwd); } catch (e) { return `its folder could not be resolved (${e.code || e.message})`; }
  const group = encodeURIComponent(real);
  // A longer name grok replaces with a slug and a hash, which this does not look up.
  if (Buffer.byteLength(group) > 255) return 'its session folder name is too long to look up';
  const dir = path.join(grokHome, 'sessions', group, sessionId);
  let summary;
  try { summary = JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8')); } catch (e) {
    return `${path.join(dir, 'summary.json')} could not be read (${e.code || 'not JSON'})`;
  }
  if (!isObject(summary) || !isObject(summary.info) || summary.info.id !== sessionId) return 'its session summary is for another session';
  if (summary.current_model_id !== id) return `its session summary names ${JSON.stringify(summary.current_model_id ?? null)}`;
  let lines;
  try { lines = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').split('\n').filter((l) => l.trim()); } catch (e) {
    return `${path.join(dir, 'events.jsonl')} could not be read (${e.code || e.message})`;
  }
  const named = [];
  const walk = (v) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (isObject(v)) for (const [k, x] of Object.entries(v)) { if (k === 'model_id') named.push(x); walk(x); }
  };
  for (const line of lines) {
    try { walk(JSON.parse(line)); } catch { return 'its session events hold a line that is not JSON'; }
  }
  if (!named.length) return 'its session events name no model';
  const other = named.find((x) => x !== id);
  return other === undefined ? null : `its session events name ${JSON.stringify(other)}`;
}

/**
 * The answer from one CLI's output, or an exit code and why. With a schema, the structured answer: claude's
 * structured_output (else its result), grok's structuredOutput (else its text), codex's stdout, as JSON text.
 */
function readAnswer(vendor, id, r, schema = null, { cwd, grokHome } = {}) {
  if (r.error) return { exit: r.error.code === 'ENOENT' ? 3 : 4, error: `${vendor} could not start: ${r.error.message}` };
  if (r.signal) return { exit: 4, error: `${vendor} was stopped by ${r.signal}` };
  let answer;
  if (vendor === 'codex') {
    // Codex reports no model, so its answer cannot be checked; the review runtime has no check either.
    if (r.code !== 0) return { exit: 4, error: `codex exited ${r.code}: ${tail(r.stderr || r.stdout)}` };
    answer = r.stdout;
  } else {
    let env;
    try { env = JSON.parse(r.stdout); } catch {
      return { exit: 4, error: `${vendor} exited ${r.code} without a JSON reply: ${tail(r.stdout || r.stderr)}` };
    }
    if (vendor === 'claude') {
      // With the user's verbose setting on, the JSON is every event in a list; the reply is its last result.
      if (Array.isArray(env)) env = env.findLast((e) => e?.type === 'result') ?? null;
      if (env === null) return { exit: 4, error: `claude printed no result event: ${tail(r.stdout)}` };
      if (env?.is_error !== false) {
        const errors = Array.isArray(env?.errors) && env.errors.length ? env.errors.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('; ') : null;
        return { exit: 4, error: `claude returned an error: ${tail(env?.result ?? errors ?? r.stderr)}` };
      }
      if (r.code !== 0) return { exit: 4, error: `claude exited ${r.code}: ${tail(r.stderr)}` };
      const used = Object.keys(env.modelUsage || {});
      if (!used.includes(id)) return { exit: 2, error: `asked for ${id}, but ${used.length ? used.join(', ') : 'no model'} answered — not its answer` };
      answer = schema && isObject(env.structured_output) ? JSON.stringify(env.structured_output) : env.result;
    } else {
      if (env?.type === 'error' || r.code !== 0) return { exit: 4, error: `grok failed (exit ${r.code}): ${tail(env?.message ?? r.stderr)}` };
      // The resolved id itself, as for claude: neither the registry nor the review runtime names a grok alias.
      // Only one usage row: the id, or `<id>-build` when grok's session record names the id. Any other row beside
      // it is a model whose part in the answer can't be told apart, so a mix refuses.
      const used = Object.keys(env.modelUsage || {});
      if (used.length !== 1 || used[0] !== id) {
        const why = used.length > 1 ? 'more than one model in its usage'
          : used[0] === `${id}-build` ? grokBuildProof(id, env.sessionId, cwd, grokHome) : '';
        if (why !== null) {
          const confirm = used.length > 1 ? ` (${why})` : why ? ` and grok's session record does not confirm ${id} (${why})` : '';
          return { exit: 2, error: `asked for ${id}, but ${used.length ? used.join(', ') : 'no model'} answered${confirm} — not its answer` };
        }
      }
      const structured = env.structuredOutput;
      answer = schema && structured != null ? (typeof structured === 'string' ? structured : JSON.stringify(structured)) : env.text;
    }
  }
  if (typeof answer !== 'string' || !answer.trim()) return { exit: 4, error: `${vendor} returned an empty answer` };
  if (!schema) return { answer: answer.trimEnd() };
  let value;
  try { value = JSON.parse(answer); } catch (e) { return { exit: 6, error: `the answer is not JSON (${e.message}): ${tail(answer)}` }; }
  const huge = nonFinite(value);
  if (huge) return { exit: 6, error: `the answer is not usable JSON: ${huge} is not a finite number` };
  const wrong = schemaError(value, schema.doc);
  if (wrong) return { exit: 6, error: `the answer does not match --schema ${schema.file}: ${wrong}` };
  return { answer: JSON.stringify(value, null, 2) };
}

async function main(argv) {
  const o = parse(argv);
  if (o.help) { process.stdout.write(`${USAGE}\n`); return 0; }
  const usage = (why) => { process.stderr.write(`ask-model: ${why}\n${USAGE}\n`); return 64; };
  if (o.error) return usage(o.error);

  let prompt;
  try { prompt = fs.readFileSync(o.promptFile, 'utf8'); } catch (e) { return usage(`cannot read --prompt-file: ${e.code || e.message}`); }
  if (!prompt.trim()) return usage(`--prompt-file ${o.promptFile} is empty`);
  if (prompt.includes('\0')) return usage(`--prompt-file ${o.promptFile} holds a NUL byte`);
  // A leading '-' would be read as a flag by every one of these CLIs; a newline before it is not.
  if (prompt.startsWith('-')) prompt = `\n${prompt}`;
  const cwd = path.resolve(o.cwd ?? process.cwd());
  try { if (!fs.statSync(cwd).isDirectory()) return usage(`--cwd ${cwd} is not a directory`); } catch { return usage(`--cwd ${cwd} does not exist`); }
  const schema = o.schemaFile === undefined ? null : loadSchema(o.schemaFile);
  if (schema?.error) return usage(schema.error);

  const m = resolve(o);
  if (m.error) return usage(m.error);
  const vendor = vendorOf(m.id);
  if (!vendor) return usage(`${m.family} resolves to "${m.id}", whose prefix names no known CLI (claude-, gpt-, grok-)`);
  if (o.xSearch && vendor !== 'grok') return usage(`--x-search uses grok's own X tools, so it needs a family grok runs; ${m.family} resolves to "${m.id}" (${vendor})`);
  // --min-tools is --no-tools for a CLI that can run with none.
  const mode = o.xSearch ? 'x-search' : o.investigate ? 'investigate' : o.noTools || (o.minTools && vendor === 'claude') ? 'no-tools' : o.minTools ? 'min-tools' : 'read-only';
  process.stderr.write(`ask-model: ${m.family} (${m.id}, effort ${m.effort || 'none'}, ${mode})\n`);

  const result = { family: m.family, id: m.id, effort: m.effort || null, mode, ...(o.minTools && MIN_TOOLS[vendor]), ...(mode === 'x-search' && X_SEARCH_TOOLS),
    ...(mode === 'investigate' && { shellSandbox: SHELL_SANDBOX[vendor] }), answer: null, changed: null, error: null };
  let grokCall = null;
  const finish = (exit) => {
    grokCall?.done();
    if (result.error) process.stderr.write(`ask-model: ${result.error}\n`);
    if (o.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else if (result.answer !== null) process.stdout.write(`${result.answer}\n`);
    return exit;
  };

  if (mode === 'no-tools' && !Object.hasOwn(TOOLS[vendor] || {}, 'no-tools')) {
    result.error = `${vendor} cannot run with no tools (it has no switch that removes every tool) — not asked`;
    return finish(4);
  }
  const unsandboxed = mode === 'investigate' ? sandboxProblem(vendor) : null;
  if (unsandboxed) { result.error = `${unsandboxed}, so --investigate would give the model a shell its sandbox does not confine — ${vendor} was not run`; return finish(4); }
  const bin = which(vendor);
  if (!bin) { result.error = `the ${vendor} CLI is not on PATH`; return finish(3); }

  let mcpOff = [];
  if (vendor === 'codex') {
    const off = codexMcpOff(bin, cwd);
    if (off.error) { result.error = `${off.error} — codex was not run`; return finish(4); }
    mcpOff = off.args;
  }
  if (vendor === 'grok') grokCall = grokCallEnv();
  const env = grokCall ? grokCall.env : process.env;
  if (vendor === 'grok') {
    const leader = grokLeader(grokCall.grokHome);
    if (leader) {
      result.error = `${leader.unclear ? `grok's leader mode could not be ruled out (${leader.file}: ${leader.unclear})`
        : leader.patch ? `grok's leader mode could not be ruled out (use_leader in an [[${leader.patch}]] entry of ${leader.file})`
          : `grok's leader mode is on (use_leader in ${leader.file})`}: ` +
        'a leader session runs with its own HOME, where MCP servers this check cannot see may start, so grok was not run.';
      return finish(4);
    }
    const allow = grokMcpAllow();
    if (allow.error) { result.error = `${allow.error}, so grok was not run`; return finish(4); }
    const hooks = grokHookFolders(cwd);
    if (hooks.length) {
      result.error = `${hooks.join(', ')} holds Grok hooks, which grok runs on every call in a trusted folder and no flag turns off, so grok was not run. ` +
        'Ask another family, or run from a folder without them.';
      return finish(4);
    }
    const mcp = grokMcpLeft(bin, cwd, env, { allow: allow.names, grokHome: grokCall.grokHome });
    if (mcp.error) { result.error = `${mcp.error} — no MCP server could be ruled out, so grok was not run`; return finish(4); }
    if (mcp.left.length) {
      result.error = `grok would start MCP servers no flag keeps out of a run (${mcp.left.join(', ')}), so grok was not run. ` +
        'Turn them off with `grok mcp disable <name>` (a plugin\'s: `grok plugin disable <name>`), or list a server grok\'s own ' +
        'config.toml defines in grokMcpAllow (the review gate\'s home config) to let it start; its tools stay denied.';
      return finish(4);
    }
    if (mcp.projectHooks.length) {
      result.error = `grok would run this project's hooks (${mcp.projectHooks.join(', ')}), so grok was not run.`;
      return finish(4);
    }
    if (mode === 'x-search' && mcp.version !== GROK_X_VERSION) {
      result.error = `grok inspect reports grok ${mcp.version ?? '(no version)'}, but --x-search's tool list was checked against grok ${GROK_X_VERSION}: `
        + 're-check the X-search tool list (GROK_X_DENY in ask-model) for this grok before using it, so grok was not run.';
      return finish(4);
    }
  }

  const before = o.investigate ? snapshot(cwd) : null;
  if (before?.error) { result.error = `${before.error}, so changes under --investigate could not be checked — ${vendor} was not run`; return finish(4); }
  if (o.investigate && !before) process.stderr.write(`ask-model: ${cwd} is not in a git work tree — changes are not checked\n`);
  const r = await run(bin, argvFor(vendor, { ...m, prompt, cwd, mode, mcpOff, schema }), cwd, env);
  // A call grok refused for want of approval leaves only this line, and grok still exits 0.
  if (vendor === 'grok') {
    for (const line of String(r.stderr || '').split('\n')) if (/permission required:/.test(line)) process.stderr.write(`ask-model: grok: ${line.trim()}\n`);
  }
  const got = readAnswer(vendor, m.id, r, schema, { cwd, grokHome: grokCall?.grokHome });
  if (got.answer !== undefined) result.answer = got.answer;
  else result.error = got.error;

  if (before) {
    const read = snapshot(cwd, before);
    const after = read && !read.error && !read.tampered ? read : null;
    result.changed = read?.tampered ? read.tampered.map((f) => `${f} (git's own files: git was not run after the call)`)
      : after ? changedPaths(before, after) : null;
    if (!after || result.changed.length) {
      const what = result.changed ? result.changed.map((c) => `  ${c}`).join('\n') : '  (the work tree could not be read after the call)';
      // A failed call is still reported; the change is what the caller must act on.
      result.error = [result.error, `files changed under --investigate (nothing was reverted):\n${what}`].filter(Boolean).join('\n');
      return finish(5);
    }
  }
  return finish(got.exit ?? 0);
}

/**
 * For `model-id --install`, after it has copied the resolver: this file beside
 * it (resolver/bin/ask-model.mjs, so ../lib/ is the resolver's lib), a launcher
 * pinned to the node running the install, and ~/.local/bin/ask-model linked to
 * it. Returns the lines to print, and an error when the link is refused.
 */
export function install({ home, studio, resolver }) {
  const tilde = (p) => (p.startsWith(home + path.sep) ? '~' + p.slice(home.length) : p);
  const put = (dest, body, mode) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    // A fresh random name, created exclusively: a link planted at a guessable name is never written through.
    const tmp = `${dest}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    try {
      fs.writeFileSync(tmp, body, { mode, flag: 'wx' });
      fs.renameSync(tmp, dest);
    } finally { fs.rmSync(tmp, { force: true }); }
  };
  const entry = path.join(resolver, 'bin', 'ask-model.mjs');
  put(entry, fs.readFileSync(SELF), 0o644);
  const q = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
  const launcher = path.join(studio, 'bin', 'ask-model');
  put(launcher, [
    '#!/bin/sh',
    '# Installed by `model-id --install` from Agent Config Studio. Re-run that to update.',
    `NODE=${q(process.execPath)}`,
    '# Pinned path first, then node on PATH, then Homebrew\'s default; otherwise fail loudly.',
    '[ -x "$NODE" ] || NODE=$(command -v node 2>/dev/null) || NODE=',
    '[ -n "$NODE" ] || { [ -x "${MODEL_ID_BREW_NODE:-/opt/homebrew/bin/node}" ] && NODE=${MODEL_ID_BREW_NODE:-/opt/homebrew/bin/node}; }',
    'if [ -z "$NODE" ]; then',
    '  echo "ask-model: node not found" >&2',
    '  exit 3',
    'fi',
    `exec "$NODE" ${q(entry)} "$@"`,
    '',
  ].join('\n'), 0o755);

  const lines = `launcher  ${tilde(launcher)}\n`;
  const link = path.join(home, '.local', 'bin', 'ask-model');
  fs.mkdirSync(path.dirname(link), { recursive: true });
  let existing = null;
  try { existing = fs.lstatSync(link); } catch {}
  if (existing && !existing.isSymbolicLink()) return { lines, error: `${tilde(link)} exists and is not a symlink — not replacing it.` };
  if (existing) fs.unlinkSync(link);
  fs.symlinkSync(launcher, link);
  return { lines: `${lines}linked    ${tilde(link)} → ${tilde(launcher)}\n` };
}

// Run as a command, not when model-id imports it for install().
const isMain = (() => { try { return fs.realpathSync(process.argv[1]) === SELF; } catch { return false; } })();
if (isMain) process.exitCode = await main(process.argv.slice(2));
