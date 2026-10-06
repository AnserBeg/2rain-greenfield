import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CanonicalModelError,
  SurfaceCompositionSchema,
  SurfaceLauncherSchema,
  SurfaceWorkspaceSchema,
  normalizeApplicationPackage,
} from '../../../packages/canonical-model/src/index.js';
import { composedApplicationDefinition } from '../../../packages/domain/src/app/builder.js';

type Json = Record<string, unknown>;
interface Launcher {
  tiles: Array<{ tileId: string; surface: string; view?: string }>;
  scan?: {
    label: string;
    actionLabel: string;
    targets: Array<{ query: string; surface: string }>;
  };
}
const ns = 'northstar.app';
const warehouse = `${ns}:surface.inventory_warehouse`;
const id = (kind: string, local: string) => `${ns}:${kind}.${local}`;

function application(): Json & { surfaces: Json[] } {
  return structuredClone(composedApplicationDefinition()) as Json & {
    surfaces: Json[];
  };
}

function surfaceOf(app: ReturnType<typeof application>, surfaceId: string) {
  return app.surfaces.find((value) => value.surfaceId === surfaceId)!;
}

function launcherOf(app: ReturnType<typeof application>): Launcher {
  return surfaceOf(app, warehouse).launcher as Launcher;
}

/** The refusal's reasons, or a failure when the declaration is accepted. */
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

test('WAREHOUSE-MODE: the Warehouse is a launcher Task in navigation, its tiles open declared List views and its scan opens documents by number, then items by SKU', () => {
  const normalized = normalizeApplicationPackage(
    composedApplicationDefinition() as never,
  );
  const surface = normalized.surfaces.find(
    (value) => value.surfaceId === warehouse,
  )!;
  assert.equal(surface.archetype, 'task');
  assert.equal(surface.label, 'Warehouse');
  assert.equal(
    surface.dataSource.targetId,
    id('query', 'inventory_movement_on_hand'),
  );
  const workspace = SurfaceWorkspaceSchema.parse(
    'workspace' in surface && surface.workspace,
  );
  assert.equal(workspace.membership, 'operational');
  assert.equal(
    workspace.entry?.authorizationQueryId,
    id('query', 'posted_stock_balance_list'),
  );
  const launcher = SurfaceLauncherSchema.parse(
    'launcher' in surface && surface.launcher,
  );
  assert.deepEqual(
    launcher.tiles.map((tile) => [tile.label, tile.surface, tile.view]),
    [
      [
        'Receive',
        id('surface', 'expected_receipt_list'),
        id('list_view', 'expected_receipt_list_to_receive'),
      ],
      [
        'Put away',
        id('surface', 'inventory_transaction_list'),
        id('list_view', 'inventory_transaction_list_transfers'),
      ],
      [
        'Pick and ship',
        id('surface', 'sales_order_list'),
        id('list_view', 'sales_order_list_to_ship'),
      ],
    ],
  );
  // Documents by their numbers first, in this order, then items by SKU; a
  // stock count waits for STOCK-COUNTS, so it has no tile or target.
  assert.deepEqual(
    launcher.scan?.targets.map((target) => [target.query, target.surface]),
    [
      'purchase_order',
      'sales_order',
      'goods_receipt',
      'shipment',
      'inventory_transaction',
      'item',
    ].map((local) => [
      id('query', `${local}_resolve`),
      id('surface', `${local}_detail`),
    ]),
  );
  // The on-hand lookup it reads stays the contextual lookup it was.
  const lookup = normalized.surfaces.find(
    (value) => value.surfaceId === id('surface', 'inventory_on_hand_lookup'),
  )!;
  assert.equal(
    SurfaceWorkspaceSchema.parse('workspace' in lookup && lookup.workspace)
      .membership,
    'contextual',
  );
  assert.equal('launcher' in lookup, false);
});

test('WAREHOUSE-MODE: a launcher is refused by name off a Task, over an undeclared List view, or with a scan target that cannot open exactly one record of its entity', () => {
  // Only a Task launches; only a launcher Task is a navigation member.
  assert.match(
    refused((app) => {
      const list = surfaceOf(app, id('surface', 'inventory_transaction_list'));
      list.launcher = surfaceOf(app, warehouse).launcher;
    }),
    /a launcher belongs to a Task surface/u,
  );
  assert.match(
    refused((app) => {
      const lookup = surfaceOf(app, id('surface', 'inventory_on_hand_lookup'));
      lookup.workspace = { membership: 'operational' };
    }),
    /navigation members must be Lists or launcher Tasks/u,
  );
  // Tiles: unique, each an active declared List, at a view it declares.
  assert.match(
    refused((app) => {
      const launcher = launcherOf(app);
      launcher.tiles[1]!.tileId = launcher.tiles[0]!.tileId;
    }),
    /launcher tile ids must be unique/u,
  );
  for (const target of [
    id('surface', 'item_detail'),
    id('surface', 'inventory_period_lock_list'),
    id('surface', 'missing_list'),
  ])
    assert.match(
      refused((app) => {
        const tile = launcherOf(app).tiles[0]!;
        tile.surface = target;
        delete tile.view;
      }),
      /a launcher tile opens an active declared List/u,
      target,
    );
  assert.match(
    refused((app) => {
      launcherOf(app).tiles[0]!.view = id(
        'list_view',
        'sales_order_list_to_ship',
      );
    }),
    /a launcher tile's view is one its List declares/u,
  );
  // Scan targets: an active resolve query with an identifier key, opening a
  // record page of the same entity, one target per entity.
  for (const query of [
    id('query', 'item_list'),
    // Its only key is advisory: a label, never an exact code.
    id('query', 'party_address_resolve'),
  ])
    assert.match(
      refused((app) => {
        launcherOf(app).scan!.targets[5]!.query = query;
      }),
      /a scan target resolves an exact identifier through an active resolve query/u,
      query,
    );
  for (const page of [
    id('surface', 'sales_order_detail'),
    id('surface', 'purchase_order_list'),
  ])
    assert.match(
      refused((app) => {
        launcherOf(app).scan!.targets[0]!.surface = page;
      }),
      /a scan target opens a record page of the entity it resolves/u,
      page,
    );
  assert.match(
    refused((app) => {
      const targets = launcherOf(app).scan!.targets;
      targets.push({ ...targets[0]! });
    }),
    /launcher scan targets \(one per entity\) must be unique/u,
  );
});

test('WAREHOUSE-MODE: the period lock page offers Close and Reopen as its own operations, Reopen only while a period is closed', () => {
  const normalized = normalizeApplicationPackage(
    composedApplicationDefinition() as never,
  );
  const page = normalized.surfaces.find(
    (value) =>
      value.surfaceId === id('surface', 'inventory_period_lock_detail'),
  )!;
  const composition = SurfaceCompositionSchema.parse(
    'composition' in page && page.composition,
  );
  assert.deepEqual(
    page.slots.map((slot) => slot.slot),
    [
      'breadcrumb',
      'titleStatus',
      'commandBar',
      'sections',
      'childTables',
      'keyFacts',
    ],
  );
  const closedThrough = id('field', 'inventory_period_lock_closed_through');
  assert.deepEqual(
    composition.actions.map((action) => ({
      label: action.label,
      inputs: action.inputs.map((input) => [
        input.label,
        input.type,
        input.required,
      ]),
      operations: action.steps.map((step) => step.operation.targetId),
      conditions: action.conditions,
    })),
    [
      {
        label: 'Close period through',
        inputs: [['Close through', 'instant', true]],
        operations: [id('operation', 'advance_period_lock')],
        conditions: [],
      },
      {
        label: 'Reopen to',
        inputs: [['Reopen to', 'instant', true]],
        operations: [id('operation', 'reopen_period')],
        conditions: [
          {
            value: { source: 'record', field: closedThrough },
            operator: 'notEquals',
            compare: null,
          },
        ],
      },
    ],
  );
});
