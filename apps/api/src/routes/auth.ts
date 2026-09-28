import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { permissionsOf, type Role } from '@releva/core';
import { withActor, type Actor } from '../db/pool.js';
import { DUMMY_HASH, newOpaqueToken, sha256, verifyPassword } from '../auth/passwords.js';
import { authenticate } from '../http/auth.js';
import { HttpError, parse } from '../http/errors.js';
import { audit } from '../services/audit.js';

const SYSTEM: Actor = { kind: 'system', reason: 'auth' };

interface UserRow {
  id: string;
  client_id: string | null;
  email: string;
  name: string;
  role: Role;
  active: boolean;
  password_hash: string;
  client_active: boolean | null;
}

export async function authRoutes(app: FastifyInstance) {
  const { pool, config } = app;

  async function issueTokens(user: Pick<UserRow, 'id' | 'role' | 'client_id'>, db: import('../db/pool.js').Db) {
    const accessToken = app.jwt.sign({ sub: user.id, role: user.role, cid: user.client_id }, { expiresIn: config.ACCESS_TOKEN_TTL });
    const refresh = newOpaqueToken();
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, now() + make_interval(days => $3)) RETURNING id`,
      [user.id, refresh.hash, config.REFRESH_TOKEN_DAYS],
    );
    return { accessToken, refreshToken: refresh.token, refreshId: rows[0]!.id };
  }

  const publicUser = (u: UserRow) => ({
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    clientId: u.client_id,
    permissions: permissionsOf(u.role),
  });

  const loadUser = (db: import('../db/pool.js').Db, where: string, value: string) =>
    db.query<UserRow>(
      `SELECT u.id, u.client_id, u.email, u.name, u.role, u.active, u.password_hash, c.active AS client_active
         FROM users u LEFT JOIN clients c ON c.id = u.client_id
        WHERE ${where} = $1`,
      [value],
    );

  app.post(
    '/auth/login',
    { config: { rateLimit: { max: config.LOGIN_RATE_LIMIT, timeWindow: '1 minute' } } },
    async (req) => {
      const body = parse(z.object({ email: z.string().trim().toLowerCase().email(), password: z.string().min(1).max(200) }), req.body);
      const result = await withActor(pool, SYSTEM, async (db) => {
        const user = (await loadUser(db, 'u.email', body.email)).rows[0];
        // Siempre se verifica un hash, exista o no el usuario, para no revelarlo por tiempo de respuesta.
        const valid = await verifyPassword(body.password, user?.password_hash ?? DUMMY_HASH);
        const usable = user && valid && user.active && (user.role === 'super_admin' || user.client_active);
        if (!usable) return { failed: true as const, userId: user?.id ?? null, clientId: user?.client_id ?? null };
        await db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
        const tokens = await issueTokens(user, db);
        const actor: Actor = { kind: 'user', id: user.id, role: user.role, clientId: user.client_id };
        await audit(db, actor, { action: 'login', entity: 'user', entityId: user.id, ip: req.ip });
        return { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, user: publicUser(user) };
      });
      if ('failed' in result) {
        // En su propia transacción: el intento fallido queda registrado aunque la respuesta sea un error.
        await withActor(pool, SYSTEM, (db) =>
          audit(db, SYSTEM, {
            action: 'login_failed',
            entity: 'user',
            entityId: result.userId,
            clientId: result.clientId,
            data: { email: body.email },
            ip: req.ip,
          }),
        );
        throw new HttpError(401, 'Email o contraseña incorrectos', 'invalid_credentials');
      }
      return result;
    },
  );

  app.post(
    '/auth/refresh',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req) => {
      const body = parse(z.object({ refreshToken: z.string().min(20).max(200) }), req.body);
      const hash = sha256(body.refreshToken);
      const result = await withActor(pool, SYSTEM, async (db) => {
        const { rows } = await db.query<{ id: string; user_id: string; revoked_at: string | null; expired: boolean }>(
          `SELECT id, user_id, revoked_at, expires_at < now() AS expired FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE`,
          [hash],
        );
        const rt = rows[0];
        if (!rt || rt.expired) return { error: 'expired' as const };
        if (rt.revoked_at) {
          // Reutilización de un token ya rotado: posible robo. Se revocan todas las sesiones del usuario.
          await db.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [rt.user_id]);
          await audit(db, SYSTEM, { action: 'refresh_reuse_detected', entity: 'user', entityId: rt.user_id, clientId: null, ip: req.ip });
          return { error: 'reused' as const };
        }
        const user = (await loadUser(db, 'u.id', rt.user_id)).rows[0];
        if (!user || !user.active || (user.role !== 'super_admin' && !user.client_active)) {
          await db.query('UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1', [rt.id]);
          return { error: 'inactive' as const };
        }
        const tokens = await issueTokens(user, db);
        await db.query('UPDATE refresh_tokens SET revoked_at = now(), replaced_by = $2 WHERE id = $1', [rt.id, tokens.refreshId]);
        return { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, user: publicUser(user) };
      });
      if ('error' in result) throw new HttpError(401, 'Sesión vencida, volvé a ingresar', 'invalid_refresh');
      return result;
    },
  );

  app.post('/auth/logout', async (req, reply) => {
    const body = parse(z.object({ refreshToken: z.string().min(20).max(200) }), req.body);
    await withActor(pool, SYSTEM, (db) =>
      db.query('UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL', [sha256(body.refreshToken)]),
    );
    return reply.status(204).send();
  });

  app.get('/me', { preHandler: authenticate }, async (req) => {
    const user = await req.db(async (db) => (await loadUser(db, 'u.id', req.actor.id)).rows[0]);
    if (!user || !user.active) throw new HttpError(401, 'Sesión inválida', 'unauthorized');
    return publicUser(user);
  });
}
