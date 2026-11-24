The next discriminating observation is a **nonsecret trace of agy’s actual authentication decision**, comparing the working Mini normal-home route with the failing private-HOME route. Establish the selected backend/selector, the native operation actually entered, its full returned status, and the branch that produces `signInNeeded`. Capture identities/statuses only; no credential values, enumeration, or invented selector queries.

The proof bar should allow three outcomes:

- **Bootstrap/selector divergence:** observe the exact branch choosing a different backend/selector or rejecting a specific private-HOME bootstrap input before the relevant credential operation. Missing prefixes do not meet this bar. This localizes the divergence; it does not yet prove which correction works.
- **Native restriction:** observe the same actual operation and selector, then demonstrate that operation succeeds outside and fails inside confinement with identical private HOME, environment, arguments, and interaction options. Normal-home success alone cannot establish this because HOME and the wall differ. Any diagnostic replay must stay within the authorized nonsecret operation; a credential-existence query cannot substitute for token retrieval.
- **Inconclusive:** incomplete trace coverage, different operations/selectors, or only another absent log. Do not force a diagnosis.

The most useful next capture is therefore the **first explicit divergence in that decision path**, with verified observation coverage. Recovering the native settings API’s full public status is worthwhile, but it answers a narrower question.

The trap in the proposed metadata-only experiment is that rescuing `show-keychain-info` proves only that the tested allowance affects that settings API. It does not establish credential access, agy’s use of that API, or the cause of `signInNeeded`. Exit `166` is not a recovered OSStatus. Even a clean service/path bisection could explain the native control completely while explaining nothing about agy authentication.

The reporter overclaims in three places:

- “The keychain still fails to open” turns a failed settings query into a demonstrated credential-open failure.
- “It never reaches its keychain sign-in step” treats absent recognized prefixes as execution evidence.
- “One of those is the next candidate” promotes correlated native-query denials into agy auth candidates without establishing a shared failing operation.

What the evidence supports is narrower: the exact directory-metadata grant rescued neither observed symptom.

A narrowly scoped production fix requires an isolated diagnostic change that **reproducibly rescues the actual pinned agy authentication/metadata route**, with the observed failure mechanism linking that change to the rescue. A native-settings rescue alone is insufficient. For a bootstrap correction, require the observed input/selector divergence and a single-input correction that restores that route; for an allowance, require the exact resource used by the failing auth operation. Preserve confinement, immutable settings, keychain sign-in, plaintext-token refusal, Google-only egress, and existing read-only routes throughout.
