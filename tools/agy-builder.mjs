import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { spawn, spawnSync } from 'node:child_process';
import { setImmediate as yieldToSignals } from 'node:timers/promises';
import { captureAgySource, protectedSourcePattern } from './agy-builder-source.mjs';

const SAFE_ENV = { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' };
const GOOGLE_ROUTES = {
  'daily-cloudcode-pa.googleapis.com': {
    '/v1internal:loadCodeAssist': 'POST',
    '/v1internal:fetchAvailableModels': 'POST',
    '/v1internal:generateContent': 'POST',
    '/v1internal:streamGenerateContent': 'POST',
    '/v1internal:streamGenerateContent?alt=sse': 'POST',
    '/v1internal:retrieveUserQuota': 'POST',
    '/v1internal:listExperiments': 'POST',
  },
  'oauth2.googleapis.com': { '/token': 'POST' },
  'play.googleapis.com': { '/log': 'POST' },
  'www.googleapis.com': { '/oauth2/v2/userinfo': 'GET' },
  'aicode.googleapis.com': { '/v1alpha:fetchConfig': 'GET' },
};

const AGY_VERSION = '1.5.14';
const AGY_DIGEST = 'e8c2959bf4744580d0e5b8f938ec2dc3918a942b620a6262e53856400f14e5fb';
const SANDBOX = '/usr/bin/sandbox-exec';

export function agyBuildWall({ source, runtime, certificate, bin, home, port }, command) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid broker port');
  const keychain = [
    '(literal (string-append (param "HOME") "/Library/Keychains/login.keychain-db"))',
    '(regex (string-append "^" (regex-quote (param "HOME")) "/Library/Keychains/\\\\.fl[0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F]$"))',
    '(regex (string-append "^" (regex-quote (param "HOME")) "/Library/Keychains/login\\\\.keychain-db\\\\.sb-[0-9a-f]+-[A-Za-z0-9]+$"))',
  ].join(' ');
  const profile = [
    '(version 1)',
    '(deny default)',
    '(import "dyld-support.sb")',
    '(allow syscall* mach-bootstrap process-fork sysctl-read system-info)',
    '(allow file-read-metadata (literal "/etc") (literal "/var") (literal "/tmp") (literal "/private/etc") (literal "/private/var"))',
    '(allow file-read-metadata (apply path-ancestors (list (param "SOURCE") (param "RUNTIME") (param "CA") (param "AGY") (string-append (param "HOME") "/Library/Keychains"))))',
    '(allow file-read* (subpath "/System/Library") (subpath "/usr/lib") (subpath "/usr/bin") (subpath "/usr/share") (subpath "/bin") (subpath "/private/var/db/timezone") (subpath "/private/etc/ssl") (literal "/private/etc/passwd") (literal "/private/etc/hosts") (literal "/private/etc/apache2/mime.types") (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random"))',
    '(allow file-map-executable (subpath "/System/Library") (subpath "/usr/lib") (subpath "/usr/bin") (literal (param "AGY")))',
    '(allow process-exec (literal (param "AGY")) (literal "/usr/bin/security"))',
    '(allow file-write-data (literal "/dev/null"))',
    `(allow file-read* (subpath (param "SOURCE")) (subpath (param "RUNTIME")) (literal (param "CA")) (literal (param "AGY")) ${keychain})`,
    `(allow file-write* (subpath (param "SOURCE")) (subpath (param "RUNTIME")) ${keychain})`,
    `(deny file-write* (require-all (subpath (param "SOURCE")) (regex #${JSON.stringify(protectedSourcePattern)})))`,
    '(deny file-write* (regex #"(^|/)antigravity-oauth-token$"))',
    // Startup registers this private workspace under projects. Hook, plugin and permission config remain unwritable.
    '(deny file-write* (require-all (subpath (string-append (param "RUNTIME") "/home/.gemini/config")) (require-not (regex (string-append "^" (regex-quote (param "RUNTIME")) "/home/[.]gemini/config/projects/[^/]+[.]json([.][^/]+[.]tmp)?$")))))',
    '(deny file-write* (regex #"(^|/)(hooks|mcp_config|plugins|agents)[.]json([.][^/]+[.]tmp)?$") (literal (string-append (param "RUNTIME") "/home/.gemini/antigravity-cli/settings.json")) (literal (string-append (param "RUNTIME") "/home/Library")) (literal (string-append (param "RUNTIME") "/home/Library/Keychains")))',
    '(allow mach-lookup (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd") (global-name "com.apple.system.logger") (global-name "com.apple.trustd.agent") (global-name "com.apple.trustd"))',
    // Pinned agy binds its language server to loopback. Seatbelt checks the outbound broker port separately.
    '(allow network-bind network-inbound (local tcp "localhost:*"))',
    `(allow network-outbound (remote tcp "localhost:${port}"))`,
  ].join('\n');

  const params = { SOURCE: source, RUNTIME: runtime, CA: certificate, AGY: bin, HOME: home };
  return [...Object.entries(params).flatMap(([name, value]) => ['-D', `${name}=${value}`]), '-p', profile, ...command];
}

function makeCertificate(directory, origins) {
  const config = path.join(directory, 'certificate.conf');
  const certificate = path.join(directory, 'root.pem');
  const keyFile = path.join(directory, 'key.pem');
  fs.writeFileSync(config, [
    '[req]', 'distinguished_name=subject', 'x509_extensions=extensions', 'prompt=no',
    '[subject]', 'CN=ACS private Google broker',
    '[extensions]', 'basicConstraints=critical,CA:TRUE',
    'keyUsage=critical,digitalSignature,keyEncipherment,keyCertSign', 'extendedKeyUsage=serverAuth',
    `subjectAltName=${origins.map((name) => `DNS:${name}`).join(',')}`,
  ].join('\n'), { mode: 0o600, flag: 'wx' });
  const result = spawnSync('/usr/bin/openssl', ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-x509', '-days', '1',
    '-config', config, '-keyout', keyFile, '-out', certificate], { env: SAFE_ENV, stdio: 'ignore', timeout: 10000 });
  if (result.status !== 0) throw new Error('could not create a per-call Google broker certificate');
  const context = tls.createSecureContext({ cert: fs.readFileSync(certificate), key: fs.readFileSync(keyFile), minVersion: 'TLSv1.2' });
  fs.unlinkSync(keyFile);
  return { certificate, context };
}

const HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection',
  'te', 'trailer', 'transfer-encoding', 'upgrade']);
function endToEnd(headers) {
  const connections = (headers.connection || '').toLowerCase().split(',').map((name) => name.trim());
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !HOP_HEADERS.has(name) && !connections.includes(name)));
}

export async function agyGoogleBroker(directory, { requestUpstream = https.request } = {}) {
  const origins = Object.keys(GOOGLE_ROUTES);
  const { certificate, context } = makeCertificate(directory, origins);
  const username = 'agy';
  const password = crypto.randomBytes(24).toString('hex');
  const credentials = Buffer.from(`${username}:${password}`).toString('base64');
  const auth = `Basic ${credentials}`;
  const sockets = new Set();
  const events = [];
  const record = (event) => { if (events.length < 1000) events.push(event); };
  const processed = http.createServer((req, res) => {
    const origin = req.socket.allowedOrigin;
    const pathname = req.url.split(/[?#]/, 1)[0];
    const evidence = { origin, method: req.method };
    if (/^\/(?!\/)[a-z0-9/_:.-]{0,255}$/i.test(pathname) && !pathname.includes(password) &&
      !pathname.includes(credentials.replace(/=+$/, ''))) evidence.path = pathname;
    const route = Object.hasOwn(GOOGLE_ROUTES[origin], req.url);
    const contentLengths = req.headersDistinct['content-length'];
    const unsafeGet = req.method === 'GET' && (
      Object.hasOwn(req.headersDistinct, 'transfer-encoding') ||
      (contentLengths && (contentLengths.length !== 1 || contentLengths[0] !== '0')) ||
      Object.keys(req.headersDistinct).some((name) => /(?:^|[-_])method(?:[-_]|$)|method[-_]?override|override[-_]?method/.test(name))
    );
    if (!route || unsafeGet || GOOGLE_ROUTES[origin][req.url] !== req.method || req.headersDistinct.host?.length !== 1 ||
      ![origin, `${origin}:443`].includes(req.headers.host)) {
      record({ ...evidence, status: 403, reason: 'request denied' });
      return res.writeHead(403).end();
    }
    const upstream = requestUpstream({
      hostname: origin, servername: origin, port: 443, method: req.method, path: req.url,
      rejectUnauthorized: true, ca: tls.rootCertificates, agent: false,
      headers: { ...endToEnd(req.headers), host: origin },
    }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400) {
        record({ ...evidence, status: 502, upstreamStatus: response.statusCode, reason: 'upstream redirect denied' });
        response.resume();
        res.writeHead(502).end();
        return;
      }
      record({ ...evidence, status: response.statusCode });
      const headers = endToEnd(response.headers);
      delete headers['alt-svc'];
      delete headers.location;
      res.writeHead(response.statusCode, headers);
      response.on('error', () => res.destroy());
      response.pipe(res);
    });
    upstream.on('error', () => {
      record({ ...evidence, status: res.headersSent ? undefined : 502, reason: 'upstream failed' });
      if (res.headersSent) res.destroy();
      else res.writeHead(502).end();
    });
    res.on('close', () => upstream.destroy());
    req.on('error', () => upstream.destroy());
    if (req.method === 'GET') upstream.end();
    else req.pipe(upstream);
  });
  processed.on('connect', (_req, socket) => socket.destroy());
  processed.on('upgrade', (_req, socket) => socket.destroy());
  const proxy = http.createServer((_req, res) => res.writeHead(403).end());
  proxy.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  proxy.on('connect', (req, socket, head) => {
    socket.on('error', () => {});
    const origin = origins.find((name) => req.url === `${name}:443`);
    if (!origin || req.headersDistinct['proxy-authorization']?.length !== 1 || req.headers['proxy-authorization'] !== auth) {
      record({ origin, method: 'CONNECT', status: 403, reason: 'CONNECT denied' });
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    record({ origin, method: 'CONNECT', status: 200 });
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    const wrapped = new tls.TLSSocket(socket, {
      isServer: true, secureContext: context, ALPNProtocols: ['http/1.1'],
      SNICallback: (servername, done) => done(servername === origin ? null : new Error('TLS authority mismatch'), context),
    });
    wrapped.on('error', () => { record({ origin, method: 'CONNECT', reason: 'client TLS failed' }); wrapped.destroy(); });
    if (head.length) socket.unshift(head);
    wrapped.once('secure', () => {
      if (wrapped.servername !== origin) return wrapped.destroy();
      wrapped.allowedOrigin = origin;
      processed.emit('connection', wrapped);
    });
  });
  proxy.on('upgrade', (_req, socket) => socket.destroy());

  // A Seatbelt localhost rule includes both loopback families. Reserve the
  // same port on ::1, then discard its connections so it cannot host a second broker.
  const ipv6 = http.createServer((_req, res) => res.writeHead(403).end());
  ipv6.on('connection', (socket) => socket.destroy());
  function close() {
    for (const socket of sockets) socket.destroy();
    proxy.close();
    ipv6.close();
  }
  try {
    await new Promise((resolve, reject) => proxy.listen(0, '127.0.0.1', resolve).once('error', reject));
    const { port } = proxy.address();
    await new Promise((resolve, reject) => ipv6.listen(port, '::1', resolve).once('error', reject));
    return { port, certificate, url: `http://${username}:${password}@127.0.0.1:${port}`, events, close };
  } catch (error) {
    close();
    throw error;
  }
}

export function agyBuildEnv({ home, runtime, broker }) {
  return {
    ...SAFE_ENV,
    HOME: home,
    TMPDIR: path.join(runtime, 'tmp'),
    AGY_CLI_DISABLE_AUTO_UPDATE: 'true',
    CMUX_ANTIGRAVITY_HOOKS_DISABLED: '1',
    HTTP_PROXY: broker.url,
    HTTPS_PROXY: broker.url,
    SSL_CERT_FILE: broker.certificate,
  };
}

function agyBuildArgs({ id, effort, prompt, logFile, source, runtime, home, certificate }) {
  const paths = [runtime, path.join(home, 'Library', 'Keychains'), path.dirname(certificate)];
  const permissions = {
    allow: [`read_file(${source})`, `write_file(${source})`],
    deny: ['command(*)', 'mcp(*)', 'read_url(*)', 'download_url(*)', 'execute_url(*)',
      ...paths.flatMap((name) => [`read_file(${name})`, `write_file(${name})`])],
  };
  return ['-p', prompt, '--model', id, ...(effort ? ['--effort', effort] : []),
    '--output-format', 'stream-json', '--print-timeout', '1800s', '--disable-slash-commands',
    '--settings', JSON.stringify({ permissions }), '--log-file', logFile];
}

async function verifiedBinary(bin, directory) {
  const original = fs.realpathSync.native(bin);
  const stat = fs.statSync(original);
  if (!stat.isFile() || stat.size !== 229_152_672) {
    throw new Error(`agy builder requires the tested macOS arm64 agy ${AGY_VERSION} binary`);
  }
  const pinned = path.join(directory, 'agy');
  fs.copyFileSync(original, pinned, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE);
  const digest = crypto.createHash('sha256');
  for await (const bytes of fs.createReadStream(pinned)) digest.update(bytes);
  if (digest.digest('hex') !== AGY_DIGEST) throw new Error(`agy builder requires the tested macOS arm64 agy ${AGY_VERSION} binary`);
  fs.chmodSync(pinned, 0o500);
  return pinned;
}

function runWalled(args, cwd, env, interruption) {
  return new Promise((resolve, reject) => {
    const child = spawn(SANDBOX, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stop = () => {
      try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch {}
    };
    let cancelled = false;
    const cancel = () => {
      cancelled = true;
      stop();
    };
    const timer = setTimeout(cancel, 1_815_000);
    interruption.addEventListener('abort', cancel, { once: true });
    const out = [];
    const err = [];
    child.stdout.on('data', (bytes) => out.push(bytes));
    child.stderr.on('data', (bytes) => err.push(bytes));
    child.once('exit', stop);
    child.once('error', reject);
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      interruption.removeEventListener('abort', cancel);
      resolve({ code, signal, cancelled, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() });
    });
  });
}

export function agyBuildLayout(callRoot) {
  const [source, runtime, assembly, ca, gitState] = ['source', 'runtime', 'assembly', 'ca', 'git-state']
    .map((name) => path.join(callRoot, name));
  const privateHome = path.join(runtime, 'home');
  for (const dir of [source, runtime, assembly, ca, gitState]) fs.mkdirSync(dir, { mode: 0o700 });
  const config = path.join(privateHome, '.gemini', 'config');
  fs.mkdirSync(path.join(config, 'projects'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(config, '.migrated'), '', { mode: 0o600 });
  fs.writeFileSync(path.join(config, 'mcp_config.json'), '{}', { mode: 0o600 });
  fs.writeFileSync(path.join(config, 'config.json'), '{"plugins":{}}', { mode: 0o600 });
  fs.mkdirSync(path.join(runtime, 'tmp'), { mode: 0o700 });
  return { source, runtime, assembly, ca, gitState, privateHome };
}

function seedAgyState(actualHome, privateHome) {
  const state = '.gemini/antigravity-cli';
  const target = path.join(privateHome, state);
  fs.mkdirSync(path.join(target, 'cache'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(target, 'settings.json'), '{}', { mode: 0o600 });
  for (const name of ['installation_id', 'jetski_state.pbtxt', 'cache/default_project_id.txt', 'cache/onboarding.json']) {
    const input = path.join(actualHome, state, name);
    const info = fs.lstatSync(input, { throwIfNoEntry: false });
    if (!info) continue;
    if (!info.isFile() || info.nlink !== 1 || info.size > 64 * 1024 || fs.realpathSync.native(input) !== input) {
      throw new Error('agy builder could not isolate an onboarding state file');
    }
    fs.copyFileSync(input, path.join(target, name), fs.constants.COPYFILE_EXCL);
    fs.chmodSync(path.join(target, name), 0o600);
  }
}

export async function prepareAgyLaunch({ source, runtime, assembly, ca, privateHome }, bin, home) {
  const pinned = await verifiedBinary(bin, assembly);
  seedAgyState(home, privateHome);
  fs.mkdirSync(path.join(privateHome, 'Library'), { mode: 0o700 });
  fs.symlinkSync(path.join(home, 'Library', 'Keychains'), path.join(privateHome, 'Library', 'Keychains'));
  const broker = await agyGoogleBroker(ca);
  const params = { source, runtime, certificate: broker.certificate, bin: pinned, home, port: broker.port };
  const env = agyBuildEnv({ home: privateHome, runtime, broker });
  const version = spawnSync(SANDBOX, agyBuildWall(params, [pinned, '--version']), {
    cwd: source, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000,
  });
  if (version.status !== 0 || version.stdout.trim() !== AGY_VERSION) {
    broker.close();
    throw new Error('agy builder version check failed inside its macOS sandbox');
  }
  return { params, env, broker };
}

export async function runAgyBuilder({ root, bin, id, effort, prompt, home = os.homedir(),
  checkWorkspace, checkConfig, checkToken, checkSignIn, readResult, onBrokerAudit }, test = {}) {
  if (process.platform !== 'darwin') throw new Error('agy builder requires macOS sandbox-exec');
  if (typeof id !== 'string' || !id || typeof prompt !== 'string' || !prompt.trim() ||
      effort !== undefined && !['low', 'medium', 'high', 'xhigh'].includes(effort)) {
    throw new Error('agy builder requires a model, prompt and supported effort');
  }
  home = fs.realpathSync.native(home);
  const config = checkConfig(home);
  if (config) throw new Error(config);
  if (checkToken(home)) throw new Error('agy builder refused a plaintext token before launch');
  const callRoot = fs.mkdtempSync('/private/tmp/acs-agy-builder-');
  const interruption = new AbortController();
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  const cancel = () => interruption.abort();
  const checkCancellation = () => {
    if (interruption.signal.aborted) throw new Error('agy builder invocation cancelled');
  };
  for (const name of signals) process.on(name, cancel);
  let launch;
  try {
    const layout = agyBuildLayout(callRoot);
    const { source, gitState, runtime, privateHome } = layout;
    const { publish } = captureAgySource(root, { source, gitState, home });
    if (checkWorkspace(root).length) throw new Error('agy builder refused workspace customization files');
    if (checkToken(privateHome) || checkToken(home)) throw new Error('agy builder refused a plaintext token before invocation');
    launch = await (test.prepare ?? prepareAgyLaunch)(layout, bin, home);
    const { params, env, broker } = launch;
    const logFile = path.join(runtime, 'agy.log');
    const args = agyBuildArgs({ id, effort, prompt, logFile, source, runtime, home, certificate: broker.certificate });
    checkCancellation();
    const reply = await (test.invoke ?? runWalled)(
      agyBuildWall(params, [params.bin, ...args]), source, env, interruption.signal,
    );
    if (reply.cancelled) throw new Error('agy builder invocation cancelled');
    checkCancellation();
    const log = fs.lstatSync(logFile, { throwIfNoEntry: false });
    if (checkToken(home) || checkToken(privateHome) || !log?.isFile() || log.nlink !== 1 ||
        fs.realpathSync.native(logFile) !== logFile || checkSignIn(logFile, privateHome)) {
      throw new Error('agy builder keychain postflight failed');
    }
    const { username, password } = new URL(broker.url);
    const credentials = Buffer.from(`${username}:${password}`).toString('base64');
    const hideProxy = (output) => String(output ?? '').replaceAll(password, '[broker credential]')
      .replaceAll(credentials, '[broker credential]');
    const result = readResult(id, { ...reply, stdout: hideProxy(reply.stdout), stderr: hideProxy(reply.stderr) });
    if (reply.code !== 0 || reply.signal || result?.exit !== undefined || typeof result?.answer !== 'string' ||
        !result.answer.trim() || result.served?.requested && result.served.requested !== id) {
      throw new Error(hideProxy(result?.error || 'agy builder did not return a valid answer for the requested model'));
    }
    await yieldToSignals();
    checkCancellation();
    // Once installation starts, an interruption must leave either the completed publication or a rollback.
    const changed = publish();
    return { ...result, mode: 'build', served: { requested: id, id, verified: false }, build: { published: true }, changed };
  } finally {
    try {
      try {
        launch?.broker.close();
        fs.rmSync(callRoot, { recursive: true, force: true });
      } finally {
        if (launch?.broker.events) onBrokerAudit?.(launch.broker.events.slice());
      }
    } finally {
      await yieldToSignals();
      for (const name of signals) process.off(name, cancel);
    }
  }
}
