// Metadata-only probe. The Seatbelt listener rule permits wildcard binds.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { spawnSync } from 'node:child_process';

const SAFE_ENV = { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' };
const GOOGLE_ROUTES = {
  'daily-cloudcode-pa.googleapis.com': {
    '/v1internal:loadCodeAssist': 'POST',
    '/v1internal:fetchAvailableModels': 'POST',
  },
  'oauth2.googleapis.com': { '/token': 'POST' },
};

const PROTECTED_NAMES = '(^|/)([.]git|[.]gemini|[.]agents?|_agents?|[.]claude|[.]codex|[.]cursor|[.]ssh|[.]aws|[.]gnupg|[.]config|[.]env[^/]*|[.]npmrc|[.]netrc|[.]pypirc|[.]gitconfig|agents[.]md|claude[.]md|gemini[.]md|hooks[.]json|mcp_config[.]json|plugins[.]json|agents[.]json)(/|$)';

export function agyBuildWall({ source, runtime, certificate, bin, home, port }, command, { testExecutable = null } = {}) {
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
    '(allow file-read-metadata (apply path-ancestors (list (param "SOURCE") (param "RUNTIME") (param "CA") (param "AGY") (string-append (param "HOME") "/.gemini/antigravity-cli/cache") (string-append (param "HOME") "/Library/Keychains"))))',
    '(allow file-read* (subpath "/System/Library") (subpath "/usr/lib") (subpath "/usr/bin") (subpath "/usr/share") (subpath "/bin") (subpath "/private/var/db/timezone") (subpath "/private/etc/ssl") (literal "/private/etc/passwd") (literal "/private/etc/hosts") (literal "/private/etc/apache2/mime.types") (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random"))',
    '(allow file-map-executable (subpath "/System/Library") (subpath "/usr/lib") (subpath "/usr/bin") (literal (param "AGY")))',
    '(allow process-exec (literal (param "AGY")) (literal "/usr/bin/security"))',
    '(allow file-write-data (literal "/dev/null"))',
    `(allow file-read* (subpath (param "SOURCE")) (subpath (param "RUNTIME")) (literal (param "CA")) (literal (param "AGY")) ${keychain})`,
    `(allow file-write* (subpath (param "SOURCE")) (subpath (param "RUNTIME")) ${keychain})`,
    `(deny file-write* (require-all (subpath (param "SOURCE")) (regex #${JSON.stringify(PROTECTED_NAMES)})))`,
    '(deny file-write* (regex #"(^|/)antigravity-oauth-token$"))',
    '(allow file-read* (subpath (string-append (param "HOME") "/.gemini/config")) (subpath (string-append (param "HOME") "/.gemini/antigravity-cli/builtin")))',
    ...['settings.json', 'installation_id', 'jetski_state.pbtxt', 'cache/default_project_id.txt', 'cache/onboarding.json'].map((name) => `(allow file-read* (literal (string-append (param "HOME") "/.gemini/antigravity-cli/${name}")))`),
    '(allow mach-lookup (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd") (global-name "com.apple.system.logger") (global-name "com.apple.trustd.agent") (global-name "com.apple.trustd"))',
    // agy starts its own listener as part of init. It made no connections to any other local port during the metadata checks.
    '(allow network-bind network-inbound (local tcp "localhost:*"))',
    `(allow network-outbound (remote tcp "localhost:${port}"))`,
    ...(testExecutable ? ['(allow process-exec file-read-data file-map-executable (literal (param "TEST")))', '(allow file-map-executable (subpath "/opt/homebrew/lib") (subpath "/usr/local/lib"))', '(allow file-read* (subpath "/opt/homebrew/lib") (subpath "/usr/local/lib"))'] : []),
  ].join('\n');

  const params = { SOURCE: source, RUNTIME: runtime, CA: certificate, AGY: bin, HOME: home };
  if (testExecutable) params.TEST = testExecutable;
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
    '-config', config, '-keyout', keyFile, '-out', certificate], { env: SAFE_ENV, timeout: 10000 });
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
  const auth = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  const sockets = new Set();
  const events = [];
  const record = (event) => { if (events.length < 1000) events.push(event); };
  const processed = http.createServer((req, res) => {
    const origin = req.socket.allowedOrigin;
    const route = Object.hasOwn(GOOGLE_ROUTES[origin], req.url);
    if (!route || GOOGLE_ROUTES[origin][req.url] !== req.method || req.headersDistinct.host?.length !== 1 ||
      ![origin, `${origin}:443`].includes(req.headers.host)) {
      record({ reason: 'request denied', origin });
      return res.writeHead(403).end();
    }
    const upstream = requestUpstream({
      hostname: origin, servername: origin, port: 443, method: req.method, path: req.url,
      rejectUnauthorized: true, ca: tls.rootCertificates, agent: false,
      headers: { ...endToEnd(req.headers), host: origin },
    }, (response) => {
      record({ origin, path: req.url, status: response.statusCode });
      if (response.statusCode >= 300 && response.statusCode < 400) {
        response.resume();
        res.writeHead(502).end();
        return;
      }
      const headers = endToEnd(response.headers);
      delete headers['alt-svc'];
      delete headers.location;
      res.writeHead(response.statusCode, headers);
      response.on('error', () => res.destroy());
      response.pipe(res);
    });
    upstream.on('error', (err) => {
      record({ reason: 'upstream failed', origin, code: err.code });
      if (res.headersSent) res.destroy();
      else res.writeHead(502).end();
    });
    res.on('close', () => upstream.destroy());
    req.on('error', () => upstream.destroy());
    req.pipe(upstream);
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
      record({ reason: 'CONNECT denied' });
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) socket.unshift(head);
    const wrapped = new tls.TLSSocket(socket, {
      isServer: true, secureContext: context, ALPNProtocols: ['http/1.1'],
      SNICallback: (servername, done) => done(servername === origin ? null : new Error('TLS authority mismatch'), context),
    });
    wrapped.on('error', () => record({ reason: 'client TLS failed', origin }));
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
    TMPDIR: runtime,
    AGY_CLI_DISABLE_AUTO_UPDATE: 'true',
    CMUX_ANTIGRAVITY_HOOKS_DISABLED: '1',
    HTTP_PROXY: broker.url,
    HTTPS_PROXY: broker.url,
    SSL_CERT_FILE: broker.certificate,
  };
}
