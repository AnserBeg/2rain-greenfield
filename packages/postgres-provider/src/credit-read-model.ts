import type { CREDIT_READ_MODEL_OUTPUTS } from '../../domain/src/sales/workspace.js';
import {
  creditLimitCents,
  creditPosition,
  formatCents,
  orderTotalCents,
  parseExact,
  type CreditPosition,
} from './commercial-amounts.js';
import {
  registeredSemanticQueryFromPinnedView,
  SEMANTIC_QUERY_REQUEST_VERSION,
  SemanticQueryPolicyDeniedError,
  type RegisteredSemanticQueryDefinition,
  type SemanticQueryGateway,
  type SemanticRecordDto,
} from '../../runtime/src/semantic-query-gateway.js';
import {
  requireSharedListResult,
  SHARED_LIST_QUERY_VERSION,
} from '../../runtime/src/list-behavior/index.js';
import type {
  ImmutableJsonValue,
  RequestRuntimeView,
} from '../../runtime/src/request-runtime-view.js';

type Read = Pick<SemanticQueryGateway, 'invoke'>;

/** A whole money amount in cents, or `null` for anything else. */
function cents(value: ImmutableJsonValue | undefined): bigint | null {
  const parsed = parseExact(value);
  if (!parsed || parsed.units < 0n) return null;
  if (parsed.scale <= 2) return parsed.units * 10n ** BigInt(2 - parsed.scale);
  const divisor = 10n ** BigInt(parsed.scale - 2);
  return parsed.units % divisor === 0n ? parsed.units / divisor : null;
}

/**
 * A customer's credit position, read through the read model's declared
 * dependency queries under current policy (SALES-EXTRAS), in one currency
 * across every company of the tenant -- the same figures the receivables
 * capability checks when an order is confirmed. A withheld read of any
 * company's invoices or orders states no figures rather than a partial sum;
 * so does a confirmed order whose total cannot be stated.
 */
export async function readCreditPosition(input: {
  readonly view: RequestRuntimeView;
  readonly gateway: Read;
  /** Dependency keys to query ids: companies, invoices, orders, lines. */
  readonly queries: Readonly<Record<string, { readonly targetId: string }>>;
  readonly namespace: string;
  readonly party: SemanticRecordDto;
  /** The currency the figures are in: the order's, else the customer's. */
  readonly currency: string | null;
}): Promise<CreditPosition> {
  const { view, gateway, namespace: ns } = input;
  const field = (name: string) => `${ns}:field.${name}`;
  const values = input.party.values;
  const hold = values[field('party_credit_hold')] === true;
  const limitCents = creditLimitCents(values[field('party_credit_limit')]);
  // The customer's currency is an enumeration whose options are its codes:
  // `party_default_currency_cad` is CAD.
  const stored = values[field('party_default_currency')];
  const marker = ':option.party_default_currency_';
  const limitCurrency =
    typeof stored === 'string' && stored.includes(marker)
      ? stored.slice(stored.indexOf(marker) + marker.length).toUpperCase()
      : null;
  const currency = input.currency ?? limitCurrency;
  const position = (
    openBalanceCents: bigint | null,
    onOrderCents: bigint | null,
  ) =>
    creditPosition({
      hold,
      limitCents,
      sameCurrency: currency !== null && limitCurrency === currency,
      openBalanceCents,
      onOrderCents,
    });
  if (currency === null) return position(null, null);
  const dependency = (key: string): RegisteredSemanticQueryDefinition => {
    const queryId = input.queries[key]?.targetId;
    const query = queryId
      ? registeredSemanticQueryFromPinnedView(view, queryId)
      : null;
    if (!query || query.queryType !== 'list' || query.readModel)
      throw new Error('Invalid credit read-model dependency');
    return query;
  };
  /** Every record a dependency List returns under one company and filter. */
  const every = async (
    key: string,
    company: string | null,
    list: Readonly<{
      parentScope?: { relationId: string; recordId: string };
      referenceScope?: { relationId: string; recordId: string };
      fieldFilters?: readonly { fieldId: string; value: string }[];
    }>,
  ): Promise<SemanticRecordDto[]> => {
    const query = dependency(key);
    const records: SemanticRecordDto[] = [];
    let cursor: string | null = null;
    do {
      const page: ReturnType<
        typeof requireSharedListResult<SemanticRecordDto>
      > = requireSharedListResult(
        await gateway.invoke(view, {
          schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
          queryId: query.queryId,
          arguments: {
            includeArchived: false,
            ...(query.legalEntityScope
              ? { [query.legalEntityScope.operand.parameterId]: company }
              : {}),
            list: {
              schemaVersion: SHARED_LIST_QUERY_VERSION,
              cursor,
              matchMode: 'substring',
              pageSize: 100,
              search: '',
              sort: [],
              relationLabels: [],
              ...(list.parentScope ? { parentScope: list.parentScope } : {}),
              ...(list.referenceScope
                ? { referenceScope: list.referenceScope }
                : {}),
              ...(list.fieldFilters
                ? { fieldFilters: list.fieldFilters.map((value) => value) }
                : {}),
            },
          },
        }),
      );
      const coverage = page.listCoverage;
      const scope = list.parentScope ?? list.referenceScope;
      const applied = list.parentScope
        ? coverage.parentScope
        : coverage.referenceScope;
      if (
        (scope &&
          (applied?.recordId !== scope.recordId ||
            applied.relationId !== scope.relationId)) ||
        (list.fieldFilters &&
          JSON.stringify(coverage.fieldFilters ?? null) !==
            JSON.stringify(list.fieldFilters))
      )
        throw new Error('Unapplied credit read-model restriction');
      records.push(...page.records);
      if (
        coverage.hasMore &&
        (!page.records.length ||
          cursor === coverage.nextCursor ||
          records.length > 1000)
      )
        throw new Error('Incomplete credit read model');
      cursor = coverage.nextCursor;
    } while (cursor !== null);
    return records;
  };
  const customer = input.party.recordId;
  const invoice = (name: string) => field(`customer_invoice_${name}`);
  const order = (name: string) => field(`sales_order_${name}`);
  const line = (name: string) => field(`sales_order_line_${name}`);
  const frozenRate = (
    taxCodeId: ImmutableJsonValue | undefined,
    rate: ImmutableJsonValue | undefined,
  ): string | null | undefined =>
    typeof taxCodeId !== 'string' || taxCodeId === ''
      ? undefined
      : typeof rate === 'string' && rate !== ''
        ? rate
        : null;
  try {
    let open = 0n;
    let onOrder = 0n;
    for (const company of await every('companies', null, {})) {
      for (const state of ['open', 'partially_paid'])
        for (const record of await every('invoices', company.recordId, {
          fieldFilters: [
            { fieldId: invoice('customer_party_id'), value: customer },
            { fieldId: invoice('currency'), value: currency },
            {
              fieldId: invoice('state'),
              value: `${ns}:option.customer_invoice_state_${state}`,
            },
          ],
        })) {
          const balance = cents(record.values[invoice('balance')]);
          if (balance === null) return position(null, null);
          open += balance;
        }
      for (const confirmed of await every('orders', company.recordId, {
        fieldFilters: [
          { fieldId: order('customer_party_id'), value: customer },
          { fieldId: order('currency'), value: currency },
          {
            fieldId: `${ns}:derived_state_field.machine.sales_order_lifecycle`,
            value: `${ns}:state.sales_order_released`,
          },
        ],
      })) {
        const total = orderTotalCents(
          (
            await every('lines', company.recordId, {
              parentScope: {
                relationId: `${ns}:relation.sales_order_line_order`,
                recordId: confirmed.recordId,
              },
            })
          ).map((value) => ({
            quantity: value.values[line('ordered_quantity')],
            unitPrice: value.values[line('unit_price')],
            discountPercent: value.values[line('discount_percent')],
            taxRatePercent: frozenRate(
              value.values[line('tax_code_id')],
              value.values[line('tax_rate_percent')],
            ),
          })),
          (['freight', 'other_fee'] as const).map((charge) => ({
            amount: confirmed.values[order(`${charge}_amount`)],
            taxRatePercent: frozenRate(
              confirmed.values[order(`${charge}_tax_code_id`)],
              confirmed.values[order(`${charge}_tax_rate_percent`)],
            ),
          })),
        );
        if (total === null) return position(null, null);
        let invoiced = 0n;
        for (const document of await every('invoices', company.recordId, {
          referenceScope: {
            relationId: `${ns}:relation.customer_invoice_order`,
            recordId: confirmed.recordId,
          },
        })) {
          const state = String(document.values[invoice('state')]);
          if (
            !['open', 'partially_paid', 'paid'].some(
              (value) =>
                state === `${ns}:option.customer_invoice_state_${value}`,
            )
          )
            continue;
          const documentTotal = cents(document.values[invoice('total')]);
          if (documentTotal === null) return position(null, null);
          invoiced += documentTotal;
        }
        if (total > invoiced) onOrder += total - invoiced;
      }
    }
    return position(open, onOrder);
  } catch (error) {
    if (!(error instanceof SemanticQueryPolicyDeniedError)) throw error;
    return position(null, null);
  }
}

/** The read-model outputs of a credit position, by output name. */
export function creditOutputs(
  position: CreditPosition | null,
): Readonly<Record<(typeof CREDIT_READ_MODEL_OUTPUTS)[number], string | null>> {
  const money = (value: bigint | null | undefined) =>
    value === null || value === undefined ? null : formatCents(value);
  return {
    customer_credit_limit: money(position?.limitCents),
    customer_open_balance: money(position?.openBalanceCents),
    customer_on_order: money(position?.onOrderCents),
    customer_available_credit: money(position?.availableCents),
    customer_credit_status: position?.status ?? null,
  };
}
