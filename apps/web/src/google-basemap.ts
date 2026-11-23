import { createHash } from 'node:crypto';
import { escapeHtml } from './html.js';
import type { MapFrameDocument } from './map-display-origins.js';

const version = '3.66';

const bootstrap = `for (const el of [document.documentElement, document.body, document.getElementById('map')]) {
  el.style.margin = '0';
  el.style.height = '100%';
}
const app = document.documentElement.dataset.app;
function receive(event) {
  if (event.source !== parent || event.origin !== app) return;
  window.removeEventListener('message',receive);
  const {key, center, zoom} = event.data;
  const signal = state => parent.postMessage(state, app);
  window.gm_authFailure = () => signal('basemap-unavailable');
  window.initBasemap = () => {
    if (!google.maps.version.startsWith('${version}.')) return;
    const map = new google.maps.Map(document.getElementById('map'), {
      center, zoom, renderingType:'RASTER', mapTypeId:'roadmap', tilt:0, heading:0,
      disableDefaultUI:true, gestureHandling:'none', keyboardShortcuts:false, clickableIcons:false
    });
    map.addListener('tilesloaded', () => {
      const actual = map.getCenter();
      const aligned = actual && Math.abs(actual.lat()-center.lat)<1e-6 &&
        Math.abs(actual.lng()-center.lng)<1e-6 && map.getZoom()===zoom;
      signal(aligned ? 'basemap-ready' : 'basemap-unavailable');
    });
  };
  const url = new URL('https://maps.googleapis.com/maps/api/js');
  url.search = new URLSearchParams({key, v:'${version}', loading:'async',
    callback:'initBasemap', auth_referrer_policy:'origin'});
  const loader = document.createElement('script');
  loader.referrerPolicy = 'origin';
  loader.src = url;
  document.head.append(loader);
}
window.addEventListener('message',receive);`;
const hash = createHash('sha256').update(bootstrap).digest('base64');
export function basemapCsp(app: URL) {
  return [
    "default-src 'none'",
    'sandbox allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox',
    'frame-ancestors ' + app.origin,
    "base-uri 'none'",
    "form-action 'none'",
    "script-src 'sha256-" +
      hash +
      "' https://maps.googleapis.com https://maps.gstatic.com",
    // Google's allowlist CSP for Maps JS needs inline styles; this origin holds
    // no record data and script-src is the hash plus Google (ADR-0036).
    "style-src 'unsafe-inline' https://fonts.googleapis.com",
    'font-src https://fonts.gstatic.com',
    'img-src data: blob: https://*.googleapis.com https://*.gstatic.com https://*.google.com https://*.googleusercontent.com',
    'connect-src https://maps.googleapis.com https://maps.gstatic.com https://*.googleapis.com https://*.google.com',
    'worker-src blob:',
  ].join('; ');
}
export function googleBasemapDocument(app: URL) {
  return (
    '<!doctype html><html lang="en" data-app="' +
    escapeHtml(app.origin) +
    '"><meta charset="utf-8"><title>Google Maps</title>' +
    '<body><div id="map"></div><script>' +
    bootstrap +
    '</script></body></html>'
  );
}
/** The Maps JavaScript API frame, registered by the composition root. */
export const GOOGLE_MAP_FRAME: MapFrameDocument = Object.freeze({
  document: googleBasemapDocument,
  csp: basemapCsp,
});
