/**
 * The first-party modules' immediate-edit declarations (AI-UNDO-1): for the
 * record types each module owns, the fields whose previous value puts a
 * change fully back, so the assistant may make them at once with Undo.
 *
 * Each module's own code reads its record types (posting, confirmation,
 * pricing, numbering), so every field it does not list here asks: fail
 * closed. This is first-party module code naming its own fields, supplied at
 * product assembly; the assistant's policy names none of them.
 *
 * The list is the one the assistant acted on before (the reviewed CRITFIX-A
 * snapshot, without the credit hold); widening it is a reviewed change to
 * this file, never a derivation.
 */
import type {
  ImmediateEditDeclaration,
  ImmediateField,
} from '../../../canonical-model/src/reversibility.js';

import {
  APPLICATION_NAMESPACE,
  composedApplicationDefinition,
} from './builder.js';

const NS = APPLICATION_NAMESPACE;

/** Plain fields of one record type, named by their local suffix. */
const plain = (entity: string, ...names: readonly string[]): ImmediateField[] =>
  names.map((name) => ({ fieldId: `${NS}:field.${entity}_${name}` }));

/** The fields each first-party module declares safe to change at once. */
const IMMEDIATE_FIELDS: Readonly<Record<string, readonly ImmediateField[]>> = {
  catalog: [
    ...plain('item', 'description', 'name'),
    ...plain('tax_code', 'name'),
  ],
  inventory: [
    ...plain('legal_entity', 'name'),
    {
      // A counted quantity can be put back only while its count is a draft:
      // review and posting read it.
      fieldId: `${NS}:field.stock_count_line_counted_quantity`,
      holdsWhile: {
        parents: [
          {
            relationId: `${NS}:relation.stock_count_line_session`,
            queryId: `${NS}:query.stock_count_get`,
            stateFieldId: `${NS}:field.stock_count_state`,
            stateIds: [`${NS}:option.stock_count_state_draft`],
            stateLabels: ['draft'],
          },
        ],
      },
    },
  ],
  location: plain('location', 'name'),
  // Not the credit hold or limit: confirmation reads them (AI-UNDO-1 slice 1).
  party: plain('party', 'contact_summary', 'name', 'payment_terms'),
  purchasing: plain('purchase_order', 'notes'),
  sales: plain('sales_order', 'notes'),
};

let declarations: readonly ImmediateEditDeclaration[] | undefined;

/** One declaration per first-party module, owning every record type it defines. */
export function firstPartyImmediateEdits(): readonly ImmediateEditDeclaration[] {
  if (declarations) return declarations;
  const definition = composedApplicationDefinition() as {
    entities: readonly {
      entityId: string;
      module: { targetId: string };
    }[];
  };
  const byModule = new Map<string, string[]>();
  for (const entity of definition.entities)
    byModule.set(entity.module.targetId, [
      ...(byModule.get(entity.module.targetId) ?? []),
      entity.entityId,
    ]);
  declarations = Object.freeze(
    [...byModule.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([moduleId, ownedEntityIds]) =>
        Object.freeze({
          owner: moduleId,
          ownedEntityIds: Object.freeze([...ownedEntityIds].sort()),
          immediateFields: Object.freeze([
            ...(IMMEDIATE_FIELDS[
              moduleId.slice(moduleId.lastIndexOf('.') + 1)
            ] ?? []),
          ]),
        }),
      ),
  );
  return declarations;
}
