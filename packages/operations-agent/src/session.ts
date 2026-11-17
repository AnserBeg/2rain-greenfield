/**
 * One operations-agent session: the handler behind the five model-facing
 * tools (ADR-0009, plan §9.2). It holds no authority of its own. Reads enter
 * the query gateway; writes enter the operation gateway on channel `AGENT`
 * with the acting person's current authorization; read-back runs the
 * operation's declared query. Plans live in memory for the session.
 *
 * The model never supplies tenant, release, principal, permission, handler,
 * table, company, record identity for a create, expected revision,
 * idempotency key or confirmation grant: the host derives each of them here.
 */
import { createHash, randomUUID } from 'node:crypto';

import type { ComposedApplicationRuntime } from '../../postgres-provider/src/composed-application-runtime.js';
import type {
  ImmutableJsonValue,
  RequestRuntimeView,
} from '../../runtime/src/request-runtime-view.js';
import {
  evaluateRegisteredOperationPrecondition,
  SEMANTIC_OPERATION_REQUEST_VERSION,
  type RegisteredOperationDefinition,
} from '../../runtime/src/semantic-operation-gateway.js';
import {
  SEMANTIC_QUERY_REQUEST_VERSION,
  type SemanticRecordDto,
} from '../../runtime/src/semantic-query-gateway.js';
import { SHARED_LIST_QUERY_VERSION } from '../../runtime/src/list-behavior/index.js';

import {
  describeEffect,
  describePredicate,
  effectKind,
  isRecord,
  localName,
  matchId,
  operationContract,
  pinnedCatalog,
  queryContract,
  searchableText,
  type PinnedCatalog,
  type QueryCatalogEntry,
} from './catalog.js';
import {
  businessDayAt,
  declaredChoiceDefaults,
  declaredCurrencyDefault,
  type BusinessCalendar,
} from './business-context.js';
import { businessMapStructure, renderBusinessMap } from './business-map.js';
import type { OperationsAgentToolId } from './tools.js';

export type AgentRuntime = Pick<
  ComposedApplicationRuntime,
  'entry' | 'operationGateway' | 'operationMediation' | 'queryGateway'
>;

export interface PlanForApproval {
  readonly planId: string;
  readonly summary: string;
  readonly steps: readonly {
    readonly step: number;
    readonly operationId: string;
    readonly effect: string;
    readonly target: string;
    readonly confirmation: 'humanRequired' | 'none';
    readonly inputs: Readonly<Record<string, ImmutableJsonValue>>;
  }[];
}

/** The person's answer to a plan. The model never supplies it. */
export type PlanApprover = (plan: PlanForApproval) => Promise<boolean>;

export interface OperationsAgentSessionOptions {
  readonly runtime: AgentRuntime;
  /** Request headers that identify the acting person to the entry adapter. */
  readonly personHeaders: Readonly<Record<string, string>>;
  /** The company the person works in; injected wherever a contract asks. */
  readonly companyId: string;
  /** The company's declared time zone and business-day boundary (ADR-0018). */
  readonly businessCalendar?: BusinessCalendar;
  /** The instant "now" is read at; a test fixes it. */
  readonly clock?: () => Date;
  readonly approve: PlanApprover;
  readonly mintId?: () => string;
  /** Upper bound on one tool result's serialized size, in characters. */
  readonly maximumResultCharacters?: number;
}

/** The page the person is on, as the browser reports it: a claim, not a fact. */
export interface AgentScreen {
  readonly surfaceId: string;
  readonly recordId?: string | null;
}

export interface ToolOutcome {
  readonly content: ImmutableJsonValue;
  readonly isError: boolean;
}

export interface ToolCallRecord {
  readonly tool: string;
  readonly isError: boolean;
}

export interface ApprovalRecord {
  readonly planId: string;
  readonly approved: boolean;
  readonly steps: number;
}

type StepRef = string | { readonly fromStep: number };

interface PlanStep {
  readonly step: number;
  readonly operation: RegisteredOperationDefinition;
  readonly entity: string;
  /** Minted for a create; the named record otherwise. */
  readonly recordId: StepRef;
  readonly pinnedRevision: number | null;
  readonly values?: Readonly<Record<string, ImmutableJsonValue>>;
  readonly relations?: Readonly<Record<string, ImmutableJsonValue>>;
  readonly patch?: Readonly<Record<string, ImmutableJsonValue>>;
  readonly arguments?: ImmutableJsonValue;
}

interface StepResult {
  readonly step: number;
  readonly operationId: string;
  readonly outcome: 'succeeded' | 'unsupported' | 'failed' | 'not-run';
  readonly recordId: string | null;
  readonly revision: number | null;
  readonly values?: Readonly<Record<string, ImmutableJsonValue>>;
  readonly error?: string;
}

interface StoredPlan {
  readonly planId: string;
  readonly steps: readonly PlanStep[];
  readonly digest: string;
  status: 'approved' | 'declined' | 'executed' | 'failed';
  execution?: {
    readonly key: string;
    readonly results: readonly StepResult[];
  };
}

class ToolInputError extends Error {
  override name = 'ToolInputError';
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const hostOwnedKeys = new Set([
  'tenantId',
  'tenant',
  'releaseId',
  'release',
  'principalId',
  'principal',
  'permissionId',
  'handler',
  'table',
  'legalEntityId',
  'expectedRevision',
  'idempotencyKey',
  'confirmationGrant',
]);

export class OperationsAgentSession {
  readonly #options: OperationsAgentSessionOptions;
  readonly #plans = new Map<string, StoredPlan>();
  readonly #mint: () => string;
  /** Eligibility decisions by principal, policy version and release. */
  readonly #usable = new Map<string, Map<string, boolean>>();
  readonly toolCalls: ToolCallRecord[] = [];
  readonly approvals: ApprovalRecord[] = [];

  constructor(options: OperationsAgentSessionOptions) {
    this.#options = options;
    this.#mint = options.mintId ?? randomUUID;
  }

  /** Every plan this session executed, with its step results. */
  executedPlans(): readonly {
    planId: string;
    results: readonly StepResult[];
  }[] {
    return [...this.#plans.values()]
      .filter((plan) => plan.execution)
      .map((plan) => ({
        planId: plan.planId,
        results: plan.execution!.results,
      }));
  }

  async call(tool: string, input: unknown): Promise<ToolOutcome> {
    let outcome: ToolOutcome;
    try {
      if (!isRecord(input)) throw new ToolInputError('input must be an object');
      const content = await this.#dispatch(tool, input);
      outcome = { content: this.#bounded(content), isError: false };
    } catch (error) {
      outcome = {
        content: {
          error:
            error instanceof Error
              ? `${error.name}: ${error.message}`
              : String(error),
        },
        isError: true,
      };
    }
    this.toolCalls.push({ tool, isError: outcome.isError });
    return outcome;
  }

  #dispatch(
    tool: string,
    input: Record<string, ImmutableJsonValue>,
  ): Promise<ImmutableJsonValue> {
    switch (tool as OperationsAgentToolId) {
      case 'erp_discover':
        return this.#discover(input);
      case 'erp_query':
        return this.#query(input);
      case 'erp_plan':
        return this.#plan(input);
      case 'erp_execute':
        return this.#execute(input);
      case 'erp_verify':
        return this.#verify(input);
      default:
        throw new ToolInputError(`no such tool ${tool}`);
    }
  }

  #run<T>(work: (view: RequestRuntimeView) => Promise<T>): Promise<T> {
    return this.#options.runtime.entry.run(
      { headers: { ...this.#options.personHeaders } },
      work,
    );
  }

  /**
   * Whether the acting person may use an operation or query under current
   * authorization (plan §9.2.1), asked of the gateways' own eligibility
   * previews. Decisions are kept for one policy version, so a revoked grant is
   * asked again on the next call. A preview that fails withholds the id.
   */
  async #usableIds(
    view: RequestRuntimeView,
    catalog: PinnedCatalog,
  ): Promise<{ operations: Set<string>; queries: Set<string> }> {
    const key = `${view.principalId}|${view.entryPolicyVersion}|${view.release.releaseId}|${view.release.contentHash}`;
    let known = this.#usable.get(key);
    if (!known) {
      known = new Map();
      this.#usable.set(key, known);
    }
    const company = this.#options.companyId;
    const { operationGateway, queryGateway } = this.#options.runtime;
    const pending: (() => Promise<void>)[] = [];
    for (const operation of catalog.operations) {
      const id = `operation|${operation.operationId}`;
      if (!known.has(id))
        pending.push(async () => {
          known.set(
            id,
            await operationGateway
              .previewTaskEligibility(
                view as never,
                [operation.operationId],
                company,
              )
              .then((answer) => answer === 'eligible')
              .catch(() => false),
          );
        });
    }
    for (const query of catalog.queries) {
      const id = `query|${query.queryId}`;
      if (!known.has(id))
        pending.push(async () => {
          known.set(
            id,
            await queryGateway
              .previewEligibility(view as never, query.queryId, company)
              .then((answer) => answer === 'eligible')
              .catch(() => false),
          );
        });
    }
    for (let at = 0; at < pending.length; at += 8)
      await Promise.all(pending.slice(at, at + 8).map((check) => check()));
    return {
      operations: new Set(
        catalog.operations
          .filter((op) => known.get(`operation|${op.operationId}`))
          .map((op) => op.operationId),
      ),
      queries: new Set(
        catalog.queries
          .filter((query) => known.get(`query|${query.queryId}`))
          .map((query) => query.queryId),
      ),
    };
  }

  /** Business date, currency and screen defaults, as context reports them. */
  #facts(view: RequestRuntimeView): Record<string, ImmutableJsonValue> {
    const calendar = this.#options.businessCalendar;
    const now = (this.#options.clock ?? (() => new Date()))();
    const today = calendar ? businessDayAt(now, calendar) : null;
    const currency = declaredCurrencyDefault(view);
    return {
      today:
        today && calendar
          ? {
              date: today.date,
              asDateTime: today.asDateTime,
              now: now.toISOString(),
              timeZone: calendar.timeZone,
              businessDayBoundary: calendar.businessDayBoundary,
              use: 'This is the company\'s business date. "Today" means this date and "yesterday" the day before; write a calendar-date field as the midnight-UTC instant asDateTime shows for that date, but a field for the moment something is posted or happens (an effective or posting time, a shipment, a receipt) as now: a posting dated midnight can fall before stock that arrived today.',
            }
          : {
              date: null,
              use: "The company's business date is not available to you. Do not guess today's date: use a date the person gives, and otherwise leave an optional date out or ask.",
            },
      currency: {
        default: currency.code,
        offered: [...currency.offered],
        use:
          currency.code === null
            ? 'No company default currency is declared. Use a currency the person names or the customer or supplier record you resolved carries; if there is none anywhere, do not invent one.'
            : 'A customer or supplier record carrying its own default currency takes precedence over default, which applies when it has none or the person names none. Use only a code the person named or one of these.',
      },
      formDefaults: {
        values: { ...declaredChoiceDefaults(view) },
        use: 'What the screens pre-select when nobody chooses, by form field or input name (for example invoice_method, the payment method). When the person did not give such a value and no record you resolved holds one, use this default instead of asking.',
      },
    };
  }

  /**
   * The business map for the acting person: the release's record types,
   * states, operations, queries and screen recipes, filtered to what the
   * person may use now. The unfiltered structure is cached by release root;
   * the filtered text is built per call and never shared.
   */
  businessMap(): Promise<string> {
    return this.#run(async (view) => {
      const catalog = pinnedCatalog(view);
      const usable = await this.#usableIds(view, catalog);
      return renderBusinessMap(businessMapStructure(view), usable);
    });
  }

  /**
   * What changes between sessions and turns, kept out of the cached prompt:
   * the business date and now, the default currency, the screens' defaults,
   * and the screen the person is on. A screen is named only when the release
   * declares it; its record id is the page's claim until read.
   */
  turnContext(screen?: AgentScreen | null): Promise<string> {
    return this.#run((view) => {
      const facts = this.#facts(view);
      const lines = [`Context (JSON): ${JSON.stringify(facts)}`];
      const named = screen ? screenFacts(view, screen) : null;
      if (named) lines.push(named);
      return Promise.resolve(lines.join('\n'));
    });
  }

  // ---------------------------------------------------------------- discover

  #discover(
    input: Record<string, ImmutableJsonValue>,
  ): Promise<ImmutableJsonValue> {
    return this.#run(async (view) => {
      const catalog = pinnedCatalog(view);
      const usable = await this.#usableIds(view, catalog);
      const operations = catalog.operations.filter((op) =>
        usable.operations.has(op.operationId),
      );
      const queries = catalog.queries.filter((query) =>
        usable.queries.has(query.queryId),
      );
      const mode = input.mode;
      const limit = boundedInteger(input.limit, 15, 30);
      const offset = cursorOffset(input.cursor);
      if (mode === 'context') {
        const entities = [
          ...new Set(operations.map((op) => catalog.operationEntity(op))),
        ]
          .filter(Boolean)
          .map(localName)
          .sort();
        return {
          mode,
          ...this.#facts(view),
          actingAs:
            'the signed-in person, with their current permissions, on channel AGENT',
          company: 'one company, supplied by the host',
          operations: operations.length,
          queries: queries.length,
          entities,
          howTo:
            'search finds operation and query ids; contracts loads up to 5 full contracts; resolve turns a name or number into a record id. Writes go through a plan the person approves.',
        };
      }
      if (mode === 'search') {
        const text = requiredText(input.search, 'search');
        const terms = text
          .toLowerCase()
          .split(/[^a-z0-9]+/u)
          .filter((term) => term.length > 1);
        const scored = [
          ...operations.map((op) => ({
            id: op.operationId,
            kind: 'operation' as const,
            text: searchableText(op.operationId, op.label),
            summary: {
              id: op.operationId,
              kind: 'operation',
              ...(op.label ? { label: op.label } : {}),
              effect: effectKind(op).replace(/Effect$/u, ''),
            },
          })),
          ...queries.map((query) => ({
            id: query.queryId,
            kind: 'query' as const,
            text: searchableText(query.queryId),
            summary: {
              id: query.queryId,
              kind: 'query',
              type: query.queryType,
            },
          })),
        ]
          .map((entry) => ({
            ...entry,
            score: terms.filter((term) => entry.text.includes(term)).length,
          }))
          .filter((entry) => entry.score > 0)
          .sort(
            (left, right) =>
              right.score - left.score || left.id.localeCompare(right.id),
          );
        const page = scored.slice(offset, offset + limit);
        const deleteAsked = terms.some((term) =>
          ['delete', 'remove', 'purge', 'erase', 'destroy'].includes(term),
        );
        return {
          mode,
          outcome: scored.length === 0 ? 'unsupported' : 'matches',
          results: page.map((entry) => entry.summary),
          ...(offset + limit < scored.length
            ? { nextCursor: String(offset + limit) }
            : {}),
          ...(deleteAsked
            ? {
                note: 'No operation deletes business records; none is registered. Archive, cancel and close are different operations with their own effects.',
              }
            : {}),
          ...(scored.length === 0
            ? {
                reason:
                  'no registered operation or query you may use matches; the capability may not exist in this release, or you may lack permission for it',
              }
            : {}),
        };
      }
      if (mode === 'contracts') {
        const ids = stringList(input.canonicalIds, 'canonicalIds').slice(0, 5);
        return {
          mode,
          contracts: ids.map((id) => {
            const operation = catalog.operation(id);
            if (operation)
              return usable.operations.has(id)
                ? operationContract(catalog, operation)
                : { id, outcome: 'denied' };
            const query = catalog.query(id);
            if (query)
              return usable.queries.has(id)
                ? queryContract(catalog, query)
                : { id, outcome: 'denied' };
            return { id, outcome: 'not-found' };
          }),
        };
      }
      if (mode === 'resolve') {
        const text = requiredText(input.search, 'search');
        const [entityHint] = stringList(input.canonicalIds, 'canonicalIds');
        if (!entityHint)
          throw new ToolInputError(
            'resolve needs canonicalIds: [the entity id or its local name]',
          );
        const entity = localName(entityHint).replace(
          /_(?:list|resolve|search|get)$/u,
          '',
        );
        const query =
          queries.find(
            (candidate) =>
              candidate.queryId === `northstar.app:query.${entity}_resolve`,
          ) ??
          queries.find(
            (candidate) =>
              localName(candidate.sourceEntityId) === entity &&
              candidate.queryType === 'resolve',
          );
        const list = queries.find(
          (candidate) =>
            localName(candidate.sourceEntityId) === entity &&
            candidate.queryType === 'list' &&
            localName(candidate.queryId) === `${entity}_list`,
        );
        if (!query && !list)
          return {
            mode,
            outcome: 'unsupported',
            reason: `no resolver for ${entity} that you may use`,
          };
        if (query) {
          const result = await this.#options.runtime.queryGateway.invoke(view, {
            schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
            queryId: query.queryId,
            arguments: withScope(query, { text }, this.#options.companyId),
          });
          if (result.records.length > 0 || !list)
            return {
              mode,
              queryId: query.queryId,
              outcome: result.outcome,
              candidates: result.records
                .slice(0, limit)
                .map((record) => compactRecord(record)),
            };
        }
        const listed = await this.#list(view, list!, { search: text }, 10);
        return {
          mode,
          queryId: list!.queryId,
          outcome:
            listed.records.length === 1
              ? 'exact'
              : listed.records.length === 0
                ? 'not-found'
                : 'ambiguous',
          candidates: listed.records.map((record) => compactRecord(record)),
        };
      }
      throw new ToolInputError(
        'mode must be one of context, search, contracts, resolve',
      );
    });
  }

  // ------------------------------------------------------------------- query

  #query(
    input: Record<string, ImmutableJsonValue>,
  ): Promise<ImmutableJsonValue> {
    return this.#run(async (view) => {
      const catalog = pinnedCatalog(view);
      const asked = requiredText(input.queryId, 'queryId');
      const query = catalog.query(asked);
      if (!query)
        return {
          queryId: asked,
          outcome: 'unsupported',
          reason: 'no registered query has this id in the pinned release',
        };
      const queryId = query.queryId;
      const args = isRecord(input.arguments) ? input.arguments : {};
      for (const key of Object.keys(args))
        if (hostOwnedKeys.has(key))
          throw new ToolInputError(`${key} is supplied by the host`);
      const limit = boundedInteger(input.limit, 25, 100);
      const selection = Array.isArray(input.selection)
        ? input.selection.filter((id): id is string => typeof id === 'string')
        : null;
      if (query.queryType === 'aggregate') {
        const result = await this.#options.runtime.queryGateway.invokeAggregate(
          view,
          {
            schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
            queryId,
            arguments: withScope(
              query,
              declaredOnly(query, args),
              this.#options.companyId,
            ),
          },
        );
        return {
          queryId,
          outcome: result.outcome,
          value: canonicalDecimal(result.value.value),
        };
      }
      if (query.queryType === 'list') {
        const listed = await this.#list(
          view,
          query,
          {
            ...(typeof args.search === 'string' ? { search: args.search } : {}),
            ...(typeof args.view === 'string' ? { view: args.view } : {}),
            ...(Array.isArray(args.filters) ? { filters: args.filters } : {}),
            ...(isRecord(args.parent) ? { parent: args.parent } : {}),
            ...(typeof input.cursor === 'string'
              ? { cursor: input.cursor }
              : {}),
          },
          limit,
          catalog,
        );
        return {
          queryId,
          outcome: listed.records.length === 0 ? 'not-found' : 'exact',
          records: listed.records.map((record) =>
            compactRecord(record, selection),
          ),
          ...(listed.nextCursor ? { nextCursor: listed.nextCursor } : {}),
        };
      }
      const argumentsForType =
        query.queryType === 'get'
          ? { recordId: requiredText(args.recordId, 'arguments.recordId') }
          : query.queryType === 'search' || query.queryType === 'resolve'
            ? { text: requiredText(args.text, 'arguments.text') }
            : declaredOnly(query, args);
      const result = await this.#options.runtime.queryGateway.invoke(view, {
        schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
        queryId,
        arguments: withScope(query, argumentsForType, this.#options.companyId),
      });
      return {
        queryId,
        outcome: result.outcome,
        records: result.records
          .slice(0, limit)
          .map((record) => compactRecord(record, selection)),
        ...(result.records.length > limit ? { truncated: true } : {}),
        ...(result.unsupportedReason
          ? { reason: result.unsupportedReason }
          : {}),
      };
    });
  }

  async #list(
    view: RequestRuntimeView,
    query: QueryCatalogEntry,
    request: {
      search?: string;
      view?: string;
      filters?: readonly ImmutableJsonValue[];
      parent?: Record<string, ImmutableJsonValue>;
      cursor?: string;
    },
    limit: number,
    catalog: PinnedCatalog = pinnedCatalog(view),
  ): Promise<{
    records: readonly SemanticRecordDto[];
    nextCursor: string | null;
  }> {
    const presetView = request.view
      ? catalog.preset(query.queryId)?.views?.find(
          (candidate) =>
            candidate.viewId ===
            matchId(
              request.view!,
              (catalog.preset(query.queryId)?.views ?? []).map(
                (view) => view.viewId,
              ),
              localName(query.queryId),
            ),
        )
      : undefined;
    if (request.view && !presetView)
      throw new ToolInputError(`no view ${request.view} on ${query.queryId}`);
    const filters = [
      ...(presetView?.fieldFilters ?? []),
      ...(request.filters ?? []).map((filter) => {
        if (
          !isRecord(filter) ||
          typeof filter.fieldId !== 'string' ||
          (typeof filter.value !== 'string' && typeof filter.value !== 'number')
        )
          throw new ToolInputError('a filter is {"fieldId", "value"}');
        return {
          fieldId:
            matchId(
              filter.fieldId,
              query.selections.map((selection) => selection.fieldId),
              localName(query.sourceEntityId),
            ) ?? filter.fieldId,
          value: String(filter.value),
        };
      }),
    ];
    if (filters.length > 4)
      throw new ToolInputError('at most four exact filters');
    const parent = request.parent
      ? {
          relationId: ((asked: string) =>
            matchId(
              asked,
              relationIds(catalog),
              localName(query.sourceEntityId),
            ) ?? asked)(
            requiredText(request.parent.relationId, 'parent.relationId'),
          ),
          recordId: requiredText(request.parent.recordId, 'parent.recordId'),
        }
      : null;
    const result = await this.#options.runtime.queryGateway.invoke(view, {
      schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
      queryId: query.queryId,
      arguments: withScope(
        query,
        {
          includeArchived: false,
          list: {
            cursor: request.cursor ?? null,
            matchMode: 'substring',
            pageSize: limit,
            relationLabels: [],
            schemaVersion: SHARED_LIST_QUERY_VERSION,
            search: request.search ?? '',
            sort: [],
            ...(filters.length > 0 ? { fieldFilters: filters } : {}),
            ...(parent ? { parentScope: parent } : {}),
          },
        },
        this.#options.companyId,
      ),
    });
    return {
      records: result.records,
      nextCursor: result.listCoverage?.nextCursor ?? null,
    };
  }

  // -------------------------------------------------------------------- plan

  #plan(
    input: Record<string, ImmutableJsonValue>,
  ): Promise<ImmutableJsonValue> {
    if (
      input.requestedBulkMode !== undefined &&
      input.requestedBulkMode !== null
    )
      throw new ToolInputError('bulk plans are not supported in this release');
    if (!Array.isArray(input.intents) || input.intents.length === 0)
      throw new ToolInputError('intents must be a non-empty array');
    if (input.intents.length > 12)
      throw new ToolInputError('at most 12 steps in one plan');
    const intents = input.intents;
    return this.#run(async (view) => {
      const catalog = pinnedCatalog(view);
      const steps: PlanStep[] = [];
      const checks: ImmutableJsonValue[] = [];
      for (const [index, intent] of intents.entries()) {
        const step = index + 1;
        if (!isRecord(intent))
          throw new ToolInputError(
            `step ${String(step)}: intent must be an object`,
          );
        const operationId = requiredText(
          intent.operationId,
          `step ${String(step)} operationId`,
        );
        const operation = catalog.operation(operationId);
        if (!operation)
          return {
            outcome: 'unsupported',
            step,
            operationId,
            reason:
              'no active registered operation has this id; the plan was not created',
          };
        const built = await this.#planStep(
          view,
          catalog,
          operation,
          intent,
          step,
        );
        steps.push(built.step);
        checks.push(built.check);
        if (built.refused)
          return {
            outcome: 'refused',
            step,
            operationId,
            reason: built.refused,
            note: 'nothing was written; the plan was not created',
          };
      }
      const planId = this.#mint();
      const digest = planDigest(steps);
      const presentation: PlanForApproval = {
        planId,
        summary: `${String(steps.length)} step(s)`,
        steps: steps.map((step) => ({
          step: step.step,
          operationId: step.operation.operationId,
          effect: describeEffect(step.operation, step.entity),
          target: refText(step.recordId),
          confirmation: step.operation.confirmation,
          inputs: {
            ...(step.values ? { values: step.values } : {}),
            ...(step.relations ? { relations: step.relations } : {}),
            ...(step.patch ? { patch: step.patch } : {}),
            ...(step.arguments !== undefined
              ? { arguments: step.arguments }
              : {}),
          },
        })),
      };
      const approved = await this.#options.approve(presentation);
      this.approvals.push({ planId, approved, steps: steps.length });
      this.#plans.set(planId, {
        planId,
        steps,
        digest,
        status: approved ? 'approved' : 'declined',
      });
      return {
        planId,
        approval: approved
          ? 'approved by the person'
          : 'declined by the person',
        steps: presentation.steps.map((step, index) => ({
          ...step,
          precondition: checks[index] ?? null,
          readBackQueryId: steps[index]!.operation.readBackQueryId,
        })),
        ...(approved
          ? {
              next: 'call erp_execute with this planId and a fresh executionIdempotencyKey',
            }
          : { next: 'do not execute; ask the person what to change' }),
      };
    });
  }

  async #planStep(
    view: RequestRuntimeView,
    catalog: PinnedCatalog,
    operation: RegisteredOperationDefinition,
    intent: Record<string, ImmutableJsonValue>,
    step: number,
  ): Promise<{ step: PlanStep; check: ImmutableJsonValue; refused?: string }> {
    const where = `step ${String(step)} (${localName(operation.operationId)})`;
    const contract = operation.inputContract;
    const keys = new Set(contract?.closedArgumentKeys ?? []);
    for (const key of Object.keys(intent))
      if (hostOwnedKeys.has(key))
        throw new ToolInputError(`${where}: ${key} is supplied by the host`);
    for (const key of ['values', 'relations', 'patch', 'arguments'])
      if (intent[key] !== undefined && intent[key] !== null && !keys.has(key))
        throw new ToolInputError(`${where}: this operation takes no ${key}`);
    const fields = new Map(
      (contract?.fields ?? []).map((field) => [field.fieldId, field]),
    );
    const prefix = localName(catalog.operationEntity(operation));
    const assigned = new Set(
      contract?.assignedFields?.map((field) => field.fieldId) ?? [],
    );
    const normalize = (
      bag: ImmutableJsonValue | undefined,
      name: 'values' | 'patch',
    ): Record<string, ImmutableJsonValue> | undefined => {
      if (bag === undefined || bag === null) return undefined;
      if (!isRecord(bag))
        throw new ToolInputError(`${where}: ${name} must be an object`);
      const out: Record<string, ImmutableJsonValue> = {};
      for (const [asked, raw] of Object.entries(bag)) {
        const fieldId = matchId(asked, fields.keys(), prefix) ?? asked;
        const field = fields.get(fieldId);
        if (!field || assigned.has(fieldId))
          throw new ToolInputError(
            `${where}: ${asked} is not a writable field of this operation`,
          );
        out[fieldId] = normalizeValue(
          typeof raw === 'string' && field.enumOptionIds.length > 0
            ? (matchId(raw, field.enumOptionIds, localName(fieldId)) ?? raw)
            : raw,
          field.fieldKind,
          field.enumOptionIds,
          step,
          `${where} ${fieldId}`,
        );
      }
      return out;
    };
    const values = normalize(intent.values, 'values');
    const patch = normalize(intent.patch, 'patch');
    if (keys.has('values')) {
      const missing = [...fields.values()]
        .filter(
          (field) =>
            field.required &&
            !assigned.has(field.fieldId) &&
            (values?.[field.fieldId] === undefined ||
              values[field.fieldId] === null),
        )
        .map((field) => field.fieldId);
      if (missing.length > 0)
        throw new ToolInputError(
          `${where}: required fields missing: ${missing.join(', ')}`,
        );
    }
    let relations: Record<string, ImmutableJsonValue> | undefined;
    if (keys.has('relations')) {
      const declared = new Map(
        (contract?.relationInputs ?? []).map((relation) => [
          relation.relationId,
          relation,
        ]),
      );
      const given = isRecord(intent.relations) ? intent.relations : {};
      relations = {};
      for (const [asked, raw] of Object.entries(given)) {
        const relationId = matchId(asked, declared.keys(), prefix) ?? asked;
        if (!declared.has(relationId))
          throw new ToolInputError(
            `${where}: ${asked} is not a relation of this operation`,
          );
        relations[relationId] = refValue(raw, step, `${where} ${relationId}`);
      }
      const missing = [...declared.values()]
        .filter(
          (relation) =>
            relation.required && !(relation.relationId in relations!),
        )
        .map((relation) => relation.relationId);
      if (missing.length > 0)
        throw new ToolInputError(
          `${where}: required relations missing: ${missing.join(', ')}`,
        );
    }
    const entity = catalog.operationEntity(operation);
    const base = {
      step,
      operation,
      entity,
      ...(values ? { values } : {}),
      ...(relations ? { relations } : {}),
      ...(patch ? { patch } : {}),
      ...(intent.arguments !== undefined && intent.arguments !== null
        ? { arguments: intent.arguments }
        : {}),
    };
    if (!keys.has('expectedRevision')) {
      if (intent.target !== undefined && intent.target !== null)
        throw new ToolInputError(
          `${where}: a create takes no target; the host mints the record id`,
        );
      return {
        step: { ...base, recordId: this.#mint(), pinnedRevision: null },
        check: 'none (creates a new record)',
      };
    }
    const target = refValue(intent.target, step, `${where} target`);
    if (typeof target !== 'string')
      return {
        step: { ...base, recordId: target as StepRef, pinnedRevision: null },
        check: `${describePredicate(operation.precondition)}; checked at execution against the record step ${String((target as { fromStep: number }).fromStep)} produces`,
      };
    const record = await readRecord(
      this.#options.runtime,
      view,
      catalog,
      operation.readBackQueryId,
      target,
      this.#options.companyId,
    );
    if (!record)
      throw new ToolInputError(
        `${where}: no ${localName(entity)} ${target} is visible to the person`,
      );
    const evaluation = evaluateRegisteredOperationPrecondition(
      operation.precondition,
      record.values,
    );
    const check = `${describePredicate(operation.precondition)}: ${evaluation.outcome}`;
    return {
      step: { ...base, recordId: target, pinnedRevision: record.revision },
      check,
      ...(evaluation.outcome === 'refused'
        ? {
            refused: `the declared precondition does not hold for this record (${describePredicate(operation.precondition)})`,
          }
        : {}),
    };
  }

  // ----------------------------------------------------------------- execute

  async #execute(
    input: Record<string, ImmutableJsonValue>,
  ): Promise<ImmutableJsonValue> {
    const planId = requiredText(input.planId, 'planId');
    const key = requiredText(
      input.executionIdempotencyKey,
      'executionIdempotencyKey',
    );
    const plan = this.#plans.get(planId);
    if (!plan) throw new ToolInputError(`no plan ${planId} in this session`);
    if (plan.execution) {
      if (plan.execution.key !== key)
        throw new ToolInputError(
          'this plan was already executed under another key; plan again to repeat it',
        );
      return executionReport(plan);
    }
    if (plan.status !== 'approved')
      throw new ToolInputError(
        'the person did not approve this plan; it cannot run',
      );
    if (planDigest(plan.steps) !== plan.digest)
      throw new ToolInputError(
        'the plan changed after approval; it cannot run',
      );
    const results: StepResult[] = [];
    const latestRevision = new Map<string, number>();
    let stopped = false;
    for (const step of plan.steps) {
      if (stopped) {
        results.push({
          step: step.step,
          operationId: step.operation.operationId,
          outcome: 'not-run',
          recordId: null,
          revision: null,
        });
        continue;
      }
      try {
        const recordId = resolveRef(step.recordId, results);
        const keys = new Set(
          step.operation.inputContract?.closedArgumentKeys ?? [],
        );
        const operationInput: Record<string, ImmutableJsonValue> = {
          recordId,
          ...(keys.has('legalEntityId')
            ? { legalEntityId: this.#options.companyId }
            : {}),
          ...(keys.has('expectedRevision')
            ? {
                expectedRevision:
                  latestRevision.get(recordId) ?? step.pinnedRevision ?? 1,
              }
            : {}),
          ...(step.values ? { values: resolveRefs(step.values, results) } : {}),
          ...(keys.has('relations')
            ? { relations: resolveRefs(step.relations ?? {}, results) }
            : {}),
          ...(step.patch ? { patch: resolveRefs(step.patch, results) } : {}),
          ...(step.arguments !== undefined
            ? { arguments: step.arguments }
            : {}),
        };
        const result = await this.#run((view) =>
          this.#options.runtime.operationGateway.invoke(
            view,
            {
              schemaVersion: SEMANTIC_OPERATION_REQUEST_VERSION,
              operationId: step.operation.operationId,
              input: operationInput,
              idempotencyKey: derivedKey(planId, key, step.step),
              confirmationGrant:
                step.operation.confirmation === 'humanRequired'
                  ? this.#options.runtime.operationMediation.issueConfirmationGrant(
                      view,
                      step.operation.operationId,
                      operationInput,
                    )
                  : null,
            },
            this.#options.runtime.operationMediation.issueInvocation(
              view,
              'AGENT',
            ),
          ),
        );
        if (result.outcome !== 'succeeded') {
          stopped = true;
          results.push({
            step: step.step,
            operationId: step.operation.operationId,
            outcome: 'unsupported',
            recordId,
            revision: null,
            error: result.unsupportedReason ?? 'unsupported',
          });
          continue;
        }
        if (result.readBack)
          latestRevision.set(
            result.readBack.recordId,
            result.readBack.revision,
          );
        results.push({
          step: step.step,
          operationId: step.operation.operationId,
          outcome: 'succeeded',
          recordId: result.readBack?.recordId ?? recordId,
          revision: result.readBack?.revision ?? null,
          ...(result.readBack
            ? { values: compactValues(result.readBack.values) }
            : {}),
        });
      } catch (error) {
        stopped = true;
        results.push({
          step: step.step,
          operationId: step.operation.operationId,
          outcome: 'failed',
          recordId: null,
          revision: null,
          error:
            error instanceof Error
              ? `${error.name}: ${error.message}`
              : String(error),
        });
      }
    }
    plan.execution = { key, results };
    plan.status = stopped ? 'failed' : 'executed';
    return executionReport(plan);
  }

  // ------------------------------------------------------------------ verify

  async #verify(
    input: Record<string, ImmutableJsonValue>,
  ): Promise<ImmutableJsonValue> {
    const planId = requiredText(
      input.operationSessionId ?? input.planId,
      'operationSessionId',
    );
    const plan = this.#plans.get(planId);
    if (!plan?.execution)
      throw new ToolInputError(`no executed plan ${planId} in this session`);
    const execution = plan.execution;
    return this.#run(async (view) => {
      const catalog = pinnedCatalog(view);
      const checks: ImmutableJsonValue[] = [];
      for (const step of plan.steps) {
        const result = execution.results.find(
          (entry) => entry.step === step.step,
        )!;
        if (result.outcome !== 'succeeded' || !result.recordId) {
          checks.push({
            step: step.step,
            verified: false,
            reason: `step ${result.outcome}`,
          });
          continue;
        }
        const record = await readRecord(
          this.#options.runtime,
          view,
          catalog,
          step.operation.readBackQueryId,
          result.recordId,
          this.#options.companyId,
        );
        const mismatches: string[] = [];
        if (!record) mismatches.push('the declared read-back finds no record');
        else {
          if (result.revision !== null && record.revision < result.revision)
            mismatches.push('revision is older than the execution returned');
          const effect = (
            step.operation as unknown as {
              effect: Record<string, unknown>;
            }
          ).effect;
          if (
            effect.kind === 'transitionStateEffect' &&
            record.values[String(effect.stateFieldId)] !== effect.toStateId
          )
            mismatches.push(
              `state is not ${localName(String(effect.toStateId))}`,
            );
          // A later step of this plan that acted on the same record (a post
          // after a create) legitimately changed it; its own read-back is
          // checked in its own row.
          const changedLater = execution.results.some(
            (later) =>
              later.step > step.step && later.recordId === result.recordId,
          );
          for (const [fieldId, expected] of changedLater
            ? []
            : Object.entries(step.values ?? {})) {
            const resolved = resolveRefs({ v: expected }, execution.results).v;
            if (
              resolved !== null &&
              resolved !== undefined &&
              fieldId in record.values &&
              !sameValue(record.values[fieldId], resolved)
            )
              mismatches.push(`${fieldId} reads back differently`);
          }
        }
        checks.push({
          step: step.step,
          readBackQueryId: step.operation.readBackQueryId,
          recordId: result.recordId,
          verified: mismatches.length === 0,
          ...(mismatches.length > 0 ? { mismatches } : {}),
          ...(record ? { observed: compactValues(record.values) } : {}),
        });
      }
      return {
        operationSessionId: planId,
        verified: checks.every(
          (check) => isRecord(check) && check.verified === true,
        ),
        steps: checks,
      };
    });
  }

  #bounded(content: ImmutableJsonValue): ImmutableJsonValue {
    const limit = this.#options.maximumResultCharacters ?? 16_000;
    const text = JSON.stringify(content);
    if (text.length <= limit) return content;
    if (isRecord(content) && Array.isArray(content.records)) {
      const records = [...content.records];
      while (
        records.length > 1 &&
        JSON.stringify({ ...content, records }).length > limit
      )
        records.pop();
      return { ...content, records, truncated: true };
    }
    return {
      truncated: true,
      note: 'the result was too large; narrow the request (selection, filters, limit)',
      preview: text.slice(0, limit - 200),
    };
  }
}

// ------------------------------------------------------------------ helpers

/** The screen in words, only when the pinned release declares that surface. */
function screenFacts(
  view: RequestRuntimeView,
  screen: AgentScreen,
): string | null {
  const surfaces =
    (
      view.projections.surface.payload as unknown as {
        surfaces?: readonly {
          surfaceId: string;
          label?: string;
          archetype?: string;
          dataSourceQueryId?: string;
        }[];
      }
    ).surfaces ?? [];
  const surface = surfaces.find(
    (candidate) => candidate.surfaceId === screen.surfaceId,
  );
  if (!surface) return null;
  const catalog = pinnedCatalog(view);
  const entity = surface.dataSourceQueryId
    ? catalog.query(surface.dataSourceQueryId)?.sourceEntityId
    : undefined;
  const record =
    typeof screen.recordId === 'string' && uuidPattern.test(screen.recordId)
      ? screen.recordId
      : null;
  return `Screen: the person is on "${surface.label ?? localName(surface.surfaceId)}" (${surface.archetype ?? 'page'}${entity ? `, ${localName(entity)}` : ''})${record ? `, showing record ${record}; "this", "it" and "here" mean that record` : ''}.`;
}

const relationIdSets = new WeakMap<PinnedCatalog, readonly string[]>();

/** Every relation id an operation of the release declares. */
function relationIds(catalog: PinnedCatalog): readonly string[] {
  let ids = relationIdSets.get(catalog);
  if (!ids) {
    ids = [
      ...new Set(
        catalog.operations.flatMap((operation) =>
          (operation.inputContract?.relationInputs ?? []).map(
            (relation) => relation.relationId,
          ),
        ),
      ),
    ];
    relationIdSets.set(catalog, ids);
  }
  return ids;
}

function executionReport(plan: StoredPlan): ImmutableJsonValue {
  const results = plan.execution!.results;
  return {
    operationSessionId: plan.planId,
    outcome: plan.status === 'executed' ? 'executed' : 'stopped',
    steps: results.map((result) => ({
      step: result.step,
      operationId: result.operationId,
      outcome: result.outcome,
      ...(result.recordId ? { recordId: result.recordId } : {}),
      ...(result.error ? { error: result.error } : {}),
      ...(result.values ? { values: result.values } : {}),
    })),
    next:
      plan.status === 'executed'
        ? 'call erp_verify with this operationSessionId before reporting success'
        : 'earlier steps that succeeded stay committed; report exactly what happened',
  };
}

async function readRecord(
  runtime: AgentRuntime,
  view: RequestRuntimeView,
  catalog: PinnedCatalog,
  queryId: string,
  recordId: string,
  companyId: string,
): Promise<SemanticRecordDto | null> {
  const query = catalog.query(queryId);
  if (!query || query.queryType !== 'get') return null;
  const result = await runtime.queryGateway.invoke(view, {
    schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
    queryId,
    arguments: withScope(query, { recordId }, companyId),
  });
  return result.records[0] ?? null;
}

function withScope(
  query: QueryCatalogEntry,
  args: Record<string, ImmutableJsonValue>,
  companyId: string,
): Record<string, ImmutableJsonValue> {
  const parameter = query.legalEntityScope?.operand.parameterId;
  return parameter ? { ...args, [parameter]: companyId } : args;
}

function declaredOnly(
  query: QueryCatalogEntry,
  args: Record<string, ImmutableJsonValue>,
): Record<string, ImmutableJsonValue> {
  const declared = new Set(
    (query.parameters ?? []).map((parameter) => parameter.parameterId),
  );
  return Object.fromEntries(
    Object.entries(args).filter(([key]) => declared.has(key)),
  );
}

function compactRecord(
  record: SemanticRecordDto,
  selection: readonly string[] | null = null,
): ImmutableJsonValue {
  const values = compactValues(record.values);
  return {
    recordId: record.recordId,
    ...(record.archived ? { archived: true } : {}),
    values: selection
      ? Object.fromEntries(
          Object.entries(values).filter(([key]) => selection.includes(key)),
        )
      : values,
  };
}

function compactValues(
  values: Readonly<Record<string, ImmutableJsonValue>>,
): Record<string, ImmutableJsonValue> {
  return Object.fromEntries(
    Object.entries(values)
      .filter(([, value]) => value !== null)
      .map(([key, value]) => [key, canonicalDecimal(value)]),
  );
}

/** `6.000000000000000000` reads as `6`; exact decimals are canonical. */
function canonicalDecimal(value: ImmutableJsonValue): ImmutableJsonValue {
  if (typeof value !== 'string' || !/^-?\d+\.\d+$/u.test(value)) return value;
  const trimmed = value.replace(/0+$/u, '').replace(/\.$/u, '');
  return trimmed === '-0' ? '0' : trimmed;
}

function normalizeValue(
  raw: ImmutableJsonValue,
  kind: string,
  options: readonly string[],
  step: number,
  where: string,
): ImmutableJsonValue {
  if (raw === null) return null;
  if (isRecord(raw)) return refValue(raw, step, where);
  if (
    kind === 'exactDecimalFieldType' ||
    kind === 'quantityFieldType' ||
    kind === 'moneyFieldType'
  ) {
    const text = typeof raw === 'number' ? String(raw) : raw;
    if (typeof text !== 'string' || !/^-?\d+(?:\.\d+)?$/u.test(text.trim()))
      throw new ToolInputError(`${where}: expected a decimal string`);
    return canonicalDecimal(
      text.trim().includes('.') ? text.trim() : `${text.trim()}.0`,
    );
  }
  if (kind === 'integerFieldType') {
    const text = typeof raw === 'number' ? String(raw) : raw;
    if (typeof text !== 'string' || !/^-?\d+$/u.test(text.trim()))
      throw new ToolInputError(`${where}: expected an integer`);
    return text.trim();
  }
  if (
    kind === 'enumFieldType' &&
    (typeof raw !== 'string' || !options.includes(raw))
  )
    throw new ToolInputError(`${where}: expected one of ${options.join(', ')}`);
  return raw;
}

function refValue(
  raw: ImmutableJsonValue | undefined,
  step: number,
  where: string,
): ImmutableJsonValue {
  if (typeof raw === 'string') {
    if (!uuidPattern.test(raw))
      throw new ToolInputError(`${where}: expected a record id (uuid)`);
    return raw;
  }
  if (isRecord(raw) && typeof raw.fromStep === 'number') {
    if (
      !Number.isInteger(raw.fromStep) ||
      raw.fromStep < 1 ||
      raw.fromStep >= step
    )
      throw new ToolInputError(`${where}: fromStep must name an earlier step`);
    return { fromStep: raw.fromStep };
  }
  throw new ToolInputError(`${where}: expected a record id or {"fromStep": n}`);
}

function resolveRef(ref: StepRef, results: readonly StepResult[]): string {
  if (typeof ref === 'string') return ref;
  const produced = results.find((result) => result.step === ref.fromStep);
  if (!produced?.recordId)
    throw new ToolInputError(`step ${String(ref.fromStep)} produced no record`);
  return produced.recordId;
}

function resolveRefs(
  bag: Readonly<Record<string, ImmutableJsonValue>>,
  results: readonly StepResult[],
): Record<string, ImmutableJsonValue> {
  return Object.fromEntries(
    Object.entries(bag).map(([key, value]) => [
      key,
      isRecord(value) && typeof value.fromStep === 'number'
        ? resolveRef({ fromStep: value.fromStep }, results)
        : value,
    ]),
  );
}

function refText(ref: StepRef): string {
  return typeof ref === 'string'
    ? ref
    : `the record step ${String(ref.fromStep)} produces`;
}

function sameValue(
  stored: ImmutableJsonValue | undefined,
  expected: ImmutableJsonValue,
): boolean {
  if (stored === undefined) return false;
  if (typeof stored === 'string' && typeof expected === 'string') {
    const a = canonicalDecimal(stored);
    const b = canonicalDecimal(expected);
    if (a === b) return true;
    const ta = Date.parse(stored);
    const tb = Date.parse(expected);
    return /\d{4}-\d{2}-\d{2}T/u.test(stored) && ta === tb;
  }
  return JSON.stringify(stored) === JSON.stringify(expected);
}

function planDigest(steps: readonly PlanStep[]): string {
  return createHash('sha256')
    .update(
      JSON.stringify(
        steps.map((step) => ({
          step: step.step,
          operationId: step.operation.operationId,
          recordId: step.recordId,
          pinnedRevision: step.pinnedRevision,
          values: step.values ?? null,
          relations: step.relations ?? null,
          patch: step.patch ?? null,
          arguments: step.arguments ?? null,
        })),
      ),
    )
    .digest('hex');
}

/** A UUID-shaped key per (plan, execution key, step): replays are idempotent. */
function derivedKey(planId: string, key: string, step: number): string {
  const hex = createHash('sha256')
    .update(`${planId}\u0000${key}\u0000${String(step)}`)
    .digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function requiredText(
  value: ImmutableJsonValue | undefined,
  name: string,
): string {
  if (typeof value !== 'string' || value.trim() === '')
    throw new ToolInputError(`${name} is required`);
  return value.trim();
}

function stringList(
  value: ImmutableJsonValue | undefined,
  name: string,
): string[] {
  if (value === undefined || value === null) return [];
  if (
    !Array.isArray(value) ||
    !value.every((entry) => typeof entry === 'string')
  )
    throw new ToolInputError(`${name} must be a list of ids`);
  return value as string[];
}

function boundedInteger(
  value: ImmutableJsonValue | undefined,
  fallback: number,
  maximum: number,
): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? Math.min(value, maximum)
    : fallback;
}

function cursorOffset(value: ImmutableJsonValue | undefined): number {
  const parsed = typeof value === 'string' ? Number.parseInt(value, 10) : 0;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}
