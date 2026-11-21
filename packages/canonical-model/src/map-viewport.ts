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
export const mapCentre = (v: MapViewport): MapPoint => ({
  latitude: (6 * v.y + 2 - 27000) / 300,
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
  const scale = mapExtent(v).scale;
  const [width, height] = MAP_SIZES[v.size];
  // A coarse provider grid still needs a reachable next cell at maximum zoom.
  const shift = (
    index: number,
    pixels: number,
    dimension: number,
    last: number,
  ) => {
    const bounded = Math.max(-dimension, Math.min(pixels, dimension));
    const cells = Math.round(bounded * scale * 50) || Math.sign(bounded);
    return clamp(index + cells, last);
  };
  return {
    ...v,
    x: shift(v.x, dx, width, 17999),
    y: shift(v.y, -dy, height, 8999),
  };
}
