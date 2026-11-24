import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const baseline = new URL('./connect-diagnostic.mjs', import.meta.url);
const digest = '4ae51fe64a5e0eb2c74decd2925232d99ed554e7afcc97a449daebc796580071';
const bytes = fs.readFileSync(baseline);
assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), digest);
let source = bytes.toString();
function replaceOne(before, after) {
  assert.equal(source.split(before).length, 2);
  source = source.replace(before, () => after);
}
for (const relative of ['../../../lib/models.js', '../../../tools/ask-model.mjs']) {
  replaceOne(`from '${relative}';`, `from ${JSON.stringify(new URL(relative, baseline).href)};`);
}
replaceOne("new URL('../../../tools/agy-builder.mjs', import.meta.url)",
  `new URL(${JSON.stringify(new URL('../../../tools/agy-builder.mjs', baseline).href)})`);
replaceOne('  const operations = [', `  const operations = [
    ['const GOOGLE_ROUTES = {', "const GOOGLE_ROUTES = {\\n  'aicode.googleapis.com': {},\\n  'www.googleapis.com': {},"],`);
replaceOne('    assert.deepEqual(forwarded, []);', `    await assertRpcStatus(broker, 'aicode.googleapis.com', '/v1internal:streamGenerateContent');
    await assertRpcStatus(broker, 'www.googleapis.com', '/oauth2/v2/userinfo');
    assert.deepEqual(forwarded, []);`);
const directory = fs.mkdtempSync('/private/tmp/acs-neon-rpc-inspect-');
try {
  const variant = path.join(directory, 'diagnostic.mjs');
  fs.writeFileSync(variant, source, { mode: 0o600, flag: 'wx' });
  await import(pathToFileURL(variant).href);
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
