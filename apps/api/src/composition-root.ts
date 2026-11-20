import { CAPABILITY_EXECUTOR_FACTORIES } from './erp-capabilities.js';
import { localDemoActor } from '../../../packages/runtime/src/local-demo-actor.js';
import {
  canonicalAuthoredProjection,
  parseNormalizedApplicationPackageJson,
} from '@north-star/canonical-model';
import { trustedContextForRequestRuntimeView } from '../../../packages/runtime/src/request-runtime-view.js';
import { readFile } from 'node:fs/promises';
import type { Server } from 'node:http';

import {
  createComposedApplicationRuntime,
  parseCompiledApplication,
  type ComposedApplicationRuntime,
  type InventoryScopeProvisioning,
} from '@north-star/postgres-provider/composed-application-runtime';
import { INVENTORY_PROVIDER_ERROR_MAPPINGS } from '@north-star/postgres-provider/inventory-provider-error-mappings';
import {
  AGENT_KEY_FILE_VARIABLE,
  anthropicModel,
  assistantRoute,
  DEFAULT_ANTHROPIC_MODEL,
  loadModelKey,
  type ModelAdapter,
} from '@north-star/operations-agent';
import {
  openCustomizationService,
  type CustomizationServiceOptions,
} from '@north-star/postgres-provider/customization-service';
import { createRequestWorkProbe } from '@north-star/postgres-provider/request-work-meter';
import {
  startWorkflowScheduler,
  type WorkflowSchedulerConfig,
} from '@north-star/postgres-provider/workflow-worker';
import {
  assistantCompany,
  createSurfaceRuntimeServer,
} from '@north-star/web/app-server';
import { COMPOSED_APPLICATION_SURFACE_RUNTIME_EXTENSION } from '@north-star/web/sales-section';

import {
  createAssistantEndpoint,
  loopbackAuthorities,
  type AssistantEndpoint,
} from './assistant-endpoint.js';
import { budgetedDraftingModel, DRAFT_BUDGET } from './draft-budget.js';

import {
  composedApplicationSeed,
  DISTRIBUTOR_COMPANY_NAME,
  type ComposedApplicationSeedProfile,
} from '../../../packages/domain/src/app/seed.js';
import { readUnboundPermissionAcknowledgementFor } from '../../web/scripts/unbound-permission-acknowledgement.js';

export interface ComposedApplicationServerOptions {
  /**
   * A compiled release envelope to serve instead of the checked-in one. Tests
   * use it to serve a metadata-only variation through the unchanged runtime.
   */
  readonly compiledApplication?: unknown;
  readonly databaseUrl: string;
  readonly host?: string;
  readonly port?: number;
  readonly rollbackReleaseRoot?: string;
  readonly workflowScheduler?: WorkflowSchedulerConfig;
  /**
   * Which authored seed to install. Defaults to `demo`, the small fixed
   * fixture the browser suite asserts against; the dev entry point asks for
   * `distributor`, which is a superset carrying enough volume to judge the
   * surfaces by eye.
   */
  readonly seedProfile?: ComposedApplicationSeedProfile;
  readonly tenantSlug?: string;
  /** The approval demo fixture opts in; tenant absence/default remains off. */
  readonly purchaseOrdersRequireApproval?: true;
  /**
   * The assistant panel's model (AGENT-3). Tests pass a scripted model; by
   * default the panel reads the key file named by NORTH_STAR_AGENT_KEY_FILE
   * on first use and says plainly when there is none. The panel is served
   * only under the local demo identity.
   */
  /** Scripted providers can exercise the same metered drafting service in CI. */
  readonly draftingProvider?: () => Promise<ModelAdapter>;
  readonly assistantModel?: () => Promise<
    ModelAdapter | { unavailable: string }
  >;
}

export interface RunningComposedApplication {
  readonly baseUrl: string;
  readonly runtime: ComposedApplicationRuntime;
  readonly seededRecords: readonly ComposedApplicationSeedReceipt[];
  readonly server: Server;
  close(): Promise<void>;
}

export interface ComposedApplicationSeedReceipt {
  readonly operationId: string;
  readonly recordId: string;
  readonly trust: {
    readonly changeDocumentId: string;
    readonly domainEventId: string;
    readonly invocationId: string;
    readonly outboxId: string;
  };
}

/**
 * The office's inventory policy (POSTING-FORWARD-DATE owner rulings,
 * 2026-09-30): the business day is Calgary's, and a posting may be dated up to
 * seven business days back. Provisioning asserts these against the stored
 * values, so a changed value needs a fresh database (pre-tenant, ADR-0066).
 */
export const COMPOSED_APPLICATION_INVENTORY_SCOPE = Object.freeze({
  adjustmentApprovalThreshold: null,
  adjustmentReasonRequirement: 'codeAndNarrative',
  businessDayBoundary: '00:00:00',
  configurationVersion: 1,
  correctionApprovalThreshold: null,
  correctionReasonRequirement: 'codeAndNarrative',
  countApprovalThreshold: null,
  countReasonRequirement: 'codeAndNarrative',
  entityCode: 'DEFAULT',
  entityName: 'Default legal entity',
  legalEntityId: '74000000-0000-4000-8000-000000000001',
  maximumBackdateDays: 7,
  negativeStock: 'reject',
  rebaselineApprovalThreshold: null,
  rebaselineReasonRequirement: 'codeAndNarrative',
  timeZone: 'America/Edmonton',
  transferApprovalThreshold: null,
  transferReasonRequirement: 'codeOnly',
} as const satisfies InventoryScopeProvisioning);

/** Thin transport root: provider assembly owns persistence and runtime wiring. */
export async function startComposedApplication(
  options: ComposedApplicationServerOptions,
): Promise<RunningComposedApplication> {
  const host = options.host ?? '127.0.0.1';
  if (!['127.0.0.1', '::1', 'localhost'].includes(host)) {
    throw new Error('the composed demo identity may bind only to loopback');
  }
  const runtime = await openComposedApplicationRuntime(options);
  // The Customize screen's service opens on first use (CUSTOMIZE), so a
  // server nobody customizes holds no extra connections.
  let customization: ReturnType<typeof openCustomizeService> | undefined;
  const customize = async () => {
    customization ??= openCustomizeService(options).catch((error: unknown) => {
      customization = undefined;
      throw error;
    });
    return (await customization).service;
  };
  const closeCustomization = async () => {
    await (await customization?.catch(() => undefined))?.close();
  };
  // Everything after the runtime exists must hand it back closed on failure.
  // Seeding is 176 operations and `listen` can fail with EADDRINUSE; either
  // one previously threw past an open runtime, leaving the caller with no
  // object to close and its pools and container still held.
  let seededRecords: readonly ComposedApplicationSeedReceipt[];
  let server: Server | undefined;
  let assistant: AssistantEndpoint | undefined;
  let workflows: ReturnType<typeof startWorkflowScheduler> | undefined;
  // The Host values the assistant answers to, known once the server listens;
  // nothing is accepted before then (end review X10).
  let authorities: readonly string[] = [];
  try {
    seededRecords = await seedComposedApplication(
      runtime,
      options.seedProfile ?? 'demo',
    );
    if (options.purchaseOrdersRequireApproval) {
      await runtime.entry.run(
        { headers: { cookie: 'northstar-demo-actor=manager' } },
        async (view) => {
          await runtime.operationGateway.invoke(
            view,
            {
              schemaVersion: 'northstar.semantic-operation-request/v1',
              operationId: 'northstar.app:operation.purchasing_settings_create',
              idempotencyKey: '74000000-0000-4000-8000-000000000098',
              confirmationGrant: null,
              input: {
                recordId: '74000000-0000-4000-8000-000000000099',
                values: {
                  'northstar.app:field.purchasing_settings_key':
                    'purchase-orders',
                  'northstar.app:field.purchasing_settings_require_approval': true,
                },
              },
            },
            runtime.operationMediation.issueInvocation(view, 'UI'),
          );
        },
      );
    }
    assistant =
      runtime.identityMode === 'LOCAL_DEMO'
        ? createAssistantEndpoint({
            runtime,
            // The page's company, proved through the person's workspace
            // entry as the page proves it (end review X9).
            company: ({ cookie, surfaceId, search }) =>
              runtime.entry.run({ headers: { cookie } }, (view) =>
                assistantCompany(view, runtime.queryGateway, {
                  surfaceId,
                  search,
                }),
              ),
            businessCalendar: COMPOSED_APPLICATION_INVENTORY_SCOPE,
            model: options.assistantModel ?? keyFileAssistantModel(),
            authorities: () => authorities,
            // The panel's handoff drafts through the Customize screen's
            // own lazily opened service: one service per server. A panel
            // draft runs inside its conversation's budget (X13).
            customize: async () => {
              const service = await customize();
              return {
                draftFromRequest: (request, budget, cookie) =>
                  runtime.entry.run({ headers: { cookie } }, (view) => {
                    const actor = trustedContextForRequestRuntimeView(view);
                    return budget
                      ? DRAFT_BUDGET.run(budget, () =>
                          service.draftFromRequest(
                            request,
                            budget.signal,
                            actor,
                          ),
                        )
                      : service.draftFromRequest(request, undefined, actor);
                  }),
              };
            },
          })
        : undefined;
    if (options.workflowScheduler && runtime.identityMode === 'LOCAL_DEMO') {
      workflows = startWorkflowScheduler(options.workflowScheduler, () => {
        process.stderr.write('WORKFLOW_SCHEDULER_POLL_FAILED\n');
      });
    }
    server = createSurfaceRuntimeServer(
      runtime.entry,
      {
        applicationExtension: COMPOSED_APPLICATION_SURFACE_RUNTIME_EXTENSION,
        operationGateway: runtime.operationGateway,
        operationMediation: runtime.operationMediation,
        queryGateway: runtime.queryGateway,
      },
      runtime.identityMode === 'LOCAL_DEMO' ? runtime.localDemoActors : null,
      runtime.identityMode === 'LOCAL_DEMO' ? customize : undefined,
      // Loopback-only dev and test server: each response reports its
      // database work as `Server-Timing` (SPEED-1).
      {
        readSnapshot: (work, snapshotOptions) =>
          runtime.readSnapshot(work, snapshotOptions),
        selectedDemoActor: localDemoActor,
        requestWork: createRequestWorkProbe(),
        ...(assistant ? { assistant } : {}),
        ...(workflows ? { workflowApprovals: workflows.worker } : {}),
      },
    );
    const listener = server;
    await new Promise<void>((resolve, reject) => {
      listener.once('error', reject);
      listener.listen(options.port ?? 4174, host, () => {
        listener.off('error', reject);
        resolve();
      });
    });
  } catch (error) {
    server?.close();
    assistant?.close();
    await workflows?.close();
    await closeCustomization();
    await runtime.close();
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === 'string') {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    await workflows?.close();
    await closeCustomization();
    await runtime.close();
    throw new Error('composed application server has no TCP address');
  }
  authorities = loopbackAuthorities(host, address.port);
  let closed = false;
  return Object.freeze({
    baseUrl: `http://${host}:${String(address.port)}`,
    async close() {
      if (closed) return;
      closed = true;
      assistant?.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await workflows?.close();
      await closeCustomization();
      await runtime.close();
    },
    runtime,
    seededRecords,
    server,
  });
}

/** The panel's default model: the key file, read once on first use. */
function keyFileAssistantModel() {
  let key: ReturnType<typeof loadModelKey> | undefined;
  const models = new Map<string, ModelAdapter>();
  return async (request: string) => {
    const route = assistantRoute(request, process.env.NORTH_STAR_AGENT_MODEL);
    const id = `${route.modelId}/${route.effort}`;
    const cached = models.get(id);
    if (cached) return cached;
    try {
      const model = anthropicModel({
        key: await (key ??= loadModelKey('anthropic')),
        ...route,
      });
      models.set(id, model);
      return model;
    } catch {
      key = undefined;
      return {
        unavailable: `The assistant has no model key. Start the app with ${AGENT_KEY_FILE_VARIABLE} naming the key file, then ask again.`,
      };
    }
  };
}

/** The release this checkout compiled, as `pnpm dev` would install it. */
export async function readCompiledApplication(): Promise<unknown> {
  return JSON.parse(
    await readFile(
      new URL('../../web/release/app.compiled.json', import.meta.url),
      'utf8',
    ),
  ) as unknown;
}

/**
 * The composed runtime alone: no seed, no listener. `startComposedApplication`
 * serves it; the operations-agent terminal opens one against the database a
 * running `pnpm dev` already installed and seeded, because a confirmation grant
 * is signed by the mediation authority of the process that issues it.
 */
export async function openComposedApplicationRuntime(
  options: Pick<
    ComposedApplicationServerOptions,
    | 'compiledApplication'
    | 'databaseUrl'
    | 'rollbackReleaseRoot'
    | 'tenantSlug'
    | 'workflowScheduler'
  >,
): Promise<ComposedApplicationRuntime> {
  let compiledApplication: unknown;
  return createComposedApplicationRuntime({
    capabilityOperationExecutorFactories: CAPABILITY_EXECUTOR_FACTORIES,
    async loadCompiledApplication() {
      compiledApplication =
        options.compiledApplication ?? (await readCompiledApplication());
      return compiledApplication;
    },
    customization: {
      get acknowledgement() {
        return readUnboundPermissionAcknowledgementFor(
          new URL('../../web/release/app.authored.json', import.meta.url)
            .pathname,
          'northstar.app:package.application',
        );
      },
      get firstPartyAuthored() {
        return canonicalAuthoredProjection(
          parseNormalizedApplicationPackageJson(
            parseCompiledApplication(compiledApplication).application
              .normalizedDefinitionBytes,
          ),
        ) as unknown as Record<string, unknown>;
      },
    },
    databaseUrl: options.databaseUrl,
    inventoryScopeProvisioning: COMPOSED_APPLICATION_INVENTORY_SCOPE,
    localDemoIdentity: true,
    ...(options.workflowScheduler
      ? { localDemoWorkflowApprovals: true as const }
      : {}),
    migrationsDirectory: new URL('../../../db/migrations/', import.meta.url)
      .pathname,
    providerErrorMappings: INVENTORY_PROVIDER_ERROR_MAPPINGS,
    ...(options.rollbackReleaseRoot !== undefined
      ? {
          releaseSelection: {
            kind: 'rollback' as const,
            targetReleaseRoot: options.rollbackReleaseRoot,
          },
        }
      : {}),
    tenantSlug: options.tenantSlug ?? 'local-composed-application',
  });
}

/** Tenant customization over the database the composed runtime serves. */
export async function openCustomizeService(
  options: Pick<
    ComposedApplicationServerOptions,
    'compiledApplication' | 'databaseUrl' | 'tenantSlug' | 'draftingProvider'
  >,
) {
  const authoredPath = new URL(
    '../../web/release/app.authored.json',
    import.meta.url,
  ).pathname;
  const firstPartyAuthored = options.compiledApplication
    ? (canonicalAuthoredProjection(
        parseNormalizedApplicationPackageJson(
          parseCompiledApplication(options.compiledApplication).application
            .normalizedDefinitionBytes,
        ),
      ) as unknown as Record<string, unknown>)
    : (JSON.parse(await readFile(authoredPath, 'utf8')) as Record<
        string,
        unknown
      >);
  return openCustomizationService({
    acknowledgement: readUnboundPermissionAcknowledgementFor(
      authoredPath,
      String((firstPartyAuthored.package as Record<string, unknown>).packageId),
    ),
    capabilityOperationExecutorFactories: CAPABILITY_EXECUTOR_FACTORIES,
    compiledApplication:
      options.compiledApplication ??
      (JSON.parse(
        await readFile(
          new URL('../../web/release/app.compiled.json', import.meta.url),
          'utf8',
        ),
      ) as unknown),
    databaseUrl: options.databaseUrl,
    draftingModel: async () =>
      draftingModelFrom(
        options.draftingProvider
          ? await options.draftingProvider()
          : anthropicModel({
              effort: 'medium',
              key: await loadModelKey('anthropic'),
              maxTokens: 8_000,
              modelId:
                process.env.NORTH_STAR_CUSTOMIZE_MODEL ??
                DEFAULT_ANTHROPIC_MODEL,
            }),
      ),
    firstPartyAuthored,
    localDemoIdentity: true,
    migrationsDirectory: new URL('../../../db/migrations/', import.meta.url)
      .pathname,
    providerErrorMappings: INVENTORY_PROVIDER_ERROR_MAPPINGS,
    tenantSlug: options.tenantSlug ?? 'local-composed-application',
  });
}

/**
 * The operations agent's provider adapter drafts customizations too (slice 4).
 * It passes tool definitions to the provider unchanged; only its tool-name
 * type is narrowed to the agent's five, so the drafting tool is handed through.
 */
function draftingModelFrom(
  provider: ModelAdapter,
): NonNullable<
  Awaited<ReturnType<NonNullable<CustomizationServiceOptions['draftingModel']>>>
> {
  // A draft the panel asked for is metered against its conversation (X13).
  const adapter = budgetedDraftingModel(provider);
  return {
    modelId: adapter.modelId,
    next: (request) =>
      adapter.next(request as unknown as Parameters<ModelAdapter['next']>[0]),
  };
}

async function seedComposedApplication(
  runtime: ComposedApplicationRuntime,
  profile: ComposedApplicationSeedProfile,
): Promise<readonly ComposedApplicationSeedReceipt[]> {
  return runtime.entry.run(
    { headers: { authorization: 'local-demo-seed' } },
    async (view) => {
      const receipts: ComposedApplicationSeedReceipt[] = [];
      for (const seed of composedApplicationSeed(profile)) {
        const result = await runtime.operationGateway.invoke(
          view,
          {
            confirmationGrant: null,
            idempotencyKey: seed.idempotencyKey,
            input: {
              recordId: seed.recordId,
              values: seed.values,
              ...(seed.relations ? { relations: seed.relations } : {}),
            },
            operationId: seed.operationId,
            schemaVersion: 'northstar.semantic-operation-request/v1',
          },
          runtime.operationMediation.issueInvocation(view, 'UI'),
        );
        if (
          result.outcome !== 'succeeded' ||
          !result.readBack ||
          !result.trust
        ) {
          throw new Error(`demo seed operation failed: ${seed.operationId}`);
        }
        receipts.push(
          Object.freeze({
            operationId: seed.operationId,
            recordId: result.readBack.recordId,
            trust: result.trust,
          }),
        );
      }
      // The distributor profile names its company (LOOK-1 round 2): one
      // update of the provisioned default company at its first revision,
      // replayed by its key when the server restarts on the same database.
      // Never fatal: a company someone renamed since keeps its name, and the
      // server still starts.
      if (profile === 'distributor') {
        await runtime.operationGateway.invoke(
          view,
          {
            confirmationGrant: null,
            idempotencyKey: '72000000-0000-4000-8000-000000009999',
            input: {
              recordId: COMPOSED_APPLICATION_INVENTORY_SCOPE.legalEntityId,
              expectedRevision: 1,
              patch: {
                'northstar.app:field.legal_entity_name':
                  DISTRIBUTOR_COMPANY_NAME,
              },
            },
            operationId: 'northstar.app:operation.legal_entity_update',
            schemaVersion: 'northstar.semantic-operation-request/v1',
          },
          runtime.operationMediation.issueInvocation(view, 'UI'),
        );
      }
      return Object.freeze(receipts);
    },
  );
}
