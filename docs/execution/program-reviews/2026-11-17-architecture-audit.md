# Independent architecture audit — 2026-11-17

Codex gpt-6.1-sol, xhigh, read-only, at `main` `b82cdde2`. Launched by the orchestrator at the owner's request ("audit our work so far on our architecture… including our approach based on doss"). Unedited below. The orchestrator's adjudication and what it changed are in [loop-ux-plan.md](../loop-ux-plan.md).

Verified in code after the audit (Sonnet, 2026-11-17): the agent-plan release binding gap and the unverified update patch are TRUE (sent to AGENT-3 as A1 and A2); executors select by capability id only, TRUE; the ADR-0036 summary is accurate. One correction: a document's next action IS authored (`schemas.ts:1074-1085`); only command-bar order is inferred from the operation id.

---

Keep the compiler/release core and movement ledger. The build is being driven too much by platform proof and too little by an office worker’s daily job. This read-only audit covers `b82cdde2`; no tests were run, and runtime performance, current CI results, real-user usability and Doss internals are **unverified**.

**1. Is the core architecture sound?**

Yes, with important qualifications. The compiler validates references and types before producing content-addressed artifacts; activation performs a tenant-scoped CAS against the previous release and fence. These are credible foundations for reproducible customization. [compiler.ts:375–396,612–624](packages/compiler/src/compiler.ts#L375), [release-activation-service.ts:740–796](packages/postgres-provider/src/release-activation-service.ts#L740)

Movement-derived stock is the right ERP choice: posting takes stock-identity locks, and accepted evidence plus the idempotency receipt commit in the posting transaction. Forced RLS, restricted database roles and current authorization provide meaningful layers of protection. This is stronger than relying on generated APIs alone. [posting:1243,1734–1754](packages/postgres-provider/src/inventory-posting-service.ts#L1243), [materializer:1607–1636](packages/postgres-provider/src/module-storage-materializer.ts#L1607), [request-context:49–77](packages/postgres-provider/src/request-context.ts#L49), [current-policy:135–203](packages/postgres-provider/src/current-policy.ts#L135)

The O0–O3 taxonomy is sensible; its implementation is narrower: operations currently declare one effect and only `o0`/`o1` tiers, versus the plan’s compound EffectGraph and O2/O3 contracts. Keep specialized kernels; defer a general execution language until concrete demand requires it. [schemas:2175–2234](packages/canonical-model/src/schemas.ts#L2175), [plan:775–790](docs/greenfield-north-star-erp-platform-plan.md#L775)

Forecast, not measured ceilings: at ten tenants, customized upgrades and support will hurt first; at 100, topology and history-dependent work will matter. Each runtime configures four pools totaling twelve connections, while posting rereads an identity’s movement history and independently recomputes its ledger sum. [runtime:269–301](packages/postgres-provider/src/composed-application-runtime.ts#L269), [posting:3894–3924,8409–8428](packages/postgres-provider/src/inventory-posting-service.ts#L3894)

**2. Plan versus code: three largest gaps**

- **Usable, tenant-ready product.** The supplied application composition explicitly enables demo identity and restricts serving to loopback; the execution record distinguishes scripted customization success from a non-developer doing it unaided. The automated bar is useful evidence, not product acceptance. [composition-root:116–118,245–250](apps/api/src/composition-root.ts#L116), [current-plan:8](docs/execution/current-plan.md#L8)
- **Customized upgrades.** Startup explicitly refuses customizations based on an earlier first-party release and prescribes `dev:reset`. That is the unresolved commercial promise: keeping customers customized while improving the product. [runtime:935–994](packages/postgres-provider/src/composed-application-runtime.ts#L935)
- **End-to-end agent release and verification guarantees.** The plan requires one release pin per run, but execution enters the runtime afresh for each step, and stored plans contain no release/fence identity; an activation can therefore cross the approval/execution boundary without the required replan. Separately, verification compares `step.values`, while update `patch` is stored and executed separately and never compared there. These are static findings, without runtime reproductions. [plan:1985–1989](docs/greenfield-north-star-erp-platform-plan.md#L1985), [session:129–138,230–234,1001–1020,1136–1146](packages/operations-agent/src/session.ts#L129)

Workflows are explicitly future N2 scope, not a shipped capability; the existing “sandbox” is a bounded compiler subprocess. [plan:3224–3265](docs/greenfield-north-star-erp-platform-plan.md#L3224), [sandbox:11–21](packages/customization/src/sandbox.ts#L11)

**3. The UI architecture**

SSR can theoretically deliver the requested experience. The present system already supports counted worklist tabs, editable reference-derived defaults and enhanced keyboard/reference interactions; calling it incapable would be inaccurate. [component-registry:2519–2535](apps/web/src/component-registry.ts#L2519), [schemas:1326–1348](packages/canonical-model/src/schemas.ts#L1326), [surface-client:53–98](apps/web/src/surface-client.ts#L53)

The blockers are today’s contracts and implementation policy:

- Command priority is inferred from operation-ID suffixes rather than authored lifecycle/next-action semantics. [component-registry:996–1017](apps/web/src/component-registry.ts#L996)
- The impact-analysis collection admits no content; generic “predicted effects” are explanatory prose rather than calculated before/after quantities. [schemas:2383–2388](packages/canonical-model/src/schemas.ts#L2383), [surface-runtime:2079](apps/web/src/surface-runtime.ts#L2079)
- ADR-0036 forbids client routing, stores, business-data rendering and most fetching—the capabilities useful for sustained, fast document entry. [ADR-0036:190–209](docs/decisions/ADR-0036-minimum-client-capability.md#L190)

**Recommend (b): a client rendering layer consuming the same compiled surfaces.** Retain server authority for permissions, calculations and writes; add typed next-action, impact-query and contextual availability bindings. Prototype one complete purchasing-to-sale loop before generalizing.

This costs a substantial staged replacement of navigation, document editing and task presentation, plus an ADR amendment. Its customization risk is renderer divergence or first-party-only components; require custom fields and tenant-created records to pass through the same component registry and interaction contracts. Hand-built core screens would make that parity harder to maintain.

**4. The Doss-derived decisions**

**Compiler/release core: right.** Schema codegen and releases are complementary: generate clients and contracts from the compiled model. However, avoid claiming executable rollback merely from metadata pinning: executor factories currently select by capability ID and reject duplicate IDs, rather than selecting preserved implementation versions. [factory:28–55](packages/postgres-provider/src/capability-operation-executor-factory.ts#L28)

**Sandboxed TypeScript workflows: right direction, premature implementation.** A general DAG language would recreate a programming language badly. But journaling and replay tests still leave a durable-execution system to build, especially the crash between an external effect and recording its result; the plan’s journal commitment alone does not settle that boundary. [plan:3254–3262](docs/greenfield-north-star-erp-platform-plan.md#L3254)

**Five tools: right abstraction; risk-classed confirmation: sensible but not implemented as advertised.** Every successfully constructed plan currently calls the approval callback, regardless of its operations’ confirmation settings. Until classification is trustworthy, that conservative default is reasonable. [session:747–772](packages/operations-agent/src/session.ts#L747)

**Customized upgrade proof: essential now, narrowed to supported field/layout changes first.** Repeating the full future proof mechanically at every stage is less valuable than demonstrating the next real compatibility boundary. [plan:3586–3595](docs/greenfield-north-star-erp-platform-plan.md#L3586)

On the supplied competitor account, Doss’s API reuse, user authority and delivery pragmatism are worth copying; five generic tools should remain a facade over those same principles.

**5. Complexity and process**

Yes, activation has a design smell. Pointer publication, post-swap verification and inventory-scope reconciliation form separate state transitions requiring repair and a session advisory lock. The record acknowledges no operator command to finish an interrupted activation. [activation:233–238](packages/postgres-provider/src/release-activation-service.ts#L233), [customization:780–869](packages/postgres-provider/src/customization-service.ts#L780), [CUSTOMIZE:58](docs/execution/packets/CUSTOMIZE.md#L58)

A simpler target is: prepare and verify the candidate first; atomically publish its ready generation with CAS, required scope changes and audit; derive scope state wherever possible; keep receipts as evidence. Post-publication health checks should not create another serving authority. Immediately, add recovery before attempting that redesign.

The current doctrine—focused local tests, CI acceptance, short records and discriminating controls for silent harm—is proportionate. [AGENTS:95–115](AGENTS.md#L95)

Repeated proof narratives and review-of-fix chains are not a sustainable development model. Those reviews found real defects, but the four-round history argues for simplifying the state machine, not institutionalizing more rounds; it also conflicts with “No confirm arms.” [review-log:190–200](docs/execution/review-log.md#L190), [AGENTS:90](AGENTS.md#L90)

**6. Biggest shipping risks, ranked**

1. **An unwanted daily experience:** cheapest mitigation is observed, timed completion of the full loop; section 3 identifies concrete gaps.
2. **Customers becoming upgrade-blocking forks:** prove a field/layout customization survives a real base upgrade.
3. **Agent confidence exceeding guarantees:** fix release binding and patch verification before enlarging the eval catalogue.
4. **Fail-closed outages becoming permanent:** expose interrupted-activation recovery, then consolidate publication authority.
5. **Demo topology becoming production architecture:** replace demo authentication and process-local draft/task state, then test realistic history and concurrency; drafts and task plans currently live in process Maps. [document-editor:90–122](apps/web/src/document-editor.ts#L90), [surface-composition:1415–1467](apps/web/src/surface-composition.ts#L1415)

**Do next (ranked)**

1. Bind agent plans to release/fence identity and add adversarial tests for activation between approval and execution and incorrect patch read-back.
2. Define and observe acceptance journeys for purchasing, receiving, reserving and shipping.
3. Implement that loop with a client renderer over compiled surfaces.
4. Demonstrate a customized tenant upgrading without reset or hand merge.
5. Add activation recovery, then consolidate publication state.
6. Establish authenticated pilot deployment and realistic load evidence before accepting tenant data.

**Stop doing**

- Treating scripted demonstration speed as usability evidence.
- Expanding platform breadth before the daily loop earns user acceptance.
- Adding repair paths where duplicated authority can be removed.
- Repeating evidence narratives across records and review rounds.