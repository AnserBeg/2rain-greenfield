import {
  MAP_SIZES,
  fitMap,
  MapViewportSchema,
  panMap,
  projectPin,
  type MapViewport,
} from '@north-star/canonical-model';
import type {
  RequestRuntimeView,
  ImmutableJsonValue,
} from '@north-star/runtime/request-runtime-view';
import { SEMANTIC_QUERY_REQUEST_VERSION } from '../../../packages/runtime/src/semantic-query-gateway.js';
import type { CompiledSurfaceDefinition } from './surface-contract.js';
import type { SurfaceRuntimeGateways } from './surface-runtime.js';
import { surfaceHref } from './component-registry.js';
import { escapeHtml as h } from './html.js';

function localUrl(p: URLSearchParams) {
  return '/?' + p.toString() + '#map';
}
function setView(params: URLSearchParams, v: MapViewport, area: boolean) {
  params.set('cx', String(v.x));
  params.set('cy', String(v.y));
  params.set('zoom', String(v.zoom));
  params.set('size', v.size);
  if (area) params.set('area', '1');
  else params.delete('area');
}
function viewportFrom(p: URLSearchParams) {
  if (!p.has('cx') && !p.has('cy') && !p.has('zoom')) return null;
  const cell = (key: string) =>
    /^\d{1,5}$/u.test(p.get(key) ?? '') ? Number(p.get(key)) : NaN;
  return MapViewportSchema.parse({
    x: cell('cx'),
    y: cell('cy'),
    zoom: cell('zoom'),
    size: p.get('size') ?? 'medium',
  });
}
const field = (name: string, value: string) =>
  '<input type="hidden" name="' + h(name) + '" value="' + h(value) + '">';
export async function readMapSlots(
  view: RequestRuntimeView,
  surface: CompiledSurfaceDefinition,
  surfaces: readonly CompiledSurfaceDefinition[],
  url: URL,
  scope: Readonly<Record<string, ImmutableJsonValue>>,
  company: string | null,
  gateways: SurfaceRuntimeGateways,
) {
  const map = surface.map!,
    b = map.body;
  const params = new URLSearchParams(url.searchParams),
    record = surfaces.find(
      (s) => s.surfaceId === b.recordSurfaceId && s.lifecycle === 'active',
    );
  if (
    !company ||
    !record ||
    (await gateways.queryGateway.previewEligibility(
      view,
      b.getQueryId,
      company,
    )) !== 'eligible'
  )
    throw new Error('Map collection unavailable.');
  params.set('mapCompany', company);
  const groupField = record.fields?.find((f) => f.fieldId === b.group?.fieldId);
  const routes = groupField?.kind === 'enumFieldType' ? groupField.options : [];
  const routeName = (group: string | null) =>
    routes.find((option) => option.optionId === group)?.label ??
    group ??
    'Ungrouped';
  const size = MapViewportSchema.shape.size.parse(
    params.get('size') ?? 'medium',
  );
  let prior = viewportFrom(params),
    area = params.get('area') === '1';
  const pinned = params.get('bounds');
  let filterViewport = pinned
    ? viewportFrom(new URLSearchParams(pinned))
    : prior;
  if (params.has('panX') || params.has('panY')) {
    const shifts = ['panX', 'panY'].map((k) => Number(params.get(k)));
    if (
      !prior ||
      !shifts.every((x) => Number.isSafeInteger(x) && Math.abs(x) <= 1024)
    )
      throw new Error('Invalid pan distance.');
    prior = panMap(prior, shifts[0]!, shifts[1]!);
    filterViewport = prior;
    params.delete('bounds');
    area = true;
    params.delete('panX');
    params.delete('panY');
    params.delete('stops');
  }
  if (area && (!prior || !filterViewport))
    throw new Error('Choose a Map viewport.');
  const day =
    b.defaultScope.kind === 'day'
      ? (params.get('day') ??
        new Intl.DateTimeFormat('en-CA', {
          timeZone: b.defaultScope.timeZone,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        }).format(gateways.clock?.() ?? new Date()))
      : null;
  if (day) params.set('day', day);
  const result = await gateways.queryGateway.invoke(view, {
    schemaVersion: SEMANTIC_QUERY_REQUEST_VERSION,
    queryId: b.listQueryId,
    arguments: {
      ...scope,
      mapPage: {
        surfaceId: surface.surfaceId,
        revisionId: map.revisionId,
        companyId: company,
        ...(day && { day }),
        ...(params.has('route') &&
          params.get('route') !== '' && {
            route:
              params.get('route') === 'ungrouped' ? '' : params.get('route')!,
          }),
        ...(area && filterViewport && { area: filterViewport }),
        ...(params.get('stops') && { cursor: params.get('stops') }),
      },
    },
  });
  const page = result.mapCoverage;
  if (
    result.outcome !== 'exact' ||
    page?.revisionId !== map.revisionId ||
    result.records.length !== page.stops.length ||
    result.records.length > Math.min(100, page.pageSize)
  )
    throw new Error('Map coverage unavailable.');
  const points = page.stops.flatMap((s) => (s.point ? [s.point] : []));
  const v = prior ?? fitMap(points, size);
  setView(params, v, area);
  const [width, height] = MAP_SIZES[v.size];
  const at = (v: MapViewport, inArea: boolean) => {
    const p = new URLSearchParams(params);
    p.delete('stops');
    p.delete('bounds');
    setView(p, v, inArea);
    return localUrl(p);
  };
  const link = (label: string, href: string) =>
    '<a data-pan-link href="' + h(href) + '">' + h(label) + '</a>';
  const pattern = (group: string | null) => {
    let hash = 0;
    for (const c of group ?? '') hash = (31 * hash + c.charCodeAt(0)) | 0;
    return Math.abs(hash) % 4;
  };
  const groups = new Map<string | null, number>();
  let prev: {
    ordinal: number;
    group: string | null;
    x: number;
    y: number;
  } | null = null;
  const lines: string[] = [],
    pins: string[] = [],
    items: string[] = [];
  for (const [index, s] of page.stops.entries()) {
    const r = result.records[index]!;
    if (r.recordId !== s.recordId) throw new Error('Map row differs.');
    groups.set(s.group, pattern(s.group));
    const label = String(r.values[b.label.fieldId] ?? r.recordId);
    const text = (s.ordinal ? s.ordinal + '. ' : '') + label;
    const href = h(
      surfaceHref(record, r.recordId, false, {
        view,
        legalEntitySelection: [company],
      }),
    );
    const p = s.point && projectPin(v, s.point),
      style = pattern(s.group);
    if (p) {
      if (
        prev &&
        s.ordinal !== null &&
        s.group === prev.group &&
        s.ordinal === prev.ordinal + 1
      )
        lines.push(
          '<line class="map-route group-' +
            style +
            '" x1="' +
            prev.x +
            '" y1="' +
            prev.y +
            '" x2="' +
            p.x +
            '" y2="' +
            p.y +
            '"/>',
        );
      pins.push(
        '<a href="' +
          href +
          '" aria-label="' +
          h(text) +
          '"><title>' +
          h(text) +
          '</title><circle class="map-hit" cx="' +
          p.x +
          '" cy="' +
          p.y +
          '" r="22"/><circle class="map-pin group-' +
          style +
          '" cx="' +
          p.x +
          '" cy="' +
          p.y +
          '" r="12"/><text x="' +
          p.x +
          '" y="' +
          (p.y + 4) +
          '" text-anchor="middle">' +
          (s.ordinal ?? '•') +
          '</text></a>',
      );
    }
    prev =
      p && s.ordinal !== null
        ? { ...p, group: s.group, ordinal: s.ordinal }
        : null;
    items.push(
      '<li><a href="' +
        href +
        '">' +
        h(text) +
        '</a> ' +
        h(b.group ? routeName(s.group) : '') +
        ' · ' +
        h(s.source) +
        (s.ordinal === null ? ' · Order unknown' : '') +
        '</li>',
    );
  }
  const handle =
    page.installationId &&
    gateways.addresses?.issueViewport?.(
      view,
      surface.surfaceId,
      company,
      page.installationId,
      v,
    );
  const image = handle
    ? '<image width="' +
      width +
      '" height="' +
      height +
      '" href="/map/image?company=' +
      encodeURIComponent(company) +
      '&amp;image=' +
      encodeURIComponent(handle) +
      '"/>'
    : '';
  const next = new URLSearchParams(params);
  if (page.hasNext) next.set('stops', page.hasNext);
  const all = new URLSearchParams(params);
  for (const k of ['area', 'cx', 'cy', 'zoom', 'stops', 'bounds'])
    all.delete(k);
  const fit = new URLSearchParams(params);
  setView(fit, fitMap(points, size), area);
  if (area && filterViewport) {
    const bounds = new URLSearchParams();
    setView(bounds, filterViewport, false);
    fit.set('bounds', bounds.toString());
  }
  const canvas =
    '<details open><summary>Map · ' +
    points.length +
    ' of ' +
    items.length +
    ' on the map</summary>' +
    '<nav aria-label="Map controls">' +
    [
      link('North', at(panMap(v, 0, -height / 3), true)),
      link('South', at(panMap(v, 0, height / 3), true)),
      link('West', at(panMap(v, -width / 3, 0), true)),
      link('East', at(panMap(v, width / 3, 0), true)),
      link('Zoom in', at({ ...v, zoom: Math.min(13, v.zoom + 1) }, true)),
      link('Zoom out', at({ ...v, zoom: Math.max(0, v.zoom - 1) }, true)),
      link('Fit this page', localUrl(fit)),
      link('All stops in this filter', localUrl(all)),
    ].join(' ') +
    '</nav>' +
    (handle ? '' : '<p role="status">Map background unavailable.</p>') +
    '<svg data-map-drag viewBox="0 0 ' +
    width +
    ' ' +
    height +
    '" aria-label="Map of stops">' +
    image +
    lines.join('') +
    pins.join('') +
    '</svg>' +
    (handle ? '<p>Demo Maps · simulated basemap</p>' : '') +
    '<p>Order of the stops you can see · straight lines, not roads</p>' +
    (b.group
      ? '<ul aria-label="Route legend">' +
        [...groups]
          .map(
            ([g, n]) =>
              '<li class="group-' +
              n +
              '">' +
              h(routeName(g)) +
              ' · ' +
              ['solid', 'dashed', 'dotted', 'dash-dot'][n] +
              '</li>',
          )
          .join('') +
        '</ul>'
      : '') +
    '</details>';
  const preserved = [...params]
    .filter(
      ([k]) =>
        ![
          'cx',
          'cy',
          'zoom',
          'area',
          'bounds',
          'stops',
          'size',
          'day',
          'route',
        ].includes(k),
    )
    .map(([k, v]) => field(k, v))
    .join('');
  const controls =
    '<form action="/#map" method="get" data-map-form>' +
    preserved +
    (day
      ? '<label>Day <input type="date" required name="day" value="' +
        h(day) +
        '"></label>'
      : '') +
    (b.group
      ? '<label>Route <select name="route"><option value="">All routes</option>' +
        [...routes, { optionId: 'ungrouped', label: 'Ungrouped' }]
          .map(
            (option) =>
              '<option value="' +
              h(option.optionId) +
              '"' +
              (params.get('route') === option.optionId ? ' selected' : '') +
              '>' +
              h(option.label) +
              '</option>',
          )
          .join('') +
        '</select></label>'
      : '') +
    '<label>Map size <select name="size">' +
    Object.entries(MAP_SIZES)
      .map(
        ([name, dimensions]) =>
          '<option value="' +
          name +
          '"' +
          (name === size ? ' selected' : '') +
          '>' +
          dimensions.join(' × ') +
          '</option>',
      )
      .join('') +
    '</select></label><button>Apply filters</button></form>';
  const stopList =
    (page.partial ? '<p role="status">Narrow the search</p>' : '') +
    (page.restarted
      ? '<p role="status">This page changed. Showing the first stops.</p>'
      : '') +
    (items.length
      ? '<ol class="map-stops">' + items.join('') + '</ol>'
      : '<p>No stops in this filter.</p>') +
    (page.hasNext
      ? '<p role="status">Showing ' +
        items.length +
        ' of this filter’s stops — choose a route or day</p>' +
        link('Next', localUrl(next))
      : '');
  return {
    title:
      '<h1 id="map" tabindex="-1" data-map-state="' +
      h(localUrl(params)) +
      '">' +
      h(surface.label) +
      '</h1>',
    savedViews: controls,
    mapCanvas: canvas,
    stopList,
  };
}
