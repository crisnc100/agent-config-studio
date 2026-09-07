#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  loadSeats, addSeat, removeSeat, detectSeats, saveSeats, snapshot, slugify, registryPath,
  writeSnapshot,
} from '../lib/usage/seats.js';

/**
 * The routing gauge: which subscription has room right now.
 *
 * Deliberately not a dashboard. The question it answers is "where should the
 * next task go", so seats sort by remaining headroom and the answer is the
 * first line. Retrospective spend analysis is a different tool.
 */

const C = process.stdout.isTTY && !process.env.NO_COLOR
  ? { dim: (s) => `\x1b[2m${s}\x1b[0m`, bold: (s) => `\x1b[1m${s}\x1b[0m`,
      green: (s) => `\x1b[32m${s}\x1b[0m`, yellow: (s) => `\x1b[33m${s}\x1b[0m`,
      red: (s) => `\x1b[31m${s}\x1b[0m`, grey: (s) => `\x1b[90m${s}\x1b[0m` }
  : new Proxy({}, { get: () => (s) => s });

const bar = (pct, width = 24) => {
  const filled = Math.round((Math.min(100, Math.max(0, pct)) / 100) * width);
  const tint = pct >= 90 ? C.red : pct >= 70 ? C.yellow : C.green;
  return tint('█'.repeat(filled)) + C.grey('░'.repeat(width - filled));
};

function until(ts) {
  if (!ts) return '';
  const ms = ts - Date.now();
  if (ms <= 0) return 'resetting';
  const h = Math.floor(ms / 3.6e6), m = Math.round((ms % 3.6e6) / 6e4);
  return h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : h ? `${h}h ${m}m` : `${m}m`;
}

/** A seat's headroom is set by its tightest window — the first one to stop you. */
const headroom = (s) =>
  s.ok && s.windows.length ? 100 - Math.max(...s.windows.map((w) => w.usedPercent)) : null;

async function gauge(argv) {
  const { seats } = loadSeats();
  if (seats.length === 0) {
    console.log(`\nNo seats registered yet.\n\n  ${C.bold('acs-usage detect')}   suggest seats from this machine` +
                `\n  ${C.bold('acs-usage add')} <vendor> <label>\n`);
    return 0;
  }
  const snap = await snapshot();
  // Persist it: the web app renders this file rather than reading a credential
  // of its own. Failing to write must not fail the gauge the user asked for.
  try { writeSnapshot(snap); } catch { /* the reading is still valid unwritten */ }
  if (argv.includes('--json')) { console.log(JSON.stringify(snap, null, 2)); return 0; }

  const ranked = [...snap.seats].sort((a, b) => {
    const ha = headroom(a), hb = headroom(b);
    if (ha === null && hb === null) return 0;
    if (ha === null) return 1;          // unreadable seats sink; they are not "full"
    if (hb === null) return -1;
    return hb - ha;
  });

  const best = ranked.find((s) => headroom(s) !== null);
  console.log('');
  console.log(best
    ? `  ${C.bold('Route to:')} ${C.bold(best.label)}  ${C.green(`${Math.round(headroom(best))}% headroom`)}`
    : `  ${C.yellow('No seat is reporting usable headroom.')}`);
  console.log('');

  for (const s of ranked) {
    const head = headroom(s);
    console.log(`  ${C.bold(s.label)} ${C.grey(`· ${s.vendor}${s.planType ? ` ${s.planType}` : ''}${s.subscriptionType ? ` ${s.subscriptionType}` : ''}`)}`);
    if (!s.ok) {
      console.log(`    ${C.yellow('not connected')} ${C.grey(`— ${s.reason}`)}`);
    } else {
      for (const w of s.windows) {
        const pct = `${String(Math.round(w.usedPercent)).padStart(3)}%`;
        const reset = w.resetsAt ? C.grey(` resets in ${until(w.resetsAt)}`) : '';
        console.log(`    ${bar(w.usedPercent)} ${pct}  ${w.label}${reset}`);
      }
      if (s.credits?.hasCredits) {
        // balance is null on plans that report credits without a figure.
        const b = s.credits.unlimited ? 'unlimited'
          : (s.credits.balance == null ? 'available' : s.credits.balance);
        console.log(`    ${C.grey(`credits: ${b}`)}`);
      }
      if (s.extraUsage?.enabled) {
        console.log(`    ${C.grey(`extra usage: ${s.extraUsage.usedCredits}/${s.extraUsage.monthlyLimit} ${s.extraUsage.currency}`)}`);
      }
      // A reading is only as good as its age. Codex readings come from the last
      // turn that ran, so an idle seat's number can be hours old and still true.
      const age = s.observedAt ? Date.now() - s.observedAt : null;
      if (age !== null && age > 30 * 60_000) {
        console.log(`    ${C.grey(`reading is ${until(Date.now() + age)} old (last recorded turn)`)}`);
      }
    }
    console.log('');
  }
  return 0;
}

function listSeats() {
  const { seats, path: file, exists } = loadSeats();
  console.log(`\n${C.grey(file)}${exists ? '' : C.grey(' (not created yet)')}\n`);
  if (!seats.length) { console.log('  no seats registered\n'); return 0; }
  for (const s of seats) {
    console.log(`  ${C.bold(s.id.padEnd(12))} ${s.vendor.padEnd(7)} ${s.label}${s.home ? C.grey(`  ${s.home}`) : ''}`);
  }
  console.log('');
  return 0;
}

function detect() {
  const found = detectSeats();
  const { seats } = loadSeats();
  const known = new Set(seats.map((s) => s.id));
  const fresh = found.filter((s) => !known.has(s.id));
  console.log('');
  if (!fresh.length) { console.log('  nothing new detected\n'); return 0; }
  for (const s of fresh) console.log(`  ${C.bold(s.id.padEnd(12))} ${s.vendor.padEnd(7)} ${s.label}${s.home ? C.grey(`  ${s.home}`) : ''}`);
  // Suggested, never registered automatically: guessing which subscriptions
  // someone holds is worse than asking.
  console.log(`\n  ${C.grey('to register these:')} acs-usage detect --save\n`);
  if (process.argv.includes('--save')) {
    saveSeats([...seats, ...fresh]);
    console.log(`  ${C.green('registered')} ${fresh.length} seat(s)\n`);
  }
  return 0;
}

function add(args) {
  const [vendor, ...rest] = args;
  const homeIdx = rest.indexOf('--home');
  const home = homeIdx === -1 ? undefined : rest[homeIdx + 1];
  const label = (homeIdx === -1 ? rest : rest.slice(0, homeIdx)).join(' ');
  if (!vendor || !label) { console.error('usage: acs-usage add <claude|codex|grok> <label> [--home <path>]'); return 2; }
  const seat = { id: uniqueId(slugify(label, vendor)), vendor, label, ...(home ? { home: path.resolve(home) } : {}) };
  addSeat(seat);
  console.log(`registered ${seat.id} (${seat.vendor})`);
  return 0;
}

const uniqueId = (base) => {
  const taken = new Set(loadSeats().seats.map((s) => s.id));
  if (!taken.has(base)) return base;
  let n = 2; while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
};

/**
 * Create a second Codex home that shares configuration by symlink.
 *
 * Verified: codex reads a symlinked config.toml normally and keeps auth.json
 * per-home, so a second seat costs one login rather than a duplicated setup.
 * Only auth and session history diverge — which is exactly the split wanted.
 */
function newCodexHome(args) {
  const label = args.filter((a) => !a.startsWith('--')).join(' ');
  if (!label) { console.error('usage: acs-usage codex-home <label>'); return 2; }
  const id = uniqueId(slugify(label, 'codex'));
  const primary = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const home = path.join(os.homedir(), '.codex-seats', id);

  if (fs.existsSync(home)) { console.error(`${home} already exists`); return 1; }
  fs.mkdirSync(home, { recursive: true });

  // Shared by symlink: configuration and instructions. NOT auth.json, and not
  // sessions — those are what make the seats distinct.
  const shared = ['config.toml', 'AGENTS.md', 'skills', 'rules', 'plugins'];
  const linked = [];
  for (const name of shared) {
    const src = path.join(primary, name);
    if (!fs.existsSync(src)) continue;
    fs.symlinkSync(src, path.join(home, name));
    linked.push(name);
  }

  addSeat({ id, vendor: 'codex', label, home });
  console.log(`\n  ${C.green('created')} ${home}`);
  console.log(`  ${C.grey(`shared by symlink: ${linked.join(', ') || 'nothing to share'}`)}`);
  console.log(`  ${C.grey('auth.json and sessions stay separate — that is what makes it a second seat')}\n`);
  console.log(`  ${C.bold('next:')} CODEX_HOME=${home} codex login`);
  console.log(`  ${C.bold('then:')} CODEX_HOME=${home} codex   ${C.grey('(to work on this seat)')}\n`);
  return 0;
}

// A leading flag is not a subcommand. `acs-usage --json` must take a reading,
// not print help — the studio's Refresh invokes exactly that, and treating it
// as an unknown command made Refresh a silent no-op.
const argv = process.argv.slice(2);
const cmd = argv[0]?.startsWith('-') ? undefined : argv[0];
const rest = cmd === undefined ? argv : argv.slice(1);
const run = async () => {
  switch (cmd) {
    case undefined: case 'gauge': return gauge(rest);
    case 'seats': case 'ls': return listSeats();
    case 'detect': return detect();
    case 'add': return add(rest);
    case 'rm': case 'remove':
      if (!rest[0]) { console.error('usage: acs-usage rm <id>'); return 2; }
      removeSeat(rest[0]); console.log(`removed ${rest[0]}`); return 0;
    case 'codex-home': return newCodexHome(rest);
    default:
      console.log(`
  acs-usage                  headroom across every seat (--json for raw)
  acs-usage seats            list registered seats
  acs-usage detect [--save]  suggest seats from this machine
  acs-usage add <vendor> <label> [--home <path>]
  acs-usage rm <id>
  acs-usage codex-home <label>   second Codex home, config shared by symlink
`);
      return cmd ? 2 : 0;
  }
};
run().then((code) => process.exit(code)).catch((e) => { console.error(e.message); process.exit(1); });
