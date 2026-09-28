import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTestEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeAll(async () => {
  env = await setupTestEnv();
});
afterAll(async () => env?.close());

describe('autenticación', () => {
  it('login correcto devuelve tokens y permisos del rol', async () => {
    const r = await env.api(null, 'POST', '/auth/login', { email: 'ANALYST-A@t.local', password: 'test-password-123' });
    expect(r.status).toBe(200);
    expect(r.body.user).toMatchObject({ role: 'analyst', clientId: env.ids.clientA });
    expect(r.body.user.permissions).toContain('points:read');
    expect(r.body.user.permissions).not.toContain('users:manage');
    expect(r.body.refreshToken).toBeTruthy();
  });

  it('credenciales incorrectas: mismo mensaje exista o no el usuario, y queda auditado', async () => {
    const bad = await env.api(null, 'POST', '/auth/login', { email: 'admin-a@t.local', password: 'incorrecta-123' });
    const none = await env.api(null, 'POST', '/auth/login', { email: 'nadie@t.local', password: 'incorrecta-123' });
    expect(bad.status).toBe(401);
    expect(none.status).toBe(401);
    expect(bad.body.message).toBe(none.body.message);
    const c = await env.pool.connect();
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.is_super', 'true', true)`);
    const n = (await c.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'login_failed'`)).rows[0].n;
    await c.query('ROLLBACK');
    c.release();
    expect(n).toBeGreaterThanOrEqual(2);
  });

  it('sin token o con token adulterado: 401', async () => {
    expect((await env.api(null, 'GET', '/me')).status).toBe(401);
    const token = await env.login('analyst-a@t.local');
    const [h, p, s] = token.split('.');
    const payload = JSON.parse(Buffer.from(p!, 'base64url').toString());
    payload.role = 'super_admin';
    const forged = `${h}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${s}`;
    expect((await env.api(forged, 'GET', '/clients')).status).toBe(401);
  });

  it('refresh rota el token y la reutilización revoca todas las sesiones', async () => {
    const l = await env.api(null, 'POST', '/auth/login', { email: 'surveyor-a@t.local', password: 'test-password-123' });
    const first = l.body.refreshToken;
    const r1 = await env.api(null, 'POST', '/auth/refresh', { refreshToken: first });
    expect(r1.status).toBe(200);
    expect(r1.body.refreshToken).not.toBe(first);
    // Reutilizar el token viejo (posible robo) → 401 y se revoca también el nuevo.
    expect((await env.api(null, 'POST', '/auth/refresh', { refreshToken: first })).status).toBe(401);
    expect((await env.api(null, 'POST', '/auth/refresh', { refreshToken: r1.body.refreshToken })).status).toBe(401);
  });

  it('un usuario desactivado no puede ingresar', async () => {
    const admin = await env.login('admin-b@t.local');
    const created = await env.api(admin, 'POST', '/users', { email: 'temp-b@t.local', name: 'Temporal', role: 'surveyor', password: 'clave-segura-1' });
    expect(created.status).toBe(201);
    expect((await env.api(admin, 'PATCH', `/users/${created.body.id}`, { active: false })).status).toBe(200);
    expect((await env.api(null, 'POST', '/auth/login', { email: 'temp-b@t.local', password: 'clave-segura-1' })).status).toBe(401);
  });

  it('exige contraseñas razonables', async () => {
    const admin = await env.login('admin-b@t.local');
    const r = await env.api(admin, 'POST', '/users', { email: 'x@t.local', name: 'X', role: 'surveyor', password: '1234' });
    expect(r.status).toBe(400);
  });
});

describe('sesiones y endurecimiento', () => {
  it('desactivar o cambiar el rol invalida el token de acceso en el acto', async () => {
    const super_ = await env.login('super@t.local');
    const u = await env.api(super_, 'POST', '/users', { email: 'rol-a@t.local', name: 'Rol', role: 'client_admin', password: 'clave-segura-1', clientId: env.ids.clientA });
    const t = await env.login('rol-a@t.local', 'clave-segura-1');
    expect((await env.api(t, 'GET', '/users')).status).toBe(200);
    await env.api(super_, 'PATCH', `/users/${u.body.id}`, { role: 'analyst' });
    expect((await env.api(t, 'GET', '/users')).status).toBe(401);
  });

  it('desactivar un cliente corta el acceso de sus usuarios', async () => {
    const super_ = await env.login('super@t.local');
    const c = await env.api(super_, 'POST', '/clients', { name: 'Cliente C', slug: 'cliente-c' });
    await env.api(super_, 'POST', '/users', { email: 'x-c@t.local', name: 'XC', role: 'analyst', password: 'clave-segura-1', clientId: c.body.id });
    const t = await env.login('x-c@t.local', 'clave-segura-1');
    expect((await env.api(t, 'GET', '/projects')).status).toBe(200);
    await env.api(super_, 'PATCH', `/clients/${c.body.id}`, { active: false });
    expect((await env.api(t, 'GET', '/projects')).status).toBe(401);
    expect((await env.api(null, 'POST', '/auth/login', { email: 'x-c@t.local', password: 'clave-segura-1' })).status).toBe(401);
  });

  it('un admin de cliente no puede tomar el control de otro admin', async () => {
    const super_ = await env.login('super@t.local');
    const peer = await env.api(super_, 'POST', '/users', { email: 'peer-a@t.local', name: 'Par', role: 'client_admin', password: 'clave-segura-1', clientId: env.ids.clientA });
    const t = await env.login('admin-a@t.local');
    expect((await env.api(t, 'PATCH', `/users/${peer.body.id}`, { password: 'otra-clave-99' })).status).toBe(403);
    expect((await env.api(t, 'PATCH', `/users/${peer.body.id}`, { active: false })).status).toBe(403);
  });

  it('limita los intentos de login por cuenta aunque cambie la IP', async () => {
    const { buildApp } = await import('../src/app.js');
    const { loadConfig } = await import('../src/config.js');
    const app = await buildApp(
      loadConfig({ DATABASE_URL: 'postgres://x@localhost/x', JWT_SECRET: 'test-secret-test-secret-test-secret-123', LOG_LEVEL: 'silent', LOGIN_RATE_LIMIT: '3', TRUST_PROXY_HOPS: '1' }),
      env.pool,
    );
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { 'x-forwarded-for': `10.0.0.${i}` },
        payload: { email: 'analyst-b@t.local', password: 'mala-clave-1' },
      });
      codes.push(r.statusCode);
    }
    await app.close();
    expect(codes).toEqual([401, 401, 401, 429, 429]);
  });
});

describe('autorización por roles', () => {
  it('el relevador no puede crear proyectos ni ver usuarios', async () => {
    const t = await env.login('surveyor-a@t.local');
    expect((await env.api(t, 'POST', '/projects', { name: 'X' })).status).toBe(403);
    expect((await env.api(t, 'GET', '/users')).status).toBe(403);
    expect((await env.api(t, 'GET', `/projects/${env.ids.projectA}/indicators`)).status).toBe(403);
  });

  it('el analista (Gobierno) lee pero no modifica', async () => {
    const t = await env.login('analyst-a@t.local');
    expect((await env.api(t, 'GET', `/projects/${env.ids.projectA}/points`)).status).toBe(200);
    expect((await env.api(t, 'PATCH', `/projects/${env.ids.projectA}`, { name: 'Cambio' })).status).toBe(403);
    expect((await env.api(t, 'POST', '/sync/surveys', { items: [] })).status).toBe(403);
  });

  it('un admin de cliente no puede crear super admins ni clientes', async () => {
    const t = await env.login('admin-a@t.local');
    const r = await env.api(t, 'POST', '/users', { email: 'evil@t.local', name: 'Evil', role: 'super_admin', password: 'clave-segura-1' });
    expect(r.status).toBe(403);
    expect((await env.api(t, 'POST', '/clients', { name: 'Otro', slug: 'otro' })).status).toBe(403);
  });

  it('un admin de cliente crea usuarios siempre en su propio cliente, aunque pida otro', async () => {
    const t = await env.login('admin-a@t.local');
    const r = await env.api(t, 'POST', '/users', {
      email: 'nuevo-a@t.local', name: 'Nuevo', role: 'analyst', password: 'clave-segura-1', clientId: env.ids.clientB,
    });
    expect(r.status).toBe(201);
    expect(r.body.clientId).toBe(env.ids.clientA);
  });

  it('el super admin debe indicar el cliente al crear un proyecto', async () => {
    const t = await env.login('super@t.local');
    expect((await env.api(t, 'POST', '/projects', { name: 'Sin cliente' })).status).toBe(400);
    const ok = await env.api(t, 'POST', '/projects', { name: 'Con cliente', clientId: env.ids.clientB });
    expect(ok.status).toBe(201);
    expect(ok.body.clientId).toBe(env.ids.clientB);
  });

  it('el relevador solo ve los proyectos asignados', async () => {
    const admin = await env.login('admin-a@t.local');
    const other = await env.api(admin, 'POST', '/projects', { name: 'Proyecto no asignado' });
    const t = await env.login('surveyor-a@t.local');
    const list = await env.api(t, 'GET', '/projects');
    expect(list.body.map((p: any) => p.id)).toEqual([env.ids.projectA]);
    expect((await env.api(t, 'GET', `/projects/${other.body.id}`)).status).toBe(404);
  });
});

describe('separación de información entre clientes', () => {
  it('un cliente no ve proyectos, usuarios ni clientes de otro', async () => {
    const t = await env.login('admin-a@t.local');
    const projects = await env.api(t, 'GET', '/projects');
    expect(projects.body.every((p: any) => p.clientId === env.ids.clientA)).toBe(true);
    const users = await env.api(t, 'GET', '/users');
    expect(users.body.every((u: any) => u.clientId === env.ids.clientA)).toBe(true);
    const clients = await env.api(t, 'GET', '/clients');
    expect(clients.body.map((c: any) => c.id)).toEqual([env.ids.clientA]);
  });

  it('acceder por id a un recurso de otro cliente devuelve 404 (no revela que existe)', async () => {
    const t = await env.login('analyst-a@t.local');
    expect((await env.api(t, 'GET', `/projects/${env.ids.projectB}`)).status).toBe(404);
    expect((await env.api(t, 'GET', `/projects/${env.ids.projectB}/points`)).status).toBe(404);
    expect((await env.api(t, 'GET', `/questionnaire-versions/${env.ids.versionB}`)).status).toBe(404);
  });

  it('no se puede escribir en un proyecto de otro cliente', async () => {
    const t = await env.login('admin-a@t.local');
    const zone = await env.api(t, 'POST', `/projects/${env.ids.projectB}/zones`, {
      name: 'Intrusa',
      geometry: { type: 'Polygon', coordinates: [[[-58.4, -34.6], [-58.3, -34.6], [-58.3, -34.7], [-58.4, -34.6]]] },
    });
    expect(zone.status).toBe(404);
    expect((await env.api(t, 'PATCH', `/projects/${env.ids.projectB}`, { name: 'Tomado' })).status).toBe(404);
    expect((await env.api(t, 'PATCH', `/users/${env.ids.surveyorB}`, { active: false })).status).toBe(404);
  });

  it('no se puede asignar a un proyecto propio un usuario de otro cliente', async () => {
    const t = await env.login('admin-a@t.local');
    const r = await env.api(t, 'PUT', `/projects/${env.ids.projectA}/members`, { userIds: [env.ids.surveyorA, env.ids.surveyorB] });
    expect(r.status).toBe(400);
    // Se revirtió: la asignación original sigue intacta.
    const p = await env.api(t, 'GET', `/projects/${env.ids.projectA}`);
    expect(p.body.members.map((m: any) => m.id)).toEqual([env.ids.surveyorA]);
  });

  it('la base de datos filtra por cliente aunque la consulta no lo haga (RLS)', async () => {
    const c = await env.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.is_super', 'false', true), set_config('app.client_id', $1, true)`, [env.ids.clientA]);
      const projects = await c.query('SELECT client_id FROM projects');
      expect(projects.rows.length).toBeGreaterThan(0);
      expect(projects.rows.every((r) => r.client_id === env.ids.clientA)).toBe(true);
      // Insertar datos en nombre de otro cliente también está bloqueado.
      await expect(c.query(`INSERT INTO organizations (client_id, name) VALUES ($1, 'Intrusa')`, [env.ids.clientB])).rejects.toThrow(
        /row-level security/,
      );
      await c.query('ROLLBACK');
      // Sin contexto no se ve nada.
      await c.query('BEGIN');
      expect((await c.query('SELECT * FROM projects')).rows).toHaveLength(0);
      expect((await c.query('SELECT * FROM users')).rows).toHaveLength(0);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });
});
