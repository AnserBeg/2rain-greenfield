import { createHash } from 'node:crypto';
import { mapCentre } from '@north-star/canonical-model';
import type { BrowserBasemap } from '../../../packages/runtime/src/address-gateway.js';
import { escapeHtml } from './html.js';

// Only the sandboxed basemap document loads provider code. Its input is the
// public camera. Record links, coordinates and session state live in the parent.
const version = '3.66';
const bootstrap = `window.gm_authFailure = () => parent.postMessage('basemap-unavailable', '*');
window.initBasemap = () => {
  const el = document.getElementById('map');
  if (!google.maps.version.startsWith('${version}.')) return;
  const center = {lat:Number(el.dataset.lat), lng:Number(el.dataset.lng)};
  const zoom = Number(el.dataset.zoom);
  const map = new google.maps.Map(el, {center, zoom, renderingType:'RASTER',
    mapTypeId:'roadmap', tilt:0, heading:0, disableDefaultUI:true,
    gestureHandling:'none', keyboardShortcuts:false, clickableIcons:false});
  map.addListener('tilesloaded', () => {
    const actual = map.getCenter();
    const aligned = actual && Math.abs(actual.lat()-center.lat)<1e-6 &&
      Math.abs(actual.lng()-center.lng)<1e-6 && map.getZoom()===zoom;
    parent.postMessage(aligned ? 'basemap-ready' : 'basemap-unavailable', '*');
  });
};`;
const hash = createHash('sha256').update(bootstrap).digest('base64');
export const basemapCsp = [
  "default-src 'none'",
  'sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox',
  "frame-ancestors 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "script-src 'sha256-" +
    hash +
    "' https://maps.googleapis.com https://maps.gstatic.com",
  "style-src 'unsafe-inline' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com',
  'img-src data: blob: https://*.googleapis.com https://*.gstatic.com https://*.google.com https://*.googleusercontent.com',
  'connect-src https://maps.googleapis.com https://maps.gstatic.com https://*.googleapis.com https://*.google.com',
  'worker-src blob:',
].join('; ');

export function googleBasemapDocument(display: BrowserBasemap) {
  const centre = mapCentre(display.viewport);
  const loader = new URL('https://maps.googleapis.com/maps/api/js');
  loader.search = new URLSearchParams({
    key: display.browserKey,
    v: version,
    loading: 'async',
    callback: 'initBasemap',
    auth_referrer_policy: 'origin',
  }).toString();
  return (
    '<!doctype html><html lang="en"><meta charset="utf-8"><title>Google Maps</title>' +
    '<style>html,body,#map{margin:0;height:100%}</style><body><div id="map" data-lat="' +
    centre.latitude +
    '" data-lng="' +
    centre.longitude +
    '" data-zoom="' +
    display.viewport.zoom +
    '"></div><script>' +
    bootstrap +
    '</script><script async referrerpolicy="origin" src="' +
    escapeHtml(loader.href) +
    '"></script></body></html>'
  );
}
