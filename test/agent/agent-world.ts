/**
 * The arranged world the operations agent is tested and measured in: a fresh,
 * uniquely named PostgreSQL container running the composed application on the
 * `distributor` seed (the profile `pnpm dev` serves), plus the governed
 * arrange steps the ten pre-registered tasks start from.
 *
 * Arrangement goes through the same operation gateway the UI uses, on channel
 * `UI`, as the demo manager. It never goes through the agent, so a task's
 * starting state cannot depend on the thing being measured.
 */
import { randomUUID } from 'node:crypto';

import type { ComposedApplicationRuntime } from '../../packages/postgres-provider/src/composed-application-runtime.js';

import {
  openComposedApplicationRuntime,
  startComposedApplication,
  COMPOSED_APPLICATION_INVENTORY_SCOPE,
} from '../../apps/api/src/composition-root.js';
import { composedApplicationSeed } from '../../packages/domain/src/app/seed.js';
import type { ImmutableJsonValue } from '../../packages/runtime/src/request-runtime-view.js';
import {
  parsePinnedOperationCatalog,
  SEMANTIC_OPERATION_REQUEST_VERSION,
  type SemanticOperationResultEnvelope,
} from '../../packages/runtime/src/semantic-operation-gateway.js';
import {
  SEMANTIC_QUERY_REQUEST_VERSION,
  type SemanticQueryResultEnvelope,
  type SemanticRecordDto,
} from '../../packages/runtime/src/semantic-query-gateway.js';
import { SHARED_LIST_QUERY_VERSION } from '../../packages/runtime/src/list-behavior/index.js';
import { withEphemeralPostgres } from '../helpers/postgres.js';

export const NS = 'northstar.app';
export const COMPANY = COMPOSED_APPLICATION_INVENTORY_SCOPE.legalEntityId;

export const BUSINESS_CALENDAR = COMPOSED_APPLICATION_INVENTORY_SCOPE;

export type DemoActor = 'buyer' | 'manager';

/** A seeded master's record id, by the name it is seeded with. */
export function seededId(name: string): string {
  const found = composedApplicationSeed('distributor').find((record) =>
    Object.values(record.values).includes(name),
  );
  if (!found) throw new Error(`no seeded record named ${name}`);
  return found.recordId;
}

export interface AgentWorld {
  readonly runtime: ComposedApplicationRuntime;
  readonly databaseName: string;
  readonly databaseUrl: string;
  readonly tenantSlug: string;
  invoke(
    local: string,
    input: ImmutableJsonValue,
    options?: { actor?: DemoActor; channel?: 'AGENT' | 'UI' },
  ): Promise<SemanticOperationResultEnvelope>;
  create(
    local: string,
    values: Record<string, ImmutableJsonValue>,
    relations?: Record<string, string>,
    recordId?: string,
  ): Promise<SemanticRecordDto>;
  read(local: string, recordId: string): Promise<SemanticRecordDto>;
  list(
    queryId: string,
    filters?: {
      fieldFilters?: readonly { fieldId: string; value: string }[];
      parentScope?: { recordId: string; relationId: string };
    },
  ): Promise<readonly SemanticRecordDto[]>;
}

export interface AgentWorlds {
  /** A fresh, uniquely named copy of the seeded base database. */
  fresh(name: string): Promise<AgentWorld & { close(): Promise<void> }>;
}

const BASE_DATABASE = 'agent_base';
const TENANT_SLUG = 'agent-world';

/**
 * One PostgreSQL container; the application is installed and seeded once into
 * a base database, and every world is `CREATE DATABASE ... TEMPLATE` of it
 * under a unique name, opened by the same runtime factory `pnpm dev` uses.
 * Installing the release lineage takes minutes; copying it takes seconds.
 */
export async function withAgentWorlds<T>(
  label: string,
  run: (worlds: AgentWorlds) => Promise<T>,
): Promise<T> {
  return withEphemeralPostgres(
    label,
    async ({ connection, pool }) => {
      const url = (database: string) =>
        `postgresql://${String(connection.user)}@${String(connection.host)}:${String(connection.port)}/${database}`;
      await pool.query(`CREATE DATABASE ${BASE_DATABASE}`);
      const base = await startComposedApplication({
        databaseUrl: url(BASE_DATABASE),
        port: 0,
        seedProfile: 'distributor',
        tenantSlug: TENANT_SLUG,
      });
      await base.close();
      return run({
        async fresh(name) {
          const databaseName = `agent_${name.toLowerCase().replaceAll(/[^a-z0-9]+/g, '_')}_${randomUUID().slice(0, 8)}`;
          await pool.query(
            `CREATE DATABASE ${databaseName} TEMPLATE ${BASE_DATABASE}`,
          );
          const runtime = await openComposedApplicationRuntime({
            databaseUrl: url(databaseName),
            tenantSlug: TENANT_SLUG,
          });
          return Object.assign(
            worldOver(runtime, databaseName, url(databaseName), TENANT_SLUG),
            { close: () => runtime.close() },
          );
        },
      });
    },
    { dataSizeMegabytes: 2048 },
  );
}

export function worldOver(
  runtime: ComposedApplicationRuntime,
  databaseName: string,
  databaseUrl = '',
  tenantSlug = TENANT_SLUG,
): AgentWorld {
  const headers = (actor: DemoActor) => ({
    headers: { cookie: `northstar-demo-actor=${actor}` },
  });
  const invoke: AgentWorld['invoke'] = (local, input, options = {}) =>
    runtime.entry.run(headers(options.actor ?? 'manager'), (view) => {
      const operationId = `${NS}:operation.${local}`;
      const operation = parsePinnedOperationCatalog(
        view.projections.operation.payload,
      ).find((value) => value.operationId === operationId);
      if (!operation) throw new Error(`no operation ${operationId}`);
      return runtime.operationGateway.invoke(
        view,
        {
          schemaVersion: SEMANTIC_OPERATION_REQUEST_VERSION,
          operationId,
          input,
          idempotencyKey: randomUUID(),
          confirmationGrant:
            operation.confirmation === 'humanRequired'
              ? runtime.operationMediation.issueConfirmationGrant(
                  view,
                  operationId,
                  input,
                )
              : null,
        },
        runtime.operationMediation.issueInvocation(
          view,
          options.channel ?? 'UI',
        ),
      );
    });
  const create: AgentWorld['create'] = async (
    local,
    values,
    relations = {},
    recordId = randomUUID(),
  ) => {
    const result = await invoke(`${local}_create`, {
      recordId,
      legalEntityId: COMPANY,
      values: Object.fromEntries(
        Object.entries(values).map(([name, value]) => [
          `${NS}:field.${local}_${name}`,
          value,
        ]),
      ),
      relations: Object.fromEntries(
        Object.entries(relations).map(([name, value]) => [
          `${NS}:relation.${local}_${name}`,
          value,
        ]),
      ),
    });
    if (result.outcome !== 'succeeded' || !result.readBack)
      throw new Error(`arrange create ${local} withheld`);
    return result.readBack;
  };
  const read: AgentWorld['read'] = (local, recordId) =>
    runtime.entry.run(headers('manager'), async (view) => {
      const result = await runtime.queryGateway.invoke(view, {
        schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
        queryId: `${NS}:query.${local}_get`,
        arguments: {
          recordId,
          [`${NS}:parameter.${local}_get_legal_entity_scope`]: COMPANY,
        },
      });
      const record = result.records[0];
      if (!record) throw new Error(`no ${local} ${recordId}`);
      return record;
    });
  const list: AgentWorld['list'] = (queryId, filters = {}) =>
    runtime.entry.run(headers('manager'), async (view) => {
      const local = queryId.split(':query.')[1]!;
      const rows: SemanticRecordDto[] = [];
      let cursor: string | null = null;
      do {
        const result: SemanticQueryResultEnvelope =
          await runtime.queryGateway.invoke(view, {
            schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
            queryId,
            arguments: {
              includeArchived: false,
              [`${NS}:parameter.${local}_legal_entity_scope`]: COMPANY,
              list: {
                cursor,
                matchMode: 'substring',
                pageSize: 100,
                relationLabels: [],
                schemaVersion: SHARED_LIST_QUERY_VERSION,
                search: '',
                sort: [],
                ...(filters.fieldFilters && filters.fieldFilters.length > 0
                  ? { fieldFilters: [...filters.fieldFilters] }
                  : {}),
                ...(filters.parentScope
                  ? { parentScope: filters.parentScope }
                  : {}),
              },
            },
          });
        rows.push(...result.records);
        cursor = result.listCoverage?.nextCursor ?? null;
      } while (cursor);
      return rows;
    });
  return {
    runtime,
    databaseName,
    databaseUrl,
    tenantSlug,
    invoke,
    create,
    read,
    list,
  };
}
