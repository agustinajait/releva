export interface LatLng {
  lat: number;
  lng: number;
}

/** Lectura de ubicación tal como la entrega el GPS del dispositivo. */
export interface LocationFix extends LatLng {
  /** Radio de precisión horizontal en metros. */
  accuracy: number;
  altitude?: number | null;
  /** Velocidad en m/s si el GPS la informa. */
  speed?: number | null;
  /** ISO 8601. */
  capturedAt: string;
}

const EARTH_RADIUS_M = 6_371_008.8;

const toRad = (deg: number) => (deg * Math.PI) / 180;

/** Distancia en metros entre dos coordenadas (fórmula de haversine). */
export function distanceMeters(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function isValidLatLng(p: LatLng): boolean {
  return (
    Number.isFinite(p.lat) &&
    Number.isFinite(p.lng) &&
    p.lat >= -90 &&
    p.lat <= 90 &&
    p.lng >= -180 &&
    p.lng <= 180
  );
}

export interface NearbyCandidate extends LatLng {
  id: string;
}

/**
 * Decide si una nueva captura corresponde a un punto existente.
 * Devuelve el más cercano dentro del radio, o null si es un punto nuevo.
 * El servidor hace lo mismo con PostGIS (ST_DWithin); esta versión la usa
 * la app offline para avisar al relevador antes de sincronizar.
 */
export function findMatchingPoint<T extends NearbyCandidate>(
  fix: LatLng,
  candidates: readonly T[],
  radiusMeters: number,
): T | null {
  let best: T | null = null;
  let bestDist = Infinity;
  for (const c of candidates) {
    const d = distanceMeters(fix, c);
    if (d <= radiusMeters && d < bestDist) {
      best = c;
      bestDist = d;
    }
  }
  return best;
}
