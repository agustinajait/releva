import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, auth, type SessionUser } from './api';

export function useUser(): SessionUser | null {
  const [user, setUser] = useState(auth.user);
  useEffect(() => {
    const off = auth.subscribe(setUser);
    return () => {
      off();
    };
  }, []);
  return user;
}

/** Carga datos de la API con estado de carga/error y recarga manual. */
export function useApi<T>(path: string | null, query?: Record<string, string | undefined>) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const qkey = JSON.stringify(query ?? {});
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!path) return;
    let alive = true;
    setLoading(true);
    setError(null);
    api<T>(path, { query: JSON.parse(qkey) })
      .then((d) => alive && setData(d))
      .catch((e: Error) => alive && setError(e.message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [path, qkey, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload, setData };
}

// ── Proyecto seleccionado ──────────────────────────────────────────────────

export interface ProjectSummary {
  id: string;
  name: string;
  clientId: string;
  clientName: string;
  status: string;
  pointCount: number;
  zoneCount: number;
}

interface ProjectCtx {
  projects: ProjectSummary[];
  current: ProjectSummary | null;
  select(id: string): void;
  reload(): void;
}

const Ctx = createContext<ProjectCtx>({ projects: [], current: null, select: () => undefined, reload: () => undefined });
const PKEY = 'releva.project';

export function ProjectProvider({ children }: { children: ReactNode }) {
  const { data, reload } = useApi<ProjectSummary[]>('/projects');
  const [selected, setSelected] = useState<string | null>(() => {
    try {
      return sessionStorage.getItem(PKEY);
    } catch {
      return null;
    }
  });
  const projects = data ?? [];
  const current = projects.find((p) => p.id === selected) ?? projects.find((p) => p.status === 'active') ?? projects[0] ?? null;
  const select = (id: string) => {
    setSelected(id);
    try {
      sessionStorage.setItem(PKEY, id);
    } catch {
      /* no-op */
    }
  };
  return <Ctx.Provider value={{ projects, current, select, reload }}>{children}</Ctx.Provider>;
}

export const useProject = () => useContext(Ctx);

// ── Formato ────────────────────────────────────────────────────────────────

const dtf = new Intl.DateTimeFormat('es-AR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Argentina/Buenos_Aires' });
export const fmtDateTime = (iso?: string | null) => (iso ? dtf.format(new Date(iso)) : '—');
const nf = new Intl.NumberFormat('es-AR');
export const fmtNum = (n: number) => nf.format(n);
