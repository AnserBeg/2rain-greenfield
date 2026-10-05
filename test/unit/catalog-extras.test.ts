import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CanonicalModelError,
  normalizeApplicationPackage,
} from '../../packages/canonical-model/src/index.js';
import { composedApplicationDefinition } from '../../packages/domain/src/app/builder.js';
import { catalogModuleDefinition } from '../../packages/domain/src/catalog/index.js';
import { inventoryModuleDefinition } from '../../packages/domain/src/inventory/definition.js';
import {
  parseSharedListArguments,
  requireSharedListEcho,
  SharedListContractError,
  type SharedListCoverage,
} from '../../packages/runtime/src/list-behavior/index.js';
import { parseSharedListFigures } from '../../packages/runtime/src/list-behavior/figures.js';

/**
 * CATALOG-EXTRAS: an item's aliases, its inventory policy and reorder rule, a
 * company's reorder percentage, and the grammar that carries them -- a
 * search through children, List figure choices, band cases by the row's own
 * enumeration or against a figure, and a Task input that leaves the record
 * out. Declarations as the product ships them, then one refusal per misuse.
 */
type Json = Record<string, unknown>;
const ns = 'northstar.app';
const id = (kind: string, local: string) => `${ns}:${kind}.${local}`;

function application(): Json & {
  fields: Json[];
  queries: Json[];
  relations: Json[];
  surfaces: Json[];
} {
  return structuredClone(composedApplicationDefinition()) as never;
}

function surfaceOf(app: ReturnType<typeof application>, local: string) {
  return app.surfaces.find(
    (value) => value.surfaceId === id('surface', local),
  )!;
}

function listOf(app: ReturnType<typeof application>, local: string) {
  return surfaceOf(app, local).list as Json & {
    columns: Json[];
    views: Json[];
    figures?: Json & {
      choices?: Array<
        Json & {
          by: string;
          cases: Array<Json & { values: string[]; value?: Json }>;
          otherwise?: Json;
        }
      >;
      bands?: Array<Json & { figureId: string; cases: Json[] }>;
      latest?: Array<Json & { figureId: string }>;
    };
    searchChildren?: Array<Json & { relation: string; field: string }>;
  };
}

function refused(mutate: (app: ReturnType<typeof application>) => void) {
  const app = application();
  mutate(app);
  try {
    normalizeApplicationPackage(app as never);
  } catch (error) {
    assert.ok(error instanceof CanonicalModelError, String(error));
    return error.diagnostics.map((diagnostic) => diagnostic.rule).join(' ');
  }
  assert.fail('the declaration was accepted');
}

test('CATALOG-EXTRAS: the product mounts aliases, an inventory policy and a reorder rule; the standalone Catalog does not', () => {
  const app = application();
  assert.doesNotThrow(() => normalizeApplicationPackage(app as never));
  const field = (local: string) =>
    app.fields.find((value) => value.fieldId === id('field', local)) as
      | (Json & {
          presence: string;
          defaultSemantics: string;
          defaultValue?: { value: string };
          businessKey?: string;
          fieldType: { kind: string; options?: Array<{ optionId: string }> };
        })
      | undefined;
  // Unset reads as stocked and manual: both are optional, stored as their
  // declared default, so every existing create path is unchanged.
  for (const [local, defaultOption] of [
    ['item_inventory_policy', 'item_inventory_policy_stocked'],
    ['item_reorder_rule', 'item_reorder_rule_manual'],
  ] as const) {
    assert.equal(field(local)?.presence, 'optional', local);
    assert.equal(field(local)?.defaultSemantics, 'declaredDefault', local);
    assert.equal(
      field(local)?.defaultValue?.value,
      id('option', defaultOption),
    );
  }
  assert.deepEqual(
    field('item_inventory_policy')?.fieldType.options?.map(
      (value) => value.optionId,
    ),
    [
      id('option', 'item_inventory_policy_stocked'),
      id('option', 'item_inventory_policy_non_stocked'),
    ],
  );
  // An alias is unique across the business, as a SKU is.
  assert.equal(
    field('item_alias_value')?.businessKey,
    'tenantEnvironmentCaseInsensitiveUnique',
  );
  assert.equal(field('item_alias_value')?.presence, 'required');
  // It belongs to its item, which is archived only once it names none.
  const relation = app.relations.find(
    (value) => value.relationId === id('relation', 'item_alias_item'),
  ) as Json & { sourceEntity: { targetId: string } };
  assert.equal(relation.ownership, 'parentScopedChild');
  assert.equal(relation.archiveBehavior, 'restrict');
  assert.equal(relation.required, true);
  assert.equal(relation.sourceEntity.targetId, id('entity', 'item_alias'));
  // The company's percentage is the legal entity's own optional field, read
  // by every legal entity query.
  assert.equal(
    field('legal_entity_reorder_point_percent')?.presence,
    'optional',
  );
  for (const queryType of ['get', 'list', 'search', 'resolve'])
    assert.ok(
      (
        app.queries.find(
          (value) => value.queryId === id('query', `legal_entity_${queryType}`),
        )!.selections as Array<{ field: { targetId: string } }>
      ).some(
        (selection) =>
          selection.field.targetId ===
          id('field', 'legal_entity_reorder_point_percent'),
      ),
      queryType,
    );

  // The standalone harnesses keep the modules they have always compiled.
  assert.deepEqual(
    catalogModuleDefinition(ns, { catalogExtras: false }),
    catalogModuleDefinition(ns),
  );
  assert.equal(
    JSON.stringify(catalogModuleDefinition(ns, { sellingPrices: true })).match(
      /item_alias|inventory_policy|reorder_rule/u,
    ),
    null,
  );
  assert.equal(
    JSON.stringify(
      inventoryModuleDefinition(ns, { documentEntry: true }),
    ).includes('reorder_point_percent'),
    false,
  );
  // The aliases are an item's: contextual, owned by the Items List.
  const aliases = surfaceOf(app, 'item_alias_list') as Json & {
    workspace: { membership: string; ownerSurfaceId?: string };
  };
  assert.equal(aliases.workspace.membership, 'contextual');
  assert.equal(aliases.workspace.ownerSurfaceId, id('surface', 'item_list'));
});

test('CATALOG-EXTRAS: an item is found by an alias in the Items List and in every product picker', () => {
  const app = application();
  const child = {
    relation: id('relation', 'item_alias_item'),
    field: id('field', 'item_alias_value'),
  };
  const items = listOf(app, 'item_list');
  assert.deepEqual(
    items.searchChildren?.map((value) => ({
      query: (value.query as { targetId: string }).targetId,
      relation: value.relation,
      field: value.field,
    })),
    [{ query: id('query', 'item_alias_list'), ...child }],
  );
  // Its tabs keep each inventory policy.
  assert.deepEqual(
    items.views.map((view) => [
      view.label,
      (view.filters as Array<{ value: string }>).map((value) => value.value),
    ]),
    [
      ['All', []],
      ['Stocked', [id('option', 'item_inventory_policy_stocked')]],
      ['Non-stocked', [id('option', 'item_inventory_policy_non_stocked')]],
    ],
  );
  type Editor = {
    lineFields: Array<{
      fieldId: string;
      reference?: { searchChildren?: unknown };
    }>;
  };
  const picker = (surface: string, fieldId: string) =>
    (surfaceOf(app, surface).documentEditor as Editor).lineFields.find(
      (value) => value.fieldId === id('field', fieldId),
    )!.reference!.searchChildren;
  for (const [surface, fieldId] of [
    ['sales_order_detail', 'sales_order_line_item_id'],
    ['purchase_order_detail', 'purchase_order_line_item_id'],
    ['inventory_transaction_detail', 'inventory_transaction_line_item_id'],
  ] as const)
    assert.deepEqual(
      picker(surface, fieldId),
      [
        {
          queryId: id('query', 'item_alias_list'),
          relationId: child.relation,
          fieldId: child.field,
        },
      ],
      surface,
    );
});

test('CATALOG-EXTRAS: the stock Lists derive the reorder point from the item rule and never judge a non-stocked item', () => {
  const app = application();
  for (const local of ['item_stock_list', 'item_buying_list']) {
    const figures = listOf(app, local).figures!;
    const reorderPoint = id('list_figure', `${local}_reorder_point`);
    assert.deepEqual(figures.choices, [
      {
        figureId: reorderPoint,
        by: id('field', 'item_reorder_rule'),
        cases: [
          {
            values: [id('option', 'item_reorder_rule_company')],
            value: {
              percent: {
                of: { field: id('field', 'item_reorder_up_to') },
                company: {
                  query: {
                    kind: 'queryReference',
                    schemaVersion: 'v6',
                    targetId: id('query', 'legal_entity_list'),
                  },
                  field: id('field', 'legal_entity_reorder_point_percent'),
                },
              },
            },
          },
        ],
        otherwise: { field: id('field', 'item_reorder_point') },
      },
    ]);
    const [band] = figures.bands!;
    // The non-stocked case comes first, so no kept range holds such an item.
    assert.deepEqual(band!.cases[0], {
      value: id('list_band', `${local}_not_stocked`),
      label: 'Not stocked',
      when: {
        field: id('field', 'item_inventory_policy'),
        values: [id('option', 'item_inventory_policy_non_stocked')],
      },
    });
    assert.deepEqual(band!.cases.at(-1)!.atMost, { figure: reorderPoint });
    // The column shows the point the band judges.
    assert.equal(
      listOf(app, local).columns.find((column) =>
        String(column.columnId).endsWith('_reorder_point'),
      )!.field,
      reorderPoint,
    );
  }
});

test('CATALOG-EXTRAS: the item page adds and removes aliases and merges a duplicate into another item', () => {
  const app = application();
  type Action = {
    actionId: string;
    datasetId?: string;
    conditions: unknown[];
    inputs: Array<Json & { excludeRecord?: true }>;
    steps: Array<{
      operation: { targetId: string };
      bindings: Array<{ path: string[]; value: Json }>;
    }>;
  };
  const composition = surfaceOf(app, 'item_detail').composition as {
    actions: Action[];
  };
  const action = (local: string) =>
    composition.actions.find(
      (value) => value.actionId === id('action', local),
    )!;
  assert.deepEqual(
    action('item_add_alias').steps.map((value) => value.operation.targetId),
    [id('operation', 'item_alias_create')],
  );
  // A merged SKU is not removed from here.
  assert.deepEqual(action('item_remove_alias').conditions, [
    {
      value: { source: 'selected', field: id('field', 'item_alias_kind') },
      operator: 'notEquals',
      compare: id('option', 'item_alias_kind_merged_sku'),
    },
  ]);
  const merge = action('item_merge');
  // The item is never offered as its own survivor.
  assert.equal(merge.inputs[0]!.excludeRecord, true);
  // Its SKU becomes the survivor's alias first, then it is archived; nothing
  // it posted is touched.
  assert.deepEqual(
    merge.steps.map((value) => value.operation.targetId),
    [id('operation', 'item_alias_create'), id('operation', 'item_archive')],
  );
  assert.deepEqual(
    Object.fromEntries(
      merge.steps[0]!.bindings.map((value) => [
        value.path.join('.'),
        value.value,
      ]),
    ),
    {
      recordId: { source: 'generated', value: 'uuid' },
      [`values.${id('field', 'item_alias_value')}`]: {
        source: 'record',
        field: id('field', 'item_sku'),
      },
      [`values.${id('field', 'item_alias_kind')}`]: {
        source: 'literal',
        value: id('option', 'item_alias_kind_merged_sku'),
      },
      [`relations.${id('relation', 'item_alias_item')}`]: {
        source: 'input',
        inputId: id('input', 'item_survivor'),
      },
    },
  );
});

test('CATALOG-EXTRAS: each misuse of the new grammar is refused by name', () => {
  const choice = (app: ReturnType<typeof application>) =>
    listOf(app, 'item_stock_list').figures!.choices![0]!;
  const statusBand = (app: ReturnType<typeof application>) =>
    listOf(app, 'item_stock_list').figures!.bands![0]!;
  const searched = (app: ReturnType<typeof application>) =>
    listOf(app, 'item_list').searchChildren![0]!;
  const queryRef = (local: string) => ({
    kind: 'queryReference',
    schemaVersion: 'v6',
    targetId: id('query', local),
  });
  const percent = (app: ReturnType<typeof application>) =>
    (choice(app).cases[0]!.value as { percent: { company: Json } }).percent;
  const cases: Array<[string, (app: ReturnType<typeof application>) => void]> =
    [
      [
        'a choice names options of an enumeration the List selects',
        (app) => {
          choice(app).by = id('field', 'item_reorder_up_to');
        },
      ],
      [
        'a choice names options of an enumeration the List selects',
        (app) => {
          choice(app).cases[0]!.values = [
            id('option', 'item_inventory_policy_stocked'),
          ];
        },
      ],
      [
        'choice values must be unique',
        (app) => {
          choice(app).cases.push({
            values: [id('option', 'item_reorder_rule_company')],
          });
        },
      ],
      [
        'a choice takes figures declared before it or exact decimals the List selects',
        (app) => {
          choice(app).otherwise = { field: id('field', 'item_name') };
        },
      ],
      [
        'a choice takes figures declared before it or exact decimals the List selects',
        (app) => {
          // Projected is a total, computed after the choices.
          choice(app).otherwise = {
            figure: id('list_figure', 'item_stock_list_projected'),
          };
        },
      ],
      [
        "a company's percentage is an exact decimal of an active unscoped q0 list query",
        (app) => {
          percent(app).company.query = queryRef('posted_stock_balance_list');
        },
      ],
      [
        "a company's percentage is an exact decimal of an active unscoped q0 list query",
        (app) => {
          percent(app).company.field = id('field', 'legal_entity_name');
        },
      ],
      [
        'a band case names options of an enumeration the List selects',
        (app) => {
          (statusBand(app).cases[0]!.when as Json).field = id(
            'field',
            'item_reorder_point',
          );
        },
      ],
      [
        'a band case names options of an enumeration the List selects',
        (app) => {
          (statusBand(app).cases[0]!.when as Json).values = [
            id('option', 'item_reorder_rule_company'),
          ];
        },
      ],
      [
        'a band case compares with one fixed decimal or exact decimal the List selects',
        (app) => {
          // A case holds one test, never an enumeration and a comparison.
          statusBand(app).cases[0]!.atMost = { value: '0' };
        },
      ],
      [
        'a band case compares with a figure declared before it',
        (app) => {
          const buying = listOf(app, 'item_buying_list').figures!;
          buying.bands![0]!.cases[1]!.atMost = {
            figure: buying.latest![0]!.figureId,
          };
        },
      ],
      [
        'a search through children reads an active unscoped q0 list query of the child entity',
        (app) => {
          searched(app).query = queryRef('posted_stock_balance_list');
        },
      ],
      [
        'a search through children follows their parentScopedChild relation to the searched entity',
        (app) => {
          searched(app).relation = id('relation', 'party_address_party');
        },
      ],
      [
        'a search through children matches a text field their list query selects',
        (app) => {
          searched(app).field = id('field', 'item_alias_kind');
        },
      ],
      [
        'search children relations must be unique',
        (app) => {
          const list = listOf(app, 'item_list');
          list.searchChildren = [
            searched(app),
            structuredClone(list.searchChildren![0]!),
          ];
        },
      ],
      [
        'a search through children follows their parentScopedChild relation to the searched entity',
        (app) => {
          // A picker's search through another entity's children.
          type Editor = {
            lineFields: Array<{
              fieldId: string;
              reference?: { searchChildren?: Array<{ relationId: string }> };
            }>;
          };
          (
            surfaceOf(app, 'sales_order_detail').documentEditor as Editor
          ).lineFields.find(
            (value) =>
              value.fieldId === id('field', 'sales_order_line_item_id'),
          )!.reference!.searchChildren![0]!.relationId = id(
            'relation',
            'party_role_party',
          );
        },
      ],
      [
        "only a reference input over the record's own entity leaves the record out",
        (app) => {
          // The add-alias Task's kind is text, not a reference.
          const composition = surfaceOf(app, 'item_detail').composition as {
            actions: Array<{ actionId: string; inputs: Json[] }>;
          };
          composition.actions.find(
            (value) => value.actionId === id('action', 'item_add_alias'),
          )!.inputs[1]!.excludeRecord = true;
        },
      ],
      [
        "only a reference input over the record's own entity leaves the record out",
        (app) => {
          // A survivor chosen from the locations is not this item's peer.
          const composition = surfaceOf(app, 'item_detail').composition as {
            actions: Array<{ actionId: string; inputs: Json[] }>;
          };
          const input = composition.actions.find(
            (value) => value.actionId === id('action', 'item_merge'),
          )!.inputs[0]!;
          input.query = queryRef('location_list');
          input.labelField = {
            kind: 'fieldReference',
            schemaVersion: 'v6',
            targetId: id('field', 'location_code'),
          };
        },
      ],
    ];
  for (const [reason, mutate] of cases) {
    const rule = refused(mutate);
    assert.match(
      rule,
      new RegExp(reason.replace(/[()']/gu, '.')),
      `${reason} -> ${rule}`,
    );
  }
  // Closed keys: a choice member the runtime does not know is refused.
  assert.match(
    refused((app) => {
      choice(app).weights = [];
    }),
    /closed supported schema/u,
  );
});

test('CATALOG-EXTRAS: the shared List contract parses, binds and requires the echo of searched children and choices', () => {
  const queryId = id('query', 'item_list');
  const child = {
    fieldId: id('field', 'item_alias_value'),
    queryId: id('query', 'item_alias_list'),
    relationId: id('relation', 'item_alias_item'),
  };
  const request = (list: Json) => ({
    list: {
      cursor: null,
      matchMode: 'substring',
      pageSize: 50,
      relationLabels: [],
      schemaVersion: 'northstar.shared-list-query/v1',
      search: 'BC-0042',
      sort: [],
      ...list,
    },
  });
  const parse = (list: Json) =>
    parseSharedListArguments(request(list) as never, {
      declaredParameterIds: [],
      maximumResultCount: 100,
      queryId,
    })!;
  const malformed = (list: Json) =>
    assert.throws(
      () => parse(list),
      (error: unknown) =>
        error instanceof SharedListContractError &&
        error.code === 'LIST_INPUT_MALFORMED',
    );
  assert.deepEqual(parse({ searchChildren: [child] }).searchChildren, [child]);
  malformed({ searchChildren: [] });
  malformed({ searchChildren: [child, child] });
  malformed({ searchChildren: [{ ...child, extra: true }] });
  // A cursor minted without the children never pages a search with them.
  const plain = parse({});
  assert.equal(plain.searchChildren, undefined);
  // An executor that searched without them is refused.
  const coverage = {
    projectedSearchValueCount: 3,
  } as unknown as SharedListCoverage;
  assert.throws(
    () => requireSharedListEcho(parse({ searchChildren: [child] }), coverage),
    (error: unknown) =>
      error instanceof SharedListContractError &&
      error.code === 'LIST_RESULT_MALFORMED',
  );
  assert.doesNotThrow(() =>
    requireSharedListEcho(parse({ searchChildren: [child] }), {
      ...coverage,
      searchChildren: [child],
    }),
  );

  // Choices: computed after the sums and before the totals.
  const sums = [
    {
      figureId: id('list_figure', 'on_hand'),
      rows: {
        matchFieldId: id('field', 'posted_stock_balance_item_id'),
        queryId: id('query', 'posted_stock_balance_list'),
        quantityFieldId: id('field', 'posted_stock_balance_posted_quantity'),
      },
      sum: 'rows',
    },
  ];
  const point = {
    byFieldId: id('field', 'item_reorder_rule'),
    cases: [
      {
        value: {
          percent: {
            company: {
              fieldId: id('field', 'legal_entity_reorder_point_percent'),
              queryId: id('query', 'legal_entity_list'),
            },
            of: { fieldId: id('field', 'item_reorder_up_to') },
          },
        },
        values: [id('option', 'item_reorder_rule_company')],
      },
    ],
    figureId: id('list_figure', 'point'),
    otherwise: { fieldId: id('field', 'item_reorder_point') },
  };
  const band = {
    cases: [
      {
        value: id('list_band', 'not_stocked'),
        when: {
          fieldId: id('field', 'item_inventory_policy'),
          values: [id('option', 'item_inventory_policy_non_stocked')],
        },
      },
      {
        atMost: { figureId: id('list_figure', 'point') },
        value: id('list_band', 'due'),
      },
    ],
    figureId: id('list_figure', 'due'),
    of: id('list_figure', 'on_hand'),
    otherwise: id('list_band', 'covered'),
  };
  const parsed = parseSharedListFigures({
    bands: [band],
    choices: [point],
    sums,
  } as never);
  assert.deepEqual(parsed.choices, [point]);
  assert.deepEqual(parsed.bands, [band]);
  const refusedFigures = (figures: Json) =>
    assert.throws(
      () => parseSharedListFigures(figures as never),
      (error: unknown) =>
        error instanceof SharedListContractError &&
        error.code === 'LIST_INPUT_MALFORMED',
    );
  // A choice takes only a figure declared before it.
  refusedFigures({
    sums,
    choices: [
      { ...point, otherwise: { figureId: id('list_figure', 'later') } },
    ],
  });
  // Its values are unique across its cases.
  refusedFigures({
    sums,
    choices: [{ ...point, cases: [...point.cases, point.cases[0]] }],
  });
  // A band case holds one test.
  refusedFigures({
    sums,
    choices: [point],
    bands: [
      {
        ...band,
        cases: [{ ...band.cases[0], atMost: { value: '0' } }],
      },
    ],
  });
  // A threshold names a figure computed before the band.
  refusedFigures({
    sums,
    bands: [band],
  });
});
