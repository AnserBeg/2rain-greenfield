import { assertRequestRuntimeView } from '@north-star/runtime/request-runtime-view';
import type * as RuntimeViewContract from '@north-star/runtime/request-runtime-view';

import { renderRegisteredSurfaceComponent } from './component-registry.js';
import { escapeHtml, shortIdentity } from './html.js';
import {
  readCompiledSurfaceManifest,
  SurfaceProjectionError,
  type CompiledSurfaceDefinition,
} from './surface-contract.js';

export interface SurfaceRuntimeResponse {
  readonly html: string;
  readonly statusCode: number;
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

  const renderedSlots = selected.slots.map((slot) =>
    renderRegisteredSurfaceComponent({ slot, surface: selected, view }),
  );
  const body = `<header class="surface-heading">
      <div>
        <p class="eyebrow">${escapeHtml(selected.archetype)} surface · compiled release</p>
        <h1>${escapeHtml(selected.label)}</h1>
        <p class="surface-id">${escapeHtml(selected.surfaceId)}</p>
      </div>
      <div class="surface-status" aria-label="Surface status roles">
        ${selected.statusRoles.map((role) => `<span data-status-role="${escapeHtml(role)}">${escapeHtml(role)}</span>`).join('')}
      </div>
    </header>
    <div class="surface-grid" data-surface-archetype="${escapeHtml(selected.archetype)}">
      ${renderedSlots.map((result) => result.html).join('')}
    </div>`;

  return Object.freeze({
    html: shellDocument(view, surfaces, selected, body),
    statusCode: 200,
  });
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
          <ul>${surfaces.map((surface) => navigationItem(surface, selected)).join('')}</ul>
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
  surface: CompiledSurfaceDefinition,
  selected: CompiledSurfaceDefinition | null,
): string {
  const current = surface.surfaceId === selected?.surfaceId;
  return `<li><a href="/?surface=${encodeURIComponent(surface.surfaceId)}"${current ? ' aria-current="page"' : ''}><span class="nav-icon" aria-hidden="true">${escapeHtml(surface.label.slice(0, 1).toUpperCase())}</span><span>${escapeHtml(surface.label)}</span><span class="nav-arrow" aria-hidden="true">›</span></a></li>`;
}

const styles = `
:root{--ink:#17221d;--muted:#66736c;--line:#dce4df;--paper:#f6f8f5;--panel:#fff;--forest:#183d2f;--mint:#dff2e7;--lime:#b8dc74;--amber:#d88b2e;--danger:#ad3f35;--shadow:0 18px 55px rgba(24,61,47,.09);font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--ink);background:var(--paper)}
*{box-sizing:border-box}body{margin:0;min-width:320px;background:radial-gradient(circle at 80% 0,rgba(184,220,116,.16),transparent 30rem),var(--paper);font-size:15px}.skip-link{position:fixed;left:1rem;top:-5rem;z-index:5;background:var(--forest);color:white;padding:.7rem 1rem;border-radius:.6rem}.skip-link:focus{top:1rem}.app-shell{min-height:100vh;display:grid;grid-template-columns:17.5rem minmax(0,1fr)}.sidebar{position:sticky;top:0;height:100vh;display:flex;flex-direction:column;padding:1.5rem 1.2rem;background:linear-gradient(165deg,#173b2e 0%,#102a21 100%);color:#f6fff9}.brand{display:flex;gap:.8rem;align-items:center;padding:.2rem .55rem 1.8rem}.brand__mark{display:grid;place-items:center;width:2.3rem;height:2.3rem;border-radius:.75rem;background:var(--lime);color:#15382b;font-size:1.3rem;font-weight:800;box-shadow:inset 0 0 0 1px rgba(255,255,255,.45)}.brand strong,.brand small{display:block}.brand strong{font-size:1.15rem;letter-spacing:.01em}.brand small{margin-top:.1rem;color:#a9c2b6;font-size:.72rem}.nav-label{padding:0 .7rem;color:#88a599;font-size:.65rem;font-weight:800;letter-spacing:.14em;text-transform:uppercase}.sidebar ul{display:grid;gap:.32rem;padding:0;margin:.55rem 0;list-style:none}.sidebar a{display:grid;grid-template-columns:2rem 1fr auto;gap:.6rem;align-items:center;min-height:2.8rem;padding:.42rem .65rem;border:1px solid transparent;border-radius:.8rem;color:#cfe0d8;text-decoration:none;font-weight:650}.sidebar a:hover{background:rgba(255,255,255,.07);color:white}.sidebar a:focus-visible{outline:3px solid var(--lime);outline-offset:2px}.sidebar a[aria-current=page]{background:#f7fbf8;color:var(--forest);box-shadow:0 9px 24px rgba(4,18,12,.25)}.nav-icon{display:grid;place-items:center;width:1.9rem;height:1.9rem;border-radius:.55rem;background:rgba(255,255,255,.09);font-size:.72rem;font-weight:800}.sidebar a[aria-current=page] .nav-icon{background:var(--mint)}.nav-arrow{font-size:1.4rem;opacity:.55}.release-card{display:flex;gap:.7rem;align-items:flex-start;margin-top:auto;padding:1rem;border:1px solid rgba(255,255,255,.1);border-radius:.9rem;background:rgba(255,255,255,.045)}.release-card__pulse{width:.52rem;height:.52rem;margin-top:.28rem;border-radius:50%;background:var(--lime);box-shadow:0 0 0 .3rem rgba(184,220,116,.12)}.release-card small,.release-card strong,.release-card span{display:block}.release-card small{color:#9bb3a8;font-size:.67rem;text-transform:uppercase;letter-spacing:.08em}.release-card strong{margin:.22rem 0;color:white;font-family:ui-monospace,monospace;font-size:.72rem}.release-card span{color:#aec2b8;font-size:.72rem}.workspace{min-width:0}.topbar{height:4.5rem;display:flex;align-items:center;justify-content:space-between;padding:0 clamp(1.2rem,3vw,3rem);border-bottom:1px solid var(--line);background:rgba(246,248,245,.84);backdrop-filter:blur(14px);color:var(--muted)}.topbar__context{color:var(--ink);font-weight:700}.topbar__divider{padding:0 .5rem;color:#aab5af}.principal{display:flex;align-items:center;gap:.65rem}.principal__avatar{display:grid;place-items:center;width:2rem;height:2rem;border-radius:50%;background:var(--mint);color:var(--forest);font-size:.67rem;font-weight:800}.principal small,.principal strong{display:block}.principal small{font-size:.62rem;color:var(--muted)}.principal strong{font-size:.74rem;color:var(--ink);font-family:ui-monospace,monospace}main{width:min(82rem,100%);margin:0 auto;padding:clamp(2rem,5vw,4.5rem) clamp(1.2rem,4vw,4rem) 5rem}.surface-heading{display:flex;align-items:flex-end;justify-content:space-between;gap:2rem;margin-bottom:2rem}.eyebrow{margin:0 0 .6rem;color:#587267;font-size:.68rem;font-weight:800;letter-spacing:.14em;text-transform:uppercase}.surface-heading h1,.standalone h1{margin:0;font-family:Georgia,"Times New Roman",serif;font-size:clamp(2.6rem,5vw,4.8rem);font-weight:500;line-height:.95;letter-spacing:-.04em}.surface-id{margin:.8rem 0 0;color:var(--muted);font-family:ui-monospace,monospace;font-size:.72rem}.surface-status{display:flex;gap:.45rem;flex-wrap:wrap;justify-content:flex-end}.surface-status span,.status-pill{padding:.4rem .65rem;border:1px solid #cbd8d1;border-radius:999px;background:rgba(255,255,255,.7);color:#52655c;font-size:.68rem;font-weight:750}.surface-status [data-status-role=success]{border-color:#a7d3b8;background:#e8f6ed;color:#246240}.surface-status [data-status-role=attention]{border-color:#efc98c;background:#fff7e8;color:#8a5918}.surface-status [data-status-role=blocked]{border-color:#e3aaa4;background:#fff0ee;color:#8f3028}.surface-status [data-status-role=inProgress]{border-color:#abc8d8;background:#edf7fc;color:#2d607d}.surface-grid{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:1.2rem}.panel,.diagnostic{grid-column:span 12;border:1px solid var(--line);border-radius:1.25rem;background:rgba(255,255,255,.92);box-shadow:var(--shadow)}.panel{padding:clamp(1.3rem,3vw,2rem)}.panel--hero{position:relative;overflow:hidden;background:linear-gradient(135deg,#fff 20%,#f1f8ed 100%)}.panel__accent{position:absolute;right:1.4rem;top:1.2rem;display:grid;place-items:center;width:3rem;height:3rem;border-radius:1rem;background:var(--forest);color:var(--lime);font-size:1.45rem}.panel h2,.diagnostic h2{max-width:43rem;margin:.2rem 0 .75rem;font-family:Georgia,"Times New Roman",serif;font-size:clamp(1.65rem,3vw,2.5rem);font-weight:500;letter-spacing:-.025em}.lede{max-width:45rem;color:#55665e;font-size:1.02rem;line-height:1.7}.fact-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:.75rem;margin:2rem 0 0}.fact-grid div{padding:1rem;border:1px solid #e1e8e3;border-radius:.85rem;background:rgba(255,255,255,.68)}.fact-grid dt{color:var(--muted);font-size:.64rem;font-weight:800;text-transform:uppercase;letter-spacing:.1em}.fact-grid dd{margin:.35rem 0 0;font-family:ui-monospace,monospace;font-size:.76rem;font-weight:700}.panel__heading{display:flex;align-items:flex-start;justify-content:space-between;gap:1rem}.panel__heading h2{margin:0}.checklist{display:grid;gap:.75rem;padding:0;margin:1.7rem 0 0;list-style:none}.checklist li{display:grid;grid-template-columns:2.2rem 1fr;gap:.8rem;align-items:start;padding:1rem 0;border-top:1px solid #e8ede9}.checklist li>span{display:grid;place-items:center;width:2rem;height:2rem;border-radius:.6rem;background:var(--mint);color:var(--forest);font-size:.65rem;font-weight:800}.checklist strong{font-size:.88rem}.checklist p{margin:.25rem 0 0;color:var(--muted);line-height:1.5}.diagnostic{display:flex;gap:1rem;align-items:flex-start;padding:1.5rem;border-color:#ebc8a2;background:#fffaf4}.diagnostic__mark{flex:0 0 auto;display:grid;place-items:center;width:2.5rem;height:2.5rem;border-radius:.8rem;background:#f6d7b3;color:#7f4810;font-size:1.2rem;font-weight:900}.diagnostic h2{font-size:1.65rem}.diagnostic p{color:#685b4e;line-height:1.55}.diagnostic code,.standalone code{display:inline-block;padding:.3rem .5rem;border-radius:.4rem;background:#f4e7d9;color:#734714;font-size:.7rem}.diagnostic--page h1{margin:.2rem 0 .7rem;font-family:Georgia,"Times New Roman",serif;font-size:2.5rem;font-weight:500}.standalone{min-height:100vh;display:grid;place-items:center;padding:1.5rem;background:radial-gradient(circle at 20% 10%,var(--mint),transparent 28rem),var(--paper)}.standalone__card{width:min(42rem,100%);padding:clamp(2rem,6vw,4rem);border:1px solid var(--line);border-radius:1.4rem;background:white;box-shadow:var(--shadow)}.standalone__card>p{color:var(--muted);line-height:1.65}.diagnostic-release{margin-top:2rem;font-family:ui-monospace,monospace;font-size:.75rem}
@media(max-width:800px){.app-shell{display:block}.sidebar{position:static;width:100%;height:auto;padding:1rem}.brand{padding-bottom:.8rem}.sidebar nav ul{display:flex;overflow-x:auto}.sidebar nav li{flex:0 0 auto}.sidebar a{grid-template-columns:1.8rem auto}.nav-arrow,.release-card,.nav-label{display:none}.topbar{height:auto;min-height:4rem;gap:1rem}.surface-heading{align-items:flex-start;flex-direction:column}.surface-status{justify-content:flex-start}.fact-grid{grid-template-columns:1fr}.principal strong{max-width:9rem;overflow:hidden;text-overflow:ellipsis}.surface-heading h1{font-size:2.8rem}}
@media(prefers-reduced-motion:no-preference){.sidebar a,.panel{transition:transform .18s ease,background .18s ease,box-shadow .18s ease}.panel:hover{transform:translateY(-2px);box-shadow:0 22px 60px rgba(24,61,47,.12)}}
`;
