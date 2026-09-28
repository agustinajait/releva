import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { ROLE_LABELS } from '@releva/core';
import { auth } from '../api';
import { useProject, useUser } from '../hooks';

function Mark() {
  return (
    <svg width="18" height="18" viewBox="0 0 32 32" aria-hidden>
      <circle cx="16" cy="13" r="6" fill="none" stroke="#f5b942" strokeWidth="3.5" />
      <path d="M16 19v8" stroke="#f5b942" strokeWidth="3.5" strokeLinecap="round" />
    </svg>
  );
}

function Link({ to, children }: { to: string; children: ReactNode }) {
  return <NavLink to={to}>{children}</NavLink>;
}

export function Layout() {
  const user = useUser()!;
  const { projects, current, select } = useProject();
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  const can = (p: string) => user.permissions.includes(p);
  useEffect(() => setOpen(false), [loc.pathname]);

  return (
    <div className={`shell ${open ? 'open' : ''}`} onClick={() => open && setOpen(false)}>
      <div className="topbar">
        <button aria-label="Menú" onClick={(e) => { e.stopPropagation(); setOpen(true); }}>☰</button>
        RELEVA
      </div>
      <nav className="side" onClick={(e) => e.stopPropagation()}>
        <div className="brand">
          <span className="brand-mark"><Mark /></span>
          RELEVA
        </div>

        {projects.length > 0 && (
          <div style={{ padding: '0 10px 6px' }}>
            <select aria-label="Proyecto" value={current?.id ?? ''} onChange={(e) => select(e.target.value)}>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {user.role === 'super_admin' ? `${p.clientName} · ` : ''}
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        )}

        {can('points:read') && (
          <>
            <div className="side-group">Territorio</div>
            <Link to="/panel/mapa">Mapa</Link>
            {can('indicators:read') && <Link to="/panel/indicadores">Indicadores</Link>}
          </>
        )}

        {(can('projects:manage') || can('users:manage') || can('clients:manage')) && (
          <>
            <div className="side-group">Administración</div>
            {can('clients:manage') && <Link to="/admin/clientes">Clientes y organismos</Link>}
            {can('users:manage') && <Link to="/admin/usuarios">Usuarios</Link>}
            {can('users:manage') && <Link to="/admin/roles">Roles</Link>}
            {can('projects:manage') && <Link to="/admin/proyectos">Proyectos</Link>}
            {can('audit:read') && <Link to="/admin/auditoria">Auditoría</Link>}
          </>
        )}

        <div className="side-foot">
          <div className="who">{user.name}</div>
          <div className="role">{ROLE_LABELS[user.role]}</div>
          <button onClick={() => void auth.logout()}>Salir</button>
        </div>
      </nav>
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}
