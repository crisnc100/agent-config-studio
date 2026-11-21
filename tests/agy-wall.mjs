/**
 * The sandbox-exec wall around every agy call (tools/ask-model.mjs AGY_WALL and its helpers; the review runtime carries
 * a copy). Off macOS: the literal is the same in both runtimes, says what it should, and agy is refused. On macOS, with
 * no model and no real agy: the per-call canary on this machine's real paths, a fake HOME laid out like ~/.gemini to
 * show which of agy's files the wall lets through, and the nested-sandbox refusal. sandbox-exec cannot start inside
 * another sandbox, so on macOS this file must run from a shell outside any sandbox; it says so and fails if it can't.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './fixtures/cleanup.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASK = path.join(ROOT, 'tools', 'ask-model.mjs');
const J = JSON.stringify;
const { AGY_ENV, AGY_WALL, SANDBOX_EXEC, agyAfterCall, agyReadRoot, agyTokenLeft, agyWall, agyWallCanary, agyWallParams, agyWallProblem } = await import(ASK);

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

console.log('\nagy wall: one profile, the same in both runtimes');
{
  // The array literal assigned to AGY_WALL, up to its join.
  const block = (src) => /^const AGY_WALL = (\[\n[\s\S]*?\n\]\.join\('\\n'\));?$/m.exec(src)?.[1] ?? null;
  const a = block(read('tools/ask-model.mjs')), r = block(read('packs/review-gate/runtime/review.mjs'));
  ok('AGY_WALL is the same literal in ask-model and the review runtime', a !== null && a === r, `${a}\n---\n${r}`);
  ok('…and it is the profile ask-model exports', a !== null && Function(`return (${a})`)() === AGY_WALL);
  const lines = AGY_WALL.split('\n');
  ok('it allows by default and refuses reads of contents, never metadata; its one write rule is the summaries\' (below)', lines[0] === '(version 1)'
    && lines[1] === '(allow default)' && !/file-read\*|file-read-metadata/.test(AGY_WALL) && (AGY_WALL.match(/file-write/g) || []).length === 1
    && /^\(deny file-write\*$/m.test(AGY_WALL), AGY_WALL);
  ok('the refused roots: /Users, /Volumes, /private/tmp, TMPDIR, macOS\'s per-user temp folder and HOME', lines[2]
    === '(deny file-read-data (subpath "/Users") (subpath "/Volumes") (subpath "/private/tmp") (subpath (param "TMP")) (subpath (param "USER_TMP")) (subpath (param "HOME")))', lines[2]);
  // The write rule, found by matching its parentheses, so nothing after it is mistaken for part of it.
  const writeStart = AGY_WALL.indexOf('(deny file-write*');
  let writeEnd = writeStart;
  for (let depth = 0; writeStart !== -1 && writeEnd < AGY_WALL.length; writeEnd++) {
    if (AGY_WALL[writeEnd] === '(') depth++;
    else if (AGY_WALL[writeEnd] === ')' && --depth === 0) break;
  }
  const writeBlock = writeStart === -1 ? '' : AGY_WALL.slice(writeStart, writeEnd + 1);
  const outsideWrite = writeStart === -1 ? AGY_WALL : AGY_WALL.slice(0, writeStart) + AGY_WALL.slice(writeEnd + 1);
  const allowBlock = outsideWrite.split('(allow file-read-data')[1] ?? '';
  const allowed = [...allowBlock.matchAll(
    /\((subpath|literal|regex) (\(param "[A-Z_]+"\)|\(string-append (?:\(param "[A-Z_]+"\)|"\^" \(regex-quote \(param "[A-Z_]+"\)\)) "[^"]+"\))\)/g)]
    .map((m) => `${m[1]} ${m[2]}`);
  ok('the allowed-back list is exactly the approved one', J(allowed) === J([
    'subpath (param "ROOT")', 'subpath (param "CALL_TMP")', 'literal (param "LOG")', 'literal (param "AGY")',
    'literal (string-append (param "HOME") "/Library/Keychains/login.keychain-db")',
    'regex (string-append "^" (regex-quote (param "HOME")) "/Library/Keychains/\\\\.fl[0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F]$")',
    'regex (string-append "^" (regex-quote (param "HOME")) "/Library/Keychains/login\\\\.keychain-db\\\\.sb-[0-9a-f]+-[A-Za-z0-9]+$")',
    'subpath (string-append (param "HOME") "/.gemini/config")',
    'subpath (string-append (param "HOME") "/.gemini/antigravity-cli/builtin")',
    'literal (string-append (param "HOME") "/.gemini/antigravity-cli/settings.json")',
    'literal (string-append (param "HOME") "/.gemini/antigravity-cli/installation_id")',
    'literal (string-append (param "HOME") "/.gemini/antigravity-cli/jetski_state.pbtxt")',
    'literal (string-append (param "HOME") "/.gemini/antigravity-cli/cache/default_project_id.txt")',
    'literal (string-append (param "HOME") "/.gemini/antigravity-cli/cache/onboarding.json")',
    'literal (string-append (param "USER_TMP") "/xcrun_db")',
  ]), J(allowed, null, 1));
  const unwritable = [...writeBlock.matchAll(/\(literal (\(string-append \(param "HOME"\) "[^"]+"\))\)/g)].map((m) => m[1]);
  ok('writes are refused to exactly agy\'s conversation summaries: the database, its -wal and -shm, and the proto', J(unwritable) === J([
    '(string-append (param "HOME") "/.gemini/antigravity-cli/conversation_summaries.db")',
    '(string-append (param "HOME") "/.gemini/antigravity-cli/conversation_summaries.db-wal")',
    '(string-append (param "HOME") "/.gemini/antigravity-cli/conversation_summaries.db-shm")',
    '(string-append (param "HOME") "/.gemini/antigravity-cli/jetbox_summaries_proto.pb")',
  ]), J(unwritable, null, 1));
  // A filter written any other way (a path spelled out, a regex) would be missing from the lists above.
  const filters = (AGY_WALL.match(/\((subpath|literal|regex|prefix) /g) || []).length;
  ok('every filter in the profile is one of those three lists', filters === 6 + allowed.length + unwritable.length,
    `${filters} filters, ${6 + allowed.length + unwritable.length} listed`);
  ok('nothing of agy\'s past conversations is allowed back anywhere in the profile outside the write rule',
    !/conversations|brain|history|summar|conversation_metadata|last_conversations|implicit|annotations/.test(outsideWrite), outsideWrite);
  ok('SANDBOX_EXEC is the system binary by absolute path', SANDBOX_EXEC === '/usr/bin/sandbox-exec');
  ok('agy\'s updater is switched off the way it honours ("true", not "1")', AGY_ENV.AGY_CLI_DISABLE_AUTO_UPDATE === 'true', J(AGY_ENV));
  ok('agyWall passes each parameter with -D and the profile with -p, then the command, in that order',
    J(agyWall({ ROOT: '/r', LOG: '/l' }, ['/bin/cat', 'x'])) === J(['-D', 'ROOT=/r', '-D', 'LOG=/l', '-p', AGY_WALL, '/bin/cat', 'x']));
  const rev = read('packs/review-gate/runtime/review.mjs'), ask = read('tools/ask-model.mjs');
  const fix = (src) => /^const AGY_TOKEN_FIX = ('[^'\n]+');?$/m.exec(src)?.[1];
  const tokenPath = (src) => /^const AGY_TOKEN_PATH = (?:path\.)?join\(('.gemini', 'antigravity-cli', 'antigravity-oauth-token')\);?$/m.exec(src)?.[1];
  ok('both runtimes name the same token file and give the same fix', fix(ask) !== undefined && fix(ask) === fix(rev)
    && tokenPath(ask) !== undefined && tokenPath(ask) === tokenPath(rev), J({ ask: [fix(ask), tokenPath(ask)], rev: [fix(rev), tokenPath(rev)] }));
  ok('the review runtime spawns agy for a review only through sandbox-exec; only --version runs bare',
    (rev.match(/spawnSync\('agy'/g) || []).length === 1 && /spawnSync\('agy', \['--version'\]/.test(rev) && /spawnSync\(SANDBOX_EXEC, agyWall\(walled\.params, \[bin, '-p'/.test(rev));
}

console.log('\nagy wall: refusals that need no sandbox');
{
  ok('off macOS agy is refused, naming the platform', /runs only inside its macOS sandbox \(sandbox-exec\), and this is linux/.test(agyWallProblem('linux') ?? ''), J(agyWallProblem('linux')));
  const home = fs.realpathSync(tempDir('acs-agy-wall-home-'));
  const r1 = agyReadRoot(home, home);
  ok('a read root that is HOME is refused', /is your home folder or holds it/.test(r1.error ?? ''), J(r1));
  const r2 = agyReadRoot(path.dirname(home), home);
  ok('…and one that holds HOME', /is your home folder or holds it/.test(r2.error ?? ''), J(r2));
  ok('…and /', /home folder or holds it/.test(agyReadRoot('/', home).error ?? ''));
  const repo = path.join(home, 'repo');
  fs.mkdirSync(path.join(repo, 'src', 'deep'), { recursive: true });
  spawnSync('git', ['init', '-q', repo]);
  const inRepo = agyReadRoot(path.join(repo, 'src', 'deep'), home);
  ok('inside a git work tree the root is its top folder', inRepo.root === repo, J(inRepo));
  // Git variables a caller inherits (a hook sets GIT_DIR, say) must not move the root to another tree.
  const other = path.join(home, 'other');
  fs.mkdirSync(other); spawnSync('git', ['init', '-q', other]);
  const inherited = { GIT_DIR: path.join(other, '.git'), GIT_WORK_TREE: other, GIT_COMMON_DIR: path.join(other, '.git'),
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.worktree', GIT_CONFIG_VALUE_0: other, GIT_CONFIG_PARAMETERS: `'core.worktree=${other}'` };
  const saved = Object.fromEntries(Object.keys(inherited).map((k) => [k, process.env[k]]));
  Object.assign(process.env, inherited);
  let moved;
  try { moved = agyReadRoot(path.join(repo, 'src', 'deep'), home); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
  ok('an inherited GIT_DIR or GIT_WORK_TREE does not move the root', moved.root === repo, J(moved));
  // A repository's own config can name another work tree (core.worktree), and a committed folder holding HEAD,
  // objects/ and refs/ is a repository with its own config: from inside either, git names that tree. Refused.
  const elsewhere = path.join(home, 'elsewhere');
  fs.mkdirSync(elsewhere);
  const cfgRepo = path.join(home, 'cfg-repo');
  fs.mkdirSync(path.join(cfgRepo, 'src'), { recursive: true });
  spawnSync('git', ['init', '-q', cfgRepo]); spawnSync('git', ['-C', cfgRepo, 'config', 'core.worktree', elsewhere]);
  const viaConfig = agyReadRoot(path.join(cfgRepo, 'src'), home);
  ok('core.worktree in the repository\'s own config naming another tree is refused', /does not hold .*cfg-repo\/src/.test(viaConfig.error ?? ''), J(viaConfig));
  const tracked = path.join(repo, 'fixtures', 'gd');
  for (const d of ['objects', 'refs/heads', 'deeper']) fs.mkdirSync(path.join(tracked, d), { recursive: true });
  fs.writeFileSync(path.join(tracked, 'HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(path.join(tracked, 'config'), `[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tworktree = ${elsewhere}\n`);
  const viaFolder = agyReadRoot(path.join(tracked, 'deeper'), home);
  ok('…and so is a cwd inside a tracked folder git takes for a repository naming another tree', /does not hold .*fixtures\/gd\/deeper/.test(viaFolder.error ?? ''), J(viaFolder));
  ok('…while the repository holding that folder still reads as itself from its top', agyReadRoot(repo, home).root === repo, J(agyReadRoot(repo, home)));
  spawnSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'base']);
  const linked = path.join(home, 'linked');
  spawnSync('git', ['-C', repo, 'worktree', 'add', '-q', linked]);
  fs.mkdirSync(path.join(linked, 'sub'), { recursive: true });
  const inLinked = agyReadRoot(path.join(linked, 'sub'), home);
  ok('a subfolder of a linked worktree is accepted, its root the worktree', inLinked.root === fs.realpathSync(linked), J(inLinked));
  const wrongCase = home.replace(/acs-agy-wall-home-/, 'ACS-AGY-WALL-HOME-');
  if (fs.existsSync(wrongCase)) {
    const shouted = agyReadRoot(wrongCase, home);
    ok('HOME spelled in the wrong case is still refused as HOME', /is your home folder or holds it/.test(shouted.error ?? ''), J(shouted));
  } else console.log('  SKIP the wrong-case HOME spelling (this file system tells case apart)');
  // The review runtime's copy, lifted out of its source (the runtime is a script, not a module) and run on the same cases.
  const revSrc = read('packs/review-gate/runtime/review.mjs');
  const start = revSrc.indexOf('function agyReadRoot(cwd, home = homedir()) {');
  const body = start === -1 ? null : revSrc.slice(start, revSrc.indexOf('\n}\n', start) + 2);
  const revReadRoot = body && Function('spawnSync', 'realpathSync', 'resolve', 'homedir', `${body}\nreturn agyReadRoot;`)(spawnSync, fs.realpathSync, path.resolve, os.homedir);
  ok('the review runtime has its own agyReadRoot', typeof revReadRoot === 'function');
  if (revReadRoot) {
    const same = [
      ['HOME', revReadRoot(home, home).error, /is your home folder or holds it/],
      ['a repo subfolder', revReadRoot(path.join(repo, 'src', 'deep'), home).root, repo],
      ['core.worktree in its config', revReadRoot(path.join(cfgRepo, 'src'), home).error, /does not hold .*cfg-repo\/src/],
      ['a tracked repository folder', revReadRoot(path.join(tracked, 'deeper'), home).error, /does not hold .*fixtures\/gd\/deeper/],
      ['a linked worktree subfolder', revReadRoot(path.join(linked, 'sub'), home).root, fs.realpathSync(linked)],
      ...(fs.existsSync(wrongCase) ? [['HOME in the wrong case', revReadRoot(wrongCase, home).error, /is your home folder or holds it/]] : []),
    ].filter(([, got, want]) => !(want instanceof RegExp ? want.test(got ?? '') : got === want));
    ok('…and it decides every case above the way ask-model\'s does', same.length === 0, J(same));
  }
  const plain = fs.realpathSync(tempDir('acs-agy-wall-plain-'));
  ok('outside one it is the folder itself', agyReadRoot(plain, home).root === plain, J(agyReadRoot(plain, home)));
  const near = `${home}-other`;
  fs.mkdirSync(near, { recursive: true });
  ok('a folder whose name only starts with HOME\'s is not HOME', agyReadRoot(near, home).root === near, J(agyReadRoot(near, home)));
  fs.rmSync(near, { recursive: true });
  const log = path.join(plain, 'call.log');
  const after = (text, h = plain) => { fs.writeFileSync(log, text); return agyAfterCall(log, h); };
  ok('agyAfterCall: a log without the line, and no token file, is fine', after('I keyringAuth: loaded token\n') === null, J(after('I keyringAuth: loaded token\n')));
  ok('…the line agy writes when it keeps the token in a file is caught', /"file-based token storage"/.test(after('W Using file-based token storage because a keyring timeout was recorded within the last 1h0m0s\n') ?? ''));
  ok('…as is its other wording', /"file-based token storage"/.test(after('Keyring set failed (x); using file-based token storage for writes for the rest of this process\n') ?? ''));
  const missing = agyAfterCall(path.join(plain, 'none.log'), plain);
  ok('…a log agy never wrote is refused with its own message', /agy left no log of the call at .*none\.log, so whether it kept its Google sign-in token in a file is unknown/.test(missing ?? ''), J(missing));
  if (process.getuid?.() !== 0) {
    fs.writeFileSync(log, 'I keyringAuth: loaded token\n'); fs.chmodSync(log, 0o000);
    const unreadable = agyAfterCall(log, plain);
    fs.chmodSync(log, 0o600);
    ok('…an unreadable one with its own message, not as if the line were read', /could not be read \(EACCES\), so whether it kept/.test(unreadable ?? '')
      && !/"file-based token storage"\)/.test(unreadable ?? ''), J(unreadable));
  }
  const th = fs.realpathSync(tempDir('acs-agy-wall-token-home-'));
  const tf = path.join(th, '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
  ok('agyTokenLeft: no token file is fine', agyTokenLeft(th) === null, J(agyTokenLeft(th)));
  fs.mkdirSync(path.dirname(tf), { recursive: true });
  fs.writeFileSync(tf, '{}');
  const found = agyTokenLeft(th);
  ok('…the file agy writes is named', found?.file === tf && /holds agy's Google sign-in token in plain text/.test(found.why), J(found));
  fs.rmSync(tf); fs.symlinkSync(path.join(th, 'nowhere'), tf);
  ok('…so is a link at that path, even one that leads nowhere', agyTokenLeft(th)?.file === tf, J(agyTokenLeft(th)));
  fs.rmSync(tf);
  fs.writeFileSync(tf, '{}');
  const leftBehind = agyAfterCall((fs.writeFileSync(path.join(th, 'call.log'), 'I keyringAuth: loaded token\n'), path.join(th, 'call.log')), th);
  ok('agyAfterCall: a token file found after the call is named with the fix, though the log is clean', leftBehind?.includes(`${tf} holds agy's Google sign-in token in plain text`)
    && /delete it: agy signs in from the keychain without it/.test(leftBehind), J(leftBehind));
  fs.rmSync(tf);
  if (process.getuid?.() !== 0) {
    fs.chmodSync(path.dirname(tf), 0o000);
    const blind = agyTokenLeft(th);
    fs.chmodSync(path.dirname(tf), 0o755);
    ok('…and a folder that cannot be looked into counts as one, not as none', /could not be checked \(EACCES\)/.test(blind?.why ?? ''), J(blind));
  }
}

if (process.platform !== 'darwin') {
  console.log('\n  SKIP the sandbox checks (sandbox-exec is macOS only)');
} else {
  const nested = spawnSync(SANDBOX_EXEC, ['-p', '(version 1)(allow default)', '/usr/bin/true'], { encoding: 'utf8' });
  if (nested.status !== 0) {
    ok('sandbox-exec runs here (run this file from a shell outside any sandbox)', false, `exit ${nested.status}: ${nested.stderr.trim()}`);
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(1);
  }
  ok('agyWallProblem is null on this Mac', agyWallProblem() === null, J(agyWallProblem()));

  // A fake HOME shaped like the real one: every file agy's state has, each holding a token a read would show.
  const home = fs.realpathSync(tempDir('acs-agy-wall-fake-home-'));
  const files = {
    allowed: ['.gemini/config/hooks.json', '.gemini/config/projects/default-cli-project.json', '.gemini/antigravity-cli/settings.json',
      '.gemini/antigravity-cli/installation_id', '.gemini/antigravity-cli/jetski_state.pbtxt', '.gemini/antigravity-cli/cache/default_project_id.txt',
      '.gemini/antigravity-cli/cache/onboarding.json', '.gemini/antigravity-cli/builtin/skills/x/SKILL.md', 'Library/Keychains/login.keychain-db',
      'Library/Keychains/.flDEADBEEF', 'Library/Keychains/login.keychain-db.sb-8ea883a1-WYOv2i'],
    denied: ['.gemini/antigravity-cli/history.jsonl', '.gemini/antigravity-cli/conversation_summaries.db', '.gemini/antigravity-cli/conversations/c.db',
      '.gemini/antigravity-cli/brain/c/.system_generated/logs/transcript.jsonl', '.gemini/antigravity-cli/cache/conversation_metadata.json',
      '.gemini/antigravity-cli/cache/last_conversations.json', '.gemini/antigravity-cli/jetbox_summaries_proto.pb', '.gemini/antigravity-cli/implicit/x.pb',
      '.gemini/antigravity-cli/log/cli.log', '.gemini/sandbox/x', '.gemini/antigravity-cli/antigravity-oauth-token', 'Library/Keychains/metadata.keychain-db',
      'Library/Keychains/.flDEADBEEF.x', 'Library/Keychains/.flDEADBEE', 'Library/Keychains/login.keychain-db.bak',
      'Library/Keychains/2C4E543B-3573-52A2-A306-C052855C84D6/keychain-2.db', '.ssh/id_ed25519', '.codex/auth.json', '.config/gh/hosts.yml'],
  };
  for (const rel of [...files.allowed, ...files.denied]) {
    fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true });
    fs.writeFileSync(path.join(home, rel), `token:${rel}`);
  }
  const root = fs.realpathSync(tempDir('acs-agy-wall-root-'));
  fs.writeFileSync(path.join(root, 'README.md'), 'inside');
  fs.symlinkSync(path.join(home, '.ssh', 'id_ed25519'), path.join(root, 'link-out'));
  const callTmp = fs.realpathSync(tempDir('acs-agy-call-'));
  fs.writeFileSync(path.join(callTmp, 't'), 'call tmp');
  const logs = path.join(home, '.agent-config-studio', 'logs', 'agy');
  fs.mkdirSync(logs, { recursive: true });
  const logFile = path.join(logs, 'call.log');
  const bin = path.join(root, 'agy');
  fs.writeFileSync(bin, '#!/bin/sh\n'); fs.chmodSync(bin, 0o755);
  const p = agyWallParams({ root, callTmp, logFile, bin, home });
  ok('agyWallParams resolves every path to its real path', !p.error && p.params.TMP === fs.realpathSync(os.tmpdir()) && p.params.HOME === home
    && p.params.LOG === logFile && p.params.ROOT === root && p.params.CALL_TMP === callTmp && p.params.USER_TMP.startsWith('/private/var/folders/'), J(p));
  const walledCat = (file) => spawnSync(SANDBOX_EXEC, agyWall(p.params, ['/bin/cat', file]), { encoding: 'utf8' });
  for (const rel of files.allowed) {
    const r = walledCat(path.join(home, rel));
    ok(`allowed back: ~/${rel}`, r.status === 0 && r.stdout === `token:${rel}`, `${r.status} ${r.stderr}`);
  }
  for (const rel of files.denied) {
    const r = walledCat(path.join(home, rel));
    ok(`walled off: ~/${rel}`, r.status !== 0 && !r.stdout.includes('token:') && /Operation not permitted/.test(r.stderr), `${r.status} ${r.stdout} ${r.stderr}`);
  }
  const inside = walledCat(path.join(root, 'README.md'));
  ok('the read root is readable', inside.status === 0 && inside.stdout === 'inside', J(inside));
  const link = walledCat(path.join(root, 'link-out'));
  ok('a symlink in the root that points outside is refused (the wall sees the resolved path)', link.status !== 0 && !link.stdout.includes('token:'), J(link));
  const tmpFile = walledCat(path.join(callTmp, 't'));
  ok('the call\'s own temp folder is readable', tmpFile.status === 0 && tmpFile.stdout === 'call tmp', J(tmpFile));
  const other = fs.realpathSync(tempDir('acs-agy-wall-other-'));
  fs.writeFileSync(path.join(other, 's'), 'token:tmp');
  const viaVar = walledCat(path.join(other, 's').replace(/^\/private\/var\//, '/var/'));
  ok('a file elsewhere in the temp folder is refused, by /private/var and by /var', walledCat(path.join(other, 's')).status !== 0
    && viaVar.status !== 0 && !viaVar.stdout.includes('token:'), J(viaVar));
  const firm = walledCat(`/System/Volumes/Data${path.join(home, '.ssh', 'id_ed25519')}`);
  ok('…and through the data volume\'s own path for it', firm.status !== 0 && !firm.stdout.includes('token:'), J(firm));
  const ls = spawnSync(SANDBOX_EXEC, agyWall(p.params, ['/bin/ls', path.join(home, '.gemini', 'antigravity-cli')]), { encoding: 'utf8' });
  ok('a walled-off folder cannot be listed', ls.status !== 0 && !/history/.test(ls.stdout), J(ls));

  // agy's summaries: a walled process that tries every kind of write leaves each file's bytes and mtime as they were,
  // and cannot create the -wal or -shm; agy's other state files stay writable.
  const state = path.join(home, '.gemini', 'antigravity-cli');
  const kept = ['conversation_summaries.db', 'jetbox_summaries_proto.pb'].map((f) => path.join(state, f));
  const past = new Date('2026-01-02T03:04:05Z');
  for (const f of kept) { fs.writeFileSync(f, `summaries:${path.basename(f)}`); fs.utimesSync(f, past, past); }
  const snap = () => kept.map((f) => ({ f, bytes: fs.readFileSync(f, 'utf8'), mtime: fs.statSync(f).mtimeMs }));
  const before = snap();
  const tries = kept.flatMap((f) => [`echo x >> '${f}'`, `echo x > '${f}'`, `touch '${f}'`, `rm -f '${f}'`, `mv -f '${f}' '${f}.old'`,
    `echo new > '${f}.tmp' && mv -f '${f}.tmp' '${f}'`, `ln -sf /etc/hosts '${f}'`]);
  const writes = tries.map((cmd) => spawnSync(SANDBOX_EXEC, agyWall(p.params, ['/bin/sh', '-c', cmd]), { encoding: 'utf8' }));
  ok('every write to the summaries is refused by the sandbox', writes.every((w) => w.status !== 0 && /Operation not permitted/.test(w.stderr)),
    J(writes.map((w, i) => [tries[i], w.status, w.stderr.trim()]).filter(([, s]) => s === 0)));
  ok('…and their bytes and mtimes are unchanged', J(snap()) === J(before), J({ before, after: snap() }));
  const sidecars = ['conversation_summaries.db-wal', 'conversation_summaries.db-shm'].map((f) => path.join(state, f));
  for (const f of sidecars) spawnSync(SANDBOX_EXEC, agyWall(p.params, ['/bin/sh', '-c', `echo x > '${f}'`]), { encoding: 'utf8' });
  ok('the database\'s -wal and -shm cannot be created', sidecars.every((f) => !fs.existsSync(f)), J(sidecars.filter((f) => fs.existsSync(f))));
  const onboarding = path.join(state, 'cache', 'onboarding.json');
  const rewrite = spawnSync(SANDBOX_EXEC, agyWall(p.params, ['/bin/sh', '-c', `echo '{}' > '${onboarding}'`]), { encoding: 'utf8' });
  ok('agy\'s other state files stay writable', rewrite.status === 0 && fs.readFileSync(onboarding, 'utf8') === '{}\n', J(rewrite));

  ok('the canary passes on the real paths', agyWallCanary(p.params) === null, J(agyWallCanary(p.params)));
  // Cleanup is checked in folders this test owns: another agy call on the machine can have a canary of its own in the
  // shared temp folder at any moment.
  const own = { ...p.params, TMP: fs.realpathSync(tempDir('acs-agy-wall-own-tmp-')), USER_TMP: fs.realpathSync(tempDir('acs-agy-wall-own-user-tmp-')) };
  const ownCanary = agyWallCanary(own);
  const leftover = [own.TMP, own.USER_TMP, logs].flatMap((d) => fs.readdirSync(d).filter((f) => f.startsWith('acs-agy-canary-')).map((f) => path.join(d, f)));
  ok('…and, run on folders this test owns, passes and leaves no test file behind', ownCanary === null && leftover.length === 0, J({ ownCanary, leftover }));
  const leaky = agyWallCanary({ ...p.params, ROOT: p.params.TMP });
  ok('a wall that lets the temp folder through fails the canary', /the wall let a test read .*acs-agy-canary-/.test(leaky ?? ''), J(leaky));
  const homeLeak = agyWallCanary({ ...p.params, ROOT: logs });
  ok('…and one that lets the log\'s folder in HOME through', /the wall let a test read .*\.agent-config-studio\/logs\/agy\/acs-agy-canary-/.test(homeLeak ?? ''), J(homeLeak));
  const blind = agyWallCanary({ ...p.params, ROOT: path.join(home, 'not-allowed-anywhere') });
  ok('a root that cannot be listed fails it too', /the wall refused to list the folder under review/.test(blind ?? ''), J(blind));
  // The canary run from inside another sandbox: sandbox-exec there cannot apply the wall and says so.
  const script = `import(${J(ASK)}).then((m) => process.stdout.write(String(m.agyWallCanary(${J(p.params)}))))`;
  const inner = spawnSync(SANDBOX_EXEC, ['-p', '(version 1)(allow default)', process.execPath, '--input-type=module', '-e', script], { encoding: 'utf8' });
  ok('inside another sandbox the canary names the nesting', /already runs inside a sandbox.*sandbox_apply: Operation not permitted.*outside any sandbox/.test(inner.stdout), J(inner));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
