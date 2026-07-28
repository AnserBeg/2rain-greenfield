import { assertRequestRuntimeView } from '@north-star/runtime/request-runtime-view';
import type * as RuntimeViewContract from '@north-star/runtime/request-runtime-view';
import {
  NoSuchRegisteredOperationError,
  SEMANTIC_OPERATION_REQUEST_VERSION,
  SemanticOperationConfirmationGrantError,
  SemanticOperationConfirmationStaleError,
  SemanticOperationPolicyDeniedError,
} from '../../../packages/runtime/src/semantic-operation-gateway.js';
import type {
  SemanticOperationGateway,
  SemanticOperationMediationAuthority,
} from '../../../packages/runtime/src/semantic-operation-gateway.js';
import {
  NoSuchRegisteredQueryError,
  SEMANTIC_QUERY_REQUEST_VERSION,
  SemanticQueryPolicyDeniedError,
  type SemanticQueryResultEnvelope,
} from '../../../packages/runtime/src/semantic-query-gateway.js';
import type { SemanticQueryGateway } from '../../../packages/runtime/src/semantic-query-gateway.js';
import { SHARED_LIST_QUERY_VERSION } from '../../../packages/runtime/src/list-behavior/index.js';

import {
  renderRegisteredSurfaceComponent,
  type SurfaceDataRenderState,
  type SurfaceOperationFeedback,
} from './component-registry.js';
import { escapeHtml, shortIdentity } from './html.js';
import {
  readCompiledSurfaceManifest,
  readCompiledSurfaceDataBinding,
  SurfaceProjectionError,
  type CompiledSurfaceDataBinding,
  type CompiledSurfaceDefinition,
  type SurfaceOperationIntent,
} from './surface-contract.js';

export interface SurfaceRuntimeResponse {
  readonly html: string;
  readonly statusCode: number;
}

export interface SurfaceRuntimeGateways {
  readonly operationMediation: SemanticOperationMediationAuthority;
  readonly operationGateway: SemanticOperationGateway;
  readonly queryGateway: SemanticQueryGateway;
}

export type SurfaceRuntimeSubmission = Readonly<Record<string, string>>;

interface SelectedSurface {
  readonly selected: CompiledSurfaceDefinition;
  readonly surfaces: readonly CompiledSurfaceDefinition[];
}

/**
 * The sole browser renderer. Its only application-definition input is one
 * issued RequestRuntimeView; it has no loader, pointer, release, or cache port.
 */
export function renderSurfaceRuntime(
  view: RuntimeViewContract.RequestRuntimeView,
  requestUrl: string,
): SurfaceRuntimeResponse {
  assertRequestRuntimeView(view);
  const selection = selectSurface(view, requestUrl);
  if ('statusCode' in selection) return selection;
  return renderSelectedSurface(
    view,
    selection,
    { status: 'UNBOUND' },
    null,
    [],
  );
}

/** Loads live DTOs through the semantic read gateway for one pinned surface. */
export async function renderSurfaceRuntimeWithData(
  view: RuntimeViewContract.RequestRuntimeView,
  requestUrl: string,
  gateways: SurfaceRuntimeGateways,
  feedback: SurfaceOperationFeedback | null = null,
): Promise<SurfaceRuntimeResponse> {
  assertRequestRuntimeView(view);
  const selection = selectSurface(view, requestUrl);
  if ('statusCode' in selection) return selection;
  let binding: CompiledSurfaceDataBinding;
  try {
    binding = readCompiledSurfaceDataBinding(view, selection.selected);
  } catch {
    return renderSelectedSurface(
      view,
      selection,
      { code: 'QUERY_UNSUPPORTED', status: 'DIAGNOSTIC' },
      feedback,
      [],
      422,
    );
  }

  const url = new URL(requestUrl, 'http://surface-runtime.local');
  const queryArguments = argumentsForSurface(binding, url);
  if (queryArguments === null) {
    const state: SurfaceDataRenderState =
      selection.selected.surfaceRole === 'form'
        ? { status: 'EMPTY' }
        : { code: 'QUERY_NOT_FOUND', status: 'DIAGNOSTIC' };
    return renderSelectedSurface(
      view,
      selection,
      state,
      feedback,
      binding.operations,
    );
  }

  let data: SurfaceDataRenderState;
  try {
    const result = await gateways.queryGateway.invoke(view, {
      arguments: queryArguments,
      queryId: selection.selected.dataSourceQueryId,
      schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
    });
    data = dataState(result);
  } catch (error) {
    data = {
      code:
        error instanceof SemanticQueryPolicyDeniedError
          ? 'QUERY_PERMISSION_DENIED'
          : error instanceof NoSuchRegisteredQueryError
            ? 'QUERY_UNSUPPORTED'
            : 'QUERY_UNAVAILABLE',
      status: 'DIAGNOSTIC',
    };
  }
  return renderSelectedSurface(
    view,
    selection,
    data,
    feedback,
    binding.operations,
  );
}

/** Resolves a browser intent to a pinned O0 binding; no operation ID is accepted. */
export async function submitSurfaceRuntimeIntent(
  view: RuntimeViewContract.RequestRuntimeView,
  requestUrl: string,
  submission: SurfaceRuntimeSubmission,
  gateways: SurfaceRuntimeGateways,
): Promise<SurfaceRuntimeResponse> {
  assertRequestRuntimeView(view);
  const selection = selectSurface(view, requestUrl);
  if ('statusCode' in selection) return selection;
  let binding: CompiledSurfaceDataBinding;
  try {
    binding = readCompiledSurfaceDataBinding(view, selection.selected);
  } catch {
    return operationDiagnostic('OPERATION_UNSUPPORTED', 422);
  }
  const intent = operationIntent(submission.intent);
  const operation = intent
    ? binding.operations.find((candidate) => candidate.intent === intent)
    : undefined;
  if (
    !intent ||
    !operation ||
    !surfaceAllowsIntent(selection.selected, intent)
  ) {
    return operationDiagnostic('OPERATION_UNSUPPORTED', 422);
  }
  const input = operationInput(selection.selected, intent, submission);
  if (
    operation.confirmation === 'humanRequired' &&
    typeof submission.confirmationGrant !== 'string'
  ) {
    try {
      const grant = gateways.operationMediation.issueConfirmationGrant(
        view,
        operation.operationId,
        input,
      );
      return renderConfirmationTransition(
        selection.selected,
        intent,
        submission,
        grant,
      );
    } catch {
      return operationDiagnostic('OPERATION_CONFIRMATION_REQUIRED', 422);
    }
  }

  let result;
  try {
    result = await gateways.operationGateway.invoke(
      view,
      {
        confirmationGrant: submission.confirmationGrant ?? null,
        idempotencyKey: submission.idempotencyKey ?? '',
        input,
        operationId: operation.operationId,
        schemaVersion: SEMANTIC_OPERATION_REQUEST_VERSION,
      },
      gateways.operationMediation.issueInvocation(view, 'UI'),
    );
  } catch (error) {
    return operationDiagnostic(
      error instanceof SemanticOperationPolicyDeniedError
        ? 'OPERATION_PERMISSION_DENIED'
        : error instanceof SemanticOperationConfirmationStaleError ||
            error instanceof SemanticOperationConfirmationGrantError
          ? 'OPERATION_CONFIRMATION_STALE'
          : error instanceof NoSuchRegisteredOperationError
            ? 'OPERATION_UNSUPPORTED'
            : 'OPERATION_UNAVAILABLE',
      error instanceof SemanticOperationPolicyDeniedError ? 403 : 422,
    );
  }
  if (result.outcome !== 'succeeded' || !result.readBack) {
    return operationDiagnostic('OPERATION_UNSUPPORTED', 422);
  }

  return renderSelectedSurface(
    view,
    selection,
    { records: [result.readBack], status: 'READY' },
    {
      intent,
      record: result.readBack,
      trustLinked: result.trust !== null,
    },
    binding.operations,
  );
}

function renderSelectedSurface(
  view: RuntimeViewContract.RequestRuntimeView,
  { selected, surfaces }: SelectedSurface,
  data: SurfaceDataRenderState,
  feedback: SurfaceOperationFeedback | null,
  operations: CompiledSurfaceDataBinding['operations'],
  statusCode = 200,
): SurfaceRuntimeResponse {
  // Compact and full layouts are alternative renderings of these same slots;
  // a responsive implementation must never mount both at once.
  const renderedSlots = selected.slots.map((slot) =>
    renderRegisteredSurfaceComponent({
      data,
      feedback,
      operations,
      slot,
      surface: selected,
      surfaces,
      view,
    }),
  );
  const legacyHeading =
    selected.archetype === 'list' || selected.archetype === 'record'
      ? ''
      : `<header class="surface-heading">
      <div>
        <p class="eyebrow">${escapeHtml(selected.archetype)} surface · compiled release</p>
        <h1>${escapeHtml(selected.label)}</h1>
        <p class="surface-id">${escapeHtml(selected.surfaceId)}</p>
      </div>
      <div class="surface-status" aria-label="Surface status roles">
        ${selected.statusRoles.map((role) => `<span data-status-role="${escapeHtml(role)}">${escapeHtml(role)}</span>`).join('')}
      </div>
    </header>`;
  const body = `${legacyHeading}
    <div class="surface-grid" data-surface-archetype="${escapeHtml(selected.archetype)}">
      ${renderedSlots.map((result) => result.html).join('')}
    </div>`;

  return Object.freeze({
    html: shellDocument(view, surfaces, selected, body),
    statusCode,
  });
}

function selectSurface(
  view: RuntimeViewContract.RequestRuntimeView,
  requestUrl: string,
): SelectedSurface | SurfaceRuntimeResponse {
  let surfaces: readonly CompiledSurfaceDefinition[];
  try {
    surfaces = readCompiledSurfaceManifest(view).surfaces.filter(
      (surface) => surface.lifecycle === 'active',
    );
  } catch (error) {
    const code =
      error instanceof SurfaceProjectionError
        ? error.code
        : 'INVALID_SURFACE_MANIFEST';
    return Object.freeze({
      html: diagnosticDocument(
        view,
        'Compiled surface unavailable',
        'The pinned release does not contain a surface projection this runtime can render.',
        code,
      ),
      statusCode: 422,
    });
  }
  if (surfaces.length === 0) {
    return Object.freeze({
      html: diagnosticDocument(
        view,
        'No active surface',
        'The pinned release contains no active browser surface.',
        'NO_ACTIVE_SURFACE',
      ),
      statusCode: 422,
    });
  }
  const requestedSurfaceId = new URL(
    requestUrl,
    'http://surface-runtime.local',
  ).searchParams.get('surface');
  const selected = requestedSurfaceId
    ? surfaces.find((surface) => surface.surfaceId === requestedSurfaceId)
    : surfaces[0];
  if (!selected) {
    return Object.freeze({
      html: shellDocument(
        view,
        surfaces,
        null,
        `<section class="diagnostic diagnostic--page" role="alert" data-diagnostic-code="UNKNOWN_SURFACE">
          <div class="diagnostic__mark" aria-hidden="true">?</div>
          <div><p class="eyebrow">Release diagnostic</p><h1>Surface not found</h1><p>The requested surface is not present in this pinned release.</p><code>UNKNOWN_SURFACE</code></div>
        </section>`,
      ),
      statusCode: 404,
    });
  }
  return { selected, surfaces };
}

function argumentsForSurface(
  binding: CompiledSurfaceDataBinding,
  url: URL,
): RuntimeViewContract.ImmutableJsonValue | null {
  const includeArchived = url.searchParams.get('archived') === 'yes';
  switch (binding.query.queryType) {
    case 'get': {
      const recordId = url.searchParams.get('record');
      return recordId ? { includeArchived, recordId } : null;
    }
    case 'list':
      return {
        includeArchived,
        list: {
          cursor: url.searchParams.get('cursor'),
          matchMode: 'substring',
          pageSize: binding.query.maximumResultCount,
          relationLabels: [],
          schemaVersion: SHARED_LIST_QUERY_VERSION,
          search: url.searchParams.get('q') ?? '',
          sort: [],
        },
      };
    case 'resolve':
    case 'search': {
      const text = url.searchParams.get('q');
      return text
        ? {
            includeArchived,
            limit: binding.query.maximumResultCount,
            text,
          }
        : null;
    }
  }
}

function dataState(
  result: SemanticQueryResultEnvelope,
): SurfaceDataRenderState {
  switch (result.outcome) {
    case 'exact':
      return result.records.length === 0 && !result.listCoverage
        ? { status: 'EMPTY' }
        : { records: result.records, result, status: 'READY' };
    case 'ambiguous':
      return { code: 'QUERY_AMBIGUOUS', status: 'DIAGNOSTIC' };
    case 'not-found':
      return { code: 'QUERY_NOT_FOUND', status: 'DIAGNOSTIC' };
    case 'unsupported':
      return { code: 'QUERY_UNSUPPORTED', status: 'DIAGNOSTIC' };
  }
}

function operationInput(
  surface: CompiledSurfaceDefinition,
  intent: SurfaceOperationIntent,
  submission: SurfaceRuntimeSubmission,
): Record<string, number | string | Readonly<Record<string, string>>> {
  const values = Object.freeze(
    Object.fromEntries(
      surface.fieldIds
        .map((fieldId) => [fieldId, submission[`value:${fieldId}`]] as const)
        .filter(
          (entry): entry is readonly [string, string] =>
            typeof entry[1] === 'string',
        ),
    ),
  );
  if (intent === 'create') {
    return { recordId: submission.recordId ?? '', values };
  }
  const recordId = submission.recordId ?? '';
  const expectedRevision = Number.parseInt(
    submission.expectedRevision ?? '',
    10,
  );
  return intent === 'update'
    ? { expectedRevision, patch: values, recordId }
    : { expectedRevision, recordId };
}

function operationIntent(
  value: string | undefined,
): SurfaceOperationIntent | null {
  return value === 'archive' ||
    value === 'create' ||
    value === 'restore' ||
    value === 'update'
    ? value
    : null;
}

function surfaceAllowsIntent(
  surface: CompiledSurfaceDefinition,
  intent: SurfaceOperationIntent,
): boolean {
  return surface.surfaceRole === 'form'
    ? intent === 'create' || intent === 'update'
    : surface.surfaceRole === 'record'
      ? intent === 'archive' || intent === 'restore'
      : false;
}

function operationDiagnostic(
  code:
    | 'OPERATION_CONFIRMATION_REQUIRED'
    | 'OPERATION_CONFIRMATION_STALE'
    | 'OPERATION_PERMISSION_DENIED'
    | 'OPERATION_UNAVAILABLE'
    | 'OPERATION_UNSUPPORTED',
  statusCode: number,
): SurfaceRuntimeResponse {
  const copy = {
    OPERATION_CONFIRMATION_REQUIRED: [
      'Confirmation required',
      'This semantic operation requires explicit human confirmation.',
    ],
    OPERATION_CONFIRMATION_STALE: [
      'Confirmation expired',
      'The operation input or expected revision changed after preview. Preview it again.',
    ],
    OPERATION_PERMISSION_DENIED: [
      'Access denied',
      'Current policy does not allow this operation.',
    ],
    OPERATION_UNAVAILABLE: [
      'Save unavailable',
      'The semantic operation could not be completed safely.',
    ],
    OPERATION_UNSUPPORTED: [
      'Operation unavailable',
      'The pinned release does not provide this semantic operation.',
    ],
  } as const;
  const [title, message] = copy[code];
  return renderApplicationDiagnostic(statusCode, title, message, code);
}

function renderConfirmationTransition(
  surface: CompiledSurfaceDefinition,
  intent: SurfaceOperationIntent,
  submission: SurfaceRuntimeSubmission,
  grant: string,
): SurfaceRuntimeResponse {
  const preserved = Object.entries(submission)
    .filter(([key]) => key !== 'confirmationGrant' && key !== 'confirmed')
    .map(
      ([key, value]) =>
        `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}">`,
    )
    .join('');
  return Object.freeze({
    html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Confirm ${escapeHtml(intentLabel(intent))} · 2rain</title><style>${styles}</style></head><body class="standalone"><main class="standalone__card" data-confirmation-step="preview"><p class="eyebrow">Operation preview</p><h1>Confirm ${escapeHtml(intentLabel(intent))}</h1><p>Review this ${escapeHtml(surface.label)} operation before it is executed.</p><form method="post" action="/?surface=${encodeURIComponent(surface.surfaceId)}">${preserved}<input type="hidden" name="confirmationGrant" value="${escapeHtml(grant)}"><button type="submit">Confirm ${escapeHtml(intentLabel(intent))}</button></form></main></body></html>`,
    statusCode: 200,
  });
}

function intentLabel(intent: SurfaceOperationIntent): string {
  return intent.slice(0, 1).toUpperCase() + intent.slice(1);
}

export function renderApplicationDiagnostic(
  statusCode: number,
  title: string,
  message: string,
  code: string,
): SurfaceRuntimeResponse {
  return Object.freeze({
    html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · 2rain</title><style>${styles}</style></head><body class="standalone"><main class="standalone__card"><p class="eyebrow">Application diagnostic</p><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><code>${escapeHtml(code)}</code></main></body></html>`,
    statusCode,
  });
}

function diagnosticDocument(
  view: RuntimeViewContract.RequestRuntimeView,
  title: string,
  message: string,
  code: string,
): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · 2rain</title><style>${styles}</style></head><body class="standalone"><main class="standalone__card" role="alert" data-diagnostic-code="${escapeHtml(code)}"><p class="eyebrow">Pinned release diagnostic</p><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><code>${escapeHtml(code)}</code><p class="diagnostic-release">Release ${escapeHtml(shortIdentity(view.release.releaseId))} · fence ${view.pointer.fence}</p></main></body></html>`;
}

function shellDocument(
  view: RuntimeViewContract.RequestRuntimeView,
  surfaces: readonly CompiledSurfaceDefinition[],
  selected: CompiledSurfaceDefinition | null,
  body: string,
): string {
  const title = selected?.label ?? 'Release diagnostic';
  const navigation = navigationSurfaces(surfaces);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="color-scheme" content="light">
    <link rel="icon" href="data:,">
    <title>${escapeHtml(title)} · 2rain</title>
    <style>${styles}</style>
  </head>
  <body>
    <a class="skip-link" href="#surface-content">Skip to content</a>
    <div class="app-shell" data-release-id="${escapeHtml(view.release.releaseId)}" data-release-content-hash="${escapeHtml(view.release.contentHash)}" data-pointer-fence="${view.pointer.fence}">
      <aside class="sidebar">
        <div class="brand"><span class="brand__mark" aria-hidden="true">2</span><span><strong>2rain</strong><small>Compiled workspace</small></span></div>
        <nav aria-label="Release navigation">
          <p class="nav-label">Application</p>
          <ul>${navigation.map((surface) => navigationItem(view, surface, selected)).join('')}</ul>
        </nav>
        <div class="release-card">
          <span class="release-card__pulse" aria-hidden="true"></span>
          <div><small>Pinned release</small><strong>${escapeHtml(shortIdentity(view.release.releaseId))}</strong><span>Fence ${view.pointer.fence}</span></div>
        </div>
      </aside>
      <div class="workspace">
        <header class="topbar">
          <div><span class="topbar__context">${escapeHtml(shortIdentity(view.tenantId))}</span><span class="topbar__divider">/</span><span>${escapeHtml(shortIdentity(view.environmentId))}</span></div>
          <div class="principal" aria-label="Signed-in principal"><span class="principal__avatar" aria-hidden="true">${escapeHtml(view.principalId.slice(0, 2).toUpperCase())}</span><span><small>Signed in</small><strong>${escapeHtml(shortIdentity(view.principalId))}</strong></span></div>
        </header>
        <main id="surface-content" tabindex="-1">${body}</main>
      </div>
    </div>
  </body>
</html>`;
}

function navigationItem(
  view: RuntimeViewContract.RequestRuntimeView,
  surface: CompiledSurfaceDefinition,
  selected: CompiledSurfaceDefinition | null,
): string {
  const current = selected
    ? surface.surfaceId === selected.surfaceId ||
      sharesSurfaceEntity(view, surface, selected)
    : false;
  const label =
    surface.surfaceRole === 'list'
      ? surface.label.replace(/\s+list$/i, '')
      : surface.label;
  return `<li><a href="/?surface=${encodeURIComponent(surface.surfaceId)}"${current ? ' aria-current="page"' : ''}><span class="nav-icon" aria-hidden="true">${escapeHtml(label.slice(0, 1).toUpperCase())}</span><span>${escapeHtml(label)}</span><span class="nav-arrow" aria-hidden="true">›</span></a></li>`;
}

function navigationSurfaces(
  surfaces: readonly CompiledSurfaceDefinition[],
): readonly CompiledSurfaceDefinition[] {
  return surfaces.filter(
    (surface) =>
      surface.surfaceRole === 'list' ||
      (surface.archetype === 'list' && surface.surfaceRole === null) ||
      (surface.archetype === 'home' && surface.surfaceRole === null),
  );
}

function sharesSurfaceEntity(
  view: RuntimeViewContract.RequestRuntimeView,
  navigation: CompiledSurfaceDefinition,
  selected: CompiledSurfaceDefinition,
): boolean {
  if (navigation.surfaceRole !== 'list') return false;
  try {
    return (
      readCompiledSurfaceDataBinding(view, navigation).query.sourceEntityId ===
      readCompiledSurfaceDataBinding(view, selected).query.sourceEntityId
    );
  } catch {
    return false;
  }
}

const styles = `
:root{--ink:#17221d;--muted:#66736c;--line:#dce4df;--paper:#f6f8f5;--panel:#fff;--forest:#183d2f;--mint:#dff2e7;--lime:#b8dc74;--amber:#d88b2e;--danger:#ad3f35;--shadow:0 18px 55px rgba(24,61,47,.09);font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--ink);background:var(--paper)}
*{box-sizing:border-box}body{margin:0;min-width:320px;background:radial-gradient(circle at 80% 0,rgba(184,220,116,.16),transparent 30rem),var(--paper);font-size:15px}.skip-link{position:fixed;left:1rem;top:-5rem;z-index:5;background:var(--forest);color:white;padding:.7rem 1rem;border-radius:.6rem}.skip-link:focus{top:1rem}.app-shell{min-height:100vh;display:grid;grid-template-columns:17.5rem minmax(0,1fr)}.sidebar{position:sticky;top:0;height:100vh;display:flex;flex-direction:column;padding:1.5rem 1.2rem;background:linear-gradient(165deg,#173b2e 0%,#102a21 100%);color:#f6fff9}.brand{display:flex;gap:.8rem;align-items:center;padding:.2rem .55rem 1.8rem}.brand__mark{display:grid;place-items:center;width:2.3rem;height:2.3rem;border-radius:.75rem;background:var(--lime);color:#15382b;font-size:1.3rem;font-weight:800;box-shadow:inset 0 0 0 1px rgba(255,255,255,.45)}.brand strong,.brand small{display:block}.brand strong{font-size:1.15rem;letter-spacing:.01em}.brand small{margin-top:.1rem;color:#a9c2b6;font-size:.72rem}.nav-label{padding:0 .7rem;color:#88a599;font-size:.65rem;font-weight:800;letter-spacing:.14em;text-transform:uppercase}.sidebar ul{display:grid;gap:.32rem;padding:0;margin:.55rem 0;list-style:none}.sidebar a{display:grid;grid-template-columns:2rem 1fr auto;gap:.6rem;align-items:center;min-height:2.8rem;padding:.42rem .65rem;border:1px solid transparent;border-radius:.8rem;color:#cfe0d8;text-decoration:none;font-weight:650}.sidebar a:hover{background:rgba(255,255,255,.07);color:white}.sidebar a:focus-visible{outline:3px solid var(--lime);outline-offset:2px}.sidebar a[aria-current=page]{background:#f7fbf8;color:var(--forest);box-shadow:0 9px 24px rgba(4,18,12,.25)}.nav-icon{display:grid;place-items:center;width:1.9rem;height:1.9rem;border-radius:.55rem;background:rgba(255,255,255,.09);font-size:.72rem;font-weight:800}.sidebar a[aria-current=page] .nav-icon{background:var(--mint)}.nav-arrow{font-size:1.4rem;opacity:.55}.release-card{display:flex;gap:.7rem;align-items:flex-start;margin-top:auto;padding:1rem;border:1px solid rgba(255,255,255,.1);border-radius:.9rem;background:rgba(255,255,255,.045)}.release-card__pulse{width:.52rem;height:.52rem;margin-top:.28rem;border-radius:50%;background:var(--lime);box-shadow:0 0 0 .3rem rgba(184,220,116,.12)}.release-card small,.release-card strong,.release-card span{display:block}.release-card small{color:#9bb3a8;font-size:.67rem;text-transform:uppercase;letter-spacing:.08em}.release-card strong{margin:.22rem 0;color:white;font-family:ui-monospace,monospace;font-size:.72rem}.release-card span{color:#aec2b8;font-size:.72rem}.workspace{min-width:0}.topbar{height:4.5rem;display:flex;align-items:center;justify-content:space-between;padding:0 clamp(1.2rem,3vw,3rem);border-bottom:1px solid var(--line);background:rgba(246,248,245,.84);backdrop-filter:blur(14px);color:var(--muted)}.topbar__context{color:var(--ink);font-weight:700}.topbar__divider{padding:0 .5rem;color:#aab5af}.principal{display:flex;align-items:center;gap:.65rem}.principal__avatar{display:grid;place-items:center;width:2rem;height:2rem;border-radius:50%;background:var(--mint);color:var(--forest);font-size:.67rem;font-weight:800}.principal small,.principal strong{display:block}.principal small{font-size:.62rem;color:var(--muted)}.principal strong{font-size:.74rem;color:var(--ink);font-family:ui-monospace,monospace}main{width:min(82rem,100%);margin:0 auto;padding:clamp(2rem,5vw,4.5rem) clamp(1.2rem,4vw,4rem) 5rem}.surface-heading{display:flex;align-items:flex-end;justify-content:space-between;gap:2rem;margin-bottom:2rem}.eyebrow{margin:0 0 .6rem;color:#587267;font-size:.68rem;font-weight:800;letter-spacing:.14em;text-transform:uppercase}.surface-heading h1,.standalone h1{margin:0;font-family:Georgia,"Times New Roman",serif;font-size:clamp(2.6rem,5vw,4.8rem);font-weight:500;line-height:.95;letter-spacing:-.04em}.surface-id{margin:.8rem 0 0;color:var(--muted);font-family:ui-monospace,monospace;font-size:.72rem}.surface-status{display:flex;gap:.45rem;flex-wrap:wrap;justify-content:flex-end}.surface-status span,.status-pill{padding:.4rem .65rem;border:1px solid #cbd8d1;border-radius:999px;background:rgba(255,255,255,.7);color:#52655c;font-size:.68rem;font-weight:750}.surface-status [data-status-role=success]{border-color:#a7d3b8;background:#e8f6ed;color:#246240}.surface-status [data-status-role=attention]{border-color:#efc98c;background:#fff7e8;color:#8a5918}.surface-status [data-status-role=blocked]{border-color:#e3aaa4;background:#fff0ee;color:#8f3028}.surface-status [data-status-role=inProgress]{border-color:#abc8d8;background:#edf7fc;color:#2d607d}.surface-grid{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:1.2rem}.panel,.diagnostic{grid-column:span 12;border:1px solid var(--line);border-radius:1.25rem;background:rgba(255,255,255,.92);box-shadow:var(--shadow)}.panel{padding:clamp(1.3rem,3vw,2rem)}.panel--hero{position:relative;overflow:hidden;background:linear-gradient(135deg,#fff 20%,#f1f8ed 100%)}.panel__accent{position:absolute;right:1.4rem;top:1.2rem;display:grid;place-items:center;width:3rem;height:3rem;border-radius:1rem;background:var(--forest);color:var(--lime);font-size:1.45rem}.panel h2,.diagnostic h2{max-width:43rem;margin:.2rem 0 .75rem;font-family:Georgia,"Times New Roman",serif;font-size:clamp(1.65rem,3vw,2.5rem);font-weight:500;letter-spacing:-.025em}.lede{max-width:45rem;color:#55665e;font-size:1.02rem;line-height:1.7}.fact-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:.75rem;margin:2rem 0 0}.fact-grid div{padding:1rem;border:1px solid #e1e8e3;border-radius:.85rem;background:rgba(255,255,255,.68)}.fact-grid dt{color:var(--muted);font-size:.64rem;font-weight:800;text-transform:uppercase;letter-spacing:.1em}.fact-grid dd{margin:.35rem 0 0;font-family:ui-monospace,monospace;font-size:.76rem;font-weight:700}.panel__heading{display:flex;align-items:flex-start;justify-content:space-between;gap:1rem}.panel__heading h2{margin:0}.checklist{display:grid;gap:.75rem;padding:0;margin:1.7rem 0 0;list-style:none}.checklist li{display:grid;grid-template-columns:2.2rem 1fr;gap:.8rem;align-items:start;padding:1rem 0;border-top:1px solid #e8ede9}.checklist li>span{display:grid;place-items:center;width:2rem;height:2rem;border-radius:.6rem;background:var(--mint);color:var(--forest);font-size:.65rem;font-weight:800}.checklist strong{font-size:.88rem}.checklist p{margin:.25rem 0 0;color:var(--muted);line-height:1.5}.diagnostic{display:flex;gap:1rem;align-items:flex-start;padding:1.5rem;border-color:#ebc8a2;background:#fffaf4}.diagnostic__mark{flex:0 0 auto;display:grid;place-items:center;width:2.5rem;height:2.5rem;border-radius:.8rem;background:#f6d7b3;color:#7f4810;font-size:1.2rem;font-weight:900}.diagnostic h2{font-size:1.65rem}.diagnostic p{color:#685b4e;line-height:1.55}.diagnostic code,.standalone code{display:inline-block;padding:.3rem .5rem;border-radius:.4rem;background:#f4e7d9;color:#734714;font-size:.7rem}.diagnostic--page h1{margin:.2rem 0 .7rem;font-family:Georgia,"Times New Roman",serif;font-size:2.5rem;font-weight:500}.standalone{min-height:100vh;display:grid;place-items:center;padding:1.5rem;background:radial-gradient(circle at 20% 10%,var(--mint),transparent 28rem),var(--paper)}.standalone__card{width:min(42rem,100%);padding:clamp(2rem,6vw,4rem);border:1px solid var(--line);border-radius:1.4rem;background:white;box-shadow:var(--shadow)}.standalone__card>p{color:var(--muted);line-height:1.65}.diagnostic-release{margin-top:2rem;font-family:ui-monospace,monospace;font-size:.75rem}
.surface-slot{display:contents}.surface-heading--slot,.record-breadcrumb,.command-bar{grid-column:span 12}.surface-heading--slot{margin-bottom:.25rem}.surface-heading__actions{display:flex;gap:.65rem;align-items:center;flex-wrap:wrap}.record-breadcrumb{display:flex;gap:.55rem;align-items:center;color:var(--muted);font-size:.78rem;font-weight:700}.record-breadcrumb a{color:var(--forest)}.command-bar{display:flex;gap:.65rem;align-items:center;min-height:3.6rem;padding:.65rem;border:1px solid var(--line);border-radius:1rem;background:rgba(255,255,255,.88);box-shadow:var(--shadow)}.command-bar .action-overflow{margin-left:auto}.action-overflow{width:max-content}.action-overflow summary{display:grid;place-items:center;min-height:2.75rem;padding:.7rem 1rem;border:1px solid #bccbc3;border-radius:.65rem;background:white;color:var(--forest);font-weight:750;cursor:pointer;list-style:none}.action-overflow summary::-webkit-details-marker{display:none}.action-overflow summary:focus-visible{outline:3px solid var(--lime);outline-offset:2px}.action-overflow[open]{padding:.35rem;border:1px solid var(--line);border-radius:.8rem;background:var(--paper)}.action-overflow .lifecycle-action{margin:.35rem 0 0}.primary-action,.secondary-action{display:inline-grid;place-items:center;min-height:2.75rem;padding:.7rem 1rem;border-radius:.65rem;font-weight:750;text-decoration:none}.primary-action{background:var(--forest);color:white}.secondary-action{border:1px solid #bccbc3;background:white;color:var(--forest)}.primary-action:focus-visible,.secondary-action:focus-visible,.record-link:focus-visible{outline:3px solid var(--lime);outline-offset:2px}.data-panel,.data-empty,.operation-feedback{grid-column:span 12}.data-table-wrap{margin-top:1.4rem;overflow-x:auto}.data-table-wrap table{width:100%;border-collapse:collapse;text-align:left}.data-table-wrap th,.data-table-wrap td{padding:.85rem .75rem;border-bottom:1px solid var(--line);vertical-align:top}.data-table-wrap th{color:var(--muted);font-size:.68rem;text-transform:uppercase;letter-spacing:.08em}.data-table-wrap code{font-size:.72rem}.record-link{color:var(--forest);font-weight:800}.status-pill[data-status-role=success]{border-color:#a7d3b8;background:#e8f6ed;color:#246240}.status-pill[data-status-role=attention]{border-color:#efc98c;background:#fff7e8;color:#8a5918}.status-pill[data-status-role=blocked]{border-color:#e3aaa4;background:#fff0ee;color:#8f3028}.status-pill[data-status-role=inProgress]{border-color:#abc8d8;background:#edf7fc;color:#2d607d}.list-pagination{display:flex;justify-content:flex-end;margin-top:1rem}.list-page-link{display:inline-grid;place-items:center;min-height:2.75rem;padding:.7rem 1rem;border-radius:.65rem;background:var(--forest);color:white;font-weight:750;text-decoration:none}.list-page-link:focus-visible{outline:3px solid var(--lime);outline-offset:2px}.record-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.8rem;margin:1.5rem 0}.record-fields div{padding:1rem;border:1px solid var(--line);border-radius:.8rem}.record-fields dt,.form-fields span{color:var(--muted);font-size:.7rem;font-weight:800;text-transform:uppercase;letter-spacing:.07em}.record-fields dd{margin:.45rem 0 0}.form-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1rem;margin:1.5rem 0}.form-fields label{display:grid;gap:.45rem}.form-fields input{width:100%;min-height:2.75rem;padding:.7rem .8rem;border:1px solid #bccbc3;border-radius:.65rem;background:white;color:var(--ink);font:inherit}.form-fields input:focus-visible,button:focus-visible{outline:3px solid var(--lime);outline-offset:2px}button{min-height:2.75rem;padding:.7rem 1rem;border:0;border-radius:.65rem;background:var(--forest);color:white;font:inherit;font-weight:750;cursor:pointer}.lifecycle-action{margin-top:1.25rem}.operation-feedback{padding:1rem 1.2rem;border:1px solid #a7d3b8;border-radius:.9rem;background:#e8f6ed;color:#246240}.operation-feedback strong{margin-right:.35rem}.muted{color:var(--muted)}
@media(max-width:800px){.app-shell{display:block}.sidebar{position:static;width:100%;height:auto;padding:1rem}.brand{padding-bottom:.8rem}.sidebar nav ul{display:flex;overflow-x:auto}.sidebar nav li{flex:0 0 auto}.sidebar a{grid-template-columns:1.8rem auto}.nav-arrow,.release-card,.nav-label{display:none}.topbar{height:auto;min-height:4rem;gap:1rem}.surface-heading{align-items:flex-start;flex-direction:column}.surface-status{justify-content:flex-start}.fact-grid,.record-fields,.form-fields{grid-template-columns:1fr}.principal strong{max-width:9rem;overflow:hidden;text-overflow:ellipsis}.surface-heading h1{font-size:2.8rem}}
@media(prefers-reduced-motion:no-preference){.sidebar a,.panel{transition:transform .18s ease,background .18s ease,box-shadow .18s ease}.panel:hover{transform:translateY(-2px);box-shadow:0 22px 60px rgba(24,61,47,.12)}}
`;
