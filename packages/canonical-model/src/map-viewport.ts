import { z } from 'zod';

// Centre is a public 0.02-degree grid cell. No provider input contains business pins.
export const MAP_SIZES = {
  small: [320, 240],
  medium: [768, 512],
  large: [1024, 640],
} as const;
export const MapViewportSchema = z.strictObject({
  x: z.number().int().min(0).max(17999),
  y: z.number().int().min(0).max(8999),
  zoom: z.number().int().min(0).max(13),
  size: z.enum(['small', 'medium', 'large']),
});
export type MapViewport = z.infer<typeof MapViewportSchema>;
export type MapPoint = { latitude: number; longitude: number };
// One third into a fixed cell: even a manually panned centre cannot equal an
// eight-decimal stored Address (the reduced denominator retains a factor of 3).
const degrees = 180 / Math.PI;
export const MERCATOR_LIMIT = Math.atan(Math.sinh(Math.PI)) * degrees;
const limitLatitude = (latitude: number) =>
  Math.max(-MERCATOR_LIMIT, Math.min(MERCATOR_LIMIT, latitude));
function northing(latitude: number) {
  return degrees * Math.asinh(Math.tan(limitLatitude(latitude) / degrees));
}
export function mercatorLatitude(northing: number) {
  return degrees * Math.atan(Math.sinh(northing / degrees));
}
export const mapCentre = (v: MapViewport): MapPoint => ({
  latitude: limitLatitude((6 * v.y + 2 - 27000) / 300),
  longitude: (6 * v.x + 2 - 54000) / 300,
});
const clamp = (n: number, max: number) => Math.max(0, Math.min(n, max));
function cell(p: MapPoint) {
  return {
    x: clamp(Math.floor((180 + p.longitude) * 50), 17999),
    y: clamp(Math.floor((90 + p.latitude) * 50), 8999),
  };
}
export function mapExtent(v: MapViewport) {
  const [width, height] = MAP_SIZES[v.size];
  const centre = mapCentre(v);
  // Spherical Mercator, 256 CSS pixels per world at zoom zero.
  const scale = 360 / (256 * 2 ** v.zoom);
  const top = northing(centre.latitude) + (height * scale) / 2;
  return {
    west: centre.longitude - (width * scale) / 2,
    east: centre.longitude + (width * scale) / 2,
    south: mercatorLatitude(top - height * scale),
    north: mercatorLatitude(top),
    top,
    scale,
  };
}
export function projectPin(v: MapViewport, p: MapPoint) {
  const box = mapExtent(v);
  return {
    x: (p.longitude - box.west) / box.scale,
    y: (box.top - northing(p.latitude)) / box.scale,
  };
}
export function fitMap(
  points: readonly MapPoint[],
  size: MapViewport['size'],
): MapViewport {
  if (!points.length)
    return { ...cell({ latitude: 0, longitude: 0 }), zoom: 0, size };
  const xs = points.map((p) => p.longitude),
    ys = points.map((p) => p.latitude);
  const centre = cell({
    longitude: (Math.min(...xs) + Math.max(...xs)) / 2,
    latitude: mercatorLatitude(
      (northing(Math.min(...ys)) + northing(Math.max(...ys))) / 2,
    ),
  });
  const originalX = centre.x;
  const step = originalX < 9000 ? 1 : -1;
  // Includes the rare case of several pins occupying consecutive cell centres.
  while (
    points.some((p) => {
      const c = mapCentre({ ...centre, size, zoom: 0 });
      return p.latitude === c.latitude && p.longitude === c.longitude;
    })
  )
    centre.x += step;
  for (let zoom = 13; zoom > 0; zoom--) {
    const v = { ...centre, size, zoom };
    const [width, height] = MAP_SIZES[size];
    if (
      points.every((point) => {
        const { x, y } = projectPin(v, point);
        return x >= 20 && x <= width - 20 && y >= 20 && y <= height - 20;
      })
    )
      return v;
  }
  return { ...centre, size, zoom: 0 };
}
export function panMap(v: MapViewport, dx: number, dy: number): MapViewport {
  const scale = mapExtent(v).scale;
  const [width, height] = MAP_SIZES[v.size];
  // A coarse provider grid still needs a reachable next cell at maximum zoom.
  const shift = (index: number, delta: number, last: number) =>
    clamp(index + (Math.round(delta * 50) || Math.sign(delta)), last);
  const latitude = mapCentre(v).latitude;
  const moveY = -Math.max(-height, Math.min(height, dy)) * scale;
  return {
    ...v,
    x: shift(v.x, Math.max(-width, Math.min(width, dx)) * scale, 17999),
    y: shift(
      v.y,
      mercatorLatitude(northing(latitude) + moveY) - latitude,
      8999,
    ),
  };
}
