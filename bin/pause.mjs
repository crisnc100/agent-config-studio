#!/usr/bin/env node
import path from 'node:path';
import { homeDir, loadRegistry, vendorOf } from '../lib/models.js';
import { pause, pauseEffect, pauseState, resume, vendorReset } from '../lib/pause.js';
import { pauseKind } from '../lib/roles.js';
import { readSnapshot, snapshotPath } from '../lib/usage/seats.js';

/**
 * `acs pause` / `acs resume` — the Usage page's Pause switch, in the
 * terminal. Every write goes through lib/pause.js, so the stale-resolver
 * refusal and the file's rules are the studio's own.
 *
 *   acs pause                                  what is paused, and what each role answers now
 *   acs pause <vendor|family> [--until <time> | --until-resume]
 *   acs resume <vendor|family>
 *
 * With neither flag, a pause ends when the last usage reading says that
 * account resets, or lasts until you resume when no reading says.
 */

const USAGE = 'usage: acs pause [<claude|codex|grok|family> [--until <time> | --until-resume]]\n       acs resume <claude|codex|grok|family>';
const home = homeDir();
const [cmd, ...argv] = process.argv.slice(2);

const fail = (msg, code = 1) => { process.stderr.write(`acs ${cmd}: ${msg}\n`); process.exit(code); };
const when = (iso) => (iso ? `until ${new Date(iso).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : 'until you resume');

function list() {
  const s = pauseState({ home });
  if (s.error) process.stderr.write(`acs pause: ${s.error}\n  Nothing is paused until it is fixed or deleted.\n`);
  const live = s.entries.filter((e) => e.active);
  if (!live.length) { console.log('Nothing is paused.'); return s.error ? 1 : 0; }
  for (const e of live) console.log(`${e.name} paused ${when(e.until)}`);
  const eff = pauseEffect({ home });
  const lines = eff.roles.filter((r) => r.refuses || r.skipped.length || r.altSkipped);
  if (lines.length) console.log('');
  for (const r of lines) {
    if (r.refuses) console.log(`  ${r.name}: refuses — every model for it is paused`);
    else console.log(`  ${r.name} → ${r.family}${r.skipped.length ? ` (skipped ${r.skipped.map((x) => x.family).join(', ')})` : ''}${r.altSkipped ? `; no second opinion (${r.altSkipped.family} skipped)` : ''}`);
  }
  if (eff.sameVendor) console.log(`\n  builder and reviewer both run on ${eff.sameVendor} now, so ${eff.sameVendor} checks its own work.`);
  return s.error ? 1 : 0;
}

function defaultUntil(name) {
  const vendor = pauseKind(name) === 'vendor' ? name : vendorOf(loadRegistry({ home }).registry.models[name]);
  const snap = readSnapshot(snapshotPath(path.join(home, '.agent-config-studio')));
  const at = vendorReset(snap?.seats, vendor);
  return at ? new Date(at).toISOString() : null;
}

function run() {
  if (cmd === 'pause' && !argv.length) return list();
  if (argv.includes('-h') || argv.includes('--help')) { console.log(USAGE); return 0; }
  const [name, ...rest] = argv;
  if (!name || name.startsWith('-')) fail(USAGE, 2);
  if (cmd === 'resume') {
    if (rest.length) fail(USAGE, 2);
    resume({ name, home });
    console.log(`${name} resumed.`);
    return 0;
  }
  let until;
  if (!rest.length) until = defaultUntil(name);
  else if (rest.length === 1 && rest[0] === '--until-resume') until = null;
  else if (rest.length === 2 && rest[0] === '--until') until = rest[1];
  else fail(USAGE, 2);
  const s = pause({ name, until, home });
  const e = s.entries.find((x) => x.name === name);
  console.log(`${name} paused ${when(e.until)}.${!rest.length && !e.until ? ' (No usage reading gives a reset time; run acs resume when it has room again.)' : ''}`);
  return 0;
}

try { process.exit(run()); }
catch (e) { fail(e.message, e.status === 400 ? 2 : 1); }
