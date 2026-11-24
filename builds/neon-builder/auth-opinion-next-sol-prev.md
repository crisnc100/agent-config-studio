**Capture one matched auth-decision trace of the existing metadata-only command under RO and STRICT**, using the pinned executable and identical fresh inputs. Follow auth dispatch through backend selection, storage initialization, fallbacks, and the branch producing `signInNeeded`.

Record only executed call sites, backend/selector-source decisions, nonsecret operation identities, and scalar error/status results. No credential values, selector contents, raw memory dumps, or additional credential requests.

**The causal proof bar:** RO remains authenticated and STRICT fails while observed. The trace must identify a differing result **actually consumed by the failed auth decision**, following any fallback through to completion. A differing syscall or nearby denial alone fails this bar.

That distinguishes:

- **Native prerequisite:** both reach the same backend and auth operation; STRICT receives a specific native failure that causes the unauthenticated result.
- **Bootstrap/selector issue:** STRICT takes a demonstrated different selection, initialization, or absence branch before that operation. Establish why that branch differs; do not infer it from missing logs.

This recommendation depends on faithful tracing being available without sudo, resigning, entitlement changes, or wall expansion. If unavailable, report that precise observability blocker. Sampling stacks or inspecting static strings cannot substitute for the consumed-result trace.

Further permission bisection is weaker now. A native settings-only matrix could establish what rescues **that settings API**, but even a clean rescue would not connect it to agy authentication.

A production fix requires the trace-established dependency, followed by an exact diagnostic allowance that restores authentication; removing it must reproduce failure, with pinned inputs and existing confinement requirements intact.

The reporter overclaims twice: exit **166** does not establish that the keychain “fails to open,” and absent recognized prefixes do not establish that agy “never reaches its keychain sign-in step.” The newer controls establish a profile-dependent failure; they do not yet locate its auth cause.
