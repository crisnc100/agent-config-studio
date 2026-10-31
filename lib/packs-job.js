/**
 * One slow Packs call, in a worker thread of the studio (lib/packs-routes.js
 * runJob): a status check or an apply. Both block on child processes the
 * installer runs, which would otherwise stop the studio answering anything.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { applyRequest, statusRequest } from './packs-routes.js';

const send = (msg) => parentPort.postMessage(msg);
const log = [];
try {
  const result = workerData.kind === 'status'
    ? await statusRequest({ trust: workerData.trust, onProgress: (message) => send({ t: 'progress', message }) })
    : { ...(await applyRequest(workerData.req, { log: (s) => { if (s) log.push(...String(s).split('\n')); } })), log };
  send({ t: 'done', result });
} catch (e) {
  send({ t: 'error', message: e.message, status: e.status || 500, log });
}
