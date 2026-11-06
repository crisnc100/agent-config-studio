/**
 * The MCP view (builds/ui-clarity PR C, C3) in the fake DOM against stubbed
 * routes: with nothing configured anywhere, one plain empty state that says
 * what MCP servers are and where to add one; "none configured" said once,
 * never per CLI. No server, no HOME.
 */
import { bootPage, routesFor, registry, settle } from './fixtures/shell-page.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
console.log('\nmcp view');
/** Every way of saying nothing is configured: "None configured.", "None are configured yet", "No MCP servers …". */
const none = (t) => (t.match(/none (?:are )?configured|no mcp servers/gi) || []).length;

try {
  // Nothing anywhere: no global servers, none in Codex, no project .mcp.json.
  const bare = registry();
  bare.groups = bare.groups.filter((g) => g.id !== 'mcp');
  const p = await bootPage({ routes: routesFor({ 'GET /api/registry': () => bare, 'GET /api/mcp': () => ({ note: 'No MCP servers configured yet.', global: [], codex: [] }) }), hash: '#mcp' });
  await settle(20);
  const t = p.text(p.$('content'));
  const empty = p.$('content').querySelector('.mcp-empty');
  ok('an empty state, in one place', !!empty && p.$('content').querySelectorAll('.mcp-empty').length === 1, t.slice(0, 300));
  ok('…that says what MCP servers are, in plain words', /MCP servers give your CLIs extra tools/.test(p.text(empty)), p.text(empty));
  ok('…and where to add one: claude mcp add, codex mcp add, or a project\'s .mcp.json', /claude mcp add/.test(p.text(empty)) && /codex mcp add/.test(p.text(empty)) && /\.mcp\.json/.test(p.text(empty)));
  ok('"none configured" is said once, not per CLI', none(t) === 1, `${none(t)}: ${t}`);
  ok('no empty per-CLI sections', !/Claude Code — read-only|^Codex$/m.test(t) && !p.$('content').querySelector('.assist-label'), t);
  ok('no page errors', p.errors.length === 0, p.errors.join(' | '));
  p.done();

  // f1: the route could not read ~/.claude.json — say that, not "none configured".
  const er = await bootPage({ routes: routesFor({ 'GET /api/registry': () => bare, 'GET /api/mcp': () => ({ note: 'Could not read ~/.claude.json: Unexpected token } in JSON', global: [], codex: [] }) }), hash: '#mcp' });
  await settle(20);
  const et = er.text(er.$('content'));
  ok('a route error note is shown, and no empty state claims none are configured', /Could not read ~\/\.claude\.json: Unexpected token/.test(et) && !er.$('content').querySelector('.mcp-empty') && !/None are configured/.test(et), et.slice(0, 300));
  er.done();

  // Something configured somewhere: the sections show, and an empty one says so in two words.
  const q = await bootPage({ routes: routesFor({ 'GET /api/mcp': () => ({ note: 'Global MCP is read-only here.', global: [{ name: 'files', scope: 'user', transport: 'stdio', target: 'npx files' }], codex: [] }) }), hash: '#mcp' });
  await settle(20);
  const u = q.text(q.$('content'));
  ok('with a global server: it is listed, and no empty state shows', /files/.test(u) && !q.$('content').querySelector('.mcp-empty'), u.slice(0, 300));
  ok('…an empty section reads "None configured." once', (u.match(/None configured\./g) || []).length === 1 && none(u) === 1, u);
  ok('…with no page errors', q.errors.length === 0, q.errors.join(' | '));
  q.done();
} catch (e) {
  ok(`no test block threw (${e?.message || e})`, false, e?.stack || String(e));
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
