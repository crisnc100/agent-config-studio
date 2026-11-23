import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readState } from '../packs-files.js';
import { readUserText } from '../paths.js';

const day = 24 * 60 * 60 * 1000;
const zero = () => ({ today: 0, days7: 0, days30: 0 });

export function countCursorTurns(text, now = Date.now()) {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);

  const completed = [];
  const stops = new Set();
  for (const line of text.split('\n')) {
    if (!line) continue;
    let turn;
    try { turn = JSON.parse(line); } catch { continue; }
    const ts = Date.parse(turn?.ts);
    if (!Number.isFinite(ts) || ts < now - 30 * day || ts > now) continue;
    const { event, conversation_id, generation_id, model, status } = turn;
    if (![conversation_id, generation_id, model, status].every((value) => typeof value === 'string' && value.trim())) continue;
    if (event === 'stop') stops.add(conversation_id);
    else if (event !== 'sessionEnd') continue;
    if (status === 'completed') completed.push({ ts, event, conversation_id, generation_id, model });
  }

  const seen = new Set();
  const byModel = new Map();
  const total = zero();
  for (const { ts, event, conversation_id, generation_id, model } of completed) {
    // Interactive sessions may emit both events, even when their only turn
    // was aborted. The session-end fallback is for sessions with no stop at all.
    if (event === 'sessionEnd' && stops.has(conversation_id)) continue;
    const key = JSON.stringify([conversation_id, event === 'stop' ? generation_id : null]);
    if (seen.has(key)) continue;
    seen.add(key);
    if (!byModel.has(model)) byModel.set(model, { model, ...zero() });
    for (const count of [byModel.get(model), total]) {
      if (ts >= today.getTime()) count.today++;
      if (ts >= now - 7 * day) count.days7++;
      count.days30++;
    }
  }

  return { models: [...byModel.values()].sort((a, b) => a.model.localeCompare(b.model)), total };
}

export function readCursorUsage(home = os.homedir()) {
  const studio = path.join(home, '.agent-config-studio');
  let installed = false;
  try {
    installed = !!readState(path.join(studio, 'packs', 'state.json')).packs.cursor?.parts?.['turn-count'];
  } catch {}
  let text = '';
  if (installed) {
    const log = path.join(studio, 'cursor', 'turns.jsonl');
    try {
      if (fs.lstatSync(log).isFile()) text = readUserText(log);
    } catch {}
  }
  return { installed, ...countCursorTurns(text) };
}
