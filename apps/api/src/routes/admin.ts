import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { assignableRoles, permissionsOf, ROLE_LABELS, ROLES, type Role } from '@releva/core';
import { authenticate, requirePermission, targetClientId } from '../http/auth.js';
import { badRequest, forbidden, notFound, parse } from '../http/errors.js';
import { hashPassword, passwordProblem } from '../auth/passwords.js';
import { audit } from '../services/audit.js';

const Id = z.object({ id: z.string().uuid() });

/** Clientes, organismos, usuarios y roles. */
export async function adminRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  // ── Roles ───────────────────────────────────────────────────────────────
  app.get('/roles', async (req) =>
    ROLES.map((r) => ({
      key: r,
      label: ROLE_LABELS[r],
      permissions: permissionsOf(r),
      assignable: assignableRoles(req.actor.role).includes(r),
    })),
  );

  // ── Clientes ────────────────────────────────────────────────────────────
  app.get('/clients', { preHandler: requirePermission('projects:read') }, async (req) =>
    req.db(async (db) => (await db.query('SELECT id, name, slug, active, created_at AS "createdAt" FROM clients ORDER BY name')).rows),
  );

  const ClientBody = z.object({
    name: z.string().trim().min(2).max(120),
    slug: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{1,62}$/, 'Solo minúsculas, números y guiones'),
  });

  app.post('/clients', { preHandler: requirePermission('clients:manage') }, async (req, reply) => {
    const body = parse(ClientBody, req.body);
    const row = await req.db(async (db) => {
      const { rows } = await db.query('INSERT INTO clients (name, slug) VALUES ($1, $2) RETURNING id, name, slug, active', [body.name, body.slug]);
      await audit(db, req.actor, { action: 'create', entity: 'client', entityId: rows[0].id, clientId: rows[0].id, data: body });
      return rows[0];
    });
    return reply.status(201).send(row);
  });

  app.patch('/clients/:id', { preHandler: requirePermission('clients:manage') }, async (req) => {
    const { id } = parse(Id, req.params);
    const body = parse(z.object({ name: z.string().trim().min(2).max(120).optional(), active: z.boolean().optional() }), req.body);
    return req.db(async (db) => {
      const { rows } = await db.query(
        `UPDATE clients SET name = coalesce($2, name), active = coalesce($3, active) WHERE id = $1 RETURNING id, name, slug, active`,
        [id, body.name ?? null, body.active ?? null],
      );
      if (!rows[0]) throw notFound('Cliente');
      await audit(db, req.actor, { action: 'update', entity: 'client', entityId: id, clientId: id, data: body });
      return rows[0];
    });
  });

  // ── Organismos ──────────────────────────────────────────────────────────
  app.get('/organizations', { preHandler: requirePermission('projects:read') }, async (req) => {
    const q = parse(z.object({ clientId: z.string().uuid().optional() }), req.query);
    return req.db(
      async (db) =>
        (
          await db.query(
            `SELECT o.id, o.name, o.client_id AS "clientId", c.name AS "clientName"
               FROM organizations o JOIN clients c ON c.id = o.client_id
              WHERE ($1::uuid IS NULL OR o.client_id = $1) ORDER BY c.name, o.name`,
            [q.clientId ?? null],
          )
        ).rows,
    );
  });

  app.post('/organizations', { preHandler: requirePermission('organizations:manage') }, async (req, reply) => {
    const body = parse(z.object({ name: z.string().trim().min(2).max(160), clientId: z.string().uuid().optional() }), req.body);
    const clientId = targetClientId(req, body.clientId);
    const row = await req.db(async (db) => {
      const { rows } = await db.query(
        'INSERT INTO organizations (client_id, name) VALUES ($1, $2) RETURNING id, name, client_id AS "clientId"',
        [clientId, body.name],
      );
      await audit(db, req.actor, { action: 'create', entity: 'organization', entityId: rows[0].id, clientId, data: { name: body.name } });
      return rows[0];
    });
    return reply.status(201).send(row);
  });

  // ── Usuarios ────────────────────────────────────────────────────────────
  const userCols = `u.id, u.email, u.name, u.role, u.active, u.client_id AS "clientId", u.organization_id AS "organizationId",
                    u.last_login_at AS "lastLoginAt", u.created_at AS "createdAt"`;

  app.get('/users', { preHandler: requirePermission('users:manage') }, async (req) => {
    const q = parse(z.object({ clientId: z.string().uuid().optional(), role: z.enum(ROLES).optional() }), req.query);
    return req.db(
      async (db) =>
        (
          await db.query(
            `SELECT ${userCols}, c.name AS "clientName" FROM users u LEFT JOIN clients c ON c.id = u.client_id
              WHERE ($1::uuid IS NULL OR u.client_id = $1) AND ($2::text IS NULL OR u.role = $2)
              ORDER BY u.name`,
            [q.clientId ?? null, q.role ?? null],
          )
        ).rows,
    );
  });

  const passwordField = z.string().superRefine((p, ctx) => {
    const problem = passwordProblem(p);
    if (problem) ctx.addIssue({ code: 'custom', message: problem });
  });

  app.post('/users', { preHandler: requirePermission('users:manage') }, async (req, reply) => {
    const body = parse(
      z.object({
        email: z.string().trim().toLowerCase().email(),
        name: z.string().trim().min(2).max(120),
        role: z.enum(ROLES),
        password: passwordField,
        clientId: z.string().uuid().optional(),
        organizationId: z.string().uuid().optional(),
      }),
      req.body,
    );
    if (!assignableRoles(req.actor.role).includes(body.role)) throw forbidden('No podés asignar ese rol');
    const clientId = body.role === 'super_admin' ? null : targetClientId(req, body.clientId);
    const passwordHash = await hashPassword(body.password);
    const row = await req.db(async (db) => {
      const { rows } = await db.query(
        `INSERT INTO users (client_id, organization_id, email, name, role, password_hash)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, email, name, role, active, client_id AS "clientId", organization_id AS "organizationId"`,
        [clientId, body.organizationId ?? null, body.email, body.name, body.role, passwordHash],
      );
      await audit(db, req.actor, {
        action: 'create',
        entity: 'user',
        entityId: rows[0].id,
        clientId,
        data: { email: body.email, role: body.role },
      });
      return rows[0];
    });
    return reply.status(201).send(row);
  });

  app.patch('/users/:id', { preHandler: requirePermission('users:manage') }, async (req) => {
    const { id } = parse(Id, req.params);
    const body = parse(
      z.object({
        name: z.string().trim().min(2).max(120).optional(),
        role: z.enum(ROLES).optional(),
        active: z.boolean().optional(),
        password: passwordField.optional(),
      }),
      req.body,
    );
    if (body.role && !assignableRoles(req.actor.role).includes(body.role)) throw forbidden('No podés asignar ese rol');
    if (id === req.actor.id && (body.active === false || (body.role && body.role !== req.actor.role))) {
      throw badRequest('No podés desactivarte ni cambiar tu propio rol');
    }
    const passwordHash = body.password ? await hashPassword(body.password) : null;
    return req.db(async (db) => {
      const current = (await db.query<{ role: Role }>('SELECT role FROM users WHERE id = $1', [id])).rows[0];
      if (!current) throw notFound('Usuario');
      if (!assignableRoles(req.actor.role).includes(current.role)) throw forbidden('No podés modificar a este usuario');
      // Entre pares: un admin de cliente no puede tomar el control de otro admin (contraseña, rol, estado).
      if (req.actor.role !== 'super_admin' && current.role === req.actor.role && id !== req.actor.id) {
        throw forbidden('Solo un super admin puede modificar a otro administrador');
      }
      const { rows } = await db.query(
        `UPDATE users SET name = coalesce($2, name), role = coalesce($3, role), active = coalesce($4, active),
                password_hash = coalesce($5, password_hash)
          WHERE id = $1
          RETURNING id, email, name, role, active, client_id AS "clientId"`,
        [id, body.name ?? null, body.role ?? null, body.active ?? null, passwordHash],
      );
      if (body.active === false || passwordHash || (body.role && body.role !== current.role)) {
        await db.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [id]);
      }
      const { password: _omit, ...logged } = body;
      await audit(db, req.actor, {
        action: 'update',
        entity: 'user',
        entityId: id,
        clientId: rows[0].clientId,
        data: { ...logged, passwordChanged: Boolean(passwordHash) },
      });
      return rows[0];
    });
  });
}
