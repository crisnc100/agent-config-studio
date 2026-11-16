import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readUserText } from '../lib/paths.js';

export function install({ home, studio, resolver }) {
  const source = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const put = (dest, body, mode = 0o644) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.tmp-${crypto.randomUUID()}`;
    try { fs.writeFileSync(tmp, body, { flag: 'wx', mode }); fs.renameSync(tmp, dest); }
    finally { fs.rmSync(tmp, { force: true }); }
  };
  const launcher = path.join(studio, 'bin', 'acs-agent');
  const link = path.join(home, '.local', 'bin', 'acs-agent');
  let existing;
  try { existing = fs.lstatSync(link); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (existing && !existing.isSymbolicLink()) throw new Error('~/.local/bin/acs-agent exists and is not a symlink — not replacing it');
  if (existing && path.resolve(path.dirname(link), fs.readlinkSync(link)) !== launcher) {
    throw new Error('~/.local/bin/acs-agent points elsewhere — not replacing it');
  }
  for (const file of ['lib/paths.js', 'lib/roots.js', 'lib/agent.js', 'bin/agent-install.mjs', 'bin/agent.mjs']) {
    put(path.join(resolver, file), readUserText(path.join(source, file)));
  }
  const quote = s => `'${s.replace(/'/g, `'\\''`)}'`;
  put(launcher, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(path.join(resolver, 'bin', 'agent.mjs'))} "$@"\n`, 0o755);
  fs.mkdirSync(path.dirname(link), { recursive: true });
  const tmp = `${link}.tmp-${crypto.randomUUID()}`;
  try { fs.symlinkSync(launcher, tmp); fs.renameSync(tmp, link); }
  finally { fs.rmSync(tmp, { force: true }); }
  return 'linked    ~/.local/bin/acs-agent → ~/.agent-config-studio/bin/acs-agent\n';
}
