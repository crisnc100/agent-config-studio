# Context — harness adapter contract + picker

## The seams (verified by reading the code in this worktree)

lib/chat.js (295 lines) — the Assist backend:
  :24-29  MODELS map. Doubles as a SECURITY ALLOWLIST: `model` arrives in an HTTP body
          and is interpolated into a shell command, so anything not named here is refused.
          Preserve this property per-harness.
  :31     DEFAULT_MODEL = 'claude-sonnet-5'
  :33     modelList() -> [{id,label}]
  :77     buildTurn({message,mentions,isFirst,seed}) — builds the prompt (STYLE+EDIT_FORMAT
          on first turn only)
  :106    parseEdits(reply, allowedPaths) — @@EDIT/@@APPEND -> proposals. Requires the label
          to match tilde(absPath) in the allowlist AND the SEARCH text to occur exactly once.
  :220    streamTurn(...) — THE SEAM. Builds argv, spawns, parses the stream.
  :232-238 argv: -p --model <id> --output-format stream-json --verbose
          --include-partial-messages [--effort X] [--resume <id>]
  :240    spawn('zsh', ['-lc','claude "$@"','claude',...args]) — args positional on purpose
          so a request body cannot reach the shell. KEEP THIS PROPERTY.
  :251-256 stream parse. Keys on exactly: ev.session_id; ev.type==='stream_event' &&
          ev.event?.type==='content_block_delta' reading ev.event.delta?.text;
          ev.type==='result' || ev.is_error!==undefined.
  :282    child.stdin.end(prompt)  <-- PROMPT GOES VIA STDIN, NOT ARGV.

lib/assist.js — a second, simpler Claude spawn path (:105-106, :142 stdin). Also needs
  containment, or it is a hole beside a fixed door.

server.js:
  :13-14  imports runAssist/listActions and streamTurn/parseEdits/resolveMentions/modelList
  :93-94  exposes assistActions + models to the client
  :277    POST /api/assist
  :307    streamTurn({...}) call site
  :397    POST /api/chat

public/app.js:
  :1627   the assist model <select>
  :1709   streamChat({message,mentions,sessionId,seed,onDelta})

## Measured facts (this session — do NOT re-derive)

GROK — binary ~/.grok/bin/grok. Emits the ANTHROPIC MESSAGES WIRE FORMAT, so chat.js's
existing parser at :251-256 handles it UNMODIFIED (verified: parseEdits accepted 5/5
bake-off tasks, every SEARCH matched exactly once).
  flags: --output-format streaming-messages-json, --include-partial-messages, -m <model>,
  --system-prompt-override (alias --system-prompt), -r/--resume <id>,
  --reasoning-effort (alias --effort), --permission-mode <mode>, --prompt-file <path>
  models: grok-4.6 (default), grok-4.5; enumerate via `grok models`
  speed: avg 74.4s/task vs Claude 19.5s. First text_delta avg 18.2s, max 36.9s.

PROMPT DELIVERY — open question the builder must settle by test:
  chat.js currently writes the prompt to the child's STDIN. Grok was verified working with
  --prompt-file (a ~9KB prompt is unsafe as an argv value). Whether grok also accepts the
  prompt on stdin is UNTESTED. Test stdin first (it keeps both harnesses on one path);
  fall back to --prompt-file + a temp file if stdin does not work.

CONTAINMENT — the core requirement.
  CLAUDE: on one observed run the exact production invocation MUTATED THE TARGET FILE ON
  DISK via a real edit tool instead of emitting @@EDIT text, bypassing Accept/Reject.
  Non-deterministic. This is a live bug in what ships today.
  GROK: naive headless run reports "permissionMode":"bypassPermissions" with write/
  search_replace available and no approval gate. Did not mutate across 8 runs, but is
  unrestrained by default.
  Grok's --sandbox and --permission-mode are ORTHOGONAL: `--sandbox workspace` does NOT
  move it off bypassPermissions. The containment flag is `--permission-mode plan`.
  For Claude the restricting flag must be determined AND PROVEN by the containment test,
  not assumed.

BINARY DETECTION — `codex` on this machine resolves to a cmux shim under
/var/folders/.../cmux-cli-shims/; the real binary is ~/.npm-global/bin/codex. grok has the
same shape (~/.grok/bin/grok vs ~/.local/bin/grok vs /Applications/cmux.app/...).
Detection must resolve the real binary, not the first PATH hit.

## Out of scope
Codex adapter. Contract must accommodate it later (streams:false) without reshaping.
