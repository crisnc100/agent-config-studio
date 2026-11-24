# Neon builder transport experiment

The broker carries pinned agy 1.5.14 metadata through process-local TLS trust and the existing macOS keychain. The writable route remains blocked. The Seatbelt rule agy needs to start its language server also lets a confined process bind a wildcard socket and respond over a non-loopback interface.

## Reproduce on macOS

Run from the checkout, outside any existing sandbox. The experimental scripts run directly from `probe/`. The broker forwards only two Google metadata RPCs and OAuth refresh. No command starts an inference turn.

| Command | Exit | Observation |
| --- | ---: | --- |
| `/usr/sbin/taskpolicy -b node builds/neon-builder/probe/metadata.mjs localhost-listener` | 0 | `models` returned SUCCESS, 27 models and zero turns. `loadCodeAssist` and `fetchAvailableModels` returned 200 through the broker. agy loaded and authenticated via the existing keychain. No plaintext token existed before or after. |
| `/usr/sbin/taskpolicy -b node builds/neon-builder/probe/metadata.mjs bind-only` | 1 | The kernel refused the language server's TCP listener before sign-in or broker contact. |
| `/usr/sbin/taskpolicy -b node builds/neon-builder/probe/metadata.mjs require-peer-localhost` | 1 | Adding a remote-loopback requirement to the inbound rule also refused the listener before sign-in or broker contact. |
| `/usr/sbin/taskpolicy -b node builds/neon-builder/probe/wildcard.mjs` | 1 | A confined fixture bound `0.0.0.0`. An independent process connected via both loopback and the Mac's non-loopback IPv4 address and received the fixture's response. Exit 1 records the containment failure. |
| `/usr/sbin/taskpolicy -b node builds/neon-builder/probe/transport-controls.mjs` | 0 | Two deterministic tests passed. The broker rejected malformed or unauthorized CONNECT, SNI and Host mismatches, unapproved methods and paths, and upstream redirects. The wall blocked outbound connections to other IPv4/IPv6 loopback ports, a Unix socket and a direct IPv4 destination. It blocked protected and outside writes, read escapes including through the macOS Data volume alias, shell execution, and an outside read from a descendant. |

The three metadata output records and the wildcard response are retained in `probe/*.out`. The outputs exclude raw agy logs, request headers and bodies, credentials, and network addresses.

The keychain token was current during the successful probe. The deterministic wall test verified the lock and temporary database rename permissions on disposable files. A real expired-token refresh and save remains unverified for this profile. Earlier print-mode `/usage` also reached brokered bootstrap with zero turns but failed on an unapproved metadata operation. No live model calls were made.

The commit contains experimental probes. The `--build` entry point and source publication remain pending. A later implementation needs an OS-enforced listener or network boundary that refuses non-loopback peers without preventing agy startup.
