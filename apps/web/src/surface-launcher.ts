import type * as RuntimeViewContract from '@north-star/runtime/request-runtime-view';
import type { SurfaceLauncher } from '../../../packages/canonical-model/src/index.js';
import {
  registeredSemanticQueryFromPinnedView,
  SEMANTIC_QUERY_REQUEST_VERSION,
  type SemanticQueryGateway,
} from '../../../packages/runtime/src/semantic-query-gateway.js';

import { escapeHtml as h } from './html.js';
import {
  declaredListArguments,
  readDeclaredListState,
} from './list-declaration.js';
import { messageAttributes, messageBody } from './message-render.js';
import {
  readCompiledSurfaceDataBinding,
  type CompiledSurfaceDefinition,
} from './surface-contract.js';

/**
 * A launcher Task (canonical `surface.launcher`, WAREHOUSE-MODE): the tiles
 * that open declared List views with their counts, and the scan box that
 * opens the record a code names. Everything here is a link, or a declared
 * query asked through the gateway under current policy on every request;
 * nothing is posted, and no count or record is guessed.
 */

/** Why a scanned code opened nothing. The code stays in the box. */
export type ScanOutcomeCode = 'SCAN_NO_MATCH' | 'SCAN_NOT_EXACT';

export interface LauncherTile {
  readonly tileId: string;
  readonly label: string;
  readonly description: string;
  readonly href: string;
  /** The opened view's count; null when it could not be read -- never a guess. */
  readonly count: number | null;
  /** The opened view's own label, read beside its count. */
  readonly viewLabel: string | null;
}

export interface LauncherRenderData {
  readonly tiles: readonly LauncherTile[];
  /** The company the page was entered in, carried by the scan form as the page carries it. */
  readonly scope: {
    readonly parameterId: string;
    readonly value: string;
  } | null;
  /** The last code scanned and why it opened nothing; null before a scan. */
  readonly scan: {
    readonly code: string;
    readonly outcome: ScanOutcomeCode;
  } | null;
}

/** The longest code a scan box accepts; longer input is no barcode. */
export const SCAN_CODE_MAXIMUM_LENGTH = 120;

/**
 * The parameter a page carries its company under: its own query's scope, or,
 * for a record every company shares (an item), the scope of the List its
 * entry is authorized by -- as that page's own entry reads it.
 */
export function companyParameterFor(
  view: RuntimeViewContract.RequestRuntimeView,
  surface: CompiledSurfaceDefinition,
): string | null {
  const own = readCompiledSurfaceDataBinding(view, surface).query
    .legalEntityScope?.operand.parameterId;
  if (own) return own;
  const entry = surface.workspace?.entry;
  return entry
    ? (registeredSemanticQueryFromPinnedView(view, entry.authorizationQueryId)
        ?.legalEntityScope?.operand.parameterId ?? null)
    : null;
}

/**
 * Each tile's link to its List at its view, in the page's company, with that
 * view's count asked exactly as the List counts its own tab. A count current
 * policy withholds, or one without the company its List needs, is omitted:
 * the tile still opens its List, which says why.
 */
export async function launcherTiles(
  view: RuntimeViewContract.RequestRuntimeView,
  launcher: SurfaceLauncher,
  surfaces: readonly CompiledSurfaceDefinition[],
  company: string | null,
  queryGateway: SemanticQueryGateway,
  now: Date,
): Promise<readonly LauncherTile[]> {
  const ordered = [...launcher.tiles].sort(
    (left, right) =>
      left.orderKey - right.orderKey ||
      (left.tileId < right.tileId ? -1 : left.tileId > right.tileId ? 1 : 0),
  );
  const tiles: LauncherTile[] = [];
  for (const tile of ordered) {
    const surface = surfaces.find(
      (candidate) => candidate.surfaceId === tile.surface,
    );
    const list = surface?.list;
    const parameters = new URLSearchParams({ surface: tile.surface });
    if (tile.view) parameters.set('view', tile.view);
    let count: number | null = null;
    if (surface && list) {
      try {
        const binding = readCompiledSurfaceDataBinding(view, surface);
        const scope = binding.query.legalEntityScope?.operand.parameterId;
        if (scope && company) parameters.set(scope, company);
        if (!scope || company) {
          const state = readDeclaredListState(
            list,
            new URL(`http://launcher.local/?${parameters.toString()}`),
          );
          const result = await queryGateway.invoke(view, {
            arguments: declaredListArguments(list, state, {
              mode: 'count',
              now,
              queryId: binding.query.queryId,
              scopeArguments: scope ? { [scope]: company } : {},
              viewId: state.viewId,
            }),
            queryId: binding.query.queryId,
            schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
          });
          count = result.listCoverage?.totalCount ?? null;
        }
      } catch {
        count = null;
      }
    }
    tiles.push(
      Object.freeze({
        tileId: tile.tileId,
        label: tile.label,
        description: tile.description,
        href: `/?${parameters.toString()}`,
        count,
        viewLabel:
          list?.views.find((candidate) => candidate.viewId === tile.view)
            ?.label ?? null,
      }),
    );
  }
  return Object.freeze(tiles);
}

/**
 * The record a scanned or typed code names: each declared target in turn
 * resolves the code through its own resolve query, in the page's company
 * where the query is scoped to one, and the first that matches exactly one
 * record by an identifier opens it on its record page. A name, or more than
 * one record, never opens anything. A target current policy withholds, or one
 * that cannot answer, is passed over without saying so -- a refusal would
 * tell a reader that a document it may not see exists.
 */
export async function resolveLauncherScan(
  view: RuntimeViewContract.RequestRuntimeView,
  launcher: SurfaceLauncher,
  surfaces: readonly CompiledSurfaceDefinition[],
  company: string | null,
  queryGateway: SemanticQueryGateway,
  code: string,
): Promise<
  { readonly location: string } | { readonly outcome: ScanOutcomeCode }
> {
  const text = code.trim();
  let notExact = false;
  if (text && text.length <= SCAN_CODE_MAXIMUM_LENGTH && launcher.scan)
    for (const target of launcher.scan.targets) {
      const definition = registeredSemanticQueryFromPinnedView(
        view,
        target.query,
      );
      const page = surfaces.find(
        (candidate) => candidate.surfaceId === target.surface,
      );
      if (!definition || definition.queryType !== 'resolve' || !page) continue;
      const scope = definition.legalEntityScope?.operand.parameterId;
      if (scope && !company) continue;
      let result;
      try {
        result = await queryGateway.invoke(view, {
          arguments: {
            includeArchived: false,
            limit: definition.maximumResultCount,
            text,
            ...(scope ? { [scope]: company } : {}),
          },
          queryId: target.query,
          schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
        });
      } catch {
        continue;
      }
      const [record] = result.records;
      if (result.outcome === 'exact' && result.records.length === 1 && record) {
        const parameters = new URLSearchParams({
          surface: page.surfaceId,
          record: record.recordId,
        });
        const parameter = company ? companyParameterFor(view, page) : null;
        if (parameter && company) parameters.set(parameter, company);
        return { location: `/?${parameters.toString()}` };
      }
      if (result.records.length > 0) notExact = true;
    }
  return { outcome: notExact ? 'SCAN_NOT_EXACT' : 'SCAN_NO_MATCH' };
}

/** The one scan form on a launcher page; the primary action submits it. */
export function launcherScanFormId(surface: CompiledSurfaceDefinition): string {
  return `launcher-scan-${surface.surfaceId.replace(/[^a-z0-9]+/gu, '-')}`;
}

/** The decision: one large tile per declared destination, with its count. */
export function renderLauncherTiles(
  surface: CompiledSurfaceDefinition,
  data: LauncherRenderData,
): string {
  return `<nav class="launcher-tiles" aria-label="${h(surface.label)}"><ul>${data.tiles
    .map(
      (tile) =>
        `<li><a class="launcher-tile" href="${h(tile.href)}" data-launcher-tile="${h(tile.tileId)}"><strong class="launcher-tile__label">${h(tile.label)}</strong>${tile.count === null ? '' : `<span class="launcher-tile__count" data-launcher-count>${String(tile.count)}</span>`}${tile.viewLabel ? `<span class="launcher-tile__view">${h(tile.viewLabel)}</span>` : ''}<span class="launcher-tile__description">${h(tile.description)}</span></a></li>`,
    )
    .join('')}</ul></nav>`;
}

/**
 * The scan box: one field, focused on arrival so a keyboard-wedge scanner
 * can type into it at once, submitted by Enter or the primary action as an
 * ordinary GET -- it works without script, and its answer is the record's own
 * page or this page again with the code kept and the reason it opened nothing.
 */
export function renderLauncherScan(
  surface: CompiledSurfaceDefinition,
  data: LauncherRenderData,
): string {
  const scan = surface.launcher?.scan;
  if (!scan) return '';
  const messageId = `${launcherScanFormId(surface)}-message`;
  const outcome = data.scan?.outcome;
  return `<section class="panel launcher-scan"><form id="${h(launcherScanFormId(surface))}" class="launcher-scan__form" method="get" action="/" role="search"><input type="hidden" name="surface" value="${h(surface.surfaceId)}">${data.scope ? `<input type="hidden" name="${h(data.scope.parameterId)}" value="${h(data.scope.value)}">` : ''}<label class="launcher-scan__field"><span>${h(scan.label)}</span><input name="scan" value="${h(data.scan?.code ?? '')}" data-scan-input="true" autocomplete="off" autocapitalize="characters" spellcheck="false" enterkeyhint="go" maxlength="${String(SCAN_CODE_MAXIMUM_LENGTH)}" required autofocus${outcome ? ` aria-invalid="true" aria-describedby="${h(messageId)}"` : ''}></label>${outcome ? `<div id="${h(messageId)}" class="launcher-scan__message" role="alert" ${messageAttributes({ code: outcome })}>${messageBody({ code: outcome }, scan.label, 'h2')}</div>` : ''}</form></section>`;
}

/** The sticky primary action: submits the scan box. */
export function renderLauncherAction(
  surface: CompiledSurfaceDefinition,
): string {
  const scan = surface.launcher?.scan;
  return scan
    ? `<div class="task-primary-action launcher-action"><button type="submit" form="${h(launcherScanFormId(surface))}">${h(scan.actionLabel)}</button></div>`
    : '';
}
