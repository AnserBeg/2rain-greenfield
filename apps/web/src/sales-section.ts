import type { SurfaceRuntimeApplicationExtension } from './app-server.js';
import { RECEIVING_SURFACE_RUNTIME_EXTENSION } from './receiving-section.js';

/** Product composition: Receiving's link panel, and the refresh after a command on a sales order or shipment page. */
export const COMPOSED_APPLICATION_SURFACE_RUNTIME_EXTENSION: SurfaceRuntimeApplicationExtension =
  Object.freeze({
    augmentRecordData: RECEIVING_SURFACE_RUNTIME_EXTENSION.augmentRecordData,
    refreshAfterOperation(
      context: Parameters<
        SurfaceRuntimeApplicationExtension['refreshAfterOperation']
      >[0],
    ) {
      return (
        RECEIVING_SURFACE_RUNTIME_EXTENSION.refreshAfterOperation(context) ||
        (context.intent === 'command' &&
          context.surface.surfaceRole === 'record' &&
          context.binding.query.sourceEntityId.endsWith(
            ':entity.sales_order',
          )) ||
        (context.intent === 'command' &&
          context.surface.surfaceRole === 'record' &&
          context.binding.query.sourceEntityId.endsWith(':entity.shipment'))
      );
    },
  });
