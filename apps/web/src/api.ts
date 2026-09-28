/**
 * Cliente HTTP del panel. Guarda la sesión en sessionStorage (se cierra con la pestaña)
 * y renueva el token de acceso automáticamente.
 * Próxima etapa: mover el refresh token a una cookie httpOnly.
 */

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: 'super_admin' | 'client_admin' | 'analyst' | 'surveyor';
  clientId: string | null;
  permissions: string[];
}

interface Session {
  accessToken: string;
  refreshToken: string;
  user: SessionUser;
}

const KEY = 'releva.session';
const BASE = '/api/v1';

let session: Session | null = load();
const listeners = new Set<(u: SessionUser | null) => void>();

function load(): Session | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

function save(s: Session | null) {
  session = s;
  try {
    if (s) sessionStorage.setItem(KEY, JSON.stringify(s));
    else sessionStorage.removeItem(KEY);
  } catch {
    /* sin almacenamiento: la sesión vive en memoria */
  }
  listeners.forEach((l) => l(s?.user ?? null));
}

export const auth = {
  get user() {
    return session?.user ?? null;
  },
  subscribe(l: (u: SessionUser | null) => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  can(permission: string) {
    return session?.user.permissions.includes(permission) ?? false;
  },
  async login(email: string, password: string) {
    const res = await fetch(`${BASE}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, body.message ?? 'No se pudo ingresar', body.details);
    save(body as Session);
  },
  async logout() {
    const rt = session?.refreshToken;
    save(null);
    if (rt) await fetch(`${BASE}/auth/logout`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken: rt }) }).catch(() => undefined);
  },
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

let refreshing: Promise<boolean> | null = null;

async function refresh(): Promise<boolean> {
  if (!session) return false;
  refreshing ??= (async () => {
    try {
      const res = await fetch(`${BASE}/auth/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: session!.refreshToken }),
      });
      if (!res.ok) {
        save(null);
        return false;
      }
      save((await res.json()) as Session);
      return true;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown; query?: Record<string, string | undefined> } = {}): Promise<T> {
  const qs = init.query
    ? '?' + new URLSearchParams(Object.entries(init.query).filter(([, v]) => v !== undefined && v !== '') as [string, string][]).toString()
    : '';
  const doFetch = () =>
    fetch(`${BASE}${path}${qs}`, {
      method: init.method ?? 'GET',
      headers: {
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(session ? { authorization: `Bearer ${session.accessToken}` } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  let res = await doFetch();
  if (res.status === 401 && session && (await refresh())) res = await doFetch();
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body.message ?? `Error ${res.status}`, body.details);
  return body as T;
}
