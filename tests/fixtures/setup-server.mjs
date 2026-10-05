/**
 * The studio as `acs` starts it, in-process, with the one seam the offline
 * walkthrough needs: a usage collector that returns fixture quota windows
 * instead of spawning the acs-usage CLI — which would read the macOS
 * Keychain and call the vendors (builds/setup-screen S8). Everything else is
 * the real server: migration, history, watchers, the roots event, every route.
 *
 * Run as `node tests/fixtures/setup-server.mjs <port>` with HOME set to a
 * temp HOME. The seam is reachable only from here, in-process.
 */
import { startStudio } from '../../server.js';
import { loadSeats, readSnapshot, writeSnapshot } from '../../lib/usage/seats.js';

const port = Number(process.argv[2]);
const WEEK = 7 * 86400_000;

/** One weekly window per registered seat, 25% used — numbers no real service gave. */
function reading() {
  const now = Date.now();
  return {
    takenAt: now,
    seats: loadSeats().seats.map((s) => ({
      seatId: s.id, label: s.label, vendor: s.vendor, home: s.home ?? null, ok: true, observedAt: now,
      windows: [{ label: 'Weekly (fixture)', usedPercent: 25, resetsAt: now + WEEK, windowMinutes: 10080 }],
    })),
  };
}

const usageCollector = {
  render: async () => {
    const snap = readSnapshot();
    const byId = new Map((snap?.seats || []).map((s) => [s.seatId, s]));
    return {
      takenAt: Date.now(), storedAt: snap?.takenAt ?? null,
      seats: loadSeats().seats.map((s) => byId.get(s.id) ?? {
        seatId: s.id, label: s.label, vendor: s.vendor, home: s.home ?? null, ok: false, windows: [], observedAt: null,
        reason: 'no stored reading — run `acs-usage` to take one',
      }),
    };
  },
  refresh: async () => { writeSnapshot(reading()); return usageCollector.render(); },
};

await startStudio({ port, app: { usageCollector } });
