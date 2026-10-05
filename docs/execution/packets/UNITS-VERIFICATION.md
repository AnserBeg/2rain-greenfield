# UNITS-VERIFICATION — Critical dependency for document quantity normalization

Status: planned dependency split from UNITS; implementation is not authorized by the UNITS charter.
Tier: Critical. Required path: `packages/postgres-provider/src/release-verification-service.ts`.

## Why this is separate

`SemanticVerificationExecutor.#createInput` populates every writable field using
`verificationFieldValue`. Adding writable entered quantity/unit fields would
therefore arrange an arbitrary entered unit with no unit master or conversion.
There is no existing unit-aware arrangement contract.
A document-boundary normalizer must refuse those records; bypassing it for
verification would prove a different mutation path. UNITS must not edit verification.

## Outcome and bounded claims

1. Verification arranges valid unit and conversion dependencies before probing a line's entered pair, with its base quantity independently checked.
2. The verifier also probes legacy lines without an entered pair through the same production mutation interpreter.
3. An unavailable or invalid conversion produces a named refusal, not a verification bypass or silently rounded base quantity.
4. Receipt replay preserves the original normalized result after configuration changes.

## Proposed discriminating controls (not executed)

- Claim 1: replace the arranged factor with a different numerator; the stored-base witness must fail.
- Claim 2: omit the legacy-line arrangement; an executed legacy mutation counter must fail.
- Claim 3: permit rounding for a non-exact factor; the expected refusal assertion must fail.
- Claim 4: run normalization before receipt lookup; replay after archiving its factor must fail.

## Owner review prompt

Review one fresh candidate SHA for UNITS-VERIFICATION, restricted to its Critical
verification diff and the four claims above. Confirm the witness reads persisted
base quantity independently, both legacy and entered paths execute the production
interpreter, non-exact conversion refuses, and replay needs no current factor.
Production defects block; evidence and wording findings are filed. No merge or
deployment is authorized by this document. Run each proposed control only after
its candidate is committed and restore only that control's confirmed mutation.

## UNITS safe boundary

Code-keyed unit masters, company-owned conversion setup and standalone exact
arithmetic can ship as setup. Entered document fields, normalization and their
screen/print/List presentation remain stopped until this dependency is handled.
