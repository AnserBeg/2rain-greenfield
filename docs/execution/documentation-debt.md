# Documentation debt

This is the tracked home for documentation obligations that have no owning
packet. Each entry states what is absent, why the absence matters, and the
condition that closes it. Recording an obligation here does not claim that the
design exists or authorize its implementation in an unrelated packet.

## Capability support matrix

- **Missing:** the capability-support matrix named by the north-star plan and
  previously described by `doctrine-coverage.md` as if it already existed.
- **Why it matters:** without one place mapping each capability to its support
  cells and evidence, “supported” can become a prose claim rather than a
  testable product contract.
- **Closes when:** a dedicated design packet creates and reviews the matrix,
  links every admitted capability to its required evidence, and replaces this
  debt entry with the living document.

## Living risk register

- **Missing:** a maintained register of program risks, owners, mitigations,
  triggers, and current disposition.
- **Why it matters:** risks now live across plans, ADRs, packet records, and
  reviews, so ownership and changes in exposure are difficult to audit.
- **Closes when:** a selected documentation packet establishes the register,
  its update cadence, ownership, and links from execution authority.

## SLO ratification beyond compiler SLOs

- **Missing:** ratified service objectives and error-budget ownership for the
  runtime, gateways, jobs, release operations, and user-facing paths beyond
  `compiler-slos.md`.
- **Why it matters:** performance and reliability gates cannot make launch
  claims without named objectives, measurement boundaries, and owners.
- **Closes when:** the owning runtime/operations packets ratify the SLO set and
  executable measurement evidence, then link it from the plan and stage gates.

## Seed skills

- **Missing:** the planned `no-source-editing`, `create-skill`, and
  `erp-architecture-layer-map` skills.
- **Why it matters:** agents do not yet have the intended reusable procedures
  for generated-module boundaries, skill authoring, and architecture routing.
- **Closes when:** a selected skill packet authors, loads, reviews, and pins all
  three skills with their executable or inspection evidence.

## G0 stage-gate evidence

- **Missing:** the consolidated evidence document certifying the completed G0
  stage against its exact accepted state.
- **Why it matters:** the ledger says G0 is complete, but readers cannot audit
  that claim through one stage-level evidence record.
- **Closes when:** a selected documentation packet reconstructs the accepted G0
  gate evidence and links the reviewed record from the ledger.

## Runtime configuration and secret-handling contract

- **Missing:** a contract for how a runnable deployment receives, scopes,
  validates, rotates, and revokes runtime configuration and credentials.
- **Why it matters:** committed-secret scans prove only that credentials are
  absent from source and fixtures; they do not govern deployed secret flow or
  configuration authority.
- **Closes when:** the runnable-app-composition packet owns a reviewed
  config/secret-handling contract and executable composition evidence.

## Compiled demo artifact byte-format contract

- **Missing:** an explicit documentation decision about whether
  `shell.compiled.json` is guarded by parsed value or by exact bytes and which
  tool owns its final formatting.
- **Why it matters:** `check:demo-release` intentionally parse-normalizes both
  sides, so it detects semantic staleness but cannot detect whitespace or array
  formatting drift; Prettier separately controls the checked-in bytes.
- **Closes when:** an owning design packet documents the parse-based contract
  and formatter ownership, or deliberately adopts a byte-exact contract with
  the required formatting policy and tests.
