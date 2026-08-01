# ver-agg — aggregate assertions produce executable verification scenarios

Status: evidence ready; Critical review round 2 correction
Tier: Critical
Branch: `packet/ver-agg`

## Outcome

The compiler now builds the verification plan from the authoritative canonical
revision rather than the aggregate-free compatibility alias. Active aggregate
assertions therefore emit declared-evidence scenarios. Release verification
decodes those scenarios, invokes aggregates through its one shared query
dispatcher, and observes the exact typed refusal produced when verification
omits business parameters it has no authority to invent.

Unresolvable assertion invocations fail closed before projection lowering:

1. Canonical decode begins at `compiler.ts:171` and returns its diagnostics
   at `:172-174`. The missing-query control observes
   `CANON_REFERENCE_UNRESOLVED` from this barrier.
2. Compiler reference resolution at `compiler.ts:198-200` is a second
   fail-closed barrier.
3. Inputs that resolve but cannot name a verification subject reach
   `validateWholeModel` at `compiler.ts:207`; its
   `validateVerificationAssertionInvocations` check rejects them, and the
   compiler returns at `:208-210`. A subjectless operation stops here.
4. Projection lowering begins only at `compiler.ts:245-250`.

Consequently, no admitted input through the compile entry point reaches the
unresolved-invocation throw in `projections.ts:697-700`. That throw is retained
as a defence-in-depth invariant for direct or future lowering callers. It is
not the behavioural fix for the former silent omission and has no independent
production-path negative control. The behavioural fix is supplying the full
canonical revision to verification-plan lowering at `compiler.ts:249`.

This corrects the earlier packet claim that replacing the lowering throw with
`continue` was controlled by the compile-failure tests. It is not: those tests
observe the earlier fail-closed barriers. AGENTS.md section 6 therefore
requires the limit to be recorded rather than manufactured by disabling the
validators. Current-plan row `5g3-lowerguard` owns the residual backstop
observability question.

## Controls

- An aggregate assertion changes the emitted plan from no matching scenario to
  one scenario bound to its assertion and source entity.
- A missing query fails canonical decode with
  `CANON_REFERENCE_UNRESOLVED` and the assertion identity.
- A subjectless operation fails whole-model validation with
  `COMPILER_VERIFICATION_ASSERTION_INVOCATION_UNRESOLVED` and the assertion
  identity.
- Existing row-query assertion scenarios retain their entity binding.
- A real staged PostgreSQL release executes its emitted parameterized aggregate
  scenario through `invokeAggregate`; changing the shared dispatcher to the row
  ingress makes this control fail before result-set assertions.
- Ordinary aggregate parameters require
  `MALFORMED_SEMANTIC_QUERY_REQUEST` with reason
  `aggregate query arguments do not match the declared parameters`.
- A legal-entity-scoped aggregate requires
  `SEMANTIC_QUERY_LEGAL_ENTITY_SCOPE_INVALID` with reason
  `selection-omitted`. A non-refusing response and a refusal with the wrong
  reason both fail the probe.

The first four controls prove the admitted compiler path and its two validation
barriers. They cannot prove the lowering backstop independently, because the
same barriers prevent malformed input from reaching it.

## Review history

Round 1 found that emitted aggregate scenarios were not executable. The fix
added aggregate verification through `invokeAggregate`, exact omission-refusal
matching, and a real staged-release execution control. The follow-up addendum
centralized aggregate and row dispatch in `#invokeQuery`; the probe takes that
method as a callback rather than owning another gateway dispatch.

Round 2 confirmed those paths and found one evidence overclaim: restoring the
old lowering-time `continue` did not redden the unresolved-invocation controls.
The compile order above confirms the guard is unreachable through production
compiler ingress. This record now classifies it as defence in depth and states
what the gates cannot prove. No validator was weakened or bypassed.

## Artifact and downstream disposition

No checked-in golden, release root, compiled artifact, migration, privilege
boundary, budget, or allowlist moves in this packet. G3-P5 may enable its
`BLOCKED(ver-agg)` scoped-aggregate probe after consuming the final accepted
SHA and deleting its duplicate query dispatch.
