## SCOPE VERDICT

right-sized — approve one zero-inference laptop run. The broker denied the exact quota-summary POST three times, and the client logged a quota-summary fetch failure. That justifies testing this route alone. [Recorded denials](/Users/cortega/Documents/Projects/personal/agent-config-studio-wt/agent-config-studio-neon-builder/builds/neon-builder/probe/laptop-bootstrap-2.result.json:933) · [Client warning](/Users/cortega/Documents/Projects/personal/agent-config-studio-wt/agent-config-studio-neon-builder/builds/neon-builder/probe/laptop-bootstrap-2.result.json:604)

## ADVISORY

- Add the exact host, POST method and queryless `/v1internal:retrieveUserQuotaSummary` to all three diagnostic checks: the temporary `GOOGLE_ROUTES`, the `DIAGNOSTIC_BOOTSTRAP` POST list and the independent dispatch gate. Missing the middle check would reproduce the existing 403 without testing the hypothesis. Give the summary its own counter because `quota` already identifies `retrieveUserQuota`. [Broker checks](/Users/cortega/Documents/Projects/personal/agent-config-studio-wt/agent-config-studio-neon-builder/builds/neon-builder/probe/connect-diagnostic.mjs:50) · [Dispatch labels](/Users/cortega/Documents/Projects/personal/agent-config-studio-wt/agent-config-studio-neon-builder/builds/neon-builder/probe/laptop-bootstrap-control.mjs:18)
- Require an upstream summary **200 followed by** a broker denial of an exact production generation POST. The current pass condition ignores dispatch statuses, and separate counters cannot establish order. Record one boolean at denial time. Retain the existing authentication, postflight and zero-forwarding checks. Use `eligibilityFailed` only to interpret a failed run. [Recorder and pass condition](/Users/cortega/Documents/Projects/personal/agent-config-studio-wt/agent-config-studio-neon-builder/builds/neon-builder/probe/laptop-bootstrap-control.mjs:82)
- Cut `fetchAdminControls`, `fetchUserInfo` and all origin or OS-permission changes from this experiment. A pass supports reviewing the one-route production change. Any other result ends the experiment. [Decision brief](/Users/cortega/Documents/Projects/personal/agent-config-studio-wt/agent-config-studio-neon-builder/builds/neon-builder/laptop-quota-advisor-brief.md:6)

## QUESTIONS

No real questions — the scope is determined.
