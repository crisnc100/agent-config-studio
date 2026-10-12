#!/usr/bin/env node
import os from 'node:os';
import { loadRoots, addRoot, removeRoot, EDIT_GRANTS } from '../lib/roots.js';

/**
 * `acs roots` — which folders the studio reads and edits.
 *
 * Every change goes through lib/roots.js, the same module a future browser
 * route will call, so the reject list exists once. A running studio notices
 * the file change by itself; nothing here talks to the server.
 */

const C = process.stdout.isTTY && !process.env.NO_COLOR
  ? { dim: (s) => `\x1b[2m${s}\x1b[0m`, bold: (s) => `\x1b[1m${s}\x1b[0m`,
      yellow: (s) => `\x1b[33m${s}\x1b[0m`, red: (s) => `\x1b[31m${s}\x1b[0m` }
  : new Proxy({}, { get: () => (s) => s });

const home = os.homedir();
const tilde = (p) => (p === home || p.startsWith(home + '/') ? '~' + p.slice(home.length) : p);

function usage() {
  console.log(`usage:
  acs roots ls [--json]
  acs roots add <path> [--edit] [--label <name>]   (read-only unless --edit)
  acs roots rm <id>`);
}

function ls(argv) {
  const r = loadRoots();
  if (argv.includes('--json')) { console.log(JSON.stringify(r, null, 2)); return r.state === 'error' ? 1 : 0; }
  if (r.state === 'error') {
    console.error(C.red(`${r.error}\n`) + `The studio is using no project folders until ${tilde(r.path)} is fixed or removed.`);
    return 1;
  }
  if (r.state === 'absent') console.log(C.dim(`${tilde(r.path)} does not exist yet — showing what the first start will write.`));
  if (!r.roots.length) {
    console.log(`\nNo project folders yet.\n\n  ${C.bold('acs roots add')} <path>          read-only: listed in Context, Skills and Worktrees` +
                `\n  ${C.bold('acs roots add')} <path> --edit   also editable in the studio\n`);
  }
  for (const x of r.roots) {
    const status = x.status === 'missing' ? C.yellow('  missing — inactive until the folder is back') : '';
    console.log(`  ${x.id.padEnd(18)} ${x.access.padEnd(5)} ${tilde(x.path)}  ${C.dim(x.label)}${status}`);
  }
  for (const bad of r.invalid) {
    console.log(C.red(`  skipped ${JSON.stringify(bad.entry?.id ?? bad.entry)}: ${bad.reason}`));
  }
  return 0;
}

function add(argv) {
  const rest = [];
  let access = 'read', label;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--edit') access = 'edit';
    else if (argv[i] === '--read') access = 'read';
    else if (argv[i] === '--label') label = argv[++i];
    else rest.push(argv[i]);
  }
  if (rest.length !== 1) { usage(); return 2; }
  const { root } = addRoot({ path: rest[0], access, label });
  console.log(`added "${root.id}" (${root.access}) ${tilde(root.path)}`);
  if (root.access === 'edit') console.log(C.dim(EDIT_GRANTS));
  return 0;
}

function rm(argv) {
  if (argv.length !== 1) { usage(); return 2; }
  const { removed } = removeRoot(argv[0]);
  console.log(`removed "${removed.id}" ${tilde(removed.path)} — the folder itself is untouched`);
  return 0;
}

const [cmd, ...argv] = process.argv.slice(2);
const run = { ls, list: ls, add, rm, remove: rm }[cmd || 'ls'];
if (!run) { usage(); process.exit(2); }
try { process.exit(run(argv)); }
catch (e) { console.error(`acs roots: ${e.message}`); process.exit(1); }
