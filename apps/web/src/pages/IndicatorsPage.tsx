import { useMemo, useState } from 'react';
import { fmtNum, useApi, useProject } from '../hooks';

interface Indicator {
  key: string;
  label: string;
  aggregate: 'sum' | 'count_true' | 'distribution' | 'average';
  value?: number;
  n?: number;
  distribution?: { option: string; label: string; count: number }[];
}
interface IndicatorsData {
  totals: { points: number; surveys: number };
  byZone: { zoneId: string | null; zoneName: string; points: number }[];
  byDay: { day: string; surveys: number }[];
  indicators: Indicator[];
}

function Bars({ rows }: { rows: { label: string; value: number }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  if (rows.length === 0) return <div className="muted">Sin datos</div>;
  return (
    <div className="bars">
      {rows.map((r) => (
        <div key={r.label} className="bar-row">
          <span title={r.label} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.label}</span>
          <div className="bar-track"><div className="bar-fill" style={{ width: `${(r.value / max) * 100}%` }} /></div>
          <span className="bar-num">{fmtNum(r.value)}</span>
        </div>
      ))}
    </div>
  );
}

function Columns({ rows }: { rows: { label: string; value: number }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  if (rows.length === 0) return <div className="muted">Sin datos</div>;
  return (
    <div className="cols" role="img" aria-label="Relevamientos por día">
      {rows.map((r) => (
        <div key={r.label} className="col">
          <span className="col-num">{r.value}</span>
          <div className="col-bar" style={{ height: `${Math.max(4, (r.value / max) * 120)}px` }} />
          <span className="col-lbl">{r.label}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * Indicadores del proyecto. No hay nada programado a mano: cada tarjeta y
 * cada distribución sale de los campos marcados como indicador en el cuestionario.
 */
export function IndicatorsPage() {
  const { current } = useProject();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const query = useMemo(
    () => ({
      from: from ? new Date(`${from}T00:00:00-03:00`).toISOString() : undefined,
      to: to ? new Date(new Date(`${to}T00:00:00-03:00`).getTime() + 86_400_000).toISOString() : undefined,
    }),
    [from, to],
  );
  const { data, error, loading } = useApi<IndicatorsData>(current ? `/projects/${current.id}/indicators` : null, query);

  if (!current) return <div className="page"><div className="empty">No hay proyectos.</div></div>;

  const scalar = (data?.indicators ?? []).filter((i) => i.aggregate !== 'distribution');
  const dists = (data?.indicators ?? []).filter((i) => i.aggregate === 'distribution');

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Indicadores</h1>
          <p>{current.name} · relevamientos completos</p>
        </div>
        <div className="row">
          <div className="field"><label>Desde</label><input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
          <div className="field"><label>Hasta</label><input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
        </div>
      </div>
      {error && <div className="alert">{error}</div>}
      {loading && !data && <div className="muted">Cargando…</div>}
      {data && (
        <>
          <div className="kpis">
            <div className="card kpi"><div className="l">Puntos relevados</div><div className="v">{fmtNum(data.totals.points)}</div><div className="s">lugares distintos</div></div>
            <div className="card kpi"><div className="l">Relevamientos</div><div className="v">{fmtNum(data.totals.surveys)}</div><div className="s">visitas a puntos</div></div>
            {scalar.map((i) => (
              <div key={i.key} className="card kpi">
                <div className="l">{i.label}</div>
                <div className="v">{fmtNum(i.value ?? 0)}</div>
                <div className="s">
                  {i.aggregate === 'sum' && 'suma de los relevamientos del período'}
                  {i.aggregate === 'average' && 'promedio'}
                  {i.aggregate === 'count_true' && `de ${fmtNum(i.n ?? 0)} relevamientos con dato`}
                </div>
              </div>
            ))}
          </div>

          <div className="grid cols-2">
            <div className="card">
              <div className="card-head"><h2>Concentración por zona</h2><span className="muted small">puntos</span></div>
              <div className="card-pad"><Bars rows={data.byZone.map((z) => ({ label: z.zoneName, value: z.points }))} /></div>
            </div>
            <div className="card">
              <div className="card-head"><h2>Evolución</h2><span className="muted small">relevamientos por día</span></div>
              <div className="card-pad"><Columns rows={data.byDay.map((d) => ({ label: d.day.slice(5).split('-').reverse().join('/'), value: d.surveys }))} /></div>
            </div>
            {dists.map((i) => (
              <div key={i.key} className="card">
                <div className="card-head"><h2>{i.label}</h2><span className="muted small">menciones</span></div>
                <div className="card-pad"><Bars rows={(i.distribution ?? []).map((d) => ({ label: d.label, value: d.count }))} /></div>
              </div>
            ))}
          </div>
          {data.indicators.length === 0 && (
            <div className="alert info" style={{ marginTop: 16 }}>
              El cuestionario de este proyecto no tiene campos marcados como indicador. Se configuran desde el editor de cuestionarios.
            </div>
          )}
        </>
      )}
    </div>
  );
}
