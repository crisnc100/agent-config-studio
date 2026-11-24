import { execFile } from 'node:child_process';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { candidates, probe, runControls } from './interface-controls.mjs';

const execute = promisify(execFile);

function interfaceIdentity({ interfaceName, host, family }) {
  return JSON.stringify([interfaceName, host, family]);
}

function sameInterfaces(first, current) {
  return first.length === current.length &&
    first.every((candidate, index) => interfaceIdentity(candidate) === interfaceIdentity(current[index]));
}

function controlBasis(row) {
  const accepted = (result) => result?.status === 'connected' && result.accepted === true;
  if (row?.reservation?.status !== 'listening' || row?.exactBind?.status !== 'listening' ||
      row?.loopbackBind?.status !== 'listening' || !accepted(row.loopbackAccept)) return 'unproven';
  if (accepted(row.exactAccept) && row.candidateToLoopback?.status === 'refused' &&
      row.candidateToLoopback.errno === 'ECONNREFUSED') return 'usable';
  if (row.exactAccept?.status === 'timeout' && row.candidateToLoopback?.status === 'timeout') return 'control-timeout';
  return 'unproven';
}

export function matchControls(interfaces, controls) {
  const matched = new Map();
  let complete = controls.aborted === false && interfaces.length === controls.results.length;
  for (const [index, candidate] of interfaces.entries()) {
    const row = controls.results[index];
    const basis = row?.ordinal === candidate.ordinal && row.family === candidate.family &&
      row.scope === candidate.scope ? controlBasis(row) : 'unproven';
    matched.set(candidate, { basis, row });
    if (basis === 'unproven') complete = false;
  }
  return { interfaces, controls: matched, ready: complete, evidence: controls };
}

export async function prepareListenerObservation() {
  const interfaces = candidates();
  // The private scoped addresses used by the controls travel with these same candidate objects into observation.
  return matchControls(interfaces, await runControls(interfaces));
}

function parseEndpoint(endpoint) {
  const separator = endpoint.lastIndexOf(':');
  const literal = endpoint.slice(0, separator);
  const rawPort = endpoint.slice(separator + 1);
  const port = Number(rawPort);
  if (separator < 1 || !/^\d{1,5}$/.test(rawPort) || port < 1 || port > 65535) return { scope: 'unparseable' };
  const bracketed = literal.startsWith('[') && literal.endsWith(']');
  const address = bracketed ? literal.slice(1, -1) : literal;
  const family = net.isIP(address);
  if (address === '*' && !bracketed) return { port, scope: 'wildcard' };
  if (!family || (bracketed && family !== 6) || address.includes('%')) return { scope: 'unparseable' };
  const canonical = family === 6 ? new URL(`http://[${address}]`).hostname.slice(1, -1) : address;
  const scope = canonical === '::1' || (family === 4 && canonical.startsWith('127.')) ? 'loopback'
    : ['0.0.0.0', '::'].includes(canonical) ? 'wildcard' : 'non-loopback';
  return { port, address: canonical, family: `IPv${family}`, scope };
}

export function parseListeners(stdout, ids) {
  const rows = [];
  let parseErrors = 0;
  let pid, command, file, endpoint;
  const finishFile = () => {
    if (file && (!ids.has(pid) || !command || !endpoint)) parseErrors++;
    if (file && ids.has(pid) && command && endpoint) {
      const parsed = parseEndpoint(endpoint);
      if (parsed.scope === 'unparseable') parseErrors++;
      rows.push({ pid, command, endpoint, ...parsed });
    }
    file = endpoint = undefined;
  };
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    const value = line.slice(1);
    switch (line[0]) {
      case 'p':
        finishFile();
        pid = /^\d+$/.test(value) ? Number(value) : undefined;
        if (!ids.has(pid)) parseErrors++;
        command = undefined;
        break;
      case 'c':
        if (!pid || command || file || !value) parseErrors++;
        command = value;
        break;
      case 'f':
        finishFile();
        if (!pid || !value) parseErrors++;
        file = value;
        break;
      case 'n':
        if (!file || endpoint || !value) parseErrors++;
        endpoint = value;
        break;
      default:
        parseErrors++;
    }
  }
  finishFile();
  return { rows, parseErrors };
}

async function processTree(pid) {
  const { stdout, stderr } = await execute('/bin/ps', ['-axo', 'pid=,ppid='], { timeout: 2500 });
  if (stderr) throw new Error('process sampling produced a diagnostic');
  const processes = stdout.trim().split('\n').map((line) => {
    const pair = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!pair) throw new Error('invalid process sample');
    return [Number(pair[1]), Number(pair[2])];
  });
  if (!processes.some(([child]) => child === pid)) return null;
  const ids = new Set([pid]);
  for (let expanded = true; expanded;) {
    expanded = false;
    for (const [child, parent] of processes) {
      if (ids.has(parent) && !ids.has(child)) {
        ids.add(child);
        expanded = true;
      }
    }
  }
  return ids;
}

async function snapshot(pid, closed) {
  const ids = await processTree(pid);
  if (!ids) {
    if (closed()) return null;
    throw new Error('process tree root disappeared before close');
  }
  try {
    const { stdout, stderr } = await execute('/usr/sbin/lsof',
      ['-nP', '-a', '-p', [...ids].join(','), '-iTCP', '-sTCP:LISTEN', '-Fpcfn'], { timeout: 2500 });
    if (stderr) throw new Error('listener sampling produced a diagnostic');
    return parseListeners(stdout, ids);
  } catch (error) {
    if (error.code === 1 && !error.stdout && !error.stderr) return { rows: [], parseErrors: 0 };
    throw error;
  }
}

export async function observe(child, closed, stop, prepared, dependencies = {}) {
  const sample = dependencies.snapshot ?? snapshot;
  const currentInterfaces = dependencies.candidates ?? candidates;
  const connect = dependencies.probe ?? probe;
  const pause = dependencies.pause ?? (() => delay(100));
  const { interfaces, controls, ready } = prepared;
  const seen = new Map();
  const signal = new AbortController().signal;
  let samples = 0;
  let sampleErrors = 0;
  let parseErrors = 0;
  let brokerPair = false;
  let cancelled = false;
  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    stop('SIGTERM');
  };
  let interfacesStable = sameInterfaces(interfaces, currentInterfaces());
  if (!ready || !interfacesStable) cancel();
  while (!closed()) {
    try {
      const state = await sample(child.pid, closed);
      if (!state) {
        if (closed()) break;
        throw new Error('no sample before close');
      }
      samples++;
      interfacesStable &&= sameInterfaces(interfaces, currentInterfaces());
      if (!interfacesStable) cancel();
      parseErrors += state.parseErrors;
      if (state.parseErrors) cancel();
      const broker = state.rows.filter(({ pid, scope }) => pid === child.pid && scope === 'loopback');
      brokerPair ||= broker.some(({ address, port }) => address === '127.0.0.1' &&
        broker.some((other) => other.address === '::1' && other.port === port));
      for (const row of state.rows) {
        const key = `${row.pid}:${row.endpoint}`;
        if (seen.has(key)) continue;
        if (row.scope !== 'loopback') cancel();
        const kind = row.pid === child.pid ? 'broker-process' : row.command === 'agy' ? 'agy' : 'other-descendant';
        const probes = Promise.all(interfaces.map(async (candidate) => {
          const { ordinal, family, scope } = candidate;
          const control = controls.get(candidate)?.basis ?? 'unproven';
          let result = { status: 'not-probed' };
          if (row.port) {
            try { result = await connect(candidate.host, row.port, signal); }
            catch { result = { status: 'probe-error' }; }
          }
          if (result.status === 'connected') cancel();
          const refused = result.status === 'refused' && result.errno === 'ECONNREFUSED';
          const timeoutsMatch = result.status === 'timeout' && control === 'control-timeout';
          return { ordinal, family, scope, control, ...result,
            evidence: refused ? 'refused' : timeoutsMatch ? 'supplementary-unproven' : 'incomplete' };
        }));
        seen.set(key, { kind, scope: row.scope, ...(row.family && { family: row.family }), probes });
      }
    } catch {
      sampleErrors++;
      cancel();
    }
    if (!closed()) await pause();
  }
  interfacesStable &&= sameInterfaces(interfaces, currentInterfaces());
  const records = await Promise.all([...seen.values()].map(async ({ probes, ...record }) =>
    ({ ...record, probes: await probes })));
  const proved = ready && interfacesStable && samples > 0 && sampleErrors === 0 && parseErrors === 0 && brokerPair &&
    records.some(({ kind, scope }) => kind === 'agy' && scope === 'loopback') &&
    records.every(({ scope, probes }) => scope === 'loopback' && probes.length === interfaces.length &&
      probes.every(({ control, evidence }) => control !== 'unproven' &&
        ['refused', 'supplementary-unproven'].includes(evidence)));
  if (!proved) cancel();
  return { proved, samples, sampleErrors, parseErrors, brokerPair, interfacesStable, externalInterfaces: interfaces.length,
    controls: prepared.evidence, records };
}
