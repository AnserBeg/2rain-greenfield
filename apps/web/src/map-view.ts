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
  /** The Record link for a stop; injected only by renderer tests. */
  recordHref?: (recordId: string) => string,
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
  const groupField = surface.fields?.find(
    (f) => f.fieldId === b.group?.fieldId,
  );
  const routes = groupField?.kind === 'enumFieldType' ? groupField.options : [];
  // Wording comes from the declarations: the group field's List column label
  // and the collection's List label (rule 16), never dispatch vocabulary.
  const owner = surfaces.find((s) => s.surfaceId === b.listSurfaceId);
  const collection = owner?.label ?? surface.label;
  const groupLabel =
    owner?.list?.columns.find((c) => c.field === b.group?.fieldId)?.label ??
    surface.label;
  const dayLabel =
    (b.defaultScope.kind === 'day' &&
      owner?.list?.columns.find(
        (c) =>
          b.defaultScope.kind === 'day' && c.field === b.defaultScope.fieldId,
      )?.label) ||
    'Day';
  const routeName = (group: string | null) =>
    routes.find((option) => option.optionId === group)?.label ??
    group ??
    'No ' + groupLabel;
  const labelField = surface.fields?.find((f) => f.fieldId === b.label.fieldId);
  const titleOf = (r: (typeof result.records)[number]) => {
    const value = r.values[b.label.fieldId];
    if (labelField?.kind === 'enumFieldType')
      return (
        labelField.options.find((o) => o.optionId === value)?.label ??
        String(value ?? r.recordId)
      );
    return r.displayValues?.[b.label.fieldId] ?? String(value ?? r.recordId);
  };
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
  // Styles follow the first-seen order of this page's groups, so two routes
  // on one page never share a style while four or fewer are visible.
  const groups = new Map<string | null, number>();
  const pattern = (group: string | null) => {
    if (!groups.has(group)) groups.set(group, groups.size % 4);
    return groups.get(group)!;
  };
  let prev: {
    ordinal: number;
    group: string | null;
    x: number;
    y: number;
  } | null = null;
  const lines: string[] = [],
    pins: string[] = [],
    items: string[] = [];
  let onCanvas = 0;
  for (const [index, s] of page.stops.entries()) {
    const r = result.records[index]!;
    if (r.recordId !== s.recordId) throw new Error('Map row differs.');
    const label = titleOf(r);
    const text = (s.ordinal ? s.ordinal + '. ' : '') + label;
    const href = h(
      recordHref
        ? recordHref(r.recordId)
        : surfaceHref(record, r.recordId, false, {
            view,
            legalEntitySelection: [company],
          }),
    );
    const p = s.point && projectPin(v, s.point),
      style = pattern(s.group);
    if (p) {
      if (p.x >= 0 && p.x <= width && p.y >= 0 && p.y <= height) onCanvas++;
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
        h(s.provenance) +
        (s.ordinal === null ? ' · Order unknown' : '') +
        '</li>',
    );
  }
  const handle =
    gateways.viewportNavigation &&
    page.installationId &&
    gateways.addresses?.issueViewport?.(
      view,
      surface.surfaceId,
      company,
      page.installationId,
      v,
    );
  const browserDisplay = page.display === 'browser';
  const image =
    handle && browserDisplay
      ? '<foreignObject width="' +
        width +
        '" height="' +
        height +
        '"><div xmlns="http://www.w3.org/1999/xhtml" data-map-frame="/map/display?image=' +
        encodeURIComponent(handle) +
        '"></div></foreignObject>' +
        '<rect width="' +
        width +
        '" height="' +
        (height - 24) +
        '" fill="transparent"/>'
      : handle
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
  // The next page fits its own pins unless the person chose an area.
  const next = new URLSearchParams(params);
  if (page.hasNext) next.set('stops', page.hasNext);
  if (!area) for (const k of ['cx', 'cy', 'zoom']) next.delete(k);
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
    onCanvas +
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
      link('All ' + collection + ' in this filter', localUrl(all)),
    ].join(' ') +
    '</nav>' +
    (browserDisplay
      ? '<p data-map-status role="status">Map background unavailable.</p>'
      : handle
        ? ''
        : '<p role="status">Map background unavailable.</p>') +
    '<svg data-map-drag viewBox="0 0 ' +
    width +
    ' ' +
    height +
    '" aria-label="' +
    h('Map of ' + collection) +
    '">' +
    (!browserDisplay && handle
      ? '<text x="8" y="24">Map background unavailable.</text>'
      : '') +
    image +
    (browserDisplay ? '<g data-map-overlay visibility="hidden">' : '') +
    lines.join('') +
    pins.join('') +
    (browserDisplay ? '</g>' : '') +
    '</svg>' +
    (!browserDisplay && handle && page.attribution
      ? '<p>' + h(page.attribution) + '</p>'
      : '') +
    '<p>' +
    h('Order of the ' + collection + ' you can see') +
    ' · straight lines, not roads</p>' +
    (b.group
      ? '<ul aria-label="' +
        h(groupLabel + ' legend') +
        '">' +
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
      ? '<label>' +
        h(dayLabel) +
        ' <input type="date" required name="day" value="' +
        h(day) +
        '"></label>'
      : '') +
    (b.group
      ? '<label>' +
        h(groupLabel) +
        ' <select name="route"><option value="">All</option>' +
        [...routes, { optionId: 'ungrouped', label: 'No ' + groupLabel }]
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
  return {
    title:
      '<h1 id="map" tabindex="-1" data-map-state="' +
      h(localUrl(params)) +
      '">' +
      h(surface.label) +
      '</h1>',
    savedViews: controls,
    mapCanvas: canvas,
    stopList: renderMapStopList(
      items,
      page,
      page.hasNext ? localUrl(next) : null,
      {
        collection,
        narrow: [b.group && groupLabel, day && dayLabel].filter(
          (x): x is string => Boolean(x),
        ),
      },
    ),
  };
}

export function renderMapStopList(
  items: readonly string[],
  page: { readonly partial: boolean; readonly restarted?: boolean },
  nextUrl: string | null,
  words: { readonly collection: string; readonly narrow: readonly string[] },
) {
  const narrow = words.narrow.length
    ? ' — choose a ' + words.narrow.join(' or ')
    : '';
  return (
    (page.partial ? '<p role="status">Narrow the search</p>' : '') +
    (page.restarted
      ? '<p role="status">' +
        h('This page changed. Showing the first ' + words.collection + '.') +
        '</p>'
      : '') +
    (items.length
      ? '<ol class="map-stops">' + items.join('') + '</ol>'
      : page.partial
        ? ''
        : '<p>' + h('No ' + words.collection + ' in this filter.') + '</p>') +
    (nextUrl
      ? '<p role="status">' +
        h(
          'Showing ' +
            items.length +
            ' of this filter’s ' +
            words.collection +
            narrow,
        ) +
        '</p>' +
        '<a data-pan-link href="' +
        h(nextUrl) +
        '">Next</a>'
      : '')
  );
}
