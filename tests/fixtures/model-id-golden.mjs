/**
 * The resolver's role output, pinned (builds/model-guide G1): a copy of
 * bin/model-id.mjs, lib/models.js and lib/roles.js beside frozen data
 * (tests/fixtures/model-id-golden/), run against a temp HOME with and
 * without a user roles.json. cases.json was captured from 939c6fd, the
 * commit before the model guide; tests/model-guide.mjs runs today's files
 * the same way and compares byte for byte.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './cleanup.mjs';

export const GOLDEN = path.join(path.dirname(fileURLToPath(import.meta.url)), 'model-id-golden');

export const CASES = [
  ['defaults', ['--roles']],
  ['defaults', ['--flavor', 'fable']],
  ['defaults', ['--role', 'builder']],
  ['user', ['--roles']],
  ['user', ['--roles', '--json']],
  ['user', ['--role', 'builder']],
  ['user', ['--role', 'reviewer', '--json']],
  ['user', ['--flavor', 'sol']],
  ['user', ['--flavor', 'grok', '--json']],
  ['user', ['--role', 'nobody']],
];

/** Run every case against a resolver built from `sources` ({ 'bin/model-id.mjs': bytes, … }). */
export function runCases(sources) {
  const tmp = fs.realpathSync(tempDir('acs-model-id-golden-'));
  try {
    const dir = path.join(tmp, 'resolver');
    for (const [rel, bytes] of Object.entries(sources)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), bytes);
    }
    fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}\n');
    fs.copyFileSync(path.join(GOLDEN, 'models.default.json'), path.join(dir, 'models.default.json'));
    fs.copyFileSync(path.join(GOLDEN, 'roles.default.json'), path.join(dir, 'lib', 'roles.default.json'));
    const homes = { defaults: path.join(tmp, 'home-defaults'), user: path.join(tmp, 'home-user') };
    for (const h of Object.values(homes)) fs.mkdirSync(path.join(h, '.agent-config-studio'), { recursive: true });
    fs.copyFileSync(path.join(GOLDEN, 'user-roles.json'), path.join(homes.user, '.agent-config-studio', 'roles.json'));
    const norm = (s) => s.split(dir).join('<RESOLVER>').split(tmp).join('<TMP>');
    return CASES.map(([home, args]) => {
      const r = spawnSync(process.execPath, [path.join(dir, 'bin', 'model-id.mjs'), ...args], {
        encoding: 'utf8', env: { HOME: homes[home], PATH: process.env.PATH },
      });
      return { home, args, status: r.status, stdout: norm(r.stdout), stderr: norm(r.stderr) };
    });
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

export const SOURCE_FILES = ['bin/model-id.mjs', 'lib/models.js', 'lib/roles.js'];
