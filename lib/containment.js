/**
 * What an Assist run is allowed to start with, and the check of what it
 * actually started with — the one rule the runtime and tests/phase1.mjs share.
 *
 * Containment is established BEFORE the spawn: argv (harness.js composeArgv)
 * and, for grok, the pre-spawn MCP refusal below. The init check is defence
 * in depth. It cannot undo anything the CLI did before it printed init, so it
 * is never the containment claim; it ends a turn that reports anything else.
 */

/** The single read tool each harness may have. */
export const ALLOWED_READ_TOOL = Object.freeze({ claude: 'Read', grok: 'read_file' });

/** How long a CLI may take to print its init event before the turn is refused. */
export const INIT_DEADLINE_MS = 30_000;

/**
 * Did this init event report exactly the contained tool set? `{ok, why}`.
 * Fails closed: a missing or malformed init, any tool besides the one read
 * tool, a toolCount that disagrees with the list, or any MCP server.
 */
export function containmentHeld(init, id) {
  const allowed = ALLOWED_READ_TOOL[id];
  if (!allowed) return { ok: false, why: `unknown harness ${id}` };
  if (!init || typeof init !== 'object') return { ok: false, why: 'no init event' };
  if (init.type !== 'system' || init.subtype !== 'init') return { ok: false, why: 'not an init event' };
  if (!Array.isArray(init.tools)) return { ok: false, why: `init has no tools list (${JSON.stringify(init.tools)})` };
  const tools = init.tools;
  if (tools.length !== 1 || tools[0] !== allowed) {
    return { ok: false, why: `effective tools ${JSON.stringify(tools.length > 8 ? `${tools.length} tools` : tools)}; want only ${allowed}` };
  }
  if (init.toolCount !== undefined && init.toolCount !== tools.length) {
    return { ok: false, why: `toolCount=${JSON.stringify(init.toolCount)} contradicts tools=[${allowed}]` };
  }
  if (init.mcp_servers !== undefined) {
    if (!Array.isArray(init.mcp_servers)) return { ok: false, why: 'init mcp_servers is not a list' };
    if (init.mcp_servers.length) {
      return { ok: false, why: `MCP servers started: ${init.mcp_servers.map((s) => s?.name ?? '?').join(', ')}` };
    }
  }
  return { ok: true, why: `tools=[${allowed}], no MCP servers (permissionMode=${init.permissionMode})` };
}

/**
 * The init gate a stream decoder runs every event through, in order. The
 * first event that carries output must come after one valid init; a second
 * init, or output before any, refuses the turn. Other `system` events (hook
 * notices and the like) may precede init — they carry no reply.
 *
 * `see(ev)` returns null to let the event through, or the refusal reason. Once
 * refused it stays refused.
 */
export function createInitGate(harness) {
  let init = null;
  let refused = null;
  return {
    see(ev) {
      if (refused) return refused;
      const isInit = ev?.type === 'system' && ev.subtype === 'init';
      if (isInit) {
        if (init) return (refused = 'a second init event arrived mid-turn');
        const held = containmentHeld(ev, harness);
        if (!held.ok) return (refused = held.why);
        init = ev;
        return null;
      }
      if (!init && ev?.type !== 'system') return (refused = `output arrived before the init event (${ev?.type ?? 'unknown'})`);
      return null;
    },
    /** The stream ended: no init by then is a refusal too. */
    end() {
      if (!refused && !init) refused = 'the CLI never reported its init event';
      return refused;
    },
    get init() { return init; },
    get refused() { return refused; },
  };
}

/** The message a refused turn ends with. */
export function refusalMessage(label, why) {
  return `${label} did not start contained (${why}); Assist stopped it and applied nothing.`;
}

/* ── grok: no MCP servers, checked before the spawn ───────────────────── */

/**
 * Environment for every grok Assist spawn and its pre-spawn check: grok's own
 * switches for the compat MCP sources (~/.claude.json, Cursor's mcp.json), so
 * an MCP server configured for Claude Code does not make Grok Assist refuse.
 * Probed in builds/ready-for-strangers/grok-mcp.md (servers started: 3 → 1).
 */
export const GROK_ASSIST_ENV = Object.freeze({ GROK_CLAUDE_MCPS_ENABLED: '0', GROK_CURSOR_MCPS_ENABLED: '0' });

/**
 * Every MCP server `grok inspect --json` says a session in this cwd would
 * load, plus plugins that bring their own. Pure, for the tests.
 *
 * Only the exact shape grok 1.0.x prints is read. Anything else — a missing
 * or non-list `mcpServers` or `plugins`, an entry that is not an object, a
 * name that is not a string, a flag that is not a boolean, a count that is
 * not a whole number — throws, and the caller refuses: unknown output is
 * never read as "no servers".
 */
export function grokMcpFromInspect(doc) {
  const bad = (what) => { throw new Error(`grok inspect --json: ${what}`); };
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (!isObj(doc)) bad('not an object');
  if (!Array.isArray(doc.mcpServers)) bad('mcpServers is not a list');
  if (!Array.isArray(doc.plugins)) bad('plugins is not a list');
  const found = [];
  for (const s of doc.mcpServers) {
    if (!isObj(s)) bad('an mcpServers entry is not an object');
    if (typeof s.name !== 'string' || !s.name) bad('an mcpServers entry has no name');
    if (s.enabled !== undefined && typeof s.enabled !== 'boolean') bad(`mcpServers ${s.name}: enabled is not a boolean`);
    if (s.compatibilityStatus !== undefined && typeof s.compatibilityStatus !== 'string') bad(`mcpServers ${s.name}: compatibilityStatus is not a string`);
    if (s.compatibilityStatus === 'disabled' || s.enabled === false) continue;
    found.push(s.name);
  }
  for (const p of doc.plugins) {
    if (!isObj(p)) bad('a plugins entry is not an object');
    if (typeof p.name !== 'string' || !p.name) bad('a plugins entry has no name');
    if (p.enabled !== undefined && typeof p.enabled !== 'boolean') bad(`plugin ${p.name}: enabled is not a boolean`);
    if (!isObj(p.provides)) bad(`plugin ${p.name}: provides is not an object`);
    const n = p.provides.mcpServers;
    if (n !== undefined && !(Number.isInteger(n) && n >= 0)) bad(`plugin ${p.name}: provides.mcpServers is not a whole number`);
    if (p.enabled !== false && n > 0) found.push(`${p.name} (plugin)`);
  }
  return found;
}

/**
 * Before any grok Assist spawn: what `grok inspect --json` (run by harness.js
 * inspectGrok in the turn's cwd, with the turn's env) says, judged. Null when
 * clear, else the reason — including when the answer cannot be read.
 */
export function grokMcpRefusal(inspected) {
  if (inspected.error) return `grok inspect could not confirm that no MCP server is configured (${inspected.error})`;
  let servers;
  try { servers = grokMcpFromInspect(JSON.parse(inspected.stdout)); }
  catch (e) { return `grok inspect could not confirm that no MCP server is configured (${e.message})`; }
  if (!servers.length) return null;
  return `Grok Assist is unavailable while grok has MCP servers configured (${servers.join(', ')}): grok starts them for every run, and ACS cannot keep them out. ` +
    'Use Claude for Assist, or turn them off with `grok mcp disable <name>` (plugins: `grok plugin disable <name>`).';
}
