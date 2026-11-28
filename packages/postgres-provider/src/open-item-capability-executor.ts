import { randomUUID } from 'node:crypto';

import type { PoolClient } from 'pg';

import {
  OPEN_ITEM_APPLY_CAPABILITY,
  OPEN_ITEM_EVENT_SCHEMA_VERSION,
  OPEN_ITEM_ISSUE_CAPABILITY,
  openItemLineSetDigest,
  type OpenItemOperationBinding,
  type OpenItemTypeBinding,
} from '../../canonical-model/src/open-item.js';
import {
  PROJECTION_FAMILY_IDS,
  type StorageTargetPayloadV1,
} from '@north-star/compiler';
import {
  SEMANTIC_OPERATION_RESULT_VERSION,
  type RegisteredCapabilityOperationAuthorization as Authorization,
  type RegisteredCapabilityOperationAuthorizationRequest as Preparation,
  type RegisteredCapabilityOperationExecutionRequest as Execution,
  type RegisteredCapabilityOperationExecutor,
  type SemanticOperationResultEnvelope,
} from '../../runtime/src/semantic-operation-gateway.js';
import {
  SEMANTIC_QUERY_REQUEST_VERSION,
  SemanticQueryPolicyDeniedError,
} from '../../runtime/src/semantic-query-gateway.js';
import { POLICY_DECISION_EVIDENCE_VERSION } from '../../platform-runtime/src/trust/contracts.js';
import type {
  PostgresCapabilityOperationExecutorContext,
  PostgresCapabilityOperationExecutorFactory,
} from './capability-operation-executor-factory.js';
import {
  auditFieldId,
  withModuleRuntimeRole,
} from './module-runtime-interpreter.js';
import { recordCreations } from './record-creation-occurrences.js';
import { withTrustedRequestTransaction } from './request-context.js';
import { PostgresTrustService } from './trust/postgres-trust-service.js';

/**
 * The open-item core (OPEN-ITEM-1 slice 1): issue and apply, executed by the
 * compiled binding an operation carries, over the release's generated tables.
 * It names no record type, field or module: every name comes from the
 * binding, every column from the active storage target.
 *
 * Issue: a draft becomes open (settled when its total is zero), numbered per
 * company and series, its total frozen from its live lines (or its entered
 * amount), applied zero and balance the total. Apply: amounts move from one
 * credit-side source to debit-side targets of the same company, counterparty,
 * currency and direction; each item's applied is the sum of its application
 * lines, re-read under the locks before commit.
 *
 * A person confirms each one: the gateway's grant is verified here, attested
 * as the approval issuer, and consumed once in SQL (lock position 0), whose
 * minted invocation is the trust receipt the deferred check verifies.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const AMOUNT = /^(?:0|[1-9]\d{0,19})(?:\.\d{1,18})?$/u;
const MAXIMUM_APPLICATION_LINES = 100;
const INVALID = 'openItem.invalidOperation';

type Entity = StorageTargetPayloadV1['entities'][number];
type Row = Record<string, unknown>;
type Kind = 'issue' | 'apply';

const object = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function refused(reason: string = INVALID): never {
  throw Object.assign(new Error(reason), {
    code: 'SEMANTIC_OPERATION_INPUT_INVALID',
  });
}

function quote(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/u.test(value))
    throw new Error('Invalid storage identifier');
  return `"${value}"`;
}

/** An exact decimal as integer units at `scale`, or null when it does not fit. */
function units(value: unknown, scale: number): bigint | null {
  if (typeof value !== 'string') return null;
  const match = /^(-?)(\d+)(?:\.(\d+))?$/u.exec(value);
  if (!match) return null;
  const fraction = (match[3] ?? '').replace(/0+$/u, '');
  if (fraction.length > scale) return null;
  const magnitude = BigInt(`${match[2]}${fraction.padEnd(scale, '0')}`);
  return match[1] === '-' ? -magnitude : magnitude;
}

function decimal(value: bigint, scale: number): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value)
    .toString()
    .padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale);
  const fraction = digits.slice(digits.length - scale);
  return `${negative ? '-' : ''}${whole}${scale > 0 ? `.${fraction}` : ''}`;
}

/** The physical names of one item type in the active storage target. */
interface ItemStorage {
  readonly binding: OpenItemTypeBinding;
  readonly entity: Entity;
  readonly table: string;
  readonly company: string;
  readonly column: (fieldId: string) => string;
  readonly counterparty: string;
  readonly lines?: {
    readonly table: string;
    readonly parent: string;
    readonly amount: string;
  };
}

class Storage {
  constructor(private readonly target: StorageTargetPayloadV1) {}

  entity(entityId: string): Entity {
    const found = this.target.entities.filter(
      (entry) => entry.entityId === entityId,
    );
    if (found.length !== 1 || !found[0]!.legalEntity)
      throw new Error(`open-item storage is missing ${entityId}`);
    return found[0]!;
  }

  column(entity: Entity, fieldId: string): string {
    const found = entity.columns.filter(
      (entry) => entry.canonicalFieldId === fieldId,
    );
    if (found.length !== 1)
      throw new Error(`open-item storage is missing ${fieldId}`);
    return quote(found[0]!.physicalName);
  }

  relation(entity: Entity, relationId: string): string {
    const found = this.target.relations.find(
      (entry) => entry.relationId === relationId,
    );
    if (!found || found.sourceEntityId !== entity.entityId)
      throw new Error(`open-item storage is missing ${relationId}`);
    return quote(found.relationColumn.physicalName);
  }

  item(binding: OpenItemTypeBinding): ItemStorage {
    const entity = this.entity(binding.entityId);
    const lineEntity = binding.lines
      ? this.entity(binding.lines.entityId)
      : undefined;
    return {
      binding,
      entity,
      table: `north_star_module.${quote(entity.physicalTableName)}`,
      company: quote(entity.legalEntity!.column),
      column: (fieldId) => this.column(entity, fieldId),
      counterparty: this.relation(entity, binding.counterpartyRelationId),
      ...(lineEntity && binding.lines
        ? {
            lines: {
              table: `north_star_module.${quote(lineEntity.physicalTableName)}`,
              parent: this.relation(lineEntity, binding.lines.relationId),
              amount: this.column(lineEntity, binding.lines.amountFieldId),
            },
          }
        : {}),
    };
  }
}

const unquote = (identifier: string) => identifier.slice(1, -1);

interface Prepared {
  readonly request: Preparation;
  readonly binding: OpenItemOperationBinding;
  readonly company: string;
  readonly recordId: string;
  readonly expectedRevision: number;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly applications: readonly {
    readonly applicationId: string;
    readonly target: string;
    readonly amount: string;
  }[];
}

interface Change {
  readonly fieldId: string;
  readonly before: string | null;
  readonly after: string | null;
}

interface Applied {
  readonly revision: number;
  readonly changes: readonly Change[];
  readonly metadata: Readonly<Record<string, string | readonly string[]>>;
}

class OpenItemCapabilityExecutor implements RegisteredCapabilityOperationExecutor {
  readonly capabilityId: string;
  readonly #prepared = new WeakMap<Authorization, Prepared>();
  readonly #storage: Storage;

  constructor(
    private readonly context: PostgresCapabilityOperationExecutorContext,
    storage: StorageTargetPayloadV1,
    private readonly kind: Kind,
  ) {
    this.capabilityId =
      kind === 'issue'
        ? OPEN_ITEM_ISSUE_CAPABILITY
        : OPEN_ITEM_APPLY_CAPABILITY;
    this.#storage = new Storage(storage);
  }

  async prepareAuthorization(request: Preparation): Promise<Authorization> {
    const binding = request.definition.openItem;
    const input = request.input;
    const args = object(input) ? input.arguments : undefined;
    const scope = request.readBackDefinition.legalEntityScope;
    if (
      !binding ||
      binding.bindingVersion !==
        (this.kind === 'issue' ? 'openItem.issue/v1' : 'openItem.apply/v1') ||
      request.definition.effect.capability.targetId !== this.capabilityId ||
      request.readBackDefinition.queryType !== 'get' ||
      !scope ||
      scope.cardinality !== 'exactlyOne' ||
      !object(input) ||
      Object.keys(input).some(
        (key) => !['recordId', 'expectedRevision', 'arguments'].includes(key),
      ) ||
      typeof input.recordId !== 'string' ||
      !UUID.test(input.recordId) ||
      typeof input.expectedRevision !== 'number' ||
      !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 1 ||
      !object(args)
    )
      return refused();
    const recordId = input.recordId;
    let applications: Prepared['applications'] = [];
    let source: OpenItemTypeBinding;
    let readBackEntityId: string;
    if (binding.bindingVersion === 'openItem.issue/v1') {
      const lines = binding.item.lines !== undefined;
      if (
        Object.keys(args).some(
          (key) =>
            !['total', ...(lines ? ['lineSetDigest'] : [])].includes(key),
        ) ||
        typeof args.total !== 'string' ||
        !AMOUNT.test(args.total) ||
        (lines &&
          (typeof args.lineSetDigest !== 'string' ||
            !DIGEST.test(args.lineSetDigest)))
      )
        return refused();
      source = binding.item;
      readBackEntityId = binding.item.entityId;
    } else {
      const lines = args.lines;
      if (
        Object.keys(args).some((key) => key !== 'lines') ||
        !Array.isArray(lines) ||
        lines.length === 0 ||
        lines.length > MAXIMUM_APPLICATION_LINES
      )
        return refused();
      applications = lines.map((line: unknown) => {
        if (
          !object(line) ||
          Object.keys(line).length !== 3 ||
          typeof line.applicationId !== 'string' ||
          !UUID.test(line.applicationId) ||
          typeof line.target !== 'string' ||
          !UUID.test(line.target) ||
          typeof line.amount !== 'string' ||
          !AMOUNT.test(line.amount)
        )
          return refused();
        return Object.freeze({
          applicationId: line.applicationId,
          target: line.target,
          amount: line.amount,
        });
      });
      if (
        new Set(applications.map((line) => line.target)).size !==
          applications.length ||
        new Set(applications.map((line) => line.applicationId)).size !==
          applications.length
      )
        return refused('openItem.duplicateLine');
      source = binding.source;
      readBackEntityId = binding.application.entityId;
    }
    if (request.readBackDefinition.sourceEntityId !== readBackEntityId)
      return refused();
    // The company is the STORED company of the source and of every target,
    // never an input (prior rule 3): a principal of one company naming
    // another company's records is decided for the records' company.
    const company = await withTrustedRequestTransaction(
      this.context.pool,
      request.context,
      async (client) => {
        await client.query('SET TRANSACTION READ ONLY');
        return withModuleRuntimeRole(client, async () => {
          const stored = async (item: ItemStorage, ids: readonly string[]) =>
            (
              await client.query<{ company: string }>(
                `SELECT ${item.company}::text AS company FROM ${item.table}
                  WHERE tenant_id=$1 AND environment_id=$2 AND record_id = ANY($3::uuid[])
                    AND archived_at IS NULL`,
                [request.context.tenantId, request.context.environmentId, ids],
              )
            ).rows.map((row) => row.company);
          const owner = await stored(this.#storage.item(source), [recordId]);
          if (owner.length !== 1) return refused('openItem.recordMissing');
          if (binding.bindingVersion === 'openItem.apply/v1') {
            const targets = await stored(
              this.#storage.item(binding.target),
              applications.map((line) => line.target),
            );
            if (targets.length !== applications.length)
              return refused('openItem.recordMissing');
            if (targets.some((value) => value !== owner[0]))
              return refused('openItem.companyMismatch');
          }
          return owner[0]!;
        });
      },
    );
    const readBackRecordId =
      binding.bindingVersion === 'openItem.issue/v1'
        ? recordId
        : applications[0]!.applicationId;
    const authorization: Authorization = Object.freeze({
      decisionInput: Object.freeze({ legalEntityId: company }),
      legalEntityReadScopeIds: Object.freeze([company]),
      readBackArguments: Object.freeze({
        [scope.operand.parameterId]: company,
        recordId: readBackRecordId,
      }),
    });
    this.#prepared.set(
      authorization,
      Object.freeze({
        request,
        binding,
        company,
        recordId,
        expectedRevision: input.expectedRevision,
        arguments: args,
        applications,
      }),
    );
    return authorization;
  }

  async execute(request: Execution): Promise<SemanticOperationResultEnvelope> {
    const prepared = this.#prepared.get(request.authorization);
    this.#prepared.delete(request.authorization);
    if (
      !prepared ||
      prepared.request.context !== request.context ||
      prepared.request.definition !== request.definition ||
      prepared.request.input !== request.input ||
      prepared.request.inputDigest !== request.inputDigest ||
      prepared.request.readBackDefinition !== request.readBackDefinition ||
      prepared.request.view !== request.view
    )
      return refused();
    // The person's confirmation: the gateway grant, verified here and
    // attested for the core, which consumes it first in the transaction.
    const grant = this.context.verifyConfirmation?.(
      request.view,
      request.definition,
      request.input,
      request.confirmationGrant ?? null,
    );
    const actor = await this.context.actorIssuer.issue(request.context);
    const human =
      actor.actor.approvingHumanId ??
      (actor.actor.executionPrincipal.kind === 'HUMAN'
        ? actor.actor.executionPrincipal.principalId
        : null);
    if (!this.context.approvalPool || !grant || !human)
      return refused('openItem.approvalRequired');
    await this.context.approvalPool.query(
      'SELECT platform.open_item_attest_approval($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
      [
        grant,
        this.capabilityId,
        request.context.tenantId,
        request.context.environmentId,
        request.context.principalId,
        human,
        request.view.release.releaseId,
        request.view.pointer.fence,
        request.definition.operationId,
        request.idempotencyKey,
        JSON.stringify(request.input),
        request.channel,
      ],
    );
    const binding = prepared.binding;
    const recordType =
      binding.bindingVersion === 'openItem.issue/v1'
        ? binding.item.entityId
        : binding.source.entityId;
    const trust = await new PostgresTrustService(
      this.context.pool,
    ).executeIdempotentAcceptedMutation<{
      readonly recordId: string;
      readonly revision: number;
    }>(
      request.context,
      actor,
      {
        actionId: request.definition.operationId,
        idempotencyKey: request.idempotencyKey,
        inputDigest: request.inputDigest,
        releaseContentHash: request.view.release.contentHash,
        releaseId: request.view.release.releaseId,
      },
      async (client) => {
        // Lock position 0: the grant, consumed once for this exact request.
        const consumed = await client.query<{ invocation: string }>(
          'SELECT platform.open_item_consume_grant($1,$2,$3,$4,$5,$6,$7,$8) AS invocation',
          [
            grant,
            this.capabilityId,
            request.view.release.releaseId,
            request.view.pointer.fence,
            request.definition.operationId,
            request.idempotencyKey,
            JSON.stringify(request.input),
            request.channel,
          ],
        );
        const invocationId = consumed.rows[0]?.invocation;
        if (typeof invocationId !== 'string' || !UUID.test(invocationId))
          throw new Error('open-item grant consumption returned no invocation');
        const applied =
          binding.bindingVersion === 'openItem.issue/v1'
            ? await this.#issue(client, request, prepared, binding, grant)
            : await this.#apply(client, request, prepared, binding);
        const metadata = {
          legalEntityId: {
            classification: 'INTERNAL' as const,
            value: prepared.company,
          },
          operationId: {
            classification: 'INTERNAL' as const,
            value: request.definition.operationId,
          },
          ...Object.fromEntries(
            Object.entries(applied.metadata).map(([key, value]) => [
              key,
              {
                classification: 'INTERNAL' as const,
                value: typeof value === 'string' ? value : [...value],
              },
            ]),
          ),
        };
        return {
          mutationResult: {
            recordId: prepared.recordId,
            revision: applied.revision,
          },
          command: {
            actionId: request.definition.operationId,
            causationId: null,
            channel: request.channel,
            correlationId: randomUUID(),
            // Minted by the grant's consumption, verified at commit.
            invocationId,
            metadata,
            releaseContentHash: request.view.release.contentHash,
            releaseId: request.view.release.releaseId,
            policy: {
              decision: 'ALLOW' as const,
              evaluatorVersion: request.policyEvaluatorVersion,
              policyVersion: request.policyVersion,
              relevantInputs: metadata,
              schemaVersion: POLICY_DECISION_EVIDENCE_VERSION,
            },
            change: {
              changeDocumentId: randomUUID(),
              recordId: prepared.recordId,
              recordType,
              revision: applied.revision,
              changes: applied.changes.map((change) => ({
                classification: 'INTERNAL' as const,
                fieldId: auditFieldId(change.fieldId),
                oldState:
                  change.before === null
                    ? { state: 'ABSENT' as const }
                    : { state: 'VALUE' as const, value: change.before },
                newState:
                  change.after === null
                    ? { state: 'ABSENT' as const }
                    : { state: 'VALUE' as const, value: change.after },
              })),
            },
            event: {
              eventId: randomUUID(),
              eventSchemaVersion: OPEN_ITEM_EVENT_SCHEMA_VERSION,
              eventType: request.definition.operationId.replace(
                ':operation.',
                ':event.',
              ),
              payload: metadata,
            },
            outbox: {
              outboxId: randomUUID(),
              deduplicationKey: `${request.definition.operationId}:${request.context.principalId}:${request.idempotencyKey}`,
            },
          },
        };
      },
    );
    let record: SemanticOperationResultEnvelope['readBack'] = null;
    const readBackId = (
      request.authorization.readBackArguments as { recordId: string }
    ).recordId;
    try {
      const result = await this.context.queryGateway.invoke(request.view, {
        schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
        queryId: request.readBackDefinition.queryId,
        arguments: request.authorization.readBackArguments,
      });
      record =
        result.records.find((row) => row.recordId === readBackId) ?? null;
    } catch (error) {
      if (!(error instanceof SemanticQueryPolicyDeniedError)) throw error;
    }
    return {
      kind: 'semanticOperationResult',
      schemaVersion: SEMANTIC_OPERATION_RESULT_VERSION,
      operationId: request.definition.operationId,
      outcome: 'succeeded',
      readBack: record,
      trust: {
        changeDocumentId: trust.changeDocumentId,
        domainEventId: trust.domainEventId,
        invocationId: trust.invocationId,
        outboxId: trust.outboxId,
      },
      unsupportedReason: null,
    };
  }

  /** One item row, locked; refused unless it is live in the prepared company. */
  async #lock(
    client: PoolClient,
    request: Execution,
    item: ItemStorage,
    company: string,
    recordId: string,
  ): Promise<Row> {
    const result = await client.query<Row>(
      `SELECT * FROM ${item.table}
        WHERE tenant_id=$1 AND environment_id=$2 AND record_id=$3
        FOR NO KEY UPDATE`,
      [request.context.tenantId, request.context.environmentId, recordId],
    );
    const row = result.rows[0];
    if (!row || row.archived_at !== null)
      return refused('openItem.recordMissing');
    if (String(row[unquote(item.company)]) !== company)
      return refused('openItem.companyMismatch');
    return row;
  }

  async #update(
    client: PoolClient,
    request: Execution,
    item: ItemStorage,
    recordId: string,
    revision: number,
    values: readonly (readonly [string, string | null])[],
  ): Promise<number> {
    const updated = await client.query<{ revision: string }>(
      `UPDATE ${item.table}
          SET ${values.map(([column], index) => `${column}=$${String(index + 5)}`).join(',')},
              revision=revision+1
        WHERE tenant_id=$1 AND environment_id=$2 AND record_id=$3 AND revision=$4
        RETURNING revision`,
      [
        request.context.tenantId,
        request.context.environmentId,
        recordId,
        revision,
        ...values.map(([, value]) => value),
      ],
    );
    if (updated.rows.length !== 1) return refused('openItem.recordChanged');
    return Number(updated.rows[0]!.revision);
  }

  async #issue(
    client: PoolClient,
    request: Execution,
    prepared: Prepared,
    binding: Extract<
      OpenItemOperationBinding,
      { bindingVersion: 'openItem.issue/v1' }
    >,
    grant: string,
  ): Promise<Applied> {
    const item = this.#storage.item(binding.item);
    const { scale, states } = binding.item;
    const stateColumn = item.column(binding.item.stateFieldId);
    // Header lock first; a line writer takes the header FOR SHARE before its
    // line (the parent guard), so the line set is frozen from here on, and
    // no line is ever locked after a header.
    const header = await withModuleRuntimeRole(client, async () => {
      const row = await this.#lock(
        client,
        request,
        item,
        prepared.company,
        prepared.recordId,
      );
      if (Number(row.revision) !== prepared.expectedRevision)
        return refused('openItem.recordChanged');
      if (row[unquote(stateColumn)] !== states.draft)
        return refused('openItem.notDraft');
      let total: bigint;
      if (item.lines) {
        const lines = await client.query<{
          record_id: string;
          revision: string;
          amount: string | null;
        }>(
          `SELECT record_id::text, revision::text, ${item.lines.amount}::text AS amount
             FROM ${item.lines.table}
            WHERE tenant_id=$1 AND environment_id=$2 AND ${item.lines.parent}=$3
              AND archived_at IS NULL
            ORDER BY record_id`,
          [
            request.context.tenantId,
            request.context.environmentId,
            prepared.recordId,
          ],
        );
        if (lines.rows.length === 0) return refused('openItem.noLines');
        if (
          openItemLineSetDigest(
            lines.rows.map((line) => ({
              recordId: line.record_id,
              revision: Number(line.revision),
            })),
          ) !== prepared.arguments.lineSetDigest
        )
          return refused('openItem.linesChanged');
        total = 0n;
        for (const line of lines.rows) {
          const amount = units(line.amount, scale);
          if (amount === null) return refused('openItem.lineAmountMissing');
          if (amount < 0n) return refused('openItem.lineNegative');
          total += amount;
        }
      } else {
        const amount = units(
          row[unquote(item.column(binding.item.amountFieldId!))] ?? null,
          scale,
        );
        if (amount === null) return refused('openItem.amountMissing');
        if (amount < 0n) return refused('openItem.amountNegative');
        total = amount;
      }
      // The figure the person previewed is the figure that is frozen.
      if (units(prepared.arguments.total, scale) !== total)
        return refused('openItem.totalChanged');
      return { row, total };
    });
    // Counter last: the number, drawn for this confirmed issue only.
    const numbered = await client.query<{ number: string }>(
      'SELECT platform.open_item_allocate_number($1,$2,$3,$4,$5,$6,$7) AS number',
      [
        grant,
        prepared.company,
        prepared.recordId,
        binding.item.number.sequenceId,
        binding.item.number.prefix,
        binding.item.number.minimumDigits,
        binding.item.number.start,
      ],
    );
    const number = numbered.rows[0]?.number;
    if (typeof number !== 'string') return refused('openItem.numberUnbound');
    const total = decimal(header.total, scale);
    const zero = decimal(0n, scale);
    const state = header.total === 0n ? states.settled : states.open;
    const figures: readonly (readonly [string, string])[] = [
      [binding.item.numberFieldId, number],
      [binding.item.subtotalFieldId, total],
      [binding.item.totalFieldId, total],
      [binding.item.appliedFieldId, zero],
      [binding.item.balanceFieldId, total],
      [binding.item.stateFieldId, state],
    ];
    const revision = await withModuleRuntimeRole(client, () =>
      this.#update(
        client,
        request,
        item,
        prepared.recordId,
        prepared.expectedRevision,
        figures.map(([fieldId, value]) => [item.column(fieldId), value]),
      ),
    );
    return {
      revision,
      changes: figures.map(([fieldId, after]) => {
        const before = header.row[unquote(item.column(fieldId))];
        return {
          fieldId,
          before:
            before === null || before === undefined ? null : String(before),
          after,
        };
      }),
      metadata: { number, total },
    };
  }

  async #apply(
    client: PoolClient,
    request: Execution,
    prepared: Prepared,
    binding: Extract<
      OpenItemOperationBinding,
      { bindingVersion: 'openItem.apply/v1' }
    >,
  ): Promise<Applied> {
    const source = this.#storage.item(binding.source);
    const target = this.#storage.item(binding.target);
    const applicationEntity = this.#storage.entity(
      binding.application.entityId,
    );
    const applicationTable = `north_star_module.${quote(applicationEntity.physicalTableName)}`;
    const sourceColumn = this.#storage.relation(
      applicationEntity,
      binding.application.sourceRelationId,
    );
    const targetColumn = this.#storage.relation(
      applicationEntity,
      binding.application.targetRelationId,
    );
    const amountColumn = this.#storage.column(
      applicationEntity,
      binding.application.amountFieldId,
    );
    const scale = binding.source.scale;
    const scope = [request.context.tenantId, request.context.environmentId];
    return withModuleRuntimeRole(client, async () => {
      // The counterparty lock (the core's own namespace), read from the
      // source before any row lock and re-checked under the row locks.
      const party = await client.query<{ party: string | null }>(
        `SELECT ${source.counterparty}::text AS party FROM ${source.table}
          WHERE tenant_id=$1 AND environment_id=$2 AND record_id=$3`,
        [...scope, prepared.recordId],
      );
      const counterparty = party.rows[0]?.party;
      if (typeof counterparty !== 'string')
        return refused('openItem.recordMissing');
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtextextended(
           'northstar.openitem:counterparty:' || $1::text || ':' || $2::text || ':' || $3::text || ':' || $4::text, 0))`,
        [...scope, prepared.company, counterparty],
      );
      // Every touched item, sorted by record ID, so one source across many
      // targets and two sources on one target never wait on each other in a
      // cycle. The second writer re-reads the balance the first committed.
      const touched = [
        { id: prepared.recordId, item: source },
        ...prepared.applications.map((line) => ({
          id: line.target,
          item: target,
        })),
      ].sort((left, right) =>
        left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
      );
      const rows = new Map<string, Row>();
      for (const { id, item } of touched)
        rows.set(
          id,
          await this.#lock(client, request, item, prepared.company, id),
        );
      const sourceRow = rows.get(prepared.recordId)!;
      if (Number(sourceRow.revision) !== prepared.expectedRevision)
        return refused('openItem.recordChanged');
      const live = (item: ItemStorage, row: Row) => {
        const state = row[unquote(item.column(item.binding.stateFieldId))];
        return (
          state === item.binding.states.open ||
          state === item.binding.states.partiallySettled
        );
      };
      // A draft source's amount is still editable, and a void or settled one
      // has nothing to give.
      if (!live(source, sourceRow)) return refused('openItem.sourceNotOpen');
      const currencyOf = (item: ItemStorage, row: Row) =>
        row[unquote(item.column(item.binding.currencyFieldId))];
      const partyOf = (item: ItemStorage, row: Row) =>
        String(row[unquote(item.counterparty)]);
      if (partyOf(source, sourceRow) !== counterparty)
        return refused('openItem.recordChanged');
      const figure = (item: ItemStorage, row: Row, fieldId: string) => {
        const value = units(row[unquote(item.column(fieldId))] ?? null, scale);
        if (value === null) return refused('openItem.figureMissing');
        return value;
      };
      let given = 0n;
      const updates: {
        id: string;
        item: ItemStorage;
        row: Row;
        moved: bigint;
      }[] = [];
      for (const line of prepared.applications) {
        const row = rows.get(line.target)!;
        if (!live(target, row)) return refused('openItem.targetNotOpen');
        if (partyOf(target, row) !== counterparty)
          return refused('openItem.counterpartyMismatch');
        if (currencyOf(target, row) !== currencyOf(source, sourceRow))
          return refused('openItem.currencyMismatch');
        const amount = units(line.amount, scale);
        if (amount === null || amount <= 0n)
          return refused('openItem.amountInvalid');
        if (amount > figure(target, row, binding.target.balanceFieldId))
          return refused('openItem.exceedsBalance');
        given += amount;
        updates.push({ id: line.target, item: target, row, moved: amount });
      }
      if (given > figure(source, sourceRow, binding.source.balanceFieldId))
        return refused('openItem.exceedsBalance');
      updates.push({
        id: prepared.recordId,
        item: source,
        row: sourceRow,
        moved: given,
      });
      // The application lines: append-only, one per target.
      for (const line of prepared.applications)
        await client.query(
          `INSERT INTO ${applicationTable}
             (tenant_id,environment_id,${quote(applicationEntity.legalEntity!.column)},record_id,revision,archived_at,
              ${sourceColumn},${targetColumn},${amountColumn})
           VALUES ($1,$2,$3,$4,1,NULL,$5,$6,$7::numeric)`,
          [
            ...scope,
            prepared.company,
            line.applicationId,
            prepared.recordId,
            line.target,
            decimal(units(line.amount, scale)!, scale),
          ],
        );
      await recordCreations(
        client,
        applicationEntity,
        prepared.company,
        prepared.applications.map((line) => line.applicationId),
      );
      let sourceRevision = 0;
      let sourceChanges: Change[] = [];
      for (const update of updates) {
        const b = update.item.binding;
        const appliedBefore = figure(update.item, update.row, b.appliedFieldId);
        const balanceBefore = figure(update.item, update.row, b.balanceFieldId);
        const applied = appliedBefore + update.moved;
        const balance = balanceBefore - update.moved;
        const stateBefore = String(
          update.row[unquote(update.item.column(b.stateFieldId))],
        );
        const state =
          balance === 0n ? b.states.settled : b.states.partiallySettled;
        const revision = await this.#update(
          client,
          request,
          update.item,
          update.id,
          Number(update.row.revision),
          [
            [update.item.column(b.appliedFieldId), decimal(applied, scale)],
            [update.item.column(b.balanceFieldId), decimal(balance, scale)],
            [update.item.column(b.stateFieldId), state],
          ],
        );
        if (update.id === prepared.recordId) {
          sourceRevision = revision;
          sourceChanges = [
            {
              fieldId: b.appliedFieldId,
              before: decimal(appliedBefore, scale),
              after: decimal(applied, scale),
            },
            {
              fieldId: b.balanceFieldId,
              before: decimal(balanceBefore, scale),
              after: decimal(balance, scale),
            },
            { fieldId: b.stateFieldId, before: stateBefore, after: state },
          ];
        }
      }
      // The gate observes the fact: each touched item's applied equals the
      // sum of its live application lines, re-read under the held locks.
      for (const update of updates) {
        const relationColumn =
          update.id === prepared.recordId ? sourceColumn : targetColumn;
        const sums = await client.query<{
          sum: string | null;
          applied: string | null;
        }>(
          `SELECT (SELECT coalesce(sum(${amountColumn}), 0)::text FROM ${applicationTable}
                    WHERE tenant_id=$1 AND environment_id=$2 AND ${relationColumn}=$3
                      AND archived_at IS NULL) AS sum,
                  (SELECT ${update.item.column(update.item.binding.appliedFieldId)}::text
                     FROM ${update.item.table}
                    WHERE tenant_id=$1 AND environment_id=$2 AND record_id=$3) AS applied`,
          [...scope, update.id],
        );
        const row = sums.rows[0];
        if (
          !row ||
          units(row.sum, scale) === null ||
          units(row.sum, scale) !== units(row.applied, scale)
        )
          return refused('openItem.appliedDiverged');
      }
      return {
        revision: sourceRevision,
        changes: sourceChanges,
        metadata: {
          targets: prepared.applications.map((line) => line.target),
          applications: prepared.applications.map((line) => line.applicationId),
          amount: decimal(given, scale),
        },
      };
    });
  }
}

const factory = (kind: Kind): PostgresCapabilityOperationExecutorFactory =>
  Object.freeze({
    capabilityId:
      kind === 'issue'
        ? OPEN_ITEM_ISSUE_CAPABILITY
        : OPEN_ITEM_APPLY_CAPABILITY,
    singleUseConfirmation: true,
    verificationRefusal: {
      code: 'SEMANTIC_OPERATION_INPUT_INVALID',
      reason: INVALID,
    },
    create(context: PostgresCapabilityOperationExecutorContext) {
      const storage = context.projection(PROJECTION_FAMILY_IDS.storageTarget)
        .payload as StorageTargetPayloadV1;
      if (storage.kind !== 'storageTargetPayload')
        throw new Error('open-item core expected the active storage target');
      return new OpenItemCapabilityExecutor(context, storage, kind);
    },
  });

/** The open-item core's two capabilities, each a general engine (rule 19). */
export const OPEN_ITEM_CAPABILITY_EXECUTOR_FACTORIES: readonly PostgresCapabilityOperationExecutorFactory[] =
  Object.freeze([factory('issue'), factory('apply')]);
