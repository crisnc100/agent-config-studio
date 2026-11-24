import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { prepareNeonGrade } from './neon-grade.mjs';
import { startPostgres } from './run.mjs';

const TARGETS = ['spelled', 'canonical'];
const CONTROLS = ['neighborUnix', 'neighborTcp', 'outsideFile'];
const STATUS = new Set(['connected', 'read', 'denied', 'error']);
const ACCESS_DENIED = new Set(['EPERM', 'EACCES']);
const ERRNO = new Set(['EPERM', 'EACCES', 'ENOENT', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTDIR', 'ENAMETOOLONG']);
const VERSION = /^v?\d+(?:\.\d+){1,3}$/;
const DRIVER_VERSION = '3.3.8';

const NODE_PROBE = String.raw`
import fs from 'node:fs';
import net from 'node:net';
const target = JSON.parse(fs.readFileSync('targets.json', 'utf8'));
const classify = (code) => ({ status: ['EPERM', 'EACCES'].includes(code) ? 'denied' : 'error', errno: code });
const connect = (options) => new Promise((resolve) => {
  const sock = net.connect(options);
  sock.setTimeout(3000, () => sock.destroy(Object.assign(new Error(), { code: 'ETIMEDOUT' })));
  sock.once('error', (e) => resolve(classify(e.code)));
  sock.once('connect', () => { sock.destroy(); resolve({ status: 'connected' }); });
});
const endpoint = {};
for (const kind of ['spelled', 'canonical']) endpoint[kind] = await connect({ path: target[kind] });
const controls = {};
controls.neighborUnix = await connect({ path: target.neighborUnix });
controls.neighborTcp = await connect(target.neighborTcp);
try { fs.readFileSync(target.outsideFile); controls.outsideFile = { status: 'read' }; }
catch (e) { controls.outsideFile = classify(e.code); }
console.log(JSON.stringify({ runtime: process.version, endpoint, controls }));
`;

const PYTHON_PROBE = String.raw`
import errno, json, os, socket, sys
from urllib.parse import parse_qs, urlsplit
import psycopg

with open('targets.json', encoding='utf-8') as file:
    target = json.load(file)
url = urlsplit(os.environ['FIRSTCALL_DATABASE_URL'])
params = parse_qs(url.query)

def classify(exc):
    code = errno.errorcode.get(getattr(exc, 'errno', None))
    if not code:
        # libpq exposes the connect errno as text via OperationalError.
        code = next((name for name in ('EPERM', 'EACCES', 'ENOENT', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTDIR', 'ENAMETOOLONG')
                     if os.strerror(getattr(errno, name)) in str(exc)), None)
    return {'status': 'denied' if code in ('EPERM', 'EACCES') else 'error', 'errno': code}

def connect(address, family=socket.AF_UNIX):
    try:
        with socket.socket(family, socket.SOCK_STREAM) as client:
            client.settimeout(3)
            client.connect(address)
        return {'status': 'connected'}
    except OSError as exc:
        return classify(exc)

def pg_connect(address):
    try:
        with psycopg.connect(host=os.path.dirname(address), port=params['port'][0], user=url.username,
                             dbname=url.path.removeprefix('/'), connect_timeout=3):
            pass
        return {'status': 'connected'}
    except psycopg.Error as exc:
        return classify(exc)

raw = {kind: connect(target[kind]) for kind in ('spelled', 'canonical')}
driver = {kind: pg_connect(target[kind]) for kind in ('spelled', 'canonical')}
controls = {
    'neighborUnix': connect(target['neighborUnix']),
    'neighborTcp': connect((target['neighborTcp']['host'], target['neighborTcp']['port']), socket.AF_INET),
}
try:
    with open(target['outsideFile'], 'rb') as file:
        file.read(1)
    controls['outsideFile'] = {'status': 'read'}
except OSError as exc:
    controls['outsideFile'] = classify(exc)
print(json.dumps({'runtime': '.'.join(map(str, sys.version_info[:3])), 'driverVersion': psycopg.__version__,
                  'implementation': psycopg.pq.__impl__, 'libpqVersion': psycopg.pq.version(),
                  'endpoint': raw, 'psycopg': driver, 'controls': controls}))
`;

function sanitizedResult(value) {
  const errno = ERRNO.has(value?.errno) ? value.errno : null;
  const validStatus = STATUS.has(value?.status) && (value.status !== 'denied' || ACCESS_DENIED.has(errno));
  return { status: validStatus ? value.status : 'error', errno };
}

function projectClient(result, python) {
  const value = JSON.parse(result.stdout);
  const project = (group, keys) => Object.fromEntries(keys.map((key) => [key, sanitizedResult(group?.[key])]));
  const report = {
    runtime: typeof value.runtime === 'string' && VERSION.test(value.runtime) ? value.runtime : null,
    endpoint: project(value.endpoint, TARGETS),
    controls: project(value.controls, CONTROLS),
  };
  if (python) Object.assign(report, {
    psycopg: project(value.psycopg, TARGETS),
    driverVersion: value.driverVersion === DRIVER_VERSION ? value.driverVersion : null,
    implementation: ['binary', 'c', 'python'].includes(value.implementation) ? value.implementation : null,
    libpqVersion: Number.isSafeInteger(value.libpqVersion) && value.libpqVersion > 0 ? value.libpqVersion : null,
  });
  return report;
}

function deniedControls(client) {
  return CONTROLS.every((key) => client.controls[key].status === 'denied');
}

function launch(command, args, { cwd, env, signal, timeout = 30_000 }) {
  signal.throwIfAborted();
  return new Promise((resolve) => {
    const child = spawn('/usr/sbin/taskpolicy', ['-b', command, ...args], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const kill = () => { if (child.pid) try { process.kill(-child.pid, 'SIGKILL'); } catch { /* exited */ } };
    const timer = setTimeout(kill, timeout);
    signal.addEventListener('abort', kill, { once: true });
    let stdout = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      if (stdout.length + chunk.length > 32_768) kill();
      else stdout += chunk;
    });
    child.on('error', kill);
    child.once('close', (status) => {
      kill();
      clearTimeout(timer);
      signal.removeEventListener('abort', kill);
      resolve({ status, stdout });
    });
  });
}

function listen(servers, location) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((connection) => connection.destroy());
    servers.push(server);
    server.once('error', reject);
    server.listen(location, () => resolve(server.address()));
  });
}

function makeCase(root, kind) {
  const dir = path.join(root, kind);
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo, { recursive: true, mode: 0o700 });
  return { case: dir, repo };
}

async function setupPython(grade, repo, signal) {
  const env = { HOME: os.homedir(), PATH: '/usr/bin:/bin', LC_ALL: 'C' };
  const invocation = grade.invocation(grade.preflight);
  const uv = fs.realpathSync(path.join(invocation.env.PATH.split(path.delimiter)[0], 'uv'));
  const run = (args, extra = {}, home = env.HOME) => launch(uv, args, {
    cwd: repo, env: { ...env, HOME: home, ...extra }, signal, timeout: 180_000,
  });
  const existing = await run(['--no-config', 'python', 'find', '--offline', '--managed-python', '3.12']);
  if (existing.status === 0) {
    const interpreter = existing.stdout.trim();
    if (!path.isAbsolute(interpreter)) throw new Error('the managed Python path is not absolute');
    const managed = path.dirname(path.dirname(interpreter));
    fs.cpSync(managed, path.join(grade.setupEnv.UV_PYTHON_INSTALL_DIR, path.basename(managed)),
      { recursive: true, verbatimSymlinks: true, mode: fs.constants.COPYFILE_FICLONE });
  }

  fs.writeFileSync(path.join(repo, 'pyproject.toml'), `[project]
name = "fixture"
version = "0.0.0"
requires-python = ">=3.12,<3.13"
dependencies = ["psycopg[binary]==${DRIVER_VERSION}"]
`);
  const cache = await run(['--no-config', 'cache', 'dir']);
  const hostCache = cache.stdout.trim();
  const options = ['--no-config', 'sync', '--python', '3.12', '--default-index', 'https://pypi.org/simple'];
  const privateHome = invocation.env.HOME;
  if (cache.status === 0 && path.isAbsolute(hostCache) && fs.existsSync(hostCache)) {
    // Only this trusted install may consult the existing package cache. The venv copies dependencies
    // into the case, and the actual sandbox sees only the case-local cache.
    const offline = await run([...options, '--offline'], { ...grade.setupEnv, UV_CACHE_DIR: hostCache }, privateHome);
    if (offline.status === 0) return 'offline';
  }
  const setup = await run(options, grade.setupEnv, privateHome);
  return setup.status === 0 ? 'online-setup' : null;
}

async function runPg() {
  if (process.platform !== 'darwin') return { status: 'unsupported-platform' };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-controls-'));
  const controller = new AbortController();
  const signal = controller.signal;
  const cancel = () => controller.abort();
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const event of signals) process.on(event, cancel);
  const servers = [];
  let pg;
  let stage = 'setup';
  try {
    const node = makeCase(root, 'node');
    const python = makeCase(root, 'python');
    const auxiliary = path.join(root, 'aux');
    fs.mkdirSync(auxiliary);
    const nodeCommand = 'node socket-probe.mjs';
    const pythonCommand = 'uv run python socket-probe.py';
    const nodeGrade = prepareNeonGrade(nodeCommand, node);
    const pythonGrade = prepareNeonGrade(pythonCommand, python);
    stage = 'python-setup';
    const setup = await setupPython(pythonGrade, python.repo, signal);
    if (!setup) return { status: signal.aborted ? 'interrupted' : 'setup-failed', stage };

    stage = 'postgres-setup';
    signal.throwIfAborted();
    pg = await startPostgres({ checked: { how: 'FIRSTCALL_DATABASE_URL=postgresql+psycopg://' } },
      'a Postgres named by FIRSTCALL_DATABASE_URL', auxiliary, { neonGrade: true });
    if (pg.error) return { status: 'setup-failed', stage };
    signal.throwIfAborted();
    stage = 'control-setup';
    const spelled = pg.socket;
    const canonical = path.join(fs.realpathSync(path.dirname(spelled)), path.basename(spelled));
    const outsideFile = path.join(root, 'outside.txt');
    fs.writeFileSync(outsideFile, 'harmless canary');
    // The real socket is removed with the PG service. Put the unrelated canary beside it
    // so both sockets share the same ancestors and pathname spelling.
    const neighborUnix = await listen(servers, path.join(path.dirname(spelled), 'neighbor.sock'));
    const neighborTcp = await listen(servers, { host: '127.0.0.1', port: 0 });
    const targets = { spelled, canonical, outsideFile, neighborUnix, neighborTcp: { host: neighborTcp.address, port: neighborTcp.port } };
    for (const dir of [node.repo, python.repo]) fs.writeFileSync(path.join(dir, 'targets.json'), JSON.stringify(targets));
    fs.writeFileSync(path.join(node.repo, 'socket-probe.mjs'), NODE_PROBE);
    fs.writeFileSync(path.join(python.repo, 'socket-probe.py'), PYTHON_PROBE);

    const grade = async (worker, cwd, command, python) => {
      const { cmd, args, env } = worker.invocation(command, pg);
      const result = await launch(cmd, args, { cwd, env, signal });
      if (result.status !== 0) return { status: 'client-failed', exitCode: result.status };
      try { return projectClient(result, python); } catch { return { status: 'invalid-client-output' }; }
    };
    stage = 'grade';
    const nodeResult = await grade(nodeGrade, node.repo, nodeCommand, false);
    const pythonResult = await grade(pythonGrade, python.repo, pythonCommand, true);
    const observed = nodeResult.runtime && pythonResult.runtime && pythonResult.driverVersion
      && pythonResult.libpqVersion && pythonResult.implementation === 'binary';
    const secure = observed && deniedControls(nodeResult) && deniedControls(pythonResult);
    return {
      status: signal.aborted ? 'interrupted' : secure ? 'observed' : observed ? 'control-failed' : 'client-failed',
      setup,
      aliasesDistinct: spelled !== canonical,
      node: nodeResult,
      python: pythonResult,
    };
  } catch {
    return { status: signal.aborted ? 'interrupted' : 'setup-failed', stage };
  } finally {
    try {
      await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
    } finally {
      try { await pg?.stop?.(); }
      finally {
        fs.rmSync(root, { recursive: true, force: true });
        for (const event of signals) process.removeListener(event, cancel);
      }
    }
  }
}

function selfTest() {
  const clean = projectClient({ stdout: JSON.stringify({
    runtime: '3.12.12', driverVersion: DRIVER_VERSION, implementation: 'binary', libpqVersion: 180000,
    endpoint: { spelled: { status: 'denied', errno: 'EPERM', message: '/private/must-not-leak' } },
    controls: { neighborUnix: { status: 'denied', errno: 'EACCES' } },
    psycopg: { canonical: { status: 'connected', path: '/private/must-not-leak' } },
  }) }, true);
  assert.deepEqual(clean.endpoint.spelled, { status: 'denied', errno: 'EPERM' });
  assert.deepEqual(clean.psycopg.canonical, { status: 'connected', errno: null });
  assert.equal(clean.driverVersion, DRIVER_VERSION);
  assert.equal(deniedControls(clean), false);
  assert.equal(JSON.stringify(clean).includes('/private'), false);
  assert.deepEqual(sanitizedResult({ status: 'bogus', errno: '/path' }), { status: 'error', errno: null });
  assert.deepEqual(sanitizedResult({ status: 'denied', errno: 'ENOENT' }), { status: 'error', errno: 'ENOENT' });
  return { status: 'self-test-passed' };
}

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--run-pg') {
  const result = await runPg().catch(() => ({ status: 'cleanup-failed' }));
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== 'observed') process.exitCode = 2;
} else if (args.length === 1 && args[0] === '--self-test') {
  console.log(JSON.stringify(selfTest()));
} else {
  console.log('usage: node runtime-controls.mjs [--self-test | --run-pg]');
  if (args.length) process.exitCode = 2;
}
