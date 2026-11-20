// The eval seed fixes the names and values. Both revisions receive the same
// declarations and prompts. Production code has no dependency on this module.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { openCustomizeService } from '../../apps/api/src/composition-root.js';
import {
  parseCustomizationPatch,
  recordTypeEntityId,
  slug,
  type CustomizationPatch,
} from '../../packages/customization/src/index.js';
import {
  localName,
  pinnedCatalog,
} from '../../packages/operations-agent/src/catalog.js';
import { type AgentWorld, NS } from './agent-world.js';
import { f, ids, NAMES, op, purchaseOrder, q, rel } from './arrange.js';
import { listRows, readRecord, type DevTask } from './dev-tasks.js';

type Shape = 'record' | 'link' | 'lines' | 'status';
type Group = 'first-party' | 'generated';
const shapes = ['record', 'link', 'lines', 'status'] as const;
const nouns = [
  ['Badge desk', 'Access desk', 'Dispatch desk'],
  ['Asset tag', 'Stock tag', 'Service tag'],
  ['Packing sheet', 'Handover sheet', 'Delivery sheet'],
  ['Site permit', 'Travel permit', 'Workshop permit'],
] as const;

interface Journey {
  label: string;
  entity: string;
  operation: string;
  prepare(world: AgentWorld): Promise<{ parent?: string }>;
  request: string;
  // Verify ordinary records, including the exact relationship on a scoped list.
  values: Record<string, string>;
  scope?: {
    kind: 'parentScope' | 'referenceScope';
    relation: string;
    target?: string;
  };
  screen?: string;
  transition?: boolean;
}
export interface ProofTask extends DevTask {
  group: Group;
  shape: Shape;
  expectedOperation: string;
}

function taskFor(
  journey: Journey,
  id: number,
  shape: Shape,
  group: Group,
): ProofTask {
  const query = q(`${journey.entity}_list`);
  return {
    id,
    shape,
    group,
    kind: group === 'generated' ? 'customized' : 'write',
    actor: 'manager',
    expectedOperation: op(journey.operation),
    title: `${group} ${shape}: ${journey.label}`,
    async arrange(world) {
      const context = await journey.prepare(world);
      return {
        ...context,
        beforeIds: (await listRows(world, query)).map((r) => r.recordId),
      };
    },
    request: () => journey.request,
    ...(journey.screen
      ? {
          screen: (context: Record<string, unknown>) => ({
            surfaceId: `${NS}:surface.${journey.screen}_detail`,
            recordId: String(context.parent),
          }),
        }
      : {}),
    async check(world, context) {
      if (journey.transition) {
        const effect = await world.runtime.entry.run(
          { headers: { cookie: 'northstar-demo-actor=manager' } },
          async (view) =>
            pinnedCatalog(view).operation(journey.operation)?.effect,
        );
        assert.ok(effect?.kind === 'transitionStateEffect');
        const record = await readRecord(
          world,
          journey.entity,
          String(context.parent),
        );
        const pass = record.values[effect.stateFieldId] === effect.toStateId;
        return {
          pass,
          reason: pass
            ? 'declared target state observed on the named record'
            : 'target state missing',
        };
      }
      const scope = journey.scope;
      const filter = scope
        ? {
            [scope.kind]: {
              relationId: rel(scope.relation),
              recordId: scope.target ?? String(context.parent),
            },
          }
        : {};
      const rows = (await listRows(world, query, filter)).filter(
        (row) => !(context.beforeIds as string[]).includes(row.recordId),
      );
      const pass =
        rows.length === 1 &&
        Object.entries(journey.values).every(([field, value]) => {
          const observed = rows[0]!.values[f(`${journey.entity}_${field}`)];
          return (
            observed === value ||
            (typeof observed === 'string' &&
              /^-?\d+\.\d+$/u.test(observed) &&
              Number(observed) === Number(value))
          );
        });
      return {
        pass,
        reason: pass
          ? 'one new matching row with the declared values and ownership'
          : 'row count, values or ownership differ',
      };
    },
  };
}

export function generatedProof(seed: string) {
  const hash = createHash('sha256').update(seed).digest();
  const code = `EVAL-${hash.subarray(0, 3).toString('hex').toUpperCase()}`;
  const tasks: ProofTask[] = [];
  const changes: CustomizationPatch[] = [];
  const noParent = async () => ({});
  const draftOrder = async (world: AgentWorld) => ({
    parent: (await purchaseOrder(world, ids().cascade, [], false)).recordId,
  });
  for (const [i, shape] of shapes.entries()) {
    const members: Record<string, unknown>[] = [];
    const labels = nouns[i]!;
    const label = labels[hash[i]! % labels.length]!;
    const entity = recordTypeEntityId(NS, label);
    const local = localName(entity);
    const fields = [
      { label: 'Name', type: 'text' },
      ...(shape === 'record'
        ? [{ label: 'Code', type: 'text', required: true }]
        : []),
    ];
    members.push({
      kind: 'addRecordType',
      label,
      companyOwnership: shape === 'record' ? 'tenantShared' : 'entityOwned',
      fields,
    });
    const makeParent = async (world: AgentWorld) => ({
      parent: (await world.create(local, { name: code })).recordId,
    });
    let generated: Journey;
    let control: Journey;
    switch (shape) {
      case 'record':
        generated = {
          label,
          entity: local,
          operation: `${local}_create`,
          prepare: noParent,
          request: `Create a ${label} with ${fields[0]!.label} Pine Ridge and ${fields[1]!.label} ${code}.`,
          values: { name: 'Pine Ridge', code },
        };
        control = {
          label: 'Store location',
          entity: 'location',
          operation: 'location_create',
          prepare: noParent,
          request: `Create a store location with name Pine Ridge and code ${code}.`,
          values: { name: 'Pine Ridge', code, type: `${NS}:option.store` },
        };
        break;
      case 'link': {
        const link = {
          kind: 'addLink',
          entity,
          label: 'Item',
          target: `${NS}:entity.item`,
        };
        members.push(link);
        generated = {
          label,
          entity: local,
          operation: `${local}_create`,
          prepare: noParent,
          request: `Create a ${label} named ${code} linked to ${NAMES.notebook} as its ${link.label}.`,
          values: { name: code },
          scope: {
            kind: 'referenceScope',
            relation: `${local}_${slug(link.label)}`,
            target: ids().notebook,
          },
        };
        control = {
          label: 'Item alias',
          entity: 'item_alias',
          operation: 'item_alias_create',
          prepare: noParent,
          request: `Create an alternate SKU alias with value ${code} for the item ${NAMES.notebook}.`,
          values: {
            value: code,
            kind: `${NS}:option.item_alias_kind_alternate_sku`,
          },
          scope: {
            kind: 'parentScope',
            relation: 'item_alias_item',
            target: ids().notebook,
          },
        };
        break;
      }
      case 'lines': {
        const line = {
          kind: 'addLineTable',
          entity,
          label: 'Entries',
          fields: [
            { label: 'Description', type: 'text', required: true },
            { label: 'Quantity', type: 'number', required: true },
          ],
        };
        members.push(line);
        generated = {
          label,
          entity: `${local}_lines`,
          operation: `${local}_lines_create`,
          prepare: makeParent,
          request: `Add line 1 to this ${label}'s ${line.label}: ${line.fields[0]!.label} ${code}, ${line.fields[1]!.label} 3.`,
          values: { line_number: '1', description: code, quantity: '3' },
          scope: { kind: 'parentScope', relation: `${local}_lines_parent` },
          screen: local,
        };
        control = {
          label: 'Purchase order',
          entity: 'purchase_order_line',
          operation: 'purchase_order_line_create',
          prepare: draftOrder,
          request: `Add line 1 to this purchase order for 3 ${NAMES.notebook} at CAD 12 each.`,
          values: {
            line_number: '1',
            item_id: ids().notebook,
            ordered_quantity: '3',
            unit_price: '12',
          },
          scope: { kind: 'parentScope', relation: 'purchase_order_line_order' },
          screen: 'purchase_order',
        };
        break;
      }
      case 'status': {
        const transition = { label: 'Close', from: 'Open', to: 'Closed' };
        members.push({
          kind: 'declareLifecycle',
          entity,
          initial: transition.from,
          states: [
            { label: transition.from, role: 'inProgress' },
            { label: transition.to, role: 'success' },
          ],
          transitions: [transition],
        });
        generated = {
          label,
          entity: local,
          operation: `${local}_action_${slug(transition.label)}`,
          prepare: makeParent,
          request: `${transition.label} this ${label}.`,
          values: {},
          screen: local,
          transition: true,
        };
        control = {
          label: 'Purchase order',
          entity: 'purchase_order',
          operation: 'purchase_order_draft_cancel',
          prepare: draftOrder,
          request: 'Cancel this draft purchase order.',
          values: {},
          screen: 'purchase_order',
          transition: true,
        };
        break;
      }
    }
    // Alternate which group is first, including which group sees a cold prompt.
    const pair = [
      taskFor(control, 200 + 2 * i, shape, 'first-party'),
      taskFor(generated, 201 + 2 * i, shape, 'generated'),
    ];
    tasks.push(...(i % 2 ? pair.reverse() : pair));
    const parsed = parseCustomizationPatch(
      members.length === 1
        ? members[0]
        : { kind: 'changeSet', patches: members },
    );
    assert.equal(parsed.status, 'parsed');
    changes.push(parsed.patch);
  }
  return { tasks, changes };
}

export async function installProof(
  world: AgentWorld,
  changes: readonly CustomizationPatch[],
) {
  const opened = await openCustomizeService({
    databaseUrl: world.databaseUrl,
    tenantSlug: world.tenantSlug,
  });
  try {
    for (const change of changes) {
      const draft = await opened.service.draft(change, 'declarativeEditor');
      assert.equal(
        draft.status,
        'drafted',
        JSON.stringify(draft.status === 'drafted' ? null : draft),
      );
      await opened.service.approve(draft.patchId);
      const result = await opened.service.activate(draft.patchId);
      assert.equal(result.status, 'activated');
      assert.equal(result.releaseId, draft.releaseId);
    }
  } finally {
    await opened.close();
  }
}
