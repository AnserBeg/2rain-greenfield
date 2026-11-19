/**
 * Bounded, model-facing views of the pinned release's compiled catalogs.
 *
 * Everything here is read from the request-pinned runtime view: the agent
 * discovery projection (ids and list presets), the operation catalog (each
 * operation's confirmation, effect, precondition, read-back and input
 * contract) and the query catalog. The complete registry stays server-side;
 * these functions return compact summaries and, for selected ids only, one
 * compact contract.
 */
import type {
  ImmutableJsonValue,
  RequestRuntimeView,
} from '../../runtime/src/request-runtime-view.js';
import {
  parseCalculatedDisplayProjection,
  type CalculatedDisplayProjectionEntry,
} from '../../canonical-model/src/calculated-display-projection.js';
import { parseFormulaValidationBindings } from '../../canonical-model/src/formula-validation-projection.js';
import type { FormulaValidationRule } from '../../canonical-model/src/formula-validation-schema.js';
import {
  parsePinnedOperationCatalog,
  type RegisteredOperationDefinition,
} from '../../runtime/src/semantic-operation-gateway.js';
import type { SurfaceList } from '../../canonical-model/src/index.js';

export interface QueryCatalogEntry {
  readonly queryId: string;
  readonly queryType: string;
  readonly sourceEntityId: string;
  readonly lifecycle: string;
  readonly maximumResultCount?: number;
  readonly parameters?: readonly {
    readonly parameterId: string;
    readonly parameterType: { readonly kind: string };
  }[];
  readonly legalEntityScope?: {
    readonly operand: { readonly parameterId: string };
  };
  readonly resolveMatchKeys?: readonly {
    readonly fieldId: string;
    readonly authority: string;
  }[];
  readonly selections: readonly { readonly fieldId: string }[];
}

export interface ListPreset {
  readonly queryId: string;
  readonly surfaceId?: string;
  readonly views?: readonly {
    readonly viewId: string;
    readonly label: string;
    readonly fieldFilters: readonly { fieldId: string; value: string }[];
    readonly columns?: readonly string[];
    readonly open?: true;
    readonly before?: {
      readonly anchor: 'startOfTodayUtc';
      readonly fieldId: string;
    };
    readonly band?: {
      readonly figureId: string;
      readonly values: readonly string[];
    };
    readonly supply?: 'covered' | 'short';
    readonly sort?: readonly {
      readonly fieldId: string;
      readonly direction: 'ascending' | 'descending';
    }[];
  }[];
  readonly referenceLabels?: readonly {
    readonly fieldId: string;
    readonly queryId: string;
    readonly referenceId: string;
    readonly sourceFieldId: string;
  }[];
  readonly progress?: ImmutableJsonValue;
  readonly figures?: ImmutableJsonValue;
  readonly searchChildren?: ImmutableJsonValue;
  readonly filters?: readonly {
    readonly filterId: string;
    readonly fieldId: string;
    readonly label: string;
    readonly values?: readonly string[];
  }[];
}

export interface MetricCard {
  readonly metricId: string;
  readonly surface: string;
  readonly label: string;
  readonly queryId: string;
  readonly view?: string;
  readonly sumField?: string;
}

interface AgentDiscoveryPayload {
  readonly confirmationRequiredFor?: readonly string[];
  readonly operations: readonly { operationId: string }[];
  readonly queries: readonly { queryId: string; fieldIds: readonly string[] }[];
  readonly listPresets?: readonly ListPreset[];
  readonly metricCards?: readonly MetricCard[];
  readonly toolIds: readonly string[];
}

export interface PinnedCatalog {
  readonly confirmationRequiredFor: ReadonlySet<string>;
  readonly operations: readonly RegisteredOperationDefinition[];
  readonly queries: readonly QueryCatalogEntry[];
  readonly presets: readonly ListPreset[];
  readonly metricCards?: readonly MetricCard[];
  readonly calculatedDisplays?: readonly CalculatedDisplayProjectionEntry[];
  readonly validationRules?: readonly FormulaValidationRule[];
  operation(operationId: string): RegisteredOperationDefinition | undefined;
  query(queryId: string): QueryCatalogEntry | undefined;
  preset(queryId: string): ListPreset | undefined;
  relationLabels(queryId: string): readonly {
    readonly fieldId: string;
    readonly queryId: string;
    readonly relationId: string;
  }[];
  /** The entity an operation acts on, read from its declared read-back. */
  operationEntity(operation: RegisteredOperationDefinition): string;
}

const catalogs = new WeakMap<object, PinnedCatalog>();

/** One parsed catalog per pinned release content, cached by payload identity. */
export function pinnedCatalog(view: RequestRuntimeView): PinnedCatalog {
  const key = view.projections;
  const cached = catalogs.get(key);
  if (cached) return cached;
  const agent = view.projections.agent
    .payload as unknown as AgentDiscoveryPayload;
  const discovered = new Set(
    agent.operations.map((entry) => entry.operationId),
  );
  const discoveredQueries = new Set(
    agent.queries.map((entry) => entry.queryId),
  );
  const operations = parsePinnedOperationCatalog(
    view.projections.operation.payload,
  ).filter(
    (operation) =>
      operation.lifecycle === 'active' && discovered.has(operation.operationId),
  );
  const queries = (
    (
      view.projections.query.payload as unknown as {
        queries: readonly QueryCatalogEntry[];
      }
    ).queries ?? []
  ).filter(
    (query) =>
      query.lifecycle === 'active' && discoveredQueries.has(query.queryId),
  );
  const operationById = new Map(operations.map((op) => [op.operationId, op]));
  const queryById = new Map(queries.map((query) => [query.queryId, query]));
  const presetById = new Map(
    (agent.listPresets ?? []).map((preset) => [preset.queryId, preset]),
  );
  // Older releases have no field declarations. Require confirmation for their setup records.
  const surfaces =
    (
      view.projections.surface.payload as unknown as {
        surfaces?: readonly {
          workspace?: { membership?: string };
          dataSourceQueryId?: string;
          surfaceId?: string;
          list?: Pick<SurfaceList, 'columns'>;
        }[];
      }
    ).surfaces ?? [];
  const confirmationRequiredFor = new Set(
    agent.confirmationRequiredFor ??
      surfaces.flatMap((s) => {
        const entity =
          s.workspace?.membership === 'setup' &&
          queryById.get(s.dataSourceQueryId ?? '')?.sourceEntityId;
        return entity ? [entity] : [];
      }),
  );
  const formulaPayload = view.projections.formulaRule?.payload;
  const catalog: PinnedCatalog = {
    ...(isRecord(formulaPayload) &&
    Object.hasOwn(formulaPayload, 'calculatedFields')
      ? { calculatedDisplays: parseCalculatedDisplayProjection(formulaPayload) }
      : {}),
    confirmationRequiredFor,
    operations,
    queries,
    presets: agent.listPresets ?? [],
    ...(agent.metricCards ? { metricCards: agent.metricCards } : {}),
    ...(view.projections.formulaRule
      ? {
          validationRules: parseFormulaValidationBindings(
            view.projections.formulaRule.payload,
          ).map(({ rule }) => rule),
        }
      : {}),
    operation: (id) =>
      operationById.get(id) ??
      operationById.get(matchId(id, operationById.keys()) ?? ''),
    query: (id) =>
      queryById.get(id) ?? queryById.get(matchId(id, queryById.keys()) ?? ''),
    preset: (id) => presetById.get(id),
    relationLabels: (id) => {
      const surfaceId = presetById.get(id)?.surfaceId;
      if (!surfaceId) return [];
      return (
        surfaces
          .find((surface) => surface.surfaceId === surfaceId)
          ?.list?.columns.flatMap((column) =>
            column.relation && column.reference
              ? [
                  {
                    fieldId: column.reference.labelField.targetId,
                    queryId: column.reference.query.targetId,
                    relationId: column.field,
                  },
                ]
              : [],
          ) ?? []
      );
    },
    operationEntity: (operation) =>
      'entity' in operation.effect
        ? operation.effect.entity.targetId
        : (queryById.get(operation.readBackQueryId)?.sourceEntityId ?? ''),
  };
  catalogs.set(key, catalog);
  return catalog;
}

export function effectKind(operation: RegisteredOperationDefinition): string {
  const effect = (operation as unknown as { effect?: { kind?: string } })
    .effect;
  return effect?.kind ?? 'unknown';
}

/** Plain words for what an operation does, from its compiled effect. */
export function describeEffect(
  operation: RegisteredOperationDefinition,
  entity: string,
): string {
  const effect = (operation as unknown as { effect?: Record<string, unknown> })
    .effect;
  const name = localName(entity);
  switch (effect?.kind) {
    case 'createRecordEffect':
      return `creates one ${name} record (a draft unless its state says otherwise)`;
    case 'updateRecordEffect':
      return `changes fields of one ${name} record`;
    case 'archiveRecordEffect':
      return `archives one ${name} record (hidden from lists; never deleted)`;
    case 'restoreRecordEffect':
      return `restores one archived ${name} record`;
    case 'transitionStateEffect':
      return `moves one ${name} from ${localName(String(effect.fromStateId))} to ${localName(String(effect.toStateId))}`;
    case 'registeredCapabilityEffect': {
      const capability = isRecord(effect.capability)
        ? String(effect.capability.targetId)
        : 'a registered capability';
      return `runs ${capability} on one ${name}; it may post stock, money or document state, and it re-checks availability and state itself`;
    }
    default:
      return `acts on one ${name}`;
  }
}

/** Search text for an id: its local words, plus the declared label. */
export function searchableText(id: string, label?: string): string {
  return `${localName(id).replaceAll('_', ' ')} ${label ?? ''}`.toLowerCase();
}

export function localName(id: string): string {
  const afterColon = id.includes(':') ? id.slice(id.indexOf(':') + 1) : id;
  const dot = afterColon.indexOf('.');
  return dot >= 0 ? afterColon.slice(dot + 1) : afterColon;
}

/** The compact, model-facing contract of one operation. */
export function operationContract(
  catalog: PinnedCatalog,
  operation: RegisteredOperationDefinition,
): Record<string, ImmutableJsonValue> {
  const entity = catalog.operationEntity(operation);
  const input = operation.inputContract;
  const argumentKeys = input?.closedArgumentKeys ?? [];
  const assigned = new Set(
    (
      input as { assignedFields?: readonly { fieldId: string }[] } | undefined
    )?.assignedFields?.map((field) => field.fieldId) ?? [],
  );
  const fields = (input?.fields ?? [])
    .filter((field) => field.writable && !assigned.has(field.fieldId))
    .map((field) => compactField(field));
  const relations = (input?.relationInputs ?? []).map((relation) => ({
    relationId: relation.relationId,
    required: relation.required,
    target: relation.targetEntityId ?? null,
    findWith: relation.targetEntityId
      ? findQueryFor(catalog, relation.targetEntityId)
      : null,
  }));
  const usesPatch = argumentKeys.includes('patch');
  const validationRules = catalog.validationRules
    ?.filter((rule) => rule.boundOperationIds.includes(operation.operationId))
    .map((rule) => ({
      ruleId: rule.ruleId,
      predicate: rule.predicate as unknown as ImmutableJsonValue,
      fieldIds: rule.fieldAnchors,
      message: rule.message,
      existingRecords: rule.existingRecords,
    }));
  return {
    operationId: operation.operationId,
    ...(operation.label ? { label: operation.label } : {}),
    entity,
    effect: describeEffect(operation, entity),
    confirmation:
      operation.confirmation === 'humanRequired'
        ? 'the person must approve it (every plan is shown for approval anyway)'
        : 'none beyond plan approval',
    precondition: describePredicate(operation.precondition),
    ...(validationRules?.length ? { validationRules } : {}),
    readBackQueryId: operation.readBackQueryId,
    target: argumentKeys.includes('expectedRevision')
      ? 'required: the recordId of an existing record (or {"fromStep": n})'
      : 'none: the host mints the new recordId',
    ...(fields.length > 0
      ? { [usesPatch ? 'patchFields' : 'valueFields']: fields }
      : {}),
    ...(relations.length > 0 ? { relations } : {}),
    ...(argumentKeys.includes('arguments')
      ? { arguments: 'operation-specific arguments object (optional)' }
      : {}),
    ...(assigned.size > 0 ? { assignedByServer: [...assigned] } : {}),
    hostSupplies:
      'recordId for creates, the company (legalEntityId), expectedRevision, the idempotency key and any confirmation grant',
  };
}

function compactField(field: {
  fieldId: string;
  fieldKind: string;
  required: boolean;
  enumOptionIds: readonly string[];
  bounds: {
    maximumLength: number | null;
    precision: number | null;
    scale: number | null;
  };
}): Record<string, ImmutableJsonValue> {
  const kind = field.fieldKind.replace(/FieldType$/u, '');
  return {
    fieldId: field.fieldId,
    kind:
      kind === 'exactDecimal'
        ? 'decimal as a string, e.g. "12.5"'
        : kind === 'integer'
          ? 'integer as a string, e.g. "1"'
          : kind === 'dateTime'
            ? 'ISO-8601 UTC instant; a business date is its midnight-UTC instant (see erp_discover context today)'
            : kind === 'text' && field.bounds.maximumLength !== null
              ? `text (max ${String(field.bounds.maximumLength)})`
              : kind,
    required: field.required,
    ...(field.enumOptionIds.length > 0
      ? { options: [...field.enumOptionIds] }
      : {}),
  };
}

function findQueryFor(catalog: PinnedCatalog, entityId: string): string | null {
  const name = localName(entityId);
  for (const suffix of ['_list', '_resolve', '_search']) {
    const match = catalog.queries.find(
      (query) =>
        query.sourceEntityId === entityId &&
        localName(query.queryId) === `${name}${suffix}`,
    );
    if (match) return match.queryId;
  }
  return null;
}

/** The compact, model-facing contract of one query. */
export function queryContract(
  catalog: PinnedCatalog,
  query: QueryCatalogEntry,
): Record<string, ImmutableJsonValue> {
  const scopeParameter = query.legalEntityScope?.operand.parameterId;
  const preset = catalog.preset(query.queryId);
  const calculatedFields = catalog.calculatedDisplays?.filter(({ readSinks }) =>
    readSinks.some(({ queryId }) => queryId === query.queryId),
  );
  const metrics = catalog.metricCards?.filter(
    (card) => card.queryId === query.queryId,
  );
  const argumentsHelp: Record<string, string> = {
    get: '{"recordId": "<uuid>"}',
    list: metrics?.length
      ? '{"metric": "<Today metric id>"} or {"search"?: text, "view"?: viewId, "filters"?: [{"fieldId", "value"}], "parent"?: {"relationId", "recordId"}}'
      : '{"search"?: text, "view"?: viewId, "filters"?: [{"fieldId", "value"}] (exact match on a selected field, max 4), "parent"?: {"relationId", "recordId"} (rows belonging to that record)}',
    search: '{"text": "<words>"}',
    resolve: '{"text": "<number or name>"}',
    aggregate: '{} (or the declared parameters)',
  };
  return {
    queryId: query.queryId,
    type: query.queryType,
    entity: query.sourceEntityId,
    arguments: argumentsHelp[query.queryType] ?? '{}',
    fields: query.selections.map((selection) => selection.fieldId),
    ...(calculatedFields?.length
      ? {
          calculatedDisplayFields: calculatedFields.map(({ declaration }) => ({
            fieldId: declaration.fieldId,
            label: declaration.label,
            currency: declaration.resultType.currency,
            scale: declaration.resultType.scale,
            readOnly: true,
          })),
        }
      : {}),
    ...(metrics?.length
      ? {
          todayMetrics: metrics.map(({ metricId, label, sumField, view }) => ({
            metricId,
            label,
            ...(sumField ? { sumField } : { measure: 'count' as const }),
            ...(view ? { view } : {}),
          })),
        }
      : {}),
    ...(query.resolveMatchKeys && query.resolveMatchKeys.length > 0
      ? {
          matchesOn: query.resolveMatchKeys.map(
            (key) => `${key.fieldId} (${key.authority})`,
          ),
        }
      : {}),
    ...((query.parameters ?? []).some(
      (parameter) => parameter.parameterId !== scopeParameter,
    )
      ? {
          parameters: (query.parameters ?? [])
            .filter((parameter) => parameter.parameterId !== scopeParameter)
            .map((parameter) => parameter.parameterId),
        }
      : {}),
    ...(preset?.views && preset.views.length > 0
      ? {
          views: preset.views.map((view) => ({
            viewId: view.viewId,
            label: view.label,
            ...(view.columns ? { columns: view.columns } : {}),
            ...(view.sort
              ? { sort: view.sort as unknown as ImmutableJsonValue }
              : {}),
            ...(view.fieldFilters.length > 0
              ? { filters: view.fieldFilters as unknown as ImmutableJsonValue }
              : {}),
          })),
        }
      : {}),
    ...(scopeParameter ? { company: 'supplied by the host' } : {}),
  };
}

/** A compiled precondition in short words: `field equals value`. */
export function describePredicate(
  predicate: Readonly<Record<string, ImmutableJsonValue>>,
): string {
  if (predicate.kind === 'booleanPredicate')
    return predicate.value === true ? 'none declared' : 'never holds';
  if (predicate.kind === 'fieldComparisonPredicate') {
    const field = isRecord(predicate.field)
      ? String(predicate.field.targetId)
      : '?';
    const value = isRecord(predicate.value)
      ? String(predicate.value.value)
      : String(predicate.value);
    return `${field} ${String(predicate.operator)} ${value}`;
  }
  return `declared (${String(predicate.kind)})`;
}

export function isRecord(
  value: unknown,
): value is Record<string, ImmutableJsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The full id a model-written name stands for, among `candidates`: the id
 * itself, else the one candidate whose local name is the text, else the one
 * whose local name is `<prefix>_<text>` (the business map writes field ids
 * without their record type's prefix). Anything else is undefined: a name
 * that is not exactly one candidate is never guessed.
 */
export function matchId(
  text: string,
  candidates: Iterable<string>,
  prefix?: string,
): string | undefined {
  const all = [...candidates];
  if (all.includes(text)) return text;
  if (text.includes(':')) return undefined;
  for (const wanted of prefix ? [text, `${prefix}_${text}`] : [text]) {
    const found = all.filter((id) => localName(id) === wanted);
    if (found.length === 1) return found[0];
    if (found.length > 1) return undefined;
  }
  return undefined;
}
