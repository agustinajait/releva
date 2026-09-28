import { useState } from 'react';
import { ROLE_LABELS, type Role } from '@releva/core';
import { api } from '../../api';
import { ErrorBox, Field, Page, useSubmit } from '../../components/ui';
import { fmtDateTime, useApi, useUser } from '../../hooks';

interface User { id: string; email: string; name: string; role: Role; active: boolean; clientId: string | null; clientName: string | null; lastLoginAt: string | null }
interface RoleInfo { key: Role; label: string; permissions: string[]; assignable: boolean }
interface Client { id: string; name: string }

export function UsersPage() {
  const me = useUser()!;
  const users = useApi<User[]>('/users');
  const roles = useApi<RoleInfo[]>('/roles');
  const clients = useApi<Client[]>(me.role === 'super_admin' ? '/clients' : null);
  const [form, setForm] = useState({ name: '', email: '', role: 'surveyor' as Role, password: '', clientId: '' });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const create = useSubmit(
    () => api('/users', { method: 'POST', body: { ...form, clientId: form.clientId || undefined } }),
    () => { setForm((f) => ({ ...f, name: '', email: '', password: '' })); users.reload(); },
  );
  const toggle = async (u: User) => {
    await api(`/users/${u.id}`, { method: 'PATCH', body: { active: !u.active } });
    users.reload();
  };

  return (
    <Page title="Usuarios" subtitle="Los relevadores usan la app móvil; los analistas de Gobierno ven el mapa y los indicadores.">
      <div className="card card-pad">
        <form className="form-row" onSubmit={create.submit}>
          <Field label="Nombre"><input className="input" value={form.name} onChange={set('name')} required /></Field>
          <Field label="Email"><input className="input" type="email" value={form.email} onChange={set('email')} required /></Field>
          <Field label="Rol">
            <select className="input" value={form.role} onChange={set('role')}>
              {(roles.data ?? []).filter((r) => r.assignable).map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
            </select>
          </Field>
          {me.role === 'super_admin' && form.role !== 'super_admin' && (
            <Field label="Cliente">
              <select className="input" value={form.clientId} onChange={set('clientId')} required>
                <option value="">Elegir…</option>
                {(clients.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </Field>
          )}
          <Field label="Contraseña inicial"><input className="input" type="password" autoComplete="new-password" value={form.password} onChange={set('password')} required minLength={10} /></Field>
          <button className="btn btn-primary" disabled={create.busy}>Crear usuario</button>
        </form>
        <div style={{ marginTop: 10 }}><ErrorBox error={create.error} /></div>
      </div>
      <div className="card table-wrap">
        <table className="table">
          <thead><tr><th>Nombre</th><th>Email</th><th>Rol</th>{me.role === 'super_admin' && <th>Cliente</th>}<th>Último ingreso</th><th>Estado</th><th /></tr></thead>
          <tbody>
            {(users.data ?? []).map((u) => (
              <tr key={u.id}>
                <td><strong>{u.name}</strong></td>
                <td className="muted">{u.email}</td>
                <td><span className="badge info">{ROLE_LABELS[u.role]}</span></td>
                {me.role === 'super_admin' && <td className="muted">{u.clientName ?? '—'}</td>}
                <td className="muted">{fmtDateTime(u.lastLoginAt)}</td>
                <td>{u.active ? <span className="badge ok">Activo</span> : <span className="badge">Inactivo</span>}</td>
                <td style={{ textAlign: 'right' }}>
                  {u.id !== me.id && <button className="btn btn-sm" onClick={() => void toggle(u)}>{u.active ? 'Desactivar' : 'Activar'}</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Page>
  );
}

const PERMISSION_LABELS: Record<string, string> = {
  'clients:manage': 'Administrar clientes',
  'organizations:manage': 'Administrar organismos',
  'users:manage': 'Administrar usuarios',
  'projects:manage': 'Administrar proyectos',
  'projects:read': 'Ver proyectos',
  'zones:manage': 'Administrar zonas',
  'routes:manage': 'Planificar recorridos',
  'routes:operate': 'Operar recorridos (app)',
  'questionnaires:manage': 'Configurar cuestionarios',
  'questionnaires:read': 'Ver cuestionarios',
  'surveys:create': 'Relevar (app)',
  'surveys:read': 'Ver relevamientos',
  'points:read': 'Ver mapa y puntos',
  'indicators:read': 'Ver indicadores',
  'audit:read': 'Consultar auditoría',
};

export function RolesPage() {
  const roles = useApi<RoleInfo[]>('/roles');
  const all = Object.keys(PERMISSION_LABELS);
  return (
    <Page title="Roles" subtitle="Permisos de cada rol. Se aplican en el servidor y en la base de datos.">
      <div className="card table-wrap">
        <table className="table">
          <thead>
            <tr><th>Permiso</th>{(roles.data ?? []).map((r) => <th key={r.key} style={{ textAlign: 'center' }}>{r.label}</th>)}</tr>
          </thead>
          <tbody>
            {all.map((p) => (
              <tr key={p}>
                <td>{PERMISSION_LABELS[p]}</td>
                {(roles.data ?? []).map((r) => (
                  <td key={r.key} style={{ textAlign: 'center' }}>{r.permissions.includes(p) ? <span className="badge ok">✓</span> : <span className="muted">—</span>}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Page>
  );
}
