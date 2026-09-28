import * as SecureStore from 'expo-secure-store';
import type { SurveySyncItem, SyncItemResult, SyncTransport } from '@releva/core';

/**
 * Cliente de la API. Los tokens se guardan en el almacenamiento seguro del
 * sistema (Keystore en Android), nunca en texto plano.
 */

// En el emulador de Android, 10.0.2.2 es el "localhost" de la computadora.
export const API_URL = (process.env.EXPO_PUBLIC_API_URL ?? 'http://10.0.2.2:4000').replace(/\/$/, '') + '/api/v1';

export interface MobileUser {
  id: string;
  name: string;
  email: string;
  role: string;
  clientId: string | null;
}

interface Tokens {
  accessToken: string;
  refreshToken: string;
}

const KEY = 'releva.tokens';
const USER_KEY = 'releva.user';

let tokens: Tokens | null = null;

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}
/** Error de red (sin señal, servidor inalcanzable): se trabaja offline. */
export class OfflineError extends Error {}

export async function restoreSession(): Promise<MobileUser | null> {
  const raw = await SecureStore.getItemAsync(KEY);
  const user = await SecureStore.getItemAsync(USER_KEY);
  if (!raw || !user) return null;
  tokens = JSON.parse(raw) as Tokens;
  return JSON.parse(user) as MobileUser;
}

async function saveSession(t: Tokens | null, user?: MobileUser) {
  tokens = t;
  if (t) {
    await SecureStore.setItemAsync(KEY, JSON.stringify(t));
    if (user) await SecureStore.setItemAsync(USER_KEY, JSON.stringify(user));
  } else {
    await SecureStore.deleteItemAsync(KEY);
    await SecureStore.deleteItemAsync(USER_KEY);
  }
}

async function rawFetch(path: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(`${API_URL}${path}`, init);
  } catch (err) {
    throw new OfflineError((err as Error).message || 'Sin conexión');
  }
}

export async function login(email: string, password: string): Promise<MobileUser> {
  const res = await rawFetch('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body.message ?? 'No se pudo ingresar');
  if (body.user.role !== 'surveyor' && body.user.role !== 'super_admin') {
    throw new ApiError(403, 'Esta app es para relevadores. Usá el panel web.');
  }
  await saveSession({ accessToken: body.accessToken, refreshToken: body.refreshToken }, body.user);
  return body.user as MobileUser;
}

export async function logout() {
  const rt = tokens?.refreshToken;
  await saveSession(null);
  if (rt) {
    await rawFetch('/auth/logout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken: rt }) }).catch(() => undefined);
  }
}

async function refresh(): Promise<boolean> {
  if (!tokens) return false;
  const res = await rawFetch('/auth/refresh', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refreshToken: tokens.refreshToken }),
  });
  if (!res.ok) return false;
  const body = await res.json();
  await saveSession({ accessToken: body.accessToken, refreshToken: body.refreshToken }, body.user);
  return true;
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const doFetch = () =>
    rawFetch(path, {
      method: init.method ?? 'GET',
      headers: {
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(tokens ? { authorization: `Bearer ${tokens.accessToken}` } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  let res = await doFetch();
  if (res.status === 401 && (await refresh())) res = await doFetch();
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body.message ?? `Error ${res.status}`);
  return body as T;
}

/** Transporte de la cola offline hacia /sync/surveys. */
export const syncTransport: SyncTransport = {
  async send(items: SurveySyncItem[]): Promise<SyncItemResult[]> {
    const r = await api<{ results: SyncItemResult[] }>('/sync/surveys', { method: 'POST', body: { items } });
    return r.results;
  },
};
