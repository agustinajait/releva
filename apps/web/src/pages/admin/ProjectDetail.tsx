import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { SAMPLE_QUESTIONNAIRE } from '@releva/core';
import { api } from '../../api';
import { ErrorBox, Field, Page, useSubmit } from '../../components/ui';
import { fmtDateTime, useApi, useProject } from '../../hooks';

interface Project { id: string; name: string; description: string | null; status: string; clientName: string; dedupeRadiusM: number; members: { id: string; name: string; email: string }[] }
interface ZoneFC { features: { properties: { id: string; name: string; code: string | null; color: string | null; areaKm2: number } }[] }
interface Route { id: string; name: string; status: string; zoneName: string | null; surveyorName: string | null; startedAt: string | null; endedAt: string | null }
interface Questionnaire { id: string; name: string; versions: { id: string; version: number; status: string; publishedAt: string | null }[] }
interface User { id: string; name: string; email: string; active: boolean }

const ROUTE_STATUS: Record<string, [string, string]> = { planned: ['Planificado', ''], in_progress: ['En curso', 'warn'], finished: ['Finalizado', 'ok'] };
const Q_STATUS: Record<string, [string, string]> = { draft: ['Borrador', 'warn'], published: ['Publicado', 'ok'], retired: ['Retirado', ''] };

/** Extrae polígonos de un GeoJSON (Feature, FeatureCollection o geometría suelta). */
function polygonsFrom(geo: any): { name?: string; geometry: any }[] {
  if (!geo) return [];
  if (geo.type === 'FeatureCollection') return geo.features.flatMap((f: any) => polygonsFrom(f));
  if (geo.type === 'Feature') return polygonsFrom(geo.geometry).map((p) => ({ ...p, name: geo.properties?.name ?? geo.properties?.nombre ?? geo.properties?.Name }));
  if (geo.type === 'Polygon' || geo.type === 'MultiPolygon') return [{ geometry: geo }];
  return [];
}

export function ProjectDetailPage() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const { reload: reloadCtx } = useProject();
  const project = useApi<Project>(`/projects/${id}`);
  const zones = useApi<ZoneFC>(`/projects/${id}/zones`);
  const routes = useApi<Route[]>(`/projects/${id}/routes`);
  const questionnaires = useApi<Questionnaire[]>(`/projects/${id}/questionnaires`);
  const surveyors = useApi<User[]>('/users', { role: 'surveyor' });

  // Miembros
  const [members, setMembers] = useState<Set<string> | null>(null);
  const memberSet = members ?? new Set(project.data?.members.map((m) => m.id) ?? []);
  const saveMembers = useSubmit(
    () => api(`/projects/${id}/members`, { method: 'PUT', body: { userIds: [...memberSet] } }),
    () => { setMembers(null); project.reload(); },
  );

  // Zonas
  const [zoneError, setZoneError] = useState<string | null>(null);
  const [zoneBusy, setZoneBusy] = useState(false);
  async function uploadZones(file: File) {
    setZoneError(null);
    setZoneBusy(true);
    try {
      const polys = polygonsFrom(JSON.parse(await file.text()));
      if (polys.length === 0) throw new Error('El archivo no contiene polígonos GeoJSON');
      const base = zones.data?.features.length ?? 0;
      for (const [i, p] of polys.entries()) {
        await api(`/projects/${id}/zones`, { method: 'POST', body: { name: p.name ?? `Zona ${base + i + 1}`, geometry: p.geometry } });
      }
      zones.reload();
    } catch (e) {
      setZoneError((e as Error).message);
    } finally {
      setZoneBusy(false);
    }
  }
  const deleteZone = async (zid: string) => {
    if (!confirm('¿Eliminar la zona? Los puntos no se borran.')) return;
    await api(`/zones/${zid}`, { method: 'DELETE' });
    zones.reload();
  };

  // Recorridos
  const [route, setRoute] = useState({ name: '', zoneId: '', surveyorId: '' });
  const createRoute = useSubmit(
    () => api(`/projects/${id}/routes`, { method: 'POST', body: { name: route.name, zoneId: route.zoneId || undefined, surveyorId: route.surveyorId || undefined } }),
    () => { setRoute({ name: '', zoneId: '', surveyorId: '' }); routes.reload(); },
  );

  // Cuestionarios
  const createQ = useSubmit(async () => {
    const q = await api<Questionnaire>(`/projects/${id}/questionnaires`, {
      method: 'POST',
      body: { name: 'Cuestionario', definition: SAMPLE_QUESTIONNAIRE },
    });
    nav(`/admin/cuestionarios/${q.versions[0]!.id}`);
  });

  const archive = useSubmit(
    () => api(`/projects/${id}`, { method: 'PATCH', body: { status: project.data?.status === 'active' ? 'archived' : 'active' } }),
    () => { project.reload(); reloadCtx(); },
  );

  if (project.error) return <Page title="Proyecto"><div className="alert">{project.error}</div></Page>;
  if (!project.data) return <Page title="Proyecto"><div className="muted">Cargando…</div></Page>;
  const p = project.data;
  const zoneList = zones.data?.features ?? [];

  return (
    <Page
      title={p.name}
      subtitle={<>{p.clientName} · radio de deduplicación {p.dedupeRadiusM} m · <Link to="/admin/proyectos">volver a proyectos</Link></>}
      actions={<button className="btn" onClick={() => void archive.submit()}>{p.status === 'active' ? 'Archivar' : 'Reactivar'}</button>}
    >
      <div className="grid cols-2">
        <div className="card">
          <div className="card-head"><h2>Zonas</h2>
            <label className="btn btn-sm" style={{ cursor: 'pointer' }}>
              {zoneBusy ? 'Cargando…' : 'Cargar GeoJSON'}
              <input type="file" accept=".json,.geojson,application/geo+json" hidden onChange={(e) => e.target.files?.[0] && void uploadZones(e.target.files[0])} />
            </label>
          </div>
          <div className="card-pad stack">
            <ErrorBox error={zoneError} />
            {zoneList.length === 0 && <div className="muted">Sin zonas. Cargá un archivo GeoJSON con polígonos (cada polígono es una zona).</div>}
            {zoneList.map((z) => (
              <div key={z.properties.id} className="row">
                <span className="swatch" style={{ background: z.properties.color ?? '#175a5b' }} />
                <strong>{z.properties.name}</strong>
                <span className="muted small">{z.properties.areaKm2} km²</span>
                <span className="spacer" />
                <button className="btn btn-sm btn-ghost" onClick={() => void deleteZone(z.properties.id)}>Eliminar</button>
              </div>
            ))}
          </div>
        </div>

        <div className="card">
          <div className="card-head"><h2>Relevadores asignados</h2>
            <button className="btn btn-sm btn-primary" disabled={!members || saveMembers.busy} onClick={() => void saveMembers.submit()}>Guardar</button>
          </div>
          <div className="card-pad stack">
            <ErrorBox error={saveMembers.error} />
            {(surveyors.data ?? []).filter((u) => u.active).map((u) => (
              <label key={u.id} className="row" style={{ cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={memberSet.has(u.id)}
                  onChange={(e) => {
                    const next = new Set(memberSet);
                    if (e.target.checked) next.add(u.id); else next.delete(u.id);
                    setMembers(next);
                  }}
                />
                <span>{u.name}</span><span className="muted small">{u.email}</span>
              </label>
            ))}
            {surveyors.data?.length === 0 && <div className="muted">No hay usuarios con rol Relevador.</div>}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head"><h2>Recorridos</h2></div>
        <div className="card-pad">
          <form className="form-row" onSubmit={createRoute.submit}>
            <Field label="Nombre"><input className="input" value={route.name} onChange={(e) => setRoute({ ...route, name: e.target.value })} required /></Field>
            <Field label="Zona">
              <select className="input" value={route.zoneId} onChange={(e) => setRoute({ ...route, zoneId: e.target.value })}>
                <option value="">Sin zona</option>
                {zoneList.map((z) => <option key={z.properties.id} value={z.properties.id}>{z.properties.name}</option>)}
              </select>
            </Field>
            <Field label="Relevador">
              <select className="input" value={route.surveyorId} onChange={(e) => setRoute({ ...route, surveyorId: e.target.value })}>
                <option value="">Cualquiera del proyecto</option>
                {p.members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            </Field>
            <button className="btn btn-primary" disabled={createRoute.busy}>Crear recorrido</button>
          </form>
          <div style={{ marginTop: 10 }}><ErrorBox error={createRoute.error} /></div>
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Recorrido</th><th>Zona</th><th>Relevador</th><th>Estado</th><th>Inicio</th><th>Fin</th></tr></thead>
            <tbody>
              {(routes.data ?? []).map((r) => (
                <tr key={r.id}>
                  <td><strong>{r.name}</strong></td>
                  <td>{r.zoneName ?? <span className="muted">—</span>}</td>
                  <td>{r.surveyorName ?? <span className="muted">—</span>}</td>
                  <td><span className={`badge ${ROUTE_STATUS[r.status]?.[1]}`}>{ROUTE_STATUS[r.status]?.[0]}</span></td>
                  <td className="muted">{fmtDateTime(r.startedAt)}</td>
                  <td className="muted">{fmtDateTime(r.endedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <div className="card-head"><h2>Cuestionarios</h2>
          <button className="btn btn-sm" disabled={createQ.busy} onClick={() => void createQ.submit()}>Nuevo cuestionario</button>
        </div>
        <div className="card-pad stack">
          <ErrorBox error={createQ.error} />
          {(questionnaires.data ?? []).map((q) => (
            <div key={q.id} className="row">
              <strong>{q.name}</strong>
              {q.versions.map((v) => (
                <Link key={v.id} to={`/admin/cuestionarios/${v.id}`} className={`badge ${Q_STATUS[v.status]?.[1]}`} style={{ textDecoration: 'none' }}>
                  v{v.version} · {Q_STATUS[v.status]?.[0]}
                </Link>
              ))}
            </div>
          ))}
          {questionnaires.data?.length === 0 && <div className="muted">Sin cuestionarios. Se crea uno a partir del modelo de ejemplo para editar.</div>}
        </div>
      </div>
    </Page>
  );
}
