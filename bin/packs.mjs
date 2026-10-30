#!/usr/bin/env node
/**
 * acs packs — install the recommended skill packs in packs/, see what they
 * are and whether they work, update them and take them out again.
 *
 * Nothing is written until the preview has been shown and confirmed
 * (--yes, or a y at the prompt). lib/packs.js holds every rule.
 */
import readline from 'node:readline';
import {
  PREVIEW_SYMBOL as SYMBOL, PREVIEW_WHAT as WHAT, STATUS, apply, explainOf, getPack, loadCatalog, machine, planInstall, planUninstall, planUpdate, status,
} from '../lib/packs.js';
import { readState } from '../lib/packs-files.js';

const USAGE = `usage: acs packs list [--json]
       acs packs explain <id>
       acs packs install <id> [--part <part>]... [--harness claude,codex,grok] [--force] [--with-deps]
                              [--fix-roles] [--set-role <role>=<family>[,<family>...]] [--dry-run] [--yes] [--json]
       acs packs status [<id>] [--no-trust-check] [--json]
       acs packs update [<id>] [--replace] [--dry-run] [--yes] [--json]
       acs packs uninstall <id> [--part <part>]... [--force] [--dry-run] [--yes] [--json]`;

// exitCode, not exit(): a large preview piped to another process must flush first.
class Stop extends Error {}
const die = (msg, code = 2) => { process.stderr.write(`${msg}\n`); process.exitCode = code; throw new Stop(); };

function parse(argv) {
  const out = { _: [], parts: [], setRoles: {} };
  const list = (v) => v.split(',').map((s) => s.trim()).filter(Boolean);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { const v = argv[++i]; if (v === undefined || v.startsWith('--')) die(`${a} needs a value\n${USAGE}`); return v; };
    if (a === '--part') out.parts.push(...list(val()));
    else if (a === '--harness') out.harnesses = list(val());
    else if (a === '--set-role') {
      const [role, fams] = val().split('=');
      if (!role || !fams) die(`--set-role needs <role>=<family>[,<family>...]\n${USAGE}`);
      out.setRoles[role] = list(fams);
    } else if (['--force', '--with-deps', '--fix-roles', '--dry-run', '--yes', '--json', '--replace', '--no-trust-check'].includes(a)) {
      out[a.slice(2).replace(/-(.)/g, (_, c) => c.toUpperCase())] = true;
    } else if (a.startsWith('--')) die(`unknown option ${a}\n${USAGE}`);
    else out._.push(a);
  }
  return out;
}

const m = machine();
const home = (p) => (p && (p === m.home || p.startsWith(`${m.home}/`)) ? `~${p.slice(m.home.length)}` : p);
const say = (s = '') => process.stdout.write(`${s}\n`);

function printExplain(pack) {
  say(`${pack.title} (${pack.id} ${pack.version})`);
  say(pack.summary);
  const block = (e, indent = '') => {
    say(`${indent}What it is: ${e.what}`);
    say(`${indent}Day to day: ${e.does}`);
    say(`${indent}What it changes:`);
    for (const c of e.changes) say(`${indent}  - ${c}`);
    say(`${indent}How to undo it: ${e.undo}`);
  };
  say();
  block(pack.explain);
  for (const part of pack.parts) {
    say();
    say(`Part ${part.id}: ${part.title} — ${part.default ? 'on by default' : 'off unless you add it with --part'} (${part.kind}${part.harnesses.length ? `; ${part.harnesses.join(', ')}` : ''})`);
    block(explainOf(pack, part), '  ');
  }
}

function printPlan(plan) {
  const verb = { install: 'Install', update: 'Update', uninstall: 'Uninstall' }[plan.action];
  say(`${verb}: ${plan.packs.join(', ')}${plan.units.length ? ` — ${plan.units.map((u) => `${u.key}${u.harnesses?.length ? ` (${u.harnesses.join(', ')})` : ''}`).join(', ')}` : ''}`);
  if (plan.requirements.length) {
    say('Requirements:');
    for (const r of plan.requirements) say(`  ${r.ok ? '✓' : '✖'} ${r.what}${r.ok ? '' : ` — fix: ${r.fix}`}`);
  }
  for (const n of plan.notes) say(`note: ${n}`);
  const files = plan.preview.filter((r) => !r.setting);
  const settings = plan.preview.filter((r) => r.setting);
  if (files.length) {
    say('Will change:');
    for (const r of files) say(`  ${SYMBOL[r.action] || '?'} ${home(r.path)}  ${WHAT[r.action] || r.action}${r.note ? ` — ${r.note}` : ''}`);
  }
  if (settings.length) {
    say('Settings:');
    for (const r of settings) say(`  ~ ${r.setting.replace(m.home, '~')}`);
  }
  for (const w of plan.warnings) say(`warning: ${w}`);
  for (const k of plan.kept || []) say(`kept: ${home(k.path)} — ${k.why}`);
  for (const r of plan.refusals) process.stderr.write(`✖ ${r}\n`);
  if (!plan.ops.length && !plan.refusals.length) say('Nothing to change.');
}

async function confirm(question) {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((r) => rl.question(`${question} [y/N] `, r));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

async function decide(plan, opts, rebuild) {
  // A missing pack dependency or a role with no installed CLI can be fixed right here, with consent.
  if (process.stdin.isTTY && !opts.yes) {
    if (!opts.withDeps && plan.refusals.some((r) => /add --with-deps/.test(r)) && plan.refusals.length === plan.refusals.filter((r) => /add --with-deps/.test(r)).length) {
      printPlan(plan);
      if (await confirm('Add the pack it needs now?')) { opts.withDeps = true; plan = rebuild(); }
    }
    if (!opts.fixRoles && plan.roles?.some((r) => !r.set && r.suggestion.length)) {
      for (const r of plan.roles.filter((x) => !x.set)) say(`The ${r.role} role uses ${r.use.join(', ') || 'nothing'}, and none of their CLIs is installed here.`);
      if (await confirm(`Set ${plan.roles.filter((x) => !x.set).map((r) => `${r.role} to ${r.suggestion.join(', ')}`).join('; ')} (through ACS's roles)?`)) { opts.fixRoles = true; plan = rebuild(); }
    }
  }
  return plan;
}

async function change(plan, opts, rebuild) {
  plan = await decide(plan, opts, rebuild);
  if (opts.json) process.stdout.write(`${JSON.stringify({ action: plan.action, packs: plan.packs, units: plan.units, preview: plan.preview, requirements: plan.requirements, refusals: plan.refusals, warnings: plan.warnings, notes: plan.notes, kept: plan.kept || [], roles: plan.roles }, null, 2)}\n`);
  else printPlan(plan);
  if (plan.refusals.length) { process.exitCode = 1; return; }
  if (!plan.ops.length || opts.dryRun) return;
  if (!opts.yes && !(await confirm('Proceed?'))) die(process.stdin.isTTY ? 'Nothing was changed.' : 'Nothing was changed: re-run with --yes to make these changes.', 1);
  try {
    const r = await apply(plan, { m, log: (s) => { if (s) process.stderr.write(`${s}\n`); } });
    for (const k of r.kept) process.stderr.write(`kept: ${home(k.path)} — ${k.why}\n`);
    process.stderr.write(`done${r.backupDir ? ` — backups in ${home(r.backupDir)}` : ''}\n`);
  } catch (e) { if (e instanceof Stop) throw e; die(`✖ ${e.message}`, 1); }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const opts = parse(rest);
  const catalog = loadCatalog();
  if (!cmd || cmd === 'help' || cmd === '--help') { say(USAGE); return; }
  if (cmd === 'list') {
    const state = readState(m.statePath);
    const rows = catalog.map((p) => ({ id: p.id, title: p.title, version: p.version, summary: p.summary, installed: Object.keys(state.packs[p.id]?.parts || {}) }));
    if (opts.json) { process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`); return; }
    for (const r of rows) say(`${r.id.padEnd(15)} ${r.installed.length ? `installed (${r.installed.join(', ')})` : 'not installed'}\n  ${r.summary}`);
    return;
  }
  if (cmd === 'explain') {
    if (opts._.length !== 1) die(USAGE);
    const pack = getPack(opts._[0], catalog);
    if (opts.json) { process.stdout.write(`${JSON.stringify({ ...pack, parts: pack.parts.map((p) => ({ ...p, explain: explainOf(pack, p) })) }, null, 2)}\n`); return; }
    printExplain(pack);
    return;
  }
  if (cmd === 'install') {
    if (opts._.length !== 1) die(USAGE);
    const rebuild = () => planInstall(opts._[0], opts, m);
    return change(rebuild(), opts, rebuild);
  }
  if (cmd === 'update') {
    if (opts._.length > 1) die(USAGE);
    const rebuild = () => planUpdate(opts._, opts, m);
    return change(rebuild(), opts, rebuild);
  }
  if (cmd === 'uninstall') {
    if (opts._.length !== 1) die(USAGE);
    const rebuild = () => planUninstall(opts._[0], opts, m);
    return change(rebuild(), opts, rebuild);
  }
  if (cmd === 'status') {
    if (opts._.length > 1) die(USAGE);
    if (opts._[0]) getPack(opts._[0], catalog);
    const r = await status({ m, trust: !opts.noTrustCheck, onProgress: (s) => process.stderr.write(`${s}\n`) });
    if (opts._[0]) r.packs = r.packs.filter((p) => p.id === opts._[0]);
    if (opts.json) { process.stdout.write(`${JSON.stringify(r, null, 2)}\n`); return; }
    if (r.legacy.length) say(`An earlier review-gate install is here (${r.legacy.join(', ')}). acs packs does not migrate it.`);
    for (const p of r.packs) {
      const installed = p.parts.some((x) => !x.statuses.includes(STATUS.absent));
      say(`${p.id} ${installed ? `${p.installedVersion}${p.installedVersion !== p.version ? ` (package has ${p.version})` : ''}` : '— not installed'}`);
      if (!installed) continue;
      for (const part of p.parts) {
        say(`  ${part.id}: ${part.statuses.join(', ')}${part.harnesses.length ? ` [${part.harnesses.join(', ')}]` : ''}`);
        for (const [h, s] of Object.entries(part.harness || {})) say(`    ${h}: ${s}`);
        for (const d of part.details) say(`    ${d}`);
      }
    }
    return;
  }
  die(`acs packs: unknown command ${cmd}\n${USAGE}`);
}

main().catch((e) => { if (!(e instanceof Stop)) { process.stderr.write(`acs packs: ${e.message}\n`); process.exitCode = 1; } });
