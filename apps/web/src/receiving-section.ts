import type { RequestRuntimeView } from '@north-star/runtime/request-runtime-view';
import { registeredSemanticQueryFromPinnedView } from '../../../packages/runtime/src/semantic-query-gateway.js';
import { escapeHtml } from './html.js';
import type { SurfaceRuntimeApplicationExtension } from './app-server.js';

export interface ReceivingNavigation {
  readonly links: readonly { readonly label: string; readonly href: string }[];
  readonly guidance: string;
}

export function receivingNavigation(
  view: RequestRuntimeView,
  entityId: string,
  legalEntityId: string,
): ReceivingNavigation | undefined {
  const namespace = entityId.split(':')[0]!;
  const spec = entityId.endsWith(':entity.goods_receipt')
    ? {
        links: [
          [
            'goods_receipt_line_form',
            'goods_receipt_line_get',
            'Add receipt line',
          ],
          [
            'goods_receipt_line_list',
            'goods_receipt_line_list',
            'View receipt lines',
          ],
          // Where the product composes it, the Purchase orders List reads its
          // orders with their totals (ORDER-PARITY), under that query's own
          // company parameter; otherwise it reads its plain query.
          [
            'purchase_order_list',
            'commercial_purchase_order_list',
            'View order progress',
            'purchase_order_list',
          ],
        ],
        guidance:
          'Add lines linked to this receipt and the matching purchase order lines, then post this receipt. Enter actual received unit cost and currency, or explicitly choose absent. To correct, create a new correction or reversal receipt linked to the posted original and identify the compensated movement on each line. Reopen a closed order first.',
      }
    : entityId.endsWith(':entity.purchase_order_line')
      ? {
          links: [
            [
              'purchase_order_amendment_form',
              'purchase_order_amendment_get',
              'Request quantity amendment',
            ],
          ],
          guidance:
            'Create one amendment request for this line and its current revision, then return here and apply Amend. New ordered quantity cannot be below received quantity. A closed order must be reopened first.',
        }
      : undefined;
  if (!spec) return undefined;
  return {
    guidance: spec.guidance,
    // A link carries the company under the parameter of the query its surface
    // reads: the first one named that the release registers.
    links: spec.links.map(([surface, query, label, otherwise]) => {
      const definition =
        registeredSemanticQueryFromPinnedView(
          view,
          `${namespace}:query.${query}`,
        ) ??
        (otherwise
          ? registeredSemanticQueryFromPinnedView(
              view,
              `${namespace}:query.${otherwise}`,
            )
          : null);
      if (!definition?.legalEntityScope)
        throw new Error('Receiving link lacks registered scope');
      return {
        label: label!,
        href: `/?${new URLSearchParams({ surface: `${namespace}:surface.${surface}`, [definition.legalEntityScope.operand.parameterId]: legalEntityId })}`,
      };
    }),
  };
}
export function renderReceivingNavigation(
  navigation: ReceivingNavigation,
): string {
  return `<section class="panel data-panel" data-receiving-navigation><h2>Receiving actions</h2><p>${navigation.links.map((link) => `<a href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a>`).join(' · ')}</p><p>${escapeHtml(navigation.guidance)}</p></section>`;
}
/** Purchasing-specific selection, loading and refresh policy. The API
 * composition root installs this contribution explicitly; SurfaceRuntime stays
 * unaware of purchasing identities. */
export const RECEIVING_SURFACE_RUNTIME_EXTENSION = Object.freeze({
  async augmentRecordData({
    binding,
    data,
    legalEntitySelection,
    surface,
    surfaces,
    view,
  }) {
    if (
      surface.surfaceRole !== 'record' ||
      legalEntitySelection.length !== 1 ||
      !surfaces.some((candidate) =>
        candidate.surfaceId.endsWith(':surface.goods_receipt_detail'),
      )
    )
      return data;
    const legalEntityId = legalEntitySelection[0]!;
    const navigation = receivingNavigation(
      view,
      binding.query.sourceEntityId,
      legalEntityId,
    );
    return {
      ...data,
      ...(navigation ? { receivingNavigation: navigation } : {}),
    };
  },
  refreshAfterOperation({ binding, intent, surface, surfaces }) {
    return (
      intent === 'command' &&
      surface.surfaceRole === 'record' &&
      ['purchase_order', 'purchase_order_line', 'goods_receipt'].some(
        (entity) => binding.query.sourceEntityId.endsWith(`:entity.${entity}`),
      ) &&
      surfaces.some((candidate) =>
        candidate.surfaceId.endsWith(':surface.goods_receipt_detail'),
      )
    );
  },
} satisfies SurfaceRuntimeApplicationExtension);
