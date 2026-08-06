# Review log

One line per review verdict, append-only. `scripts/check-review-record.sh` reads
this file and fails when a packet's executable work has reached `main` without a
verdict recorded against the SHA that landed.

**What this file proves, and what it does not.** It proves a verdict was
*recorded*. It cannot prove a review *happened*, and it is not evidence of
quality — a BLOCK is as valid an entry as a PASS. It closes exactly one failure:
integrating a packet and forgetting the review arm entirely. That failure
happened twice on 2026-08-06, to `U2` and `U2-fix`, and both times it was caught
by the user asking rather than by the orchestrator noticing.

**Baseline: `367aebf`.** Commits at or before it are not checked. Every packet
integrated after it needs a line here. The baseline sits deliberately *before*
`U2` rather than at the then-current HEAD, so the gate checks real rows from its
first run instead of starting against an empty set.

Format — pipe-separated, the integrated SHA first:

    <integrated-sha> | <packet-id> | <arm> | <verdict> | <date> | <note>

`arm` is `online-first`, `online-confirm`, `local-confirm`, or `scope-review`.
`verdict` is `PASS`, `BLOCK`, or `REVISE`. A packet reviewed more than once gets
one line per round; the gate only requires that the SHA on `main` appears.

| Integrated SHA | Packet | Arm | Verdict | Date | Note |
|---|---|---|---|---|---|
| `d150f80eab2755ebebd3194a39c0734f1b23bee3` | U2 | online-confirm | BLOCK | 2026-08-06 | Round 1 BLOCKed at `8feabfa` (tag `u2-reviewed-r1`), revised, then accepted without a confirm arm. The confirm review ran afterwards and found two shipped defects — the focus ring below 3:1 on two unmeasured grounds, and numeric alignment unreachable on the shared-list path. Corrective: `U2-fix`. |
| `3975746658e23d6efc37a09045973d72d295a27e` | U2-fix | online-confirm | BLOCK | 2026-08-06 | Source fix correct — the two broken focus grounds are genuinely repaired and the tokens match ADR-0035 §2.2. The gate is a regression: it deleted `readRenderedFocusRing` (which focused a real link and read computed `outlineColor`/`outlineStyle`/`outlineWidth`) and the both-schemes `emulateMedia` loop, replacing them with inference from CSS declarations. Corrective: `U2-fix-b`. |
