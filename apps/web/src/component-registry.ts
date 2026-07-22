import type * as RuntimeViewContract from '@north-star/runtime/request-runtime-view';

import { escapeHtml, shortIdentity } from './html.js';
import type {
  CompiledSurfaceDefinition,
  CompiledSurfaceSlot,
} from './surface-contract.js';

export interface SurfaceComponentContext {
  readonly slot: CompiledSurfaceSlot;
  readonly surface: CompiledSurfaceDefinition;
  readonly view: RuntimeViewContract.RequestRuntimeView;
}

export type SurfaceComponentRenderResult =
  | { readonly html: string; readonly status: 'RENDERED' }
  | {
      readonly code: 'COMPONENT_RENDER_FAILED' | 'UNSUPPORTED_COMPONENT';
      readonly html: string;
      readonly status: 'DIAGNOSTIC';
    };

type SurfaceComponentRenderer = (context: SurfaceComponentContext) => string;

const componentRegistry: Readonly<Record<string, SurfaceComponentRenderer>> =
  Object.freeze({
    'northstar.shell:component.error_probe': renderBoundaryProbe,
    'northstar.shell:component.release_summary': renderReleaseSummary,
    'northstar.shell:component.setup_checklist': renderSetupChecklist,
  });

export const REGISTERED_SURFACE_COMPONENT_IDS = Object.freeze(
  Object.keys(componentRegistry).sort(),
);

/** Closed lookup: there is deliberately no register/override escape hatch. */
export function renderRegisteredSurfaceComponent(
  context: SurfaceComponentContext,
): SurfaceComponentRenderResult {
  const renderer = Object.hasOwn(
    componentRegistry,
    context.slot.contentReferenceId,
  )
    ? componentRegistry[context.slot.contentReferenceId]
    : undefined;
  if (!renderer) {
    return Object.freeze({
      code: 'UNSUPPORTED_COMPONENT' as const,
      html: diagnostic(
        'Unsupported release capability',
        `This runtime does not register ${context.slot.contentReferenceId}.`,
        'UNSUPPORTED_COMPONENT',
      ),
      status: 'DIAGNOSTIC' as const,
    });
  }

  try {
    return Object.freeze({
      html: renderer(context),
      status: 'RENDERED' as const,
    });
  } catch {
    return Object.freeze({
      code: 'COMPONENT_RENDER_FAILED' as const,
      html: diagnostic(
        'Component unavailable',
        'The release-defined component could not be rendered. The rest of the pinned surface is unchanged.',
        'COMPONENT_RENDER_FAILED',
      ),
      status: 'DIAGNOSTIC' as const,
    });
  }
}

function renderReleaseSummary({
  surface,
  view,
}: SurfaceComponentContext): string {
  const roles =
    surface.statusRoles.length === 0
      ? 'No status roles declared'
      : surface.statusRoles.join(' · ');
  return `<section class="panel panel--hero" data-component="northstar.shell:component.release_summary">
    <div class="panel__accent" aria-hidden="true">↗</div>
    <p class="eyebrow">Pinned application definition</p>
    <h2>${escapeHtml(surface.label)} is release-defined</h2>
    <p class="lede">This request is rendering one immutable compiled surface. A later activation can change the next request without changing this one.</p>
    <dl class="fact-grid">
      <div><dt>Release</dt><dd>${escapeHtml(shortIdentity(view.release.releaseId))}</dd></div>
      <div><dt>Fence</dt><dd>${view.pointer.fence}</dd></div>
      <div><dt>Status grammar</dt><dd>${escapeHtml(roles)}</dd></div>
    </dl>
  </section>`;
}

function renderSetupChecklist({
  surface,
  view,
}: SurfaceComponentContext): string {
  return `<section class="panel" data-component="northstar.shell:component.setup_checklist">
    <div class="panel__heading">
      <div>
        <p class="eyebrow">Compiled setup</p>
        <h2>${escapeHtml(surface.label)} checklist</h2>
      </div>
      <span class="status-pill">Release ${escapeHtml(shortIdentity(view.release.releaseId))}</span>
    </div>
    <ol class="checklist">
      <li><span aria-hidden="true">01</span><div><strong>Surface manifest loaded</strong><p>${surface.slots.length} release-defined slot${surface.slots.length === 1 ? '' : 's'} selected.</p></div></li>
      <li><span aria-hidden="true">02</span><div><strong>Request definition pinned</strong><p>Fence ${view.pointer.fence} remains stable for this unit of work.</p></div></li>
      <li><span aria-hidden="true">03</span><div><strong>Projection ready</strong><p>${surface.fieldIds.length} compiled field reference${surface.fieldIds.length === 1 ? '' : 's'} available to later data screens.</p></div></li>
    </ol>
  </section>`;
}

function renderBoundaryProbe(): string {
  throw new Error('intentional registered boundary probe');
}

function diagnostic(title: string, message: string, code: string): string {
  return `<section class="diagnostic" role="alert" data-diagnostic-code="${escapeHtml(code)}">
    <div class="diagnostic__mark" aria-hidden="true">!</div>
    <div><p class="eyebrow">Release diagnostic</p><h2>${escapeHtml(title)}</h2><p>${escapeHtml(message)}</p><code>${escapeHtml(code)}</code></div>
  </section>`;
}
