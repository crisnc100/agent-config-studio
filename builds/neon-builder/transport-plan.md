# Neon builder transport checkpoint

Outcome: provide a reusable, deny-default macOS wall and per-call exact-Google-origin transport for a later opt-in agy builder route. This checkpoint deliberately exposes no new public CLI mode and does not enroll Neon or run inference.

The full authorized plan is plan.md beside this file. Phase 2 will add private source copies, safe publication, CLI wiring and installation. Phase 3 will supply live proof, enrollment and the Mac mini benchmark. Their absence at this checkpoint is intentional.

Bar for this phase:

1. The broker terminates client TLS under per-call trust, permits only exact required Google origins/operations, verifies upstream TLS and HTTP authority, and refuses other hosts/paths/redirects. No blind external CONNECT tunnel.
2. The whole agy process and descendants run inside a deny-default OS profile: no direct external egress, only the private broker TCP endpoint, no arbitrary IPC, and only narrow file/runtime/keychain allowances. Local listen/bind may support agy's own startup, without arbitrary loopback outbound.
3. Harmless actual-Mac tests independently observe refusal of forbidden file reads/writes, direct IPv4/IPv6/loopback connections and IPC, and observe allowed in-root/runtime operations.
4. Pinned agy 1.5.14 completes a non-model metadata request through the transport, reports zero turns, loads the existing keychain sign-in, and leaves no plaintext token or fallback. Inference remains unverified until the orchestrator's later live probe.
5. Existing ask-model/review read-only wall/settings remain byte-identical. No token/key values in output, no global trust or account changes, no push or merge.

Review this checkpoint only, not the unfinished later phases. The installed review gate owns the review record. Findings remain open until the final pr-review close at the tip; do not close this phase now.
