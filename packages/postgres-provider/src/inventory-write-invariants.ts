import type { StorageTargetPayloadV1 } from '@north-star/compiler';

import type {
  ModuleWriteInvariantProvider,
  StateDependentWriteInvariant,
} from './module-write-invariants.js';

const STOCK_COUNT_ENTITY_SUFFIX = ':entity.stock_count';

/**
 * Inventory owns this declaration. Once a stock count is counting, its
 * counting mode is fixed and only a stock count command leaves the state: an
 * ordinary edit cannot reset the header to draft to change the mode. The
 * generic record writer receives it only through product assembly and never
 * names Inventory, the stock count or its fields itself.
 */
export const STOCK_COUNT_COUNTING_INVARIANT = Object.freeze({
  providerId: 'northstar.inventory:write-invariant.stock-count-counting',
  bind(storage: StorageTargetPayloadV1) {
    return Object.freeze(
      storage.entities
        .filter((entity) => entity.entityId.endsWith(STOCK_COUNT_ENTITY_SUFFIX))
        .map((entity): StateDependentWriteInvariant => {
          const namespace = entity.entityId.slice(
            0,
            -STOCK_COUNT_ENTITY_SUFFIX.length,
          );
          const state = `${namespace}:field.stock_count_state`;
          const mode = `${namespace}:field.stock_count_counting_mode`;
          return Object.freeze({
            entityId: entity.entityId,
            stateFieldId: state,
            guardedStateId: `${namespace}:option.stock_count_state_counting`,
            // Older count definitions do not have a mode.
            appliesToRecordsWithFieldId: mode,
            frozenFields: Object.freeze([
              Object.freeze({
                fieldId: mode,
                refusal: 'counting mode is fixed after Start counting',
              }),
              Object.freeze({
                fieldId: state,
                refusal: 'use a stock count command to leave counting',
              }),
            ]),
          });
        }),
    );
  },
} satisfies ModuleWriteInvariantProvider);

export const INVENTORY_WRITE_INVARIANTS: readonly ModuleWriteInvariantProvider[] =
  Object.freeze([STOCK_COUNT_COUNTING_INVARIANT]);
