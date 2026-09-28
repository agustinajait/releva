import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticate, requirePermission, targetClientId } from '../http/auth.js';
import { badRequest, notFound, parse } from '../http/errors.js';
import { audit } from '../services/audit.js';
import type { Db } from '../db/pool.js';

const Id = z.object({ id: z.string().uuid() });

/** Restricción SQL: los relevadores solo ven proyectos a los que están asignados. */
export function projectAccessSql(alias: string, roleParam: string, userParam: string) {
  return `(${roleParam} <> 'surveyor' OR EXISTS (
            SELECT 1 FROM project_members pm WHERE pm.project_id = ${alias}.id AND pm.user_id = ${userParam}))`;
}

/** Verifica que el proyecto exista y sea visible para el usuario. */
export async function assertProjectAccess(db: Db, req: FastifyRequest, projectId: string) {
  const { rows } = await db.query<{ id: string; client_id: string; dedupe_radius_m: number }>(
    `SELECT p.id, p.client_id, p.dedupe_radius_m FROM projects p WHERE p.id = $1 AND ${projectAccessSql('p', '$2', '$3')}`,
    [projectId, req.actor.role, req.actor.id],
  );
  if (!rows[0]) throw notFound('Proyecto');
  return rows[0];
}

/** Recalcula la zona de todos los puntos del proyecto (al crear o borrar zonas). */
async function reassignZones(db: Db, projectId: string) {
  await db.query(
    `UPDATE points p SET zone_id = (
       SELECT z.id FROM zones z WHERE z.project_id = p.project_id AND ST_Covers(z.geom, p.location::geometry)
        ORDER BY ST_Area(z.geom) ASC LIMIT 1)
      WHERE p.project_id = $1`,
    [projectId],
  );
}

const PolygonGeo = z.object({
  type: z.enum(['Polygon', 'MultiPolygon']),
  coordinates: z.array(z.any()).min(1),
});
const LineGeo = z.object({ type: z.literal('LineString'), coordinates: z.array(z.tuple([z.number(), z.number()])).min(2) });

async function assertValidGeometry(db: Db, geojson: unknown) {
  const { rows } = await db.query<{ reason: string; points: number }>(
    `SELECT ST_IsValidReason(g) AS reason, ST_NPoints(g) AS points FROM (SELECT ST_SetSRID(ST_GeomFromGeoJSON($1), 4326) AS g) x`,
    [JSON.stringify(geojson)],
  );
  if ((rows[0]?.points ?? 0) > 50_000) throw badRequest('La geometría tiene demasiados vértices (máximo 50.000)');
  if (rows[0]?.reason !== 'Valid Geometry') throw badRequest(`Geometría inválida: ${rows[0]?.reason}`);
}

/** Proyectos, miembros, zonas y recorridos. */
export async function projectRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  // ── Proyectos ───────────────────────────────────────────────────────────
  const projectCols = `p.id, p.name, p.description, p.status, p.client_id AS "clientId", p.organization_id AS "organizationId",
    p.dedupe_radius_m AS "dedupeRadiusM", p.created_at AS "createdAt", c.name AS "clientName"`;

  app.get('/projects', { preHandler: requirePermission('projects:read') }, async (req) => {
    const q = parse(z.object({ clientId: z.string().uuid().optional(), status: z.enum(['active', 'archived']).optional() }), req.query);
    return req.db(
      async (db) =>
        (
          await db.query(
            `SELECT ${projectCols},
                    (SELECT count(*) FROM points pt WHERE pt.project_id = p.id)::int AS "pointCount",
                    (SELECT count(*) FROM zones z WHERE z.project_id = p.id)::int AS "zoneCount"
               FROM projects p JOIN clients c ON c.id = p.client_id
              WHERE ($1::uuid IS NULL OR p.client_id = $1) AND ($2::text IS NULL OR p.status = $2)
                AND ${projectAccessSql('p', '$3', '$4')}
              ORDER BY p.created_at DESC`,
            [q.clientId ?? null, q.status ?? null, req.actor.role, req.actor.id],
          )
        ).rows,
    );
  });

  app.get('/projects/:id', { preHandler: requirePermission('projects:read') }, async (req) => {
    const { id } = parse(Id, req.params);
    return req.db(async (db) => {
      await assertProjectAccess(db, req, id);
      const { rows } = await db.query(`SELECT ${projectCols} FROM projects p JOIN clients c ON c.id = p.client_id WHERE p.id = $1`, [id]);
      const members = await db.query(
        `SELECT u.id, u.name, u.email, u.role FROM project_members pm JOIN users u ON u.id = pm.user_id WHERE pm.project_id = $1 ORDER BY u.name`,
        [id],
      );
      return { ...rows[0], members: members.rows };
    });
  });

  const ProjectBody = z.object({
    name: z.string().trim().min(2).max(160),
    description: z.string().trim().max(2000).optional(),
    organizationId: z.string().uuid().optional(),
    dedupeRadiusM: z.number().int().min(1).max(500).optional(),
    clientId: z.string().uuid().optional(),
  });

  app.post('/projects', { preHandler: requirePermission('projects:manage') }, async (req, reply) => {
    const body = parse(ProjectBody, req.body);
    const clientId = targetClientId(req, body.clientId);
    const row = await req.db(async (db) => {
      const { rows } = await db.query(
        `INSERT INTO projects (client_id, organization_id, name, description, dedupe_radius_m, created_by)
         VALUES ($1, $2, $3, $4, coalesce($5, 25), $6)
         RETURNING id, name, description, status, client_id AS "clientId", dedupe_radius_m AS "dedupeRadiusM"`,
        [clientId, body.organizationId ?? null, body.name, body.description ?? null, body.dedupeRadiusM ?? null, req.actor.id],
      );
      await audit(db, req.actor, { action: 'create', entity: 'project', entityId: rows[0].id, clientId, data: { name: body.name } });
      return rows[0];
    });
    return reply.status(201).send(row);
  });

  app.patch('/projects/:id', { preHandler: requirePermission('projects:manage') }, async (req) => {
    const { id } = parse(Id, req.params);
    const body = parse(
      ProjectBody.omit({ clientId: true, organizationId: true }).partial().extend({ status: z.enum(['active', 'archived']).optional() }),
      req.body,
    );
    return req.db(async (db) => {
      const { rows } = await db.query(
        `UPDATE projects SET name = coalesce($2, name), description = coalesce($3, description),
                dedupe_radius_m = coalesce($4, dedupe_radius_m), status = coalesce($5, status)
          WHERE id = $1 RETURNING id, name, description, status, client_id AS "clientId", dedupe_radius_m AS "dedupeRadiusM"`,
        [id, body.name ?? null, body.description ?? null, body.dedupeRadiusM ?? null, body.status ?? null],
      );
      if (!rows[0]) throw notFound('Proyecto');
      await audit(db, req.actor, { action: 'update', entity: 'project', entityId: id, clientId: rows[0].clientId, data: body });
      return rows[0];
    });
  });

  app.put('/projects/:id/members', { preHandler: requirePermission('projects:manage') }, async (req) => {
    const { id } = parse(Id, req.params);
    const body = parse(z.object({ userIds: z.array(z.string().uuid()).max(500) }), req.body);
    return req.db(async (db) => {
      const p = await assertProjectAccess(db, req, id);
      await db.query('DELETE FROM project_members WHERE project_id = $1', [id]);
      if (body.userIds.length) {
        // La FK compuesta (client_id, user_id) impide asignar usuarios de otro cliente.
        await db.query(
          `INSERT INTO project_members (client_id, project_id, user_id) SELECT $1, $2, unnest($3::uuid[])`,
          [p.client_id, id, body.userIds],
        );
      }
      await audit(db, req.actor, { action: 'set_members', entity: 'project', entityId: id, clientId: p.client_id, data: body });
      return { projectId: id, userIds: body.userIds };
    });
  });

  // ── Zonas ───────────────────────────────────────────────────────────────
  app.get('/projects/:id/zones', { preHandler: requirePermission('projects:read') }, async (req) => {
    const { id } = parse(Id, req.params);
    return req.db(async (db) => {
      await assertProjectAccess(db, req, id);
      const { rows } = await db.query(
        `SELECT json_build_object(
                  'type', 'FeatureCollection',
                  'features', coalesce(json_agg(json_build_object(
                    'type', 'Feature', 'id', z.id,
                    'geometry', ST_AsGeoJSON(z.geom, 6)::json,
                    'properties', json_build_object('id', z.id, 'name', z.name, 'code', z.code, 'color', z.color,
                                                    'areaKm2', round((ST_Area(z.geom::geography) / 1e6)::numeric, 3))
                  ) ORDER BY z.name), '[]'::json)) AS fc
           FROM zones z WHERE z.project_id = $1`,
        [id],
      );
      return rows[0]!.fc;
    });
  });

  app.post('/projects/:id/zones', { preHandler: requirePermission('zones:manage') }, async (req, reply) => {
    const { id } = parse(Id, req.params);
    const body = parse(
      z.object({
        name: z.string().trim().min(1).max(160),
        code: z.string().trim().max(40).optional(),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
        geometry: PolygonGeo,
      }),
      req.body,
    );
    const row = await req.db(async (db) => {
      const p = await assertProjectAccess(db, req, id);
      await assertValidGeometry(db, body.geometry);
      const { rows } = await db.query(
        `INSERT INTO zones (client_id, project_id, name, code, color, geom)
         VALUES ($1, $2, $3, $4, $5, ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON($6), 4326)))
         RETURNING id, name, code, color`,
        [p.client_id, id, body.name, body.code ?? null, body.color ?? null, JSON.stringify(body.geometry)],
      );
      await reassignZones(db, id);
      await audit(db, req.actor, { action: 'create', entity: 'zone', entityId: rows[0].id, clientId: p.client_id, data: { name: body.name } });
      return rows[0];
    });
    return reply.status(201).send(row);
  });

  app.delete('/zones/:id', { preHandler: requirePermission('zones:manage') }, async (req, reply) => {
    const { id } = parse(Id, req.params);
    await req.db(async (db) => {
      const { rows } = await db.query<{ client_id: string; name: string; project_id: string }>(
        'DELETE FROM zones WHERE id = $1 RETURNING client_id, name, project_id',
        [id],
      );
      if (!rows[0]) throw notFound('Zona');
      await reassignZones(db, rows[0].project_id);
      await audit(db, req.actor, { action: 'delete', entity: 'zone', entityId: id, clientId: rows[0].client_id, data: { name: rows[0].name } });
    });
    return reply.status(204).send();
  });

  // ── Recorridos ──────────────────────────────────────────────────────────
  const routeCols = `r.id, r.name, r.status, r.project_id AS "projectId", r.zone_id AS "zoneId", z.name AS "zoneName",
    r.surveyor_id AS "surveyorId", u.name AS "surveyorName", r.started_at AS "startedAt", r.ended_at AS "endedAt",
    ST_AsGeoJSON(r.planned_path, 6)::json AS "plannedPath"`;
  const routeFrom = `FROM routes r LEFT JOIN zones z ON z.id = r.zone_id LEFT JOIN users u ON u.id = r.surveyor_id`;

  app.get('/projects/:id/routes', { preHandler: requirePermission('projects:read') }, async (req) => {
    const { id } = parse(Id, req.params);
    return req.db(async (db) => {
      await assertProjectAccess(db, req, id);
      const mine = req.actor.role === 'surveyor';
      const { rows } = await db.query(
        `SELECT ${routeCols} ${routeFrom}
          WHERE r.project_id = $1 AND (NOT $2 OR r.surveyor_id = $3 OR r.surveyor_id IS NULL)
          ORDER BY r.created_at DESC`,
        [id, mine, req.actor.id],
      );
      return rows;
    });
  });

  app.post('/projects/:id/routes', { preHandler: requirePermission('routes:manage') }, async (req, reply) => {
    const { id } = parse(Id, req.params);
    const body = parse(
      z.object({
        name: z.string().trim().min(1).max(160),
        zoneId: z.string().uuid().optional(),
        surveyorId: z.string().uuid().optional(),
        plannedPath: LineGeo.optional(),
      }),
      req.body,
    );
    const row = await req.db(async (db) => {
      const p = await assertProjectAccess(db, req, id);
      if (body.plannedPath) await assertValidGeometry(db, body.plannedPath);
      const { rows } = await db.query(
        `INSERT INTO routes (client_id, project_id, zone_id, name, surveyor_id, planned_path)
         VALUES ($1, $2, $3, $4, $5, CASE WHEN $6::text IS NULL THEN NULL ELSE ST_SetSRID(ST_GeomFromGeoJSON($6), 4326) END)
         RETURNING id`,
        [p.client_id, id, body.zoneId ?? null, body.name, body.surveyorId ?? null, body.plannedPath ? JSON.stringify(body.plannedPath) : null],
      );
      await audit(db, req.actor, { action: 'create', entity: 'route', entityId: rows[0].id, clientId: p.client_id, data: { name: body.name } });
      return (await db.query(`SELECT ${routeCols} ${routeFrom} WHERE r.id = $1`, [rows[0].id])).rows[0];
    });
    return reply.status(201).send(row);
  });

  /** El relevador inicia o finaliza su recorrido desde la app. */
  for (const action of ['start', 'finish'] as const) {
    app.post(`/routes/:id/${action}`, { preHandler: requirePermission('routes:operate') }, async (req) => {
      const { id } = parse(Id, req.params);
      return req.db(async (db) => {
        const { rows } = await db.query<{ client_id: string; project_id: string; status: string; surveyor_id: string | null }>(
          'SELECT client_id, project_id, status, surveyor_id FROM routes WHERE id = $1 FOR UPDATE',
          [id],
        );
        const r = rows[0];
        if (!r) throw notFound('Recorrido');
        // El relevador solo opera recorridos de proyectos a los que está asignado.
        await assertProjectAccess(db, req, r.project_id).catch(() => {
          throw notFound('Recorrido');
        });
        if (r.surveyor_id && r.surveyor_id !== req.actor.id) throw badRequest('El recorrido está asignado a otro relevador');
        if (action === 'start' && r.status === 'finished') throw badRequest('El recorrido ya finalizó');
        if (action === 'finish' && r.status !== 'in_progress') throw badRequest('El recorrido no está en curso');
        const sql =
          action === 'start'
            ? `UPDATE routes SET status = 'in_progress', started_at = coalesce(started_at, now()), surveyor_id = coalesce(surveyor_id, $2) WHERE id = $1`
            : `UPDATE routes SET status = 'finished', ended_at = now() WHERE id = $1`;
        await db.query(sql, action === 'start' ? [id, req.actor.id] : [id]);
        await audit(db, req.actor, { action, entity: 'route', entityId: id, clientId: r.client_id });
        return (await db.query(`SELECT ${routeCols} ${routeFrom} WHERE r.id = $1`, [id])).rows[0];
      });
    });
  }
}
