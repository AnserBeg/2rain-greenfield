import {
  InventoryPostingError,
  translateInventoryPostingError,
} from './inventory-posting-service.js';
import type { ModuleProviderErrorMapping } from './module-runtime-interpreter.js';

const baseUnitImmutableProviderMessage =
  'INVENTORY_BASE_UNIT_IMMUTABLE' as const;

/**
 * Inventory owns this translation declaration. The generic module interpreter
 * receives it only through product assembly and never names Inventory itself.
 */
export const INVENTORY_PROVIDER_ERROR_MAPPINGS = Object.freeze([
  Object.freeze({
    providerMessage: baseUnitImmutableProviderMessage,
    sqlstate: 'P0001',
    translate(input) {
      const translated = translateInventoryPostingError({
        code: input.metadata.sqlstate,
        detail: input.detail,
        message: input.providerMessage,
      });
      if (
        !(translated instanceof InventoryPostingError) ||
        translated.code !== baseUnitImmutableProviderMessage
      ) {
        return null;
      }
      return Object.freeze({
        code: translated.code,
        details: translated.details,
        message:
          'item base unit cannot change after its first referenced movement',
        subjectId: input.subjectId,
      });
    },
  } satisfies ModuleProviderErrorMapping),
] as const);
