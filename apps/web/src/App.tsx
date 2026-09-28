import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { ProjectProvider, useUser } from './hooks';
import { LoginPage } from './pages/Login';
import { IndicatorsPage } from './pages/IndicatorsPage';
import { ClientsPage } from './pages/admin/Clients';
import { RolesPage, UsersPage } from './pages/admin/Users';
import { AuditPage, ProjectsPage } from './pages/admin/Projects';
import { ProjectDetailPage } from './pages/admin/ProjectDetail';
import { QuestionnaireEditorPage } from './pages/admin/QuestionnaireEditor';

// El mapa (MapLibre) es pesado: se carga solo cuando se usa.
const MapPage = lazy(() => import('./pages/MapPage').then((m) => ({ default: m.MapPage })));

function Guard({ permission, children }: { permission: string; children: React.ReactElement }) {
  const user = useUser();
  return user?.permissions.includes(permission) ? children : <Navigate to="/" replace />;
}

export function App() {
  const user = useUser();
  if (!user) return <LoginPage />;
  if (user.role === 'surveyor') {
    return (
      <div className="page">
        <div className="card card-pad">
          <h2>Hola, {user.name}</h2>
          <p className="muted">Los relevadores trabajan desde la app móvil RELEVA. Este panel es para administración y Gobierno.</p>
        </div>
      </div>
    );
  }
  const home = user.permissions.includes('points:read') ? '/panel/mapa' : '/admin/proyectos';
  return (
    <ProjectProvider>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/panel/mapa" element={<Guard permission="points:read"><Suspense fallback={<div className="page muted">Cargando mapa…</div>}><MapPage /></Suspense></Guard>} />
          <Route path="/panel/indicadores" element={<Guard permission="indicators:read"><IndicatorsPage /></Guard>} />
          <Route path="/admin/clientes" element={<Guard permission="clients:manage"><ClientsPage /></Guard>} />
          <Route path="/admin/usuarios" element={<Guard permission="users:manage"><UsersPage /></Guard>} />
          <Route path="/admin/roles" element={<Guard permission="users:manage"><RolesPage /></Guard>} />
          <Route path="/admin/proyectos" element={<Guard permission="projects:manage"><ProjectsPage /></Guard>} />
          <Route path="/admin/proyectos/:id" element={<Guard permission="projects:manage"><ProjectDetailPage /></Guard>} />
          <Route path="/admin/cuestionarios/:id" element={<Guard permission="questionnaires:manage"><QuestionnaireEditorPage /></Guard>} />
          <Route path="/admin/auditoria" element={<Guard permission="audit:read"><AuditPage /></Guard>} />
          <Route path="*" element={<Navigate to={home} replace />} />
        </Route>
      </Routes>
    </ProjectProvider>
  );
}
