# UPGRADE-2 — platform upgrades for customized companies

Slice 0 proposes [ADR-0085](../../decisions/ADR-0085-platform-upgrades-for-customized-tenants.md) for Fable. Implementation awaits the design ruling and the CUSTOMIZE-3 and WORKFLOW-1 prerequisites. The first-customer gate includes the survival suite, deployment check and legacy fixtures.

## Design decisions

- An authorized human may opt a tenant/environment into clean platform upgrades with a revocable decision proof. Each eligible candidate gets its own policy-attributed approval. A correction requires human approval of its exact revision.
- Waves schedule tenant/environment pointers. Authorized company rows show the verified serving release alongside pending work, conflicts and failed attempts.
- The permanent CI proof exercises all five customization kinds in one tenant, including a reset layout property and a pinned workflow body, through upgrade and rollback.
- Forward conversion preserves historical bytes and evidence. Deployment admission enforces both fleet high-water marks, including after pointer rollback or store restore.
- The ADR specifies closure tests for missing compiler pins, Inspection releases stamped 25 and the old-demo lineage refusal. These are executable-slice obligations.

## Gates

The local record check and all 18 hosted CI jobs passed. Synchronization renumbered the proposal after Billing took ADR-0084. [Packet CI at `8427011a`](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44676762151)

## Test it yourself

1. In the ADR, follow the **Delivery note** conflict through a replacement draft. Find the proof required before the correction can serve, even with automatic approval enabled.
2. In **Rollout waves and the company version dashboard**, trace two companies sharing one pointer while a swap awaits verification. Both still show the source version.
3. In **Evidence required to close the filed cases**, compare Inspection and Today releases both stamped 25. Only the Inspection store requires the higher reader.
4. Run `scripts/check-records.sh` from the repository root. Expect exit status zero.
