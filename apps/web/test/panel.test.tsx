import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { App } from '../src/App';
import { api, auth } from '../src/api';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  sessionStorage.clear();
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('panel web', () => {
  it('muestra el error de credenciales sin exponer detalles', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(401, { message: 'Email o contraseña incorrectos' }));
    render(<MemoryRouter><App /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'a@b.com' } });
    fireEvent.change(screen.getByLabelText('Contraseña'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ingresar' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Email o contraseña incorrectos');
  });

  it('renueva el token vencido una sola vez y reintenta', async () => {
    sessionStorage.setItem('releva.session', JSON.stringify({ accessToken: 'viejo', refreshToken: 'r'.repeat(40), user: { id: '1', role: 'analyst', permissions: [] } }));
    // El módulo leyó la sesión al importarse; se fuerza el estado vía login simulado.
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock.mockResolvedValueOnce(json(200, { accessToken: 'viejo', refreshToken: 'r'.repeat(40), user: { id: '1', name: 'A', role: 'analyst', permissions: ['points:read'] } }));
    await auth.login('a@b.com', 'x');
    fetchMock
      .mockResolvedValueOnce(json(401, { message: 'vencido' }))
      .mockResolvedValueOnce(json(200, { accessToken: 'nuevo', refreshToken: 's'.repeat(40), user: { id: '1', name: 'A', role: 'analyst', permissions: ['points:read'] } }))
      .mockResolvedValueOnce(json(200, { ok: true }));
    const r = await api<{ ok: boolean }>('/me');
    expect(r.ok).toBe(true);
    const calls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(calls.slice(-3)).toEqual(['/api/v1/me', '/api/v1/auth/refresh', '/api/v1/me']);
    const last = fetchMock.mock.calls.at(-1)![1] as RequestInit;
    expect((last.headers as Record<string, string>).authorization).toBe('Bearer nuevo');
  });

  it('un relevador ve el aviso de usar la app móvil', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(200, { accessToken: 't', refreshToken: 'r'.repeat(40), user: { id: '1', name: 'Rel', role: 'surveyor', permissions: [] } }));
    await auth.login('r@b.com', 'x');
    render(<MemoryRouter><App /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText(/app móvil RELEVA/)).toBeTruthy());
  });
});
