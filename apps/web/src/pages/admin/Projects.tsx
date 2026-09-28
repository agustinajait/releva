import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api';
import { ErrorBox, Field, Page, useSubmit } from '../../components/ui';
import { fmtDateTime, useApi, useProject, useUser, type ProjectSummary } from '../../hooks';

interface Audit { id: number; at: string; action: string; entity: string; entityId: string | null; actorName: string | null; actorEmail: string | null; actorRole: string | null; clientName: string | null; data: Record<string, unknown> }

export function ProjectsPage() {
  const me = useUser()!;
  const { reload: reloadCtx } = useProject();
  const projects = useApi<(ProjectSummary & { createdAt: string })[]>('/projects');
  const clients = useApi<{ id: string; name: string }[]>(me.role === 'super_admin' ? '/clients' : null);
  const [name, setName] = useState('');
  const [clientId, setClientId] = useState('');
  const create = useSubmit(
    () => api('/projects', { method: 'POST', body: { name, clientId: clientId || undefined } }),
    () => { setName(''); projects.reload(); reloadCtx(); },
  );
  return (
    <Page title="Proyectos" subtitle="Cada proyecto tiene sus zonas, recorridos, cuestionario y relevadores asignados.">
      <div className="card card-pad">
        <form className="form-row" onSubmit={create.submit}>
          {me.role === 'super_admin' && (
            <Field label="Cliente">
              <select className="input" value={clientId} onChange={(e) => setClientId(e.target.value)} required>
                <option value="">Elegir…</option>
                {(clients.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </Field>
          )}
          <Field label="Nombre del proyecto"><input className="input" value={name} onChange={(e) => setName(e.target.value)} required /></Field>
          <button className="btn btn-primary" disabled={create.busy}>Crear proyecto</button>
        </form>
        <div style={{ marginTop: 10 }}><ErrorBox error={create.error} /></div>
      </div>
      <div className="card table-wrap">
        <table className="table">
          <thead><tr><th>Proyecto</th>{me.role === 'super_admin' && <th>Cliente</th>}<th>Zonas</th><th>Puntos</th><th>Estado</th><th>Alta</th></tr></thead>
          <tbody>
            {(projects.data ?? []).map((p) => (
              <tr key={p.id}>
                <td><Link to={`/admin/proyectos/${p.id}`}><strong>{p.name}</strong></Link></td>
                {me.role === 'super_admin' && <td className="muted">{p.clientName}</td>}
                <td>{p.zoneCount}</td>
                <td>{p.pointCount}</td>
                <td>{p.status === 'active' ? <span className="badge ok">Activo</span> : <span className="badge">Archivado</span>}</td>
                <td className="muted">{fmtDateTime(p.createdAt)}</td>
              </tr>
            ))}
            {projects.data?.length === 0 && <tr><td colSpan={6} className="empty">Todavía no hay proyectos</td></tr>}
          </tbody>
        </table>
      </div>
    </Page>
  );
}

const ACTION_LABELS: Record<string, string> = {
  create: 'Creó', update: 'Modificó', delete: 'Eliminó', login: 'Ingresó', login_failed: 'Ingreso fallido',
  publish: 'Publicó', new_version: 'Nueva versión', sync: 'Sincronizó', start: 'Inició', finish: 'Finalizó',
  set_members: 'Asignó miembros', refresh_reuse_detected: 'Reuso de sesión detectado',
};

export function AuditPage() {
  const [entity, setEntity] = useState('');
  const audit = useApi<Audit[]>('/audit', { entity: entity || undefined, limit: '200' });
  return (
    <Page
      title="Auditoría"
      subtitle="Registro inmutable de las acciones realizadas en el sistema."
      actions={
        <select className="input" value={entity} onChange={(e) => setEntity(e.target.value)} aria-label="Entidad">
          <option value="">Todas las entidades</option>
          {['user', 'client', 'organization', 'project', 'zone', 'route', 'questionnaire', 'questionnaire_version', 'survey'].map((e) => (
            <option key={e} value={e}>{e}</option>
          ))}
        </select>
      }
    >
      <div className="card table-wrap">
        <table className="table">
          <thead><tr><th>Fecha</th><th>Quién</th><th>Acción</th><th>Entidad</th><th>Detalle</th></tr></thead>
          <tbody>
            {(audit.data ?? []).map((a) => (
              <tr key={a.id}>
                <td className="muted" style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(a.at)}</td>
                <td>{a.actorName ?? <span className="muted">{a.actorRole ?? 'sistema'}</span>}{a.clientName && <div className="small muted">{a.clientName}</div>}</td>
                <td><span className={`badge ${a.action === 'login_failed' || a.action.includes('reuse') ? 'danger' : ''}`}>{ACTION_LABELS[a.action] ?? a.action}</span></td>
                <td>{a.entity}<div className="mono muted">{a.entityId?.slice(0, 8)}</div></td>
                <td className="mono muted" style={{ maxWidth: 380, overflow: 'hidden', textOverflow: 'ellipsis' }}>{Object.keys(a.data).length ? JSON.stringify(a.data) : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Page>
  );
}
