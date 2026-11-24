**Keep Neon unenrolled. The canary establishes a blocker for claiming that Seatbelt alone enforces the network boundary. Whether it blocks the pinned, edit-only route is still open.** The smallest next step is to observe the actual agy listener during a zero-turn launch. The evidence does not yet justify changing isolation architectures.

### Findings

Scores are judgments about the likelihood and impact of each stated failure. `protected true` marks a failure of Cris’s required boundary.

| Finding | Supplied facts | Judgment |
|---|---|---|
| The OS wall permits a reply outside the broker | An independent process received the canary’s reply over the Mac’s non-loopback IPv4 address. The broker separately enforced Google authorities and paths for metadata traffic. | The broker cannot police replies on a socket it never sees. This capability is demonstrated. **Likelihood 10/10 · impact 9/10 · protected true.** |
| Pinned agy exposes that path in edit-only mode | Only pinned agy and `/usr/bin/security` may execute. Arbitrary commands, MCP and URL tools are denied. agy needed listener permissions to start, but the report gives neither its bind address nor a model-reachable operation that changes it. | A reachable alternate transport is plausible and unproven. The executable pin narrows the question to what that binary exposes, including through configuration or files the builder can influence. **Likelihood 4/10 · impact 9/10 · protected true.** |
| A startup observation misses a later listener | `models` succeeded with zero turns. `/usage` reached print mode with zero turns. Neither exercised an inference turn. | A clean startup observation can settle the startup question. Extending it to the edit session requires evidence that the listener configuration stays fixed and edits cannot activate another listener. **Likelihood 3/10 · impact 9/10 · protected true.** |

### One deciding experiment

Run **one zero-turn launch of the exact pin through the intended builder startup path**, using the production profile, broker and tool permissions. Use the demonstrated print-mode `/usage` path if it shares that startup. From outside the sandbox, observe listener creation and closure across the agy process tree from launch through exit. Record ownership, IPv4 and IPv6 bind addresses, and whether a non-loopback peer can complete a harmless transport handshake with any exposed listener. Keep the broker’s socket distinct and verify zero inference turns. A missed short-lived listener or a materially different startup path makes the result inconclusive.

**If agy accepts a non-loopback connection, the route is blocked.** The external peer already has a transport to the pinned process. No model-issued shell command is needed. Try the narrowest supported fixed/private listener setting, or a Seatbelt rule demonstrated to preserve startup and refuse that connection. The two rules already tried failed startup. If neither remedy works, consider an external guard only if it can enforce the restriction for this launch from before process start, fail closed, and preserve the broker and keychain flows without global firewall, account or trust changes. No such guard has been demonstrated. A materially different isolation architecture becomes warranted if the reachable path survives those options.

**If agy binds only a private endpoint, the canary alone is insufficient reason to redesign.** Cris owns one threat-model choice: whether the exact pin and launcher-controlled, builder-immutable listener configuration may form part of the guarantee, or whether the OS wall must withstand arbitrary code inside agy. The first choice still requires evidence that builder-controlled inputs cannot change or repurpose the listener. The second is already blocked by the canary.

A clean result clears only this listener question. Private source-copy and publication remain unwired, live inference remains untested, and model identity remains unverified.
