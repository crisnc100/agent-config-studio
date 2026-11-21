// walled.mjs <agy> <args…>: one agy call from the current folder inside the wall both runtimes ship, built by
// ask-model's own exports (agyWallProblem, agyReadRoot, agyWallParams, agyWallCanary, agyWall, AGY_ENV) with a fresh
// TMPDIR, so the probe proves the configuration that runs. The args must carry --log-file. Exit: agy's own, or 2 when
// the wall refuses (the reason on stderr). Prints the read root on stderr.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AGY_ENV, SANDBOX_EXEC, agyReadRoot, agyWall, agyWallCanary, agyWallParams, agyWallProblem } from '../../../tools/ask-model.mjs';

const [bin, ...args] = process.argv.slice(2);
const logFile = args[args.indexOf('--log-file') + 1];
function walled() {
  if (!bin || !args.includes('--log-file') || !logFile) return { error: 'usage: walled.mjs <agy> <args…> with --log-file <file>' };
  const problem = agyWallProblem();
  if (problem) return { error: problem };
  const read = agyReadRoot(process.cwd());
  if (read.error) return { error: read.error };
  const callTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acs-agy-call-'));
  try {
    const p = agyWallParams({ root: read.root, callTmp, logFile, bin });
    if (p.error) return { error: p.error };
    const broken = agyWallCanary(p.params);
    if (broken) return { error: broken };
    process.stderr.write(`walled: read root ${p.params.ROOT}\n`);
    const r = spawnSync(SANDBOX_EXEC, agyWall(p.params, [bin, ...args]), { stdio: 'inherit', env: { ...process.env, ...AGY_ENV, TMPDIR: callTmp } });
    return { status: r.status ?? 1 };
  } finally {
    fs.rmSync(callTmp, { recursive: true, force: true });
  }
}
const r = walled();
if (r.error) process.stderr.write(`walled: ${r.error}\n`);
process.exitCode = r.error ? 2 : r.status;
