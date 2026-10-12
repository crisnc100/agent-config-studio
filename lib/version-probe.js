import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

/**
 * `--version` for several CLIs at once, off the main thread.
 *
 * harness.js readVersion is the one place a --version probe may spawn
 * (tests/guards.mjs), and it is synchronous. Run on the server's thread, three
 * slow CLIs held every request — sign-in polling included — for the sum of
 * their timeouts. Here each probe runs readVersion in its own worker, all in
 * parallel, so the server stays responsive and the slowest probe bounds the
 * wait. No new spawn site: the worker calls the audited function.
 */

if (!isMainThread && workerData?.versionProbe) {
  const { readVersion } = await import('./harness.js');
  parentPort.postMessage(readVersion(workerData.binary, workerData.timeoutMs));
}

/** One probe; resolves null on timeout or failure, never rejects. */
export function probeVersion(binary, timeoutMs = 3000) {
  return new Promise((resolve) => {
    let worker;
    try {
      worker = new Worker(new URL(import.meta.url), { workerData: { versionProbe: true, binary, timeoutMs } });
    } catch { return resolve(null); }
    let done = false;
    const finish = (v) => { if (done) return; done = true; clearTimeout(timer); resolve(v); worker.terminate().catch(() => {}); };
    // A little past the child's own timeout, for the worker's start-up.
    const timer = setTimeout(() => finish(null), timeoutMs + 500);
    worker.once('message', (v) => finish(typeof v === 'string' ? v : null));
    worker.once('error', () => finish(null));
    worker.once('exit', () => finish(null));
  });
}

/** `{[binary]: version|null}` for every distinct binary, probed in parallel. */
export async function probeVersions(binaries, timeoutMs = 3000) {
  const list = [...new Set(binaries.filter(Boolean))];
  const versions = await Promise.all(list.map((b) => probeVersion(b, timeoutMs)));
  return Object.fromEntries(list.map((b, i) => [b, versions[i]]));
}
