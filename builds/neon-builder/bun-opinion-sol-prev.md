Start with isolated runtime probes under the unchanged profile. They can narrow the failure without granting anything. This is an experiment proposal, not a diagnosis.

1. **Run three fresh Bun processes** in the same private grade environment and working directory: one performs Unicode normalization on decomposed accented text; one constructs and uses `Intl.Collator`; one executes a Unicode-property regex. Each reports reaching the operation and completing it. Include the existing passing simple-test control.

   A reproducible trap localizes a minimal reproducer. Successful probes establish only that those operations work; they do **not** clear ICU or JSC for every transitive-import path.

2. **If probes do not localize it, use a bounded diagnostic matrix on the unchanged trusted reference.** Compare four disposable profiles:

   | Profile | Added diagnostic capabilities |
   |---|---|
   | Baseline | None |
   | I | Exact observed ICU-file metadata operation |
   | R | All other recorded same-PID denial operation/target pairs |
   | I+R | Both groups |

   Keep targets literal and operations explicit. Include the previously tested directory operations in R: their individual failures did not exclude a conjunction. Add no speculative executable-memory permission, wildcard paths, arbitrary IPC, or network access. Preserve the reference commit, dependencies, environment, test command, and setup.

   This matrix distinguishes **sufficiency within the recorded candidate set**: I alone rescues; R alone rescues; only their combination rescues; or none rescues. It cannot establish that ICU is unused or that executable memory is responsible.

3. **Bisect only a group that demonstrably rescues the reference.** If only I+R passes, retain I while bisecting R, then test removing I from the surviving combination. That preserves possible interactions while reducing the capability set.

The proof bar is all **61 assertions passing**, not merely surviving startup. Repeat any rescuing comparison with baseline interleaved, and run the unrelated host-file, UNIX, and TCP refusal canaries under every rescuing profile. Reject a candidate that breaks those refusals. Record the exact profile differences. No result automatically authorizes a production allowance.

If I+R still traps, the recorded denials have supplied **no sufficient rescue**. The missing observation is a native trap location resolved to a function using symbols matching this Bun binary, an explicit fatal diagnostic, or a trace exposing an additional relevant operation. More speculative grants would not settle the alternatives.

The reporter overclaims in two places: “the sandbox is what crashes Bun” should be **“the crash reproduces under this confinement configuration.”** Parent-directory grants failing establish that those grants are insufficient; they do not exclude those permissions as prerequisites in a combination. Calling the remaining denials “suspects” is acceptable only as a candidate list, not a causal ranking.
