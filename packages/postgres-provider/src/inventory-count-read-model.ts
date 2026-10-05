import { INVENTORY_READ_MODEL_BINDINGS } from '../../domain/src/inventory/workspace.js';
import {
  registeredSemanticQueryFromPinnedView,
  SEMANTIC_QUERY_REQUEST_VERSION,
  SemanticQueryPolicyDeniedError,
  type SemanticQueryReadModelExecutor,
  type SemanticRecordDto,
} from '../../runtime/src/semantic-query-gateway.js';
import {
  requireSharedListResult,
  SHARED_LIST_QUERY_VERSION,
} from '../../runtime/src/list-behavior/index.js';
import type { ImmutableJsonValue } from '../../runtime/src/request-runtime-view.js';

/**
 * STOCK-COUNTS: what each line of one count expects and differs by. While the
 * count is a draft or counting, expected is what is posted at the count's
 * location now -- the posted stock list, under current policy and the page's
 * company -- and variance is the physical count less it, except that a blind
 * count states neither until it is reviewed; once reviewed, both are the
 * figures its review froze, which the posting kernel checks again under its
 * stock locks. It answers only for the lines of one count (the executor's
 * echoed parent scope).
 *
 * A display, not the rule: a withheld count or stock read states no figure,
 * and nothing here decides what posts.
 */
export const inventoryCountReadModel: SemanticQueryReadModelExecutor = async ({
  view,
  definition,
  arguments: args,
  result,
  gateway,
}) => {
  const model = definition.readModel!;
  if (model.binding !== INVENTORY_READ_MODEL_BINDINGS.countLine)
    throw new Error('Unknown inventory read-model binding');
  const ns = definition.sourceEntityId.split(':')[0]!;
  const scope = definition.legalEntityScope;
  if (!scope || !args || typeof args !== 'object' || Array.isArray(args))
    throw new Error('Inventory read model requires explicit scope');
  const scopeId = (args as Readonly<Record<string, ImmutableJsonValue>>)[
    scope.operand.parameterId
  ];
  if (typeof scopeId !== 'string')
    throw new Error('Inventory scope is not exact');
  const field = (name: string) => `${ns}:field.${name}`;
  const option = (name: string) => `${ns}:option.${name}`;
  const dependency = (key: string) => {
    const queryId = model.queries[key]?.targetId;
    const query = queryId
      ? registeredSemanticQueryFromPinnedView(view, queryId)
      : null;
    if (
      !query ||
      query.queryType === 'aggregate' ||
      query.readModel ||
      !query.legalEntityScope
    )
      throw new Error('Invalid inventory read-model dependency');
    return query;
  };
  const invoke = (
    key: string,
    arguments_: Record<string, ImmutableJsonValue>,
  ) => {
    const query = dependency(key);
    return gateway.invoke(view, {
      schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
      queryId: query.queryId,
      arguments: {
        ...arguments_,
        [query.legalEntityScope!.operand.parameterId]: scopeId,
      },
    });
  };
  const list = async (
    key: string,
    extra: Readonly<Record<string, ImmutableJsonValue>>,
  ) => {
    const records: SemanticRecordDto[] = [];
    let cursor: string | null = null;
    do {
      const page: ReturnType<
        typeof requireSharedListResult<SemanticRecordDto>
      > = requireSharedListResult(
        await invoke(key, {
          includeArchived: false,
          list: {
            relationLabels: [],
            ...extra,
            schemaVersion: SHARED_LIST_QUERY_VERSION,
            cursor,
            matchMode: 'substring',
            pageSize: 100,
            search: '',
            sort: [],
          },
        }),
      );
      if (
        extra.fieldFilters &&
        JSON.stringify(page.listCoverage.fieldFilters) !==
          JSON.stringify(extra.fieldFilters)
      )
        throw new Error('Unapplied exact field filters');
      records.push(...page.records);
      if (
        page.listCoverage.hasMore &&
        (!page.records.length ||
          cursor === page.listCoverage.nextCursor ||
          records.length > 5000)
      )
        throw new Error('Incomplete inventory read model');
      cursor = page.listCoverage.nextCursor;
    } while (cursor !== null);
    return records;
  };
  const parent = result.listCoverage?.parentScope;
  const countId =
    parent && parent.relationId === `${ns}:relation.stock_count_line_session`
      ? parent.recordId
      : null;
  let count: SemanticRecordDto | null = null;
  if (countId && result.records.length) {
    try {
      const read = await invoke('count', {
        recordId: countId,
        includeArchived: false,
      });
      count =
        read.outcome === 'exact'
          ? (read.records.find((record) => record.recordId === countId) ?? null)
          : null;
    } catch (error) {
      if (!(error instanceof SemanticQueryPolicyDeniedError)) throw error;
    }
  }
  const state = count?.values[field('stock_count_state')];
  const frozen =
    state === option('stock_count_state_reviewed') ||
    state === option('stock_count_state_posted');
  const counting =
    state === option('stock_count_state_draft') ||
    state === option('stock_count_state_counting');
  // A blind count states no expectation until it is reviewed (ruling SC-4).
  const blind =
    count?.values[field('stock_count_counting_mode')] ===
    option('stock_count_counting_mode_blind');
  // What is posted at the count's location now, by product.
  let posted: Map<string, bigint> | null = null;
  const location = count?.values[field('stock_count_location_id')];
  if (counting && !blind && typeof location === 'string') {
    try {
      posted = new Map();
      for (const balance of await list('stock', {
        fieldFilters: [
          {
            fieldId: field('posted_stock_balance_location_id'),
            value: location,
          },
        ],
      })) {
        const item = String(
          balance.values[field('posted_stock_balance_item_id')],
        ).toLowerCase();
        posted.set(
          item,
          (posted.get(item) ?? 0n) +
            scaled(
              String(
                balance.values[field('posted_stock_balance_posted_quantity')],
              ),
            ),
        );
      }
    } catch (error) {
      if (!(error instanceof SemanticQueryPolicyDeniedError)) throw error;
      posted = null;
    }
  }
  const rows: SemanticRecordDto[] = [];
  for (const row of result.records) {
    const values: Record<string, ImmutableJsonValue> = { ...row.values };
    const emit = (key: string, value: string | null) => {
      const target = model.resultFields[key];
      if (!target) throw new Error('Read-model output is undeclared');
      values[target] = value;
    };
    const stored = (name: string) => {
      const value = row.values[field(`stock_count_line_${name}`)];
      return value === null || value === undefined ? null : String(value);
    };
    if (frozen) {
      emit('count_book', canonical(stored('expected_quantity')));
      emit('count_variance', canonical(stored('variance_quantity')));
    } else if (counting && posted) {
      const item = String(
        row.values[field('stock_count_line_item_id')],
      ).toLowerCase();
      const book = posted.get(item) ?? 0n;
      const physical = stored('physical_quantity');
      emit('count_book', decimal(book));
      emit(
        'count_variance',
        physical === null ? null : decimal(scaled(physical) - book),
      );
    } else {
      emit('count_book', null);
      emit('count_variance', null);
    }
    rows.push({ ...row, values });
  }
  return { ...result, records: rows };
};

function canonical(value: string | null): string | null {
  return value === null ? null : decimal(scaled(value));
}

function scaled(value: string): bigint {
  const match = /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?$/u.exec(value);
  if (!match) throw new Error('Inventory read model read a non-decimal');
  const fraction = (match[3] ?? '').padEnd(18, '0').slice(0, 18);
  const magnitude = BigInt(`${match[2]!}${fraction}`);
  return match[1] === '-' ? -magnitude : magnitude;
}

function decimal(value: bigint): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(19, '0');
  const whole = digits.slice(0, -18).replace(/^0+(?=\d)/u, '');
  const fraction = digits.slice(-18).replace(/0+$/u, '');
  const text = fraction ? `${whole}.${fraction}` : whole;
  return negative && text !== '0' ? `-${text}` : text;
}
