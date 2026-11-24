**Keep boundary sign-off blocked while testing the actual pinned route.** The canary proves the current OS profile permits an alternate transport. It does not establish that Neon can exercise that transport through the intended edit-only permissions. A different isolation architecture is therefore premature.

The scores below are judgment calls, not measured probabilities. `protected true` identifies a required security boundary.

1. **The profile cannot support an unconditional network-refusal claim.** **90/100 — likelihood 10/10 × impact 9/10; protected true.**  
   **Fact:** A confined canary bound a wildcard address and exchanged data with an independent process through the Mac’s non-loopback IPv4 address. The tested localhost rule therefore does not enforce the assumed interface restriction. Two attempted restrictions broke actual agy startup.

   **Judgment:** This is a confirmed blocker if the promise is that the OS prevents every permitted process from communicating with non-Google peers, including a compromised agy. The impact score assumes the channel could carry protected data; the observed response itself was harmless.

2. **A usable escape from the intended edit-only route remains unproven.** **27/100 — likelihood 3/10 × impact 9/10; protected true.**  
   **Fact:** Execution is restricted to pinned agy and `/usr/bin/security`; arbitrary commands, MCP and URL tools remain denied. The canary deliberately exercised behavior that has not been established for either allowed executable.

   **Judgment:** Those restrictions materially reduce reachability. Relevant questions are whether actual agy exposes a non-loopback service, what that service accepts or returns, and whether permitted edits or tool operations can influence it. Executable pinning alone does not answer those questions: an allowed program can contain network functionality. Conversely, a capability available only to an unavailable canary is insufficient evidence of a Neon escape. The likelihood score reflects that evidentiary gap.

The smallest defensible remedy should follow the actual listener behavior. Prefer a **supported private or fixed loopback listener configuration**, or a **demonstrated valid Seatbelt restriction**, while preserving startup, keychain sign-in and plaintext-token refusal. A fixed port alone does not restrict interfaces. A supported loopback setting would narrow the trusted behavior of pinned agy; it would not prove that the existing OS rule itself enforces loopback binding.

An external guard is worth considering only if it can actually prevent direct access to the child’s listener within the stated constraints. A launcher or broker that controls the intended connection path provides no protection against a separate reachable wildcard listener. Require independent evidence that the guard closes that path without global firewall, account or trust changes. The supplied observations establish no such guard yet.

A materially different isolation architecture becomes justified if **the actual allowed route exposes a prohibited channel and supported listener controls, valid sandbox restrictions and a scoped external guard cannot close it**. Compatibility failures from two attempted rules do not establish that conclusion.

**The single next experiment:** run the exact pinned agy through the already successful zero-turn metadata startup under the unchanged production profile and intended permissions, while an independent observer identifies its actual listener sockets and probes those sockets through the Mac’s non-loopback addresses using a harmless supported handshake. Capture socket ownership, bound addresses, external connection results, protocol response and authentication requirements. Use only credentials an outside peer could obtain.

That experiment decides whether the canary’s transport is exposed by actual agy during that startup:

- A reachable service establishes a real path requiring assessment and closure. TCP acceptance alone does not prove source disclosure or model control, although it defeats a literal prohibition on all non-Google connections.
- Loopback-only binding supports the narrower pinned-process argument. Its strength depends on launch settings being outside permitted edits.
- If metadata startup does not instantiate the builder’s actual listener, the result is inconclusive for builder mode; retain that limitation explicitly.

The operator-owned trade-off is the guarantee: **containment of malicious requests through a fixed edit-only interface**, or **containment even after compromise of the allowed native executable**. Do not silently substitute the former for the latter. Continue metadata-only work to resolve reachability; keep enrollment pending, including the separately unfinished source-copy/publication boundary.
