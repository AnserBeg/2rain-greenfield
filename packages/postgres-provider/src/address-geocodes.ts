import { MapImagery } from './map-imagery.js';
import {
  SurfaceMapSchema,
  type MapViewport,
} from '@north-star/canonical-model';
import {
  addressColumns,
  readAddress,
  addressScalars,
} from './address-storage.js';
import { randomUUID } from 'node:crypto';
import { withModuleRuntimeRole } from './module-runtime-interpreter.js';
import type {
  AddressGateway,
  AddressInstallation,
} from '../../runtime/src/address-gateway.js';
import type { Pool, PoolClient } from 'pg';
import {
  AddressProjectionSchema,
  CoordinatesSchema,
} from '@north-star/canonical-model';
import type {
  RequestRuntimeView,
  CurrentPolicyGateway,
} from '../../runtime/src/request-runtime-view.js';
import {
  authorizeCurrentPolicy,
  issueLegalEntityReadScope,
  trustedContextForRequestRuntimeView,
} from '../../runtime/src/request-runtime-view.js';
import {
  parsePinnedOperationCatalog,
  OPERATION_BOUNDARY_PERMISSION_ID,
} from '../../runtime/src/semantic-operation-gateway.js';
import {
  registeredQueryFromPinnedView,
  SEMANTIC_QUERY_REQUEST_VERSION,
  type SemanticQueryGateway,
} from '../../runtime/src/semantic-query-gateway.js';
import {
  addressProvider,
  mapProviderDescriptor,
  AddressProviderError,
  type AddressProvider,
  type InstallationIdentity,
} from './address-provider.js';
import {
  withTrustedRequestRead,
  withTrustedRequestTransaction,
} from './request-context.js';
import {
  currentPolicyVersionOf,
  ADDRESS_CONNECTOR_CONFIGURE_BINDING,
  MAP_VIEWPORT_READ_BINDING,
} from './current-policy.js';
import type { StorageTargetPayloadV1 } from '@north-star/compiler';

type Entity = StorageTargetPayloadV1['entities'][number];
interface Install extends InstallationIdentity {
  provider: 'fake' | 'google';
  enrichment: boolean;
  period_calls: number;
  period_budget_micros: string;
}
export interface AddressTarget {
  fieldId: string;
  recordId: string;
  companyId: string;
}
interface Job extends AddressTarget {
  installationId: string;
  revision: string;
  claim: string;
  entityId: string;
  sourceDigest: string;
  releaseRoot: string;
  releaseId: string;
  fence: string;
  outbox: string;
  attempts: number;
}
const denied = () => new AddressProviderError('unconfigured');
const ident = (v: string) => {
  if (!/^[a-z][a-z0-9_]{0,62}$/u.test(v)) throw denied();
  return '"' + v + '"';
};
const isUuid = (v: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(v);
const bindingFor = (view: RequestRuntimeView, id: string) => {
  const definition = AddressProjectionSchema.safeParse(
    view.projections.connector?.payload,
  );
  const binding = definition.data?.bindings.find((b) => b.fieldId === id);
  if (!binding) throw denied();
  return binding;
};
async function active(client: PoolClient, view: RequestRuntimeView) {
  const pointer = await client.query(
    'SELECT 1 FROM platform.active_release_pointers WHERE tenant_id=$1 AND environment_id=$2 AND release_id=$3 AND fence=$4 AND pointer_id=$5 FOR SHARE',
    [
      view.tenantId,
      view.environmentId,
      view.release.releaseId,
      view.pointer.fence,
      view.pointer.pointerId,
    ],
  );
  const epoch = await client.query(
    'SELECT platform.lock_current_policy_epoch($1,$2) AS v',
    [view.tenantId, view.environmentId],
  );
  if (
    !pointer.rowCount ||
    currentPolicyVersionOf(epoch.rows[0].v) !== view.entryPolicyVersion
  )
    throw denied();
}
async function installation(
  client: PoolClient,
  view: RequestRuntimeView,
  company: string,
): Promise<Install | null> {
  const installed = await client.query<
    Omit<Install, 'tenantId' | 'environmentId' | 'companyId'>
  >(
    `SELECT installation_id AS "installationId", account, provider, enrichment, period_calls,
   period_budget_micros::text AS period_budget_micros FROM platform.address_installation($1)`,
    [company],
  );
  const row = installed.rows[0];
  return row
    ? {
        ...row,
        tenantId: view.tenantId,
        environmentId: view.environmentId,
        companyId: company,
      }
    : null;
}
async function reserve(client: PoolClient, i: Install) {
  const r = await client.query<{ ok: boolean }>(
    'SELECT platform.address_reserve($1,$2) AS ok',
    [i.companyId, i.installationId],
  );
  if (!r.rows[0]?.ok) throw new AddressProviderError('quota');
}
// The caller has validated and committed the governed record's new field revision
// within this same transaction. The deferred FK resolves when trust writes the outbox.
export async function enqueueAddress(
  client: PoolClient,
  view: RequestRuntimeView,
  company: string,
  entityId: string,
  recordId: string,
  fieldId: string,
  revision: string,
  outbox: string,
  installationId: string,
  sourceDigest: string,
) {
  await client.query(
    'SELECT platform.address_enqueue($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
    [
      company,
      installationId,
      outbox,
      fieldId,
      entityId,
      recordId,
      revision,
      view.release.releaseId,
      view.release.contentHash,
      view.pointer.fence,
      sourceDigest,
    ],
  );
}

export class PostgresAddresses implements AddressGateway {
  constructor(
    private readonly pool: Pool,
    private readonly queries: SemanticQueryGateway,
    private readonly release: (id: string) =>
      | Promise<{
          policy: CurrentPolicyGateway;
          storage: StorageTargetPayloadV1 | null;
        }>
      | {
          policy: CurrentPolicyGateway;
          storage: StorageTargetPayloadV1 | null;
        },
    private readonly demo: boolean,
    private readonly providerFor: (i: Install) => AddressProvider = (i) =>
      addressProvider(
        i,
        i.provider,
        demo,
        process.env.NORTH_STAR_GOOGLE_MAPS_TERMS === 'non-eea',
      ),
  ) {}
  private readonly imagery = new MapImagery();
  private viewportScope(
    view: RequestRuntimeView,
    surfaceId: string,
    companyId: string,
    installationId: string,
  ) {
    return {
      surfaceId,
      companyId,
      installationId,
      tenantId: view.tenantId,
      environmentId: view.environmentId,
      principalId: view.principalId,
      fence: String(view.pointer.fence),
      releaseId: view.release.releaseId,
      policyVersion: String(view.entryPolicyVersion),
    };
  }
  issueViewport(
    view: RequestRuntimeView,
    surfaceId: string,
    companyId: string,
    installationId: string,
    viewport: MapViewport,
  ) {
    return this.imagery.issue(
      this.viewportScope(view, surfaceId, companyId, installationId),
      viewport,
    );
  }
  async viewportImage(
    view: RequestRuntimeView,
    handle: string,
    companyId: string,
  ) {
    const display = await this.viewportAccess(
      view,
      handle,
      companyId,
      'raster',
    );
    return this.imagery.image(
      handle,
      display.scope,
      display.reserve,
      display.provider.imagery,
    );
  }
  async viewportDisplay(view: RequestRuntimeView, handle: string) {
    const company = this.imagery.request(handle)?.scope.companyId;
    if (
      !company ||
      process.env.CI ||
      !this.demo ||
      process.env.NORTH_STAR_CONNECTOR_DEMO !== '1'
    )
      throw denied();
    const display = await this.viewportAccess(view, handle, company, 'browser');
    const frame = display.provider.frame;
    const key = frame?.browserKey();
    if (!frame || !key) throw denied();
    const viewport = await this.imagery.browserViewport(
      handle,
      display.scope,
      display.reserve,
    );
    return {
      frame: { document: frame.document, title: frame.title },
      browserKey: key,
      viewport,
    };
  }
  private async viewportAccess(
    view: RequestRuntimeView,
    handle: string,
    companyId: string,
    display: 'browser' | 'raster',
  ) {
    const request = this.imagery.request(handle);
    if (!request || !isUuid(companyId)) throw denied();
    const { surfaceId } = request.scope;
    const manifest = view.projections.surface.payload as {
      surfaces: readonly Record<string, unknown>[];
    };
    const surface = manifest.surfaces.find(
      (s) =>
        s.surfaceId === surfaceId &&
        s.lifecycle === 'active' &&
        s.archetype === 'map',
    );
    const binding = SurfaceMapSchema.safeParse(surface?.map);
    if (!binding.success) throw denied();
    const { body } = binding.data;
    const connector = AddressProjectionSchema.parse(
      view.projections.connector?.payload,
    );
    if (
      !connector.viewports?.some(
        (v) => v.surfaceId === surfaceId && v.fieldId === body.addressFieldId,
      )
    )
      throw denied();
    const { policy } = await this.release(view.release.releaseId);
    await issueLegalEntityReadScope(policy, view, [companyId]);
    const disclosure = await authorizeCurrentPolicy(
      policy,
      view,
      MAP_VIEWPORT_READ_BINDING.permissionId,
      {
        arguments: { legalEntityId: companyId },
        kind: 'registeredSemanticQueryPolicyInput',
        queryId: body.viewport,
        requestId: view.requestId,
        schemaVersion: 'northstar.semantic-query-policy-input/v1',
      },
    );
    if (
      disclosure.decision !== 'ALLOW' ||
      disclosure.policyVersion !== view.entryPolicyVersion
    )
      throw denied();
    for (const queryId of [body.listQueryId, body.getQueryId])
      if (
        (await this.queries.previewEligibility(view, queryId, companyId)) !==
        'eligible'
      )
        throw denied();
    const live = async (c: PoolClient) => {
      await active(c, view);
      const i = await installation(c, view, companyId);
      if (!i || mapProviderDescriptor(i.provider)?.display !== display)
        throw denied();
      return i;
    };
    const i = await this.tx(view, live);
    const provider = mapProviderDescriptor(i.provider)!;
    return {
      provider,
      scope: this.viewportScope(view, surfaceId, companyId, i.installationId),
      reserve: () =>
        this.tx(view, async (c) => {
          const current = await live(c);
          if (current.installationId !== i.installationId) throw denied();
          await reserve(c, current);
        }),
    };
  }
  private tx<T>(
    view: RequestRuntimeView,
    work: (client: PoolClient) => Promise<T>,
  ) {
    return withTrustedRequestTransaction(
      this.pool,
      trustedContextForRequestRuntimeView(view),
      work,
    );
  }
  async installations(view: RequestRuntimeView) {
    // The installation read policy filters by the trusted principal's live
    // company memberships on this connection.
    return withTrustedRequestRead(
      this.pool,
      trustedContextForRequestRuntimeView(view),
      async (c) =>
        (
          await c.query<AddressInstallation>(
            `SELECT company_id AS "companyId", installation_id AS "installationId", account,provider,enrichment
      FROM platform.address_installations()`,
          )
        ).rows,
    );
  }
  async canConfigure(view: RequestRuntimeView, company: string) {
    if (!this.demo || !isUuid(company)) return false;
    const { policy } = await this.release(view.release.releaseId);
    const decision = await authorizeCurrentPolicy(
      policy,
      view,
      ADDRESS_CONNECTOR_CONFIGURE_BINDING.permissionId,
      { legalEntityId: company },
    );
    return (
      decision.decision === 'ALLOW' &&
      decision.policyVersion === view.entryPolicyVersion
    );
  }

  async configure(
    view: RequestRuntimeView,
    company: string,
    options: {
      provider: 'fake' | 'google';
      account: string;
      enrichment: boolean;
      calls: number;
      budgetMicros: number;
      enabled: boolean;
    },
  ) {
    if (
      !this.demo ||
      !isUuid(company) ||
      !['fake', 'google'].includes(options.provider) ||
      !/^[\w.-]{1,120}$/u.test(options.account) ||
      !Number.isSafeInteger(options.calls) ||
      !Number.isSafeInteger(options.budgetMicros)
    )
      throw denied();
    if (!(await this.canConfigure(view, company))) throw denied();
    // The single entry point for enabling a provider. SIGNIN-1 slice 2b adds
    // its passkey decision proof to platform.address_configure.
    return this.tx(view, async (c) => {
      await active(c, view);
      try {
        const r = await c.query<{ id: string | null }>(
          'SELECT platform.address_configure($1,$2,$3,$4,$5,$6,$7) AS id',
          [
            company,
            options.provider,
            options.account,
            options.enrichment,
            options.calls,
            options.budgetMicros,
            options.enabled,
          ],
        );
        return r.rows[0]?.id ?? undefined;
      } catch (error) {
        if ((error as { code?: unknown }).code === '42501') throw denied();
        throw error;
      }
    });
  }
  private async authorize(
    view: RequestRuntimeView,
    t: AddressTarget,
    editing: boolean,
  ) {
    if (
      !isUuid(t.companyId) ||
      (!isUuid(t.recordId) && !(editing && t.recordId === ''))
    )
      throw denied();
    const binding = bindingFor(view, t.fieldId);
    const { policy, storage } = await this.release(view.release.releaseId);
    const entity = storage?.entities.find(
      (e) => e.entityId === binding.entityId,
    );
    if (!entity) throw denied();
    await issueLegalEntityReadScope(policy, view, [t.companyId]);
    const q = registeredQueryFromPinnedView(view, binding.recordQueryId);
    if (!q || q.sourceEntityId !== entity.entityId) throw denied();
    const scope = q.legalEntityScope;
    if (t.recordId) {
      const result = await this.queries.invoke(view, {
        schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
        queryId: q.queryId,
        arguments: {
          recordId: t.recordId,
          ...(scope && {
            [scope.operand.parameterId]:
              scope.cardinality === 'exactlyOne' ? t.companyId : [t.companyId],
          }),
        },
      });
      const record = result.records[0];
      if (
        result.outcome !== 'exact' ||
        !record ||
        record.archived ||
        record.recordId !== t.recordId
      )
        throw denied();
    }
    if (editing) {
      const op = parsePinnedOperationCatalog(
        view.projections.operation.payload,
      ).find(
        (op) =>
          binding.editOperationIds.includes(op.operationId) &&
          op.effect.kind ===
            (t.recordId ? 'updateRecordEffect' : 'createRecordEffect'),
      );
      if (!op) throw denied();
      for (const permission of [
        OPERATION_BOUNDARY_PERMISSION_ID,
        op.permissionId,
      ]) {
        const decision = await authorizeCurrentPolicy(
          policy,
          view,
          permission,
          {
            kind: 'registeredSemanticOperationPolicyInput',
            schemaVersion: 'northstar.semantic-operation-policy-input/v1',
            requestId: view.requestId,
            operationId: op.operationId,
            input: { legalEntityId: t.companyId, recordId: t.recordId },
          },
        );
        if (
          decision.decision !== 'ALLOW' ||
          decision.policyVersion !== view.entryPolicyVersion
        )
          throw denied();
      }
    }
    return { binding, entity };
  }
  // Lock the physical row from the pinned storage descriptor. An old response
  // cannot race a committed edit or carry a shared record's pin across companies.
  private async address(
    c: PoolClient,
    view: RequestRuntimeView,
    t: AddressTarget,
    entity: Entity,
  ) {
    const columns = addressColumns(entity, t.fieldId);
    const company = entity.legalEntity;
    const r = await withModuleRuntimeRole(c, () =>
      c.query(
        `SELECT ${Object.values(columns).map(ident).join(', ')} FROM north_star_module.${ident(entity.physicalTableName)}
      WHERE tenant_id=$1 AND environment_id=$2 AND ${ident(entity.recordIdentity.column)}=$3 AND ${ident(entity.archive.archivedAtColumn)} IS NULL
      ${company ? 'AND ' + ident(company.column) + '=$4' : ''} FOR SHARE`,
        [
          view.tenantId,
          view.environmentId,
          t.recordId,
          ...(company ? [t.companyId] : []),
        ],
      ),
    );
    if (r.rows.length !== 1) throw denied();
    return readAddress(columns, r.rows[0]);
  }
  async suggest(
    view: RequestRuntimeView,
    t: AddressTarget,
    queryId: string,
    text: string,
    session: string,
  ) {
    const { entity, binding } = await this.authorize(view, t, true);
    if (
      queryId !== binding.suggestQueryId ||
      text.trim().length < 3 ||
      text.length > 512 ||
      !isUuid(session)
    )
      throw denied();
    const i = await this.tx(view, async (c) => {
      await active(c, view);
      if (t.recordId) await this.address(c, view, t, entity);
      const i = await installation(c, view, t.companyId);
      if (!i) throw denied();
      await reserve(c, i);
      return i;
    });
    const p = this.providerFor(i);
    return {
      suggestions: await p.suggest(text, session),
      attribution: p.attribution,
    };
  }
  async pin(view: RequestRuntimeView, t: AddressTarget, queryId: string) {
    const { entity, binding } = await this.authorize(view, t, false);
    if (queryId !== binding.mapQueryId) throw denied();
    return this.tx(view, async (c) => {
      await active(c, view);
      const address = await this.address(c, view, t, entity);
      if (!address) return { status: 'absent' } as const;
      if (address.pin)
        return {
          status: 'ready',
          pin: address.pin,
          attribution: 'User pin',
        } as const;
      const i = await installation(c, view, t.companyId);
      if (!i) return { status: 'unavailable' } as const;
      const r = await c.query<{
        state: string;
        latitude: string | null;
        longitude: string | null;
        usable: boolean;
      }>('SELECT * FROM platform.address_pin($1,$2,$3,$4,$5,$6)', [
        t.companyId,
        i.installationId,
        entity.entityId,
        t.recordId,
        t.fieldId,
        address.revision,
      ]);
      const row = r.rows[0];
      if (row?.state === 'ready' && row.usable) {
        const pin = CoordinatesSchema.parse({
          latitude: row.latitude,
          longitude: row.longitude,
        });
        const p = this.providerFor(i);
        return {
          status: 'ready',
          pin,
          attribution: p.attribution,
          image: p.staticMap(pin),
        } as const;
      }
      return {
        status:
          row && ['queued', 'working'].includes(row.state)
            ? 'locating'
            : 'unavailable',
      } as const;
    });
  }
  async workOne(view: RequestRuntimeView) {
    const job = await this.tx(view, async (c) => {
      const claim = randomUUID();
      const r = await c.query<Job>(
        `SELECT company_id AS "companyId",installation_id AS "installationId",revision,release_id AS "releaseId",
        entity_id AS "entityId",release_root AS "releaseRoot",source_digest AS "sourceDigest",fence,record_id AS "recordId",
        field_id AS "fieldId",outbox,attempts,claim_id AS claim FROM platform.address_claim($1)`,
        [claim],
      );
      return r.rows[0];
    });
    if (!job) return false;
    const jobKey = [
      job.companyId,
      job.installationId,
      job.outbox,
      job.fieldId,
      job.claim,
    ];
    try {
      if (
        view.release.contentHash !== job.releaseRoot ||
        view.release.releaseId !== job.releaseId ||
        view.pointer.fence !== Number(job.fence) ||
        job.attempts >= 4
      )
        throw denied();
      const { entity } = await this.authorize(view, job, true);
      if (entity.entityId !== job.entityId) throw denied();
      const checked = async (c: PoolClient) => {
        await active(c, view);
        const i = await installation(c, view, job.companyId);
        const address = await this.address(c, view, job, entity);
        if (
          i?.installationId !== job.installationId ||
          !i.enrichment ||
          !address ||
          address.revision !== job.revision ||
          addressScalars(address).sourceDigest !== job.sourceDigest ||
          address.pin
        )
          throw denied();
        return { i, address };
      };
      const { i, address } = await this.tx(view, async (c) => {
        const checkedResult = await checked(c);
        const attempt = await c.query<{ ok: boolean }>(
          'SELECT platform.address_attempt($1,$2,$3,$4,$5) AS ok',
          jobKey,
        );
        if (!attempt.rows[0]?.ok) throw denied();
        await reserve(c, checkedResult.i);
        return checkedResult;
      });
      const p = this.providerFor(i);
      const pin = await p.geocode(
        address.text,
        address.place?.namespace ===
          (p.name === 'google' ? 'google.places' : 'demo.places')
          ? address.place.id
          : undefined,
      );
      await this.authorize(view, job, true);
      await this.tx(view, async (c) => {
        await checked(c);
        await c.query(
          'SELECT platform.address_complete($1,$2,$3,$4,$5,$6,$7,$8)',
          [...jobKey, pin.latitude, pin.longitude, pin.precision],
        );
      });
    } catch (error) {
      const reason =
        error instanceof AddressProviderError ? error.reason : 'unavailable';
      const retry =
        ['unavailable', 'quota'].includes(reason) && job.attempts < 3;
      await this.tx(view, (c) =>
        c.query(
          'SELECT platform.address_settle($1,$2,$3,$4,$5,$6,$7,$8::smallint,$9::integer)',
          [
            ...jobKey,
            retry ? 'queued' : reason === 'unconfigured' ? 'held' : 'failed',
            reason,
            Math.min(job.attempts + 1, 4),
            [5, 30, 120, 120][Math.min(job.attempts, 3)],
          ],
        ),
      );
    }
    return true;
  }
  /** Scrub expired provider coordinates, at most `limit` per call. */
  async sweep(view: RequestRuntimeView, limit = 100) {
    return this.tx(view, async (c) => {
      const r = await c.query<{ swept: number }>(
        'SELECT platform.address_sweep($1) AS swept',
        [limit],
      );
      return r.rows[0]?.swept ?? 0;
    });
  }
}
