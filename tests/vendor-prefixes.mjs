/**
 * One id-prefix → vendor table. lib/models.js owns VENDOR_PREFIXES; the review runtime and
 * public/workflow.js run without it and carry a copy of the literal. A copy that differs,
 * or a vendor rule written some other way beside it, fails here. tools/ask-model.mjs runs
 * beside the resolver's lib and imports the table instead of copying it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUBSCRIPTION_OF, VENDOR_PREFIXES, subscriptionOf, vendorOf, loadRegistry, tracks } from '../lib/models.js';
import { parseVersion, compareVersions } from '../lib/models-catalog.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** The object literal assigned to `name` in `src`, parsed; null when there is none or it is not a plain string map. */
function literal(src, name) {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:Object\\.freeze\\()?(\\{[^}]*\\})`).exec(src);
  if (!m) return null;
  try { return JSON.parse(m[1].replace(/'/g, '"')); } catch { return null; }
}
const same = (a, b) => JSON.stringify(Object.entries(a)) === JSON.stringify(Object.entries(b));

const expected = { 'claude-': 'claude', 'gpt-': 'codex', 'grok-': 'grok', 'gemini-': 'agy' };
ok('lib/models.js VENDOR_PREFIXES is the four-vendor table, in order', same(VENDOR_PREFIXES, expected), JSON.stringify(VENDOR_PREFIXES));
ok('lib/models.js states it as a literal', same(literal(read('lib/models.js'), 'VENDOR_PREFIXES') || {}, VENDOR_PREFIXES));

for (const [file, name] of [['packs/review-gate/runtime/review.mjs', 'VENDOR_PREFIXES'], ['public/workflow.js', 'WF_VENDOR_PREFIXES']]) {
  const src = read(file);
  const copy = literal(src, name);
  ok(`${file}: ${name} is identical to lib/models.js`, copy && same(copy, VENDOR_PREFIXES), JSON.stringify(copy));
  // A second rule (an id.startsWith('grok-') branch, say) would route beside the table and drift from it.
  const stray = [...src.matchAll(/startsWith\(\s*['"](claude|gpt|grok|gemini)-['"]\s*\)/g)].map((m) => m[0]);
  ok(`${file}: no vendor rule outside the table`, stray.length === 0, stray.join(', '));
}

const ask = read('tools/ask-model.mjs');

// agy's containment lives in two runtimes (ask-model and the review gate, installed apart): the same deny list, the
// same probed version and the same workspace names, or one of them refuses less than the other.
const rev = read('packs/review-gate/runtime/review.mjs');
const line = (src, name) => (new RegExp(`^const ${name} = (.+?);?$`, 'm').exec(src)?.[1] ?? null);
for (const name of ['AGY_SETTINGS', 'AGY_VERSION', 'AGY_WORKSPACE', 'AGY_CMUX_HOOK', 'AGY_ENV']) {
  const a = line(ask, name), r = line(rev, name);
  ok(`${name} is the same literal in ask-model and the review runtime`, a !== null && a === r, `${a} | ${r}`);
}
const ws = Function(`return (${line(ask, 'AGY_WORKSPACE')})`)();
ok('AGY_WORKSPACE names the approved folders and files', JSON.stringify(ws) === JSON.stringify({
  dirs: ['.agents', '.agent', '_agents', '_agent'], names: ['hooks.json', 'mcp_config.json', 'plugins.json', 'agents.json', 'plugins'] }), JSON.stringify(ws));
const deny = Function(`return (${line(ask, 'AGY_SETTINGS')})`)().permissions.deny;
ok('the agy deny list covers commands, writes, MCP and every URL action', ['command(*)', 'write_file(*)', 'mcp(*)', 'read_url(*)', 'download_url(*)', 'execute_url(*)'].every((d) => deny.includes(d)), JSON.stringify(deny));
ok('tools/ask-model.mjs imports vendorOf from lib/models.js', /import \{[^}]*\bvendorOf\b[^}]*\} from '\.\.\/lib\/models\.js'/.test(ask));
ok('tools/ask-model.mjs defines no vendorOf of its own', !/function vendorOf\b|const vendorOf\b/.test(ask));

ok('a gemini- id runs on agy', vendorOf('gemini-4-neon') === 'agy');
ok('every vendor in the table has a subscription; agy draws on gemini', Object.values(VENDOR_PREFIXES).every((v) => Object.hasOwn(SUBSCRIPTION_OF, v)) && subscriptionOf('agy') === 'gemini'
  && ['claude', 'codex', 'grok'].every((v) => subscriptionOf(v) === v), JSON.stringify(SUBSCRIPTION_OF));
ok('an unknown vendor has no subscription', subscriptionOf('acme') === null && subscriptionOf(null) === null);
ok('an id that only starts with "gemini" (no dash) has no vendor', vendorOf('gemini4') === null);
ok('a bare vendor word is not an id', vendorOf('agy') === null);

// The shipped registry: neon and sol-prev exist, prev sorts below current on a fresh install.
const { defaults } = loadRegistry({ home: path.join(ROOT, 'tests', 'fixtures', 'no-such-home') });
ok('neon ships as a gemini- id', vendorOf(defaults.models.neon) === 'agy', defaults.models.neon);
ok('sol-prev ships and does not track newer ids', typeof defaults.models['sol-prev'] === 'string' && !tracks(defaults, 'sol-prev'));
const prev = parseVersion(defaults.models['sol-prev']), cur = parseVersion(defaults.models.sol);
ok('the shipped sol is newer than the shipped sol-prev', prev && cur && compareVersions(prev, cur) < 0, `${defaults.models['sol-prev']} vs ${defaults.models.sol}`);

const roles = JSON.parse(read('lib/roles.default.json'));
ok('neon has a flavor', !!roles.flavor.neon?.brief);
const inRole = Object.entries(roles.roles).filter(([, r]) => [].concat(r.use, r.alt ?? []).some((u) => (typeof u === 'string' ? u : u?.family) === 'neon'));
ok('neon is in no shipped default role', inRole.length === 0, inRole.map(([k]) => k).join(', '));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
