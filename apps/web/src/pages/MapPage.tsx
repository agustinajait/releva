import { useEffect, useMemo, useRef, useState } from 'react';
import maplibregl, { type GeoJSONSource, type Map as MlMap } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { fmtDateTime, useApi, useProject } from '../hooks';
import { PointDetail } from '../components/PointDetail';

interface Feature {
  type: 'Feature';
  id?: string | number;
  geometry: { type: string; coordinates: any };
  properties: Record<string, any>;
}
interface FC {
  type: 'FeatureCollection';
  features: Feature[];
}

const BASE_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      // Para producción, reemplazar por un proveedor de teselas con acuerdo de uso.
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      attribution: '© OpenStreetMap',
    },
  },
  layers: [
    { id: 'bg', type: 'background', paint: { 'background-color': '#ece8e1' } },
    { id: 'osm', type: 'raster', source: 'osm', paint: { 'raster-saturation': -0.75, 'raster-opacity': 0.9 } },
  ],
};

const EMPTY: FC = { type: 'FeatureCollection', features: [] };

function bboxOf(fcs: FC[]): [number, number, number, number] | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const visit = (c: any) => {
    if (typeof c[0] === 'number') {
      minX = Math.min(minX, c[0]); maxX = Math.max(maxX, c[0]);
      minY = Math.min(minY, c[1]); maxY = Math.max(maxY, c[1]);
    } else c.forEach(visit);
  };
  for (const fc of fcs) for (const f of fc.features) if (f.geometry && 'coordinates' in f.geometry) visit(f.geometry.coordinates);
  return Number.isFinite(minX) ? [minX, minY, maxX, maxY] : null;
}

export function MapPage() {
  const { current } = useProject();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [zoneId, setZoneId] = useState('');
  const [selected, setSelected] = useState<string | null>(null);

  const query = useMemo(
    () => ({
      from: from ? new Date(`${from}T00:00:00-03:00`).toISOString() : undefined,
      to: to ? new Date(new Date(`${to}T00:00:00-03:00`).getTime() + 86_400_000).toISOString() : undefined,
      zoneId: zoneId || undefined,
    }),
    [from, to, zoneId],
  );
  const zones = useApi<FC>(current ? `/projects/${current.id}/zones` : null);
  const points = useApi<FC>(current ? `/projects/${current.id}/points` : null, query);

  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const [ready, setReady] = useState(false);
  const fitted = useRef<string | null>(null);

  useEffect(() => {
    if (!container.current) return;
    const map = new maplibregl.Map({ container: container.current, style: BASE_STYLE, center: [-58.4, -34.61], zoom: 11.5, attributionControl: { compact: true } });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.on('load', () => {
      map.addSource('zones', { type: 'geojson', data: EMPTY as never });
      map.addSource('points', { type: 'geojson', data: EMPTY as never });
      map.addLayer({ id: 'zones-fill', type: 'fill', source: 'zones', paint: { 'fill-color': ['coalesce', ['get', 'color'], '#175a5b'], 'fill-opacity': 0.12 } });
      map.addLayer({ id: 'zones-line', type: 'line', source: 'zones', paint: { 'line-color': ['coalesce', ['get', 'color'], '#175a5b'], 'line-width': 2, 'line-opacity': 0.85 } });
      map.addLayer({
        id: 'points-halo', type: 'circle', source: 'points',
        paint: {
          'circle-radius': ['+', 6, ['*', 3, ['min', 6, ['coalesce', ['get', 'personas'], 1]]]],
          'circle-color': '#f5b942', 'circle-opacity': 0.25,
        },
      });
      map.addLayer({
        id: 'points', type: 'circle', source: 'points',
        paint: {
          'circle-radius': ['+', 4, ['*', 1.6, ['min', 6, ['coalesce', ['get', 'personas'], 1]]]],
          'circle-color': ['case', ['boolean', ['get', 'menores'], false], '#e0782f', '#f5b942'],
          'circle-stroke-color': ['case', ['boolean', ['get', 'selected'], false], '#0f3d3e', '#6b4400'],
          'circle-stroke-width': ['case', ['boolean', ['get', 'selected'], false], 3, 1.5],
        },
      });
      map.on('click', 'points', (e) => {
        const id = e.features?.[0]?.properties?.id;
        if (id) setSelected(String(id));
      });
      map.on('mouseenter', 'points', () => (map.getCanvas().style.cursor = 'pointer'));
      map.on('mouseleave', 'points', () => (map.getCanvas().style.cursor = ''));
      setReady(true);
    });
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
      setReady(false);
    };
  }, []);

  // Aplana los datos del último relevamiento para poder estilizar por valor.
  const pointFc = useMemo<FC>(() => {
    const fc = points.data ?? EMPTY;
    return {
      type: 'FeatureCollection',
      features: fc.features.map((f) => ({
        ...f,
        properties: { ...f.properties, personas: f.properties.facts?.personas ?? null, menores: f.properties.facts?.menores === true, selected: f.properties.id === selected },
      })),
    };
  }, [points.data, selected]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    (map.getSource('zones') as GeoJSONSource).setData((zones.data ?? EMPTY) as never);
    (map.getSource('points') as GeoJSONSource).setData(pointFc as never);
    if (current && fitted.current !== current.id && (zones.data || points.data)) {
      const bb = bboxOf([zones.data ?? EMPTY, points.data ?? EMPTY]);
      if (bb) {
        map.fitBounds(bb, { padding: { top: 120, bottom: 50, left: 50, right: 50 }, maxZoom: 16, duration: 0 });
        fitted.current = current.id;
      }
    }
  }, [ready, zones.data, pointFc, current, points.data]);

  useEffect(() => setSelected(null), [current?.id]);

  const total = points.data?.features.length ?? 0;
  const persons = (points.data?.features ?? []).reduce((a, f) => a + (Number(f.properties.facts?.personas) || 0), 0);

  if (!current) return <div className="page"><div className="empty">No tenés proyectos asignados.</div></div>;

  return (
    <div className="map-page">
      <div className="map-wrap">
        <div ref={container} className="map" />
        <div className="map-toolbar">
          <div className="map-chip"><strong>{current.name}</strong></div>
          <div className="map-chip">
            <span className="muted small">Desde</span>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="Desde" />
            <span className="muted small">Hasta</span>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label="Hasta" />
          </div>
          <div className="map-chip">
            <select value={zoneId} onChange={(e) => setZoneId(e.target.value)} aria-label="Zona">
              <option value="">Todas las zonas</option>
              {(zones.data?.features ?? []).map((z) => (
                <option key={z.properties.id} value={z.properties.id}>{z.properties.name}</option>
              ))}
            </select>
          </div>
          <div className="map-chip" title="Personas según el último relevamiento de cada punto">
            <span>{total} puntos</span>
            <span className="muted">·</span>
            <span>{persons} personas</span>
          </div>
        </div>
        <div className="legend">
          <strong>Referencias</strong>
          <div className="legend-row"><span className="dot" style={{ width: 12, height: 12 }} /> Punto relevado (tamaño = personas)</div>
          <div className="legend-row"><span className="dot" style={{ width: 12, height: 12, background: '#e0782f' }} /> Con menores</div>
          <div className="legend-row"><span className="swatch" style={{ background: 'rgba(23,90,91,.25)', border: '2px solid #175a5b' }} /> Zona</div>
        </div>
        {points.error && <div className="alert" style={{ position: 'absolute', bottom: 12, right: 12, zIndex: 3 }}>{points.error}</div>}
      </div>
      <aside className="detail">
        {selected ? (
          <PointDetail id={selected} onClose={() => setSelected(null)} />
        ) : (
          <div className="detail-section">
            <h2>Puntos relevados</h2>
            <p className="muted">Seleccioná un punto en el mapa para ver su ficha.</p>
            <div className="stack" style={{ marginTop: 12 }}>
              {[...(points.data?.features ?? [])]
                .sort((a, b) => String(b.properties.lastSurveyAt).localeCompare(String(a.properties.lastSurveyAt)))
                .slice(0, 30)
                .map((f) => (
                  <button key={f.properties.id} className="btn" style={{ justifyContent: 'space-between', width: '100%' }} onClick={() => setSelected(f.properties.id)}>
                    <span>{f.properties.zoneName ?? 'Sin zona'}</span>
                    <span className="muted small">{fmtDateTime(f.properties.lastSurveyAt)} · {f.properties.facts?.personas ?? '?'} pers.</span>
                  </button>
                ))}
            </div>
          </div>
        )}
      </aside>
    </div>
  );
}
