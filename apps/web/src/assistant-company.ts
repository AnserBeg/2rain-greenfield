/**
 * The company an assistant conversation works in (end review X9): the one the
 * person's page settled on, proved the way the page proves it. The page's
 * own workspace entry decides when it declares one; a page without a
 * company of its own (a shared record, the Customize screen) takes the
 * landing launcher's, as its sidebar does. A company is accepted only when
 * it is one of the companies the entry offers this person now; the URL's
 * parameter alone is never trusted.
 */
import type { RequestRuntimeView } from '../../../packages/runtime/src/request-runtime-view.js';
import type { SemanticQueryGateway } from '../../../packages/runtime/src/semantic-query-gateway.js';
import {
  readCompiledSurfaceManifest,
  type CompiledSurfaceDefinition,
} from './surface-contract.js';
import { landingSurface } from './surface-runtime.js';
import { resolveWorkspaceEntry } from './workspace-entry.js';

export interface AssistantCompany {
  readonly companyId: string;
  /** The company's name as the entry offers it. */
  readonly label: string;
}

export async function assistantCompany(
  view: RequestRuntimeView,
  queryGateway: SemanticQueryGateway,
  page: { readonly surfaceId: string | null; readonly search: string },
): Promise<AssistantCompany | null> {
  const manifest = readCompiledSurfaceManifest(view);
  // A fresh URL per resolution: resolving may write the default into it.
  const url = () =>
    new URL(
      `/${page.search.startsWith('?') ? page.search : `?${page.search}`}`,
      'http://assistant.local',
    );
  const settle = async (surface: CompiledSurfaceDefinition) => {
    const entry = await resolveWorkspaceEntry(
      view,
      surface,
      url(),
      queryGateway,
    );
    if (!entry) return undefined;
    if (entry.invalid) return null;
    const offered = entry.options.find(
      (option) => option.recordId === entry.selected,
    );
    return offered
      ? { companyId: offered.recordId, label: offered.label }
      : undefined;
  };
  const own = page.surfaceId
    ? manifest.surfaces.find((surface) => surface.surfaceId === page.surfaceId)
    : undefined;
  if (own) {
    const settled = await settle(own);
    if (settled !== undefined) return settled;
  }
  const landing = landingSurface(manifest.navigation, manifest.surfaces);
  if (!landing?.launcher || !landing.workspace?.entry) return null;
  return (await settle(landing)) ?? null;
}
