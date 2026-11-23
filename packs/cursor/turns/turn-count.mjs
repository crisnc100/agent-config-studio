import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const log = path.join(os.homedir(), '.agent-config-studio', 'cursor', 'turns.jsonl');
const maxBytes = 1024 * 1024;
const retention = 30 * 24 * 60 * 60 * 1000;
const nonEmpty = (value) => typeof value === 'string' && value.trim() !== '';

function turnFrom(payload) {
  const { hook_event_name: event, conversation_id, generation_id } = payload;
  const model = payload.model_id ?? payload.model;
  if (event !== 'stop' && event !== 'sessionEnd') return null;
  const status = event === 'stop' ? payload.status : (payload.final_status ?? payload.reason);
  if (![conversation_id, generation_id, model, status].every(nonEmpty)) return null;
  return { ts: new Date().toISOString(), event, conversation_id, generation_id, model, status };
}

function unlock(folder, owner) {
  fs.unlinkSync(path.join(folder, owner));
  try { fs.rmdirSync(folder); } catch {}
}

function clearDeadLock(lock) {
  try {
    const [owner] = fs.readdirSync(lock);
    const pid = Number(owner?.match(/^owner-(\d+)-/)?.[1]);
    if (!pid) return;
    try { process.kill(pid, 0); } catch (error) {
      if (error.code === 'ESRCH') unlock(lock, owner);
    }
  } catch {}
}

// A nonempty directory cannot be replaced by rename. All writers share this
// lock so compaction cannot discard another session's append.
async function lockLog() {
  const lock = `${log}.lock`;
  const candidate = fs.mkdtempSync(path.join(path.dirname(log), `.turn-lock-${process.pid}-`));
  const owner = path.basename(candidate).replace('.turn-lock-', 'owner-');
  try {
    fs.writeFileSync(path.join(candidate, owner), '');
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        fs.renameSync(candidate, lock);
        return { lock, owner };
      } catch (error) {
        if (error.code !== 'ENOTEMPTY' && error.code !== 'EEXIST') throw error;
        clearDeadLock(lock);
        await delay(5);
      }
    }
    return null;
  } finally {
    fs.rmSync(candidate, { recursive: true, force: true });
  }
}

function trimLog(cutoff) {
  const kept = fs.readFileSync(log, 'utf8').split('\n').filter((line) => {
    try { return Date.parse(JSON.parse(line).ts) >= cutoff; } catch { return false; }
  });
  const tmp = `${log}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    try { fs.writeFileSync(fd, kept.map((line) => `${line}\n`).join('')); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, log);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

async function appendTurn(turn) {
  fs.mkdirSync(path.dirname(log), { recursive: true, mode: 0o700 });
  const held = await lockLog();
  if (!held) return;
  try {
    const prior = fs.lstatSync(log, { throwIfNoEntry: false });
    if (prior && (!prior.isFile() || prior.nlink !== 1)) return;
    const line = `${JSON.stringify(turn)}\n`;
    fs.appendFileSync(log, line, { mode: 0o600 });
    if ((prior?.size ?? 0) + Buffer.byteLength(line) > maxBytes) trimLog(Date.now() - retention);
  } finally {
    unlock(held.lock, held.owner);
  }
}

try {
  const turn = turnFrom(JSON.parse(fs.readFileSync(0, 'utf8')));
  if (turn) await appendTurn(turn);
} catch {
  // Usage logging is best effort even when the log cannot be written.
}
process.stdout.write('{}\n');
