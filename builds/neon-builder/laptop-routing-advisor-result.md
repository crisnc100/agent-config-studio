## 1. SCOPE VERDICT

**right-sized** — The laptop trace justifies testing the two observed metadata GETs. One bootstrap control can establish whether agy reaches generation before spending another live call. [Laptop trace, line 70](/Users/cortega/Documents/Projects/personal/agent-config-studio-wt/agent-config-studio-neon-builder/builds/neon-builder/probe/laptop-rpc-1.result.json:70)

## 2. ADVISORY

- Admit only `GET www.googleapis.com/oauth2/v2/userinfo` and `GET aicode.googleapis.com/v1alpha:fetchConfig` in the builder. The trace records pathnames after query stripping, so a query-free request is still an assumption. Keep exact raw-URL matching. If the control sees a variant, record only whether a query was present and stop. [Broker, line 104](/Users/cortega/Documents/Projects/personal/agent-config-studio-wt/agent-config-studio-neon-builder/tools/agy-builder.mjs:104)
- Make both GETs bodyless. The broker forwards end-to-end headers and pipes the request body. Reject transfer encoding, nonzero content length and method-override headers before opening the upstream request. Extend the existing broker fixture to prove each exact GET forwards once and rejected variants forward zero times. This keeps the metadata allowance from carrying an upload. [Broker, line 114](/Users/cortega/Documents/Projects/personal/agent-config-studio-wt/agent-config-studio-neon-builder/tools/agy-builder.mjs:114) · [Broker tests, line 122](/Users/cortega/Documents/Projects/personal/agent-config-studio-wt/agent-config-studio-neon-builder/tests/agy-builder-wall.mjs:122)
- Keep both generation blocks. Pass the control only on clean keychain postflight and an agy-originated request matching a production generation RPC that the broker denied. The diagnostic currently prints `forwardedInference: 0` literally. Count actual upstream dispatches by route and retain only route labels, counts and statuses. This distinguishes reaching generation from another early startup failure. [Diagnostic, line 227](/Users/cortega/Documents/Projects/personal/agent-config-studio-wt/agent-config-studio-neon-builder/builds/neon-builder/probe/connect-diagnostic.mjs:227)
- Then run one high-effort laptop edit/refusal probe. Gate local eligibility on the published edit, observed refusals, listener check and clean token postflight. Have Mythos check the final route diff and tests. Cut speculative daily-cloud allowances and scheduler work. Keep the Mini benchmark deferred. [Rollout plan, line 59](/Users/cortega/Documents/Projects/personal/agent-config-studio-wt/agent-config-studio-neon-builder/builds/neon-builder/plan.md:59)

## 3. QUESTIONS

No real questions — the scope is determined.
