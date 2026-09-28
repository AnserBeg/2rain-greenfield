import { COMMERCIAL_READ_MODEL_BINDINGS } from '../../domain/src/sales/workspace.js';
import {
  chargeAmounts,
  formatCents,
  lineAmounts,
  sameExact,
  type LineAmounts,
} from './commercial-amounts.js';
import {
  registeredSemanticQueryFromPinnedView,
  SEMANTIC_QUERY_REQUEST_VERSION,
  type SemanticQueryReadModelExecutor,
  type SemanticRecordDto,
} from '../../runtime/src/semantic-query-gateway.js';
import {
  requireSharedListResult,
  SHARED_LIST_QUERY_VERSION,
} from '../../runtime/src/list-behavior/index.js';
import type { ImmutableJsonValue } from '../../runtime/src/request-runtime-view.js';

/**
 * Line amounts and order totals (owner ruling B), from each line's and
 * charge's own frozen figures; the order's lines are read through the declared
 * dependency query, re-entering current policy and scope. A figure that cannot
 * be stated -- an unpriced line, a discount outside 0-100%, a tax code without
 * a frozen rate -- is `null`, and so is every total it would feed: nothing is
 * guessed as zero.
 */
export const commercialReadModel: SemanticQueryReadModelExecutor = async ({
  view,
  definition,
  arguments: args,
  result,
  gateway,
}) => {
  const model = definition.readModel!;
  const ns = definition.sourceEntityId.split(':')[0]!;
  const scope = definition.legalEntityScope;
  if (!scope || !args || typeof args !== 'object' || Array.isArray(args))
    throw new Error('Commercial read model requires explicit scope');
  const scopeId = (args as Readonly<Record<string, ImmutableJsonValue>>)[
    scope.operand.parameterId
  ];
  if (typeof scopeId !== 'string')
    throw new Error('Commercial scope is not exact');
  const field = (name: string) => `${ns}:field.${name}`;
  const invoke = async (
    key: string,
    arguments_: Record<string, ImmutableJsonValue>,
  ) => {
    const queryId = model.queries[key]?.targetId;
    const query = queryId
      ? registeredSemanticQueryFromPinnedView(view, queryId)
      : null;
    if (!query || query.queryType === 'aggregate' || query.readModel)
      throw new Error('Invalid commercial read-model dependency');
    return gateway.invoke(view, {
      schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
      queryId: query.queryId,
      arguments: {
        ...arguments_,
        ...(query.legalEntityScope
          ? { [query.legalEntityScope.operand.parameterId]: scopeId }
          : {}),
      },
    });
  };
  // The rate a line or charge is taxed at, frozen from its tax code when the
  // code was chosen. `undefined`: no code (untaxed); `null`: a code without a
  // frozen rate, which cannot be stated.
  const frozenRate = (
    taxCodeId: ImmutableJsonValue | undefined,
    rate: ImmutableJsonValue | undefined,
  ): string | null | undefined =>
    typeof taxCodeId !== 'string' || taxCodeId === ''
      ? undefined
      : typeof rate === 'string' && rate !== ''
        ? rate
        : null;
  const priced = (line: SemanticRecordDto): LineAmounts | null =>
    lineAmounts({
      quantity: line.values[field('sales_order_line_ordered_quantity')],
      unitPrice: line.values[field('sales_order_line_unit_price')],
      discountPercent: line.values[field('sales_order_line_discount_percent')],
      taxRatePercent: frozenRate(
        line.values[field('sales_order_line_tax_code_id')],
        line.values[field('sales_order_line_tax_rate_percent')],
      ),
    });
  const linesOf = async (orderId: string) => {
    const records: SemanticRecordDto[] = [];
    const parentScope = {
      relationId: `${ns}:relation.sales_order_line_order`,
      recordId: orderId,
    };
    let cursor: string | null = null;
    do {
      const page: ReturnType<
        typeof requireSharedListResult<SemanticRecordDto>
      > = requireSharedListResult(
        await invoke('lines', {
          includeArchived: false,
          list: {
            schemaVersion: SHARED_LIST_QUERY_VERSION,
            cursor,
            matchMode: 'substring',
            pageSize: 100,
            search: '',
            sort: [],
            relationLabels: [],
            parentScope,
          },
        }),
      );
      if (
        page.listCoverage.parentScope?.recordId !== orderId ||
        page.listCoverage.parentScope.relationId !== parentScope.relationId
      )
        throw new Error('Unapplied exact parent scope');
      records.push(...page.records);
      if (
        page.listCoverage.hasMore &&
        (!page.records.length ||
          cursor === page.listCoverage.nextCursor ||
          records.length > 1000)
      )
        throw new Error('Incomplete commercial read model');
      cursor = page.listCoverage.nextCursor;
    } while (cursor !== null);
    return records;
  };
  const money = (cents: bigint | null) =>
    cents === null ? null : formatCents(cents);
  const rows: SemanticRecordDto[] = [];
  for (const row of result.records) {
    const values: Record<string, ImmutableJsonValue> = { ...row.values };
    const emit = (key: string, value: string | null) => {
      const target = model.resultFields[key];
      if (!target) throw new Error('Read-model output is undeclared');
      values[target] = value;
    };
    if (model.binding === COMMERCIAL_READ_MODEL_BINDINGS.line) {
      const amounts = priced(row);
      emit('line_amount', money(amounts?.amountCents ?? null));
      emit('line_tax', money(amounts?.taxCents ?? null));
      // A unit price that differs from the list price it started from was
      // set by hand (ruling B); without a list price there is nothing to mark.
      const list = row.values[field('sales_order_line_list_price')];
      const unit = row.values[field('sales_order_line_unit_price')];
      emit(
        'price_basis',
        list === null || list === undefined || list === ''
          ? null
          : sameExact(list, unit)
            ? 'List price'
            : 'Manual price',
      );
    } else if (model.binding === COMMERCIAL_READ_MODEL_BINDINGS.order) {
      let complete = true;
      let subtotal = 0n;
      let tax = 0n;
      for (const line of await linesOf(row.recordId)) {
        const amounts = priced(line);
        if (!amounts) complete = false;
        else {
          subtotal += amounts.amountCents;
          tax += amounts.taxCents;
        }
      }
      let charges = 0n;
      for (const charge of ['freight', 'other_fee'] as const) {
        const amounts = chargeAmounts(
          row.values[field(`sales_order_${charge}_amount`)],
          frozenRate(
            row.values[field(`sales_order_${charge}_tax_code_id`)],
            row.values[field(`sales_order_${charge}_tax_rate_percent`)],
          ),
        );
        if (!amounts) complete = false;
        else {
          charges += amounts.amountCents;
          tax += amounts.taxCents;
        }
      }
      emit('order_subtotal', complete ? money(subtotal) : null);
      emit('order_charges', complete ? money(charges) : null);
      emit('order_tax', complete ? money(tax) : null);
      emit('order_total', complete ? money(subtotal + charges + tax) : null);
    } else throw new Error('Unknown commercial read-model binding');
    rows.push({ ...row, values });
  }
  return { ...result, records: rows };
};
