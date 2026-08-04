1. **Ruling — B, narrowed to declarative progressive enhancement**

Adopt **Option B**, at Critical decision tier: one repository-owned, dependency-free browser module that progressively enhances server-rendered markup.

It may:

- use browser-native `<details>`, constraint validation, `<progress>`, `fetch`, `AbortController`, and event delegation;
- poll server-authoritative job status and invoke server-provided cancel/background URLs;
- apply only compiler-declared optimistic transitions, retaining a DOM before-image for rollback;
- request semantic validation from the server on blur, while mirroring simple type/presence constraints as HTML attributes;
- hold only ephemeral interaction state: pending requests, the latest job snapshot, and optimistic rollback state.

It may not introduce React, hydration, a virtual DOM, a client router, a data cache/store, a hypermedia dependency, tenant-authored JavaScript/HTML/selectors, executable validation rules, client-generated business truth, persistent/offline queues, or client-rendered reads. C and D remain unauthorized unless a later ADR supersedes this ruling.

Every enhanced read control must remain a real anchor or form whose initial and destination content are server-rendered. A failed enhancement follows that native URL or submission path. Current code already demonstrates the pattern: sections use native `<details>` ([component-registry.ts:547-561](/home/rvham/2rain-greenfield/apps/web/src/component-registry.ts:547)), while record writes are ordinary forms ([component-registry.ts:586-596](/home/rvham/2rain-greenfield/apps/web/src/component-registry.ts:586)).

Two factual corrections:

- ADR-0032 sets determinate progress at **over 10 seconds**, not over 3 seconds ([ADR-0032:48-55](/home/rvham/2rain-greenfield/docs/decisions/ADR-0032-feedback-ladder-and-loading-states.md:48)). The `U3` queue row still says “>3 s determinate progress” and is stale ([current-plan.md:261](/home/rvham/2rain-greenfield/docs/execution/current-plan.md:261)).
- ADR-0032 treats inline validation as an assumed client need, but it does **not** ratify “before submit” or “on blur.” That rule exists only in the UX proposal ([ux-strategy-proposal.md:201-214](/home/rvham/2rain-greenfield/docs/execution/ux-strategy-proposal.md:201)), which current-plan explicitly calls “reference, not doctrine” ([current-plan.md:268-275](/home/rvham/2rain-greenfield/docs/execution/current-plan.md:268)). ADR-0036 should ratify the rule if it is to bind.

2. **Admissibility — ADR-0005 constrains this choice but does not prohibit it**

There is no actual plan-versus-ADR conflict. ADR-0005 concerns `@agent-native/core`, which owned identity, an action registry, and application state ([ADR-0005:7-17](/home/rvham/2rain-greenfield/docs/decisions/ADR-0005-drop-agent-native-core.md:7)). Its superseding-ADR rule applies to that package or an equivalent framework that duplicates canonical, identity, gateway, release, or policy authority ([ADR-0005:34-38](/home/rvham/2rain-greenfield/docs/decisions/ADR-0005-drop-agent-native-core.md:34)).

Its enforcement clause nevertheless binds as an authority test: the browser module may not own application state or become a peer authority ([ADR-0005:60-66](/home/rvham/2rain-greenfield/docs/decisions/ADR-0005-drop-agent-native-core.md:60)). Ephemeral request and DOM rollback state is not application authority; job truth, validation truth, authorization, releases, and business state remain server-owned.

Therefore:

- **No superseding ADR-0005 is required.**
- **ADR-0036 is required**, because ADR-0032 expressly forbids introducing a client runtime until that reserved decision lands ([ADR-0032:171-178](/home/rvham/2rain-greenfield/docs/decisions/ADR-0032-feedback-ladder-and-loading-states.md:171)).
- **Plan §8.1 must be amended.** It currently assumes React terminology ([plan:1571-1589](/home/rvham/2rain-greenfield/docs/greenfield-north-star-erp-platform-plan.md:1571)). Replace that paragraph with a framework-neutral server renderer plus optional repository-owned enhancement controller. Also correct ADR-0032’s imprecise statement that ADR-0005 “dropped the framework”; it dropped a specific agent/application-authority framework.

3. **Smallest first increment**

The first useful increment should be **inline validation on one existing compiled generic record form**, after the compiled message work represented by `U6` is available:

- emit primitive HTML constraints from compiled field metadata;
- conditionally load the one enhancement module;
- on blur, send `surfaceId`, `fieldId`, and the candidate form values to a SurfaceRuntime validation endpoint;
- resolve the actual validation binding from the request-pinned release server-side—never accept a validation or operation ID from the browser;
- render the returned message inline with `aria-invalid` and `aria-describedby`;
- revalidate normally on submit.

Do not invent a synthetic long-running product operation merely to justify polling.

The gate must use a real controlled browser and observe:

- an invalid blur producing the inline error before any operation-gateway invocation;
- correction clearing it;
- server submission still refusing invalid input;
- an undeclared field causing no validation request;
- an unknown enhancement kind failing compilation;
- JavaScript-disabled reads rendering and navigating normally.

The completed capability later needs controlled-response tests that observe a progress bar tracking persisted `current/total`, an indeterminate treatment when total is absent, server cancellation/background handoff, immediate optimistic state before a latched response, rollback after refusal, and compiler refusal for every forbidden optimistic class. Timing tests use a controlled clock, never sleeping; projection changes also require downstream consumer suites and the full matrix ([AGENTS.md:125-148](/home/rvham/2rain-greenfield/AGENTS.md:125)).

4. **Cost at the compiled-surface seam**

The compiler does **not** start emitting components.

Today, authored inventory surfaces are plain records naming archetype, data source, slots, content references, and role ([definition.ts:1320-1361](/home/rvham/2rain-greenfield/packages/domain/src/inventory/definition.ts:1320)). The compiler directly lowers those records into the surface manifest ([projections.ts:481-529](/home/rvham/2rain-greenfield/packages/compiler/src/projections.ts:481)), and `SurfaceRuntime` remains the sole renderer ([surface-runtime.ts:75-104](/home/rvham/2rain-greenfield/apps/web/src/surface-runtime.ts:75)).

The smallest compiler change is:

- add a versioned, framework-neutral `interactions` section to each **compiled** surface;
- derive it from existing slots, field contracts, and registered operation semantics where possible;
- encode only canonical target IDs and closed kinds: progress, inline validation, and the seven ADR-0032 optimistic classes;
- link progress policy to the compiled operation binding;
- fail compilation on unknown kinds or optimistic eligibility outside the closed list;
- bump the surface-manifest projection version and runtime-capability minimum.

Do not add executable JavaScript or component names to authored definitions. A canonical language bump is needed only if later evidence shows authors must declare information that cannot be derived; it should not be paid in the first increment.

`surface-runtime.ts` and its neighbours must:

- render semantic attributes, error containers, real cancel/background forms or links, and `<progress>`;
- include the module only when the compiled surface declares an enhancement;
- retain full SSR before the module executes;
- add platform-owned validation/job endpoints;
- update the current CSP—which presently admits no scripts or connections—to narrowly allow the self-hosted module and same-origin requests ([app-server.ts:35-39](/home/rvham/2rain-greenfield/apps/web/src/app-server.ts:35)).

The charter’s assertion that a component framework necessarily makes the compiler emit components is incorrect. Plan §8.1 itself describes React components interpreting metadata. React could technically remain a generic interpreter. D is rejected because it is unnecessary and much less reversible, not because component emission is logically inevitable.

The UX pin must be deliberately upgraded, not bypassed. It currently names the runtime entry point and definition source ([ux-grammar/SKILL.md:25-69](/home/rvham/2rain-greenfield/.agents/skills/ux-grammar/SKILL.md:25)), and its test pins the plan, server, registry, contract, runtime, and canonical constants ([ux-grammar-skill.test.ts:11-22](/home/rvham/2rain-greenfield/test/architecture/ux-grammar-skill.test.ts:11)). Bump the pin schema to v2, add the client entry point and interaction vocabulary, add the new file to the required paths, and extend the checker to compare compiler/runtime/client vocabularies. This follows the `ux-grammar` rule that tenants customize content, never grammar ([ux-grammar/SKILL.md:17-23](/home/rvham/2rain-greenfield/.agents/skills/ux-grammar/SKILL.md:17)).

5. **Cost at G6**

B preserves G6’s customization model:

- custom fields, views, sections, and validations still compile into metadata;
- semantic and cross-field validation executes through the server Formula IR evaluator, avoiding a second JavaScript evaluator ([plan:2747-2754](/home/rvham/2rain-greenfield/docs/greenfield-north-star-erp-platform-plan.md:2747));
- the browser module interprets the same closed interaction descriptors for every first-party or tenant-customized surface;
- tenants cannot inject scripts, selectors, fragments, components, routes, or new behavior kinds.

This directly supports G6’s requirement that customization never edit host routes or components and that customized surfaces remain within the same grammar ([plan:2822-2839](/home/rvham/2rain-greenfield/docs/greenfield-north-star-erp-platform-plan.md:2822)). The planned optimistic Draft Preview Runtime can use the same controller and server-authoritative patch history ([plan:2797-2801](/home/rvham/2rain-greenfield/docs/greenfield-north-star-erp-platform-plan.md:2797)). Any builder behavior beyond the ratified closed kinds remains a separate platform decision.

6. **One-way-door assessment**

At six months, B is highly reversible: remove the module and the server-rendered application still reads, navigates, submits, validates on submit, and exposes job pages. Removing the richer feedback would require amending ADR-0032, but it would not require rebuilding the application.

At eighteen months, it remains moderately reversible if three constraints hold:

- interaction descriptors stay semantic and framework-neutral;
- all durable state remains on the server;
- every surface retains native anchor/form behavior.

The same descriptors could later drive a vetted hypermedia or component runtime without recompiling tenant surfaces.

It becomes substantially less reversible if client-side routing or initial data fetching becomes mandatory, compiler output contains DOM selectors or library directives, tenant customizations emit client code, Formula IR gains an independent browser evaluator, a persistent cache/store becomes authoritative, or offline queues/service-worker state enter this layer. Those are explicitly outside this verdict.

7. **Disposition of Option A**

Not applicable. This ruling implements ADR-0032’s progress and optimistic decisions rather than striking or deferring them. No accepted ADR-0032 ruling is removed.

8. **What would change my mind**

I would reconsider C if an audited hypermedia library demonstrably implemented this exact closed contract—with server-owned state, no client-dependent reads, deterministic rollback, accessible validation, real progress/cancel, strict CSP, and a materially smaller maintenance and defect burden than the single owned module.

I would reconsider D only after measured G6 builder evidence showed that the owned controller had already become an accidental component/state framework, or that required interaction latency and focus reconciliation could not be met while preserving server-rendered surfaces. Code volume alone would not suffice; I would require browser-journey failure data, maintenance cost, and proof that a metadata-driven component interpreter could preserve the same compiler and tenant-customization boundary.

**Verdict text:** Adopt Tier B: a single dependency-free, repository-owned progressive-enhancement module over fully server-rendered `SurfaceDefinition` output. It may poll server-authoritative progress, invoke server-provided cancel/background actions, apply only compiler-enumerated optimistic transitions with rollback, and request inline validation from the server; it may hold no durable or business-authoritative state. Reads, navigation, and forms remain native SSR paths without JavaScript. React, hypermedia libraries, hydration, client routers/stores, executable client validation, tenant-authored client code, and component-emitting compiler output are not authorized. ADR-0005 is satisfied and need not be superseded; record the choice as ADR-0036 and amend plan §8.1 and the UX grammar pin accordingly.
