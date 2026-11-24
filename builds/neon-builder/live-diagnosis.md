# First live builder attempt

At staged source 440f0c5 on the Mini, the explicit high-effort live probe ran once at 08:07:50–08:08:52 on 2026-11-24. Evidence nonce: 769f1171eb3477f0348e7fc5eaa6b7eb. CLI exited 4, harness failed. No roles, installed runtime, main checkout or benchmark model calls changed.

The sanitized projection contains 27 CONNECT 403 denials and no admitted CONNECT or HTTP upstream request. No build/action evidence or publication occurred. Three outside canaries stayed unchanged and cleanup passed. Keychain postflight and unverified answer label remain unproven for this attempt.

## CONNECT observation needed

Production determines an exact allowlisted authority before checking proxy authentication, and records that origin even when authentication fails. The projection retains either allowlisted origin. The 27 missing origins therefore show failed exact authority matching; missing authentication alone cannot explain those rows. Authentication may independently fail too.

Alive hypotheses:

- A different Google authority is needed by inference, while metadata uses the two current authorities. Observe a sanitized exact Google DNS name without forwarding its request.
- Print mode routes an internal loopback request through HTTPS_PROXY. Observe loopback authority class and numeric port, without admitting a tunnel.
- The target is a malformed or differently spelled form of an existing authority. Observe authority classification independently of proxy auth present/matched booleans.
- Our model of the pinned SDK's print initialization is incomplete. Compare metadata and print requests while all inference routes remain denied.

No production admission change before the discriminating observation. A separate diagnostic harness must preserve CONNECT admission and refuse all inference paths. It must never record credentials, headers, bodies, raw logs or arbitrary URLs. The helper author is preparing that harness with fake-only validation.

## Listener observation needed

427 clean samples saw two broker and two agy listeners, all loopback. Both IPv4 candidates and nine IPv6 candidates explicitly refused. The same seven other IPv6 ordinals timed out against all four listeners. This suggests a path-specific condition, but timeouts do not prove refusal; the existing proof remains failed.

A zero-model control will retain every interface, require an exact-address synthetic listener/accept positive control, then test the candidate against loopback-only listeners on the same port. Persist opaque ordinals, family, scope, errno and timings only. No timeout is treated as refusal and no interface is silently dropped.

## Reference matrix

The independent zero-model reference matrix is still running. ACS lockfile (22 assertions), ACS credential race (113), AirFlo reread (25), and AskWell length (8) have passed. AirFlo staff-mail exits 133 at Bun startup (Trace/BPT trap 5), before test counts. The grader owner is inspecting the pinned imports/profile and will request a narrow Mini crash/deny observation. Do not score this infrastructure failure against Neon or alter the case command/tests.
