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
export const mapCentre = (v: MapViewport): MapPoint => ({
  latitude: (2 * v.y + 1 - 9000) / 100,
  longitude: (2 * v.x + 1 - 18000) / 100,
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
  // At zoom zero even the short preset contains the entire world.
  const scale = 400 / (Math.min(width, 2 * height) * 2 ** v.zoom);
  return {
    west: centre.longitude - (width * scale) / 2,
    east: centre.longitude + (width * scale) / 2,
    south: centre.latitude - (height * scale) / 2,
    north: centre.latitude + (height * scale) / 2,
    scale,
  };
}
export function projectPin(v: MapViewport, p: MapPoint) {
  const box = mapExtent(v);
  return {
    x: (p.longitude - box.west) / box.scale,
    y: (box.north - p.latitude) / box.scale,
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
    latitude: (Math.min(...ys) + Math.max(...ys)) / 2,
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
    const v = { ...centre, size, zoom },
      box = mapExtent(v);
    if (
      points.every(
        (p) =>
          p.longitude >= box.west + 20 * box.scale &&
          p.longitude <= box.east - 20 * box.scale &&
          p.latitude >= box.south + 20 * box.scale &&
          p.latitude <= box.north - 20 * box.scale,
      )
    )
      return v;
  }
  return { ...centre, size, zoom: 0 };
}
export function panMap(v: MapViewport, dx: number, dy: number): MapViewport {
  const c = mapCentre(v),
    s = mapExtent(v).scale;
  const [width, height] = MAP_SIZES[v.size];
  return {
    ...v,
    ...cell({
      longitude: c.longitude + Math.max(-width, Math.min(dx, width)) * s,
      latitude: c.latitude - Math.max(-height, Math.min(dy, height)) * s,
    }),
  };
}
