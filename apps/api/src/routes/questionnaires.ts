import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseQuestionnaire } from '@releva/core';
import { authenticate, requirePermission } from '../http/auth.js';
import { badRequest, notFound, parse } from '../http/errors.js';
import { audit } from '../services/audit.js';
import { assertProjectAccess } from './projects.js';

const Id = z.object({ id: z.string().uuid() });

/**
 * Cuestionarios versionados.
 * - Un borrador se puede editar libremente (se guarda aunque tenga errores, para no perder trabajo).
 * - Publicar valida con el mismo motor que usa la app. Lo publicado es inmutable.
 * - Cada relevamiento queda asociado a la versión exacta con la que se hizo.
 */
export async function questionnaireRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  const versionCols = `v.id, v.version, v.status, v.questionnaire_id AS "questionnaireId", v.published_at AS "publishedAt", v.created_at AS "createdAt"`;

  app.get('/projects/:id/questionnaires', { preHandler: requirePermission('questionnaires:read') }, async (req) => {
    const { id } = parse(Id, req.params);
    return req.db(async (db) => {
      await assertProjectAccess(db, req, id);
      const { rows } = await db.query(
        `SELECT q.id, q.name, q.created_at AS "createdAt",
                coalesce(json_agg(json_build_object('id', v.id, 'version', v.version, 'status', v.status, 'publishedAt', v.published_at)
                         ORDER BY v.version DESC) FILTER (WHERE v.id IS NOT NULL), '[]') AS versions
           FROM questionnaires q LEFT JOIN questionnaire_versions v ON v.questionnaire_id = q.id
          WHERE q.project_id = $1 GROUP BY q.id ORDER BY q.created_at`,
        [id],
      );
      return rows;
    });
  });

  app.post('/projects/:id/questionnaires', { preHandler: requirePermission('questionnaires:manage') }, async (req, reply) => {
    const { id } = parse(Id, req.params);
    const body = parse(z.object({ name: z.string().trim().min(2).max(160), definition: z.unknown().optional() }), req.body);
    if (JSON.stringify(body.definition ?? {}).length > 512_000) throw badRequest('El cuestionario es demasiado grande');
    const row = await req.db(async (db) => {
      const p = await assertProjectAccess(db, req, id);
      const q = await db.query<{ id: string }>(
        'INSERT INTO questionnaires (client_id, project_id, name) VALUES ($1, $2, $3) RETURNING id',
        [p.client_id, id, body.name],
      );
      const definition = body.definition ?? { schemaVersion: 1, title: body.name, openingQuestion: '', fields: [], questions: [] };
      const v = await db.query(
        `INSERT INTO questionnaire_versions (client_id, questionnaire_id, version, definition) VALUES ($1, $2, 1, $3)
         RETURNING id, version, status`,
        [p.client_id, q.rows[0]!.id, JSON.stringify(definition)],
      );
      await audit(db, req.actor, { action: 'create', entity: 'questionnaire', entityId: q.rows[0]!.id, clientId: p.client_id, data: { name: body.name } });
      return { id: q.rows[0]!.id, name: body.name, versions: v.rows };
    });
    return reply.status(201).send(row);
  });

  app.get('/questionnaire-versions/:id', { preHandler: requirePermission('questionnaires:read') }, async (req) => {
    const { id } = parse(Id, req.params);
    return req.db(async (db) => {
      const { rows } = await db.query(
        `SELECT ${versionCols}, v.definition, q.project_id AS "projectId", q.name
           FROM questionnaire_versions v JOIN questionnaires q ON q.id = v.questionnaire_id WHERE v.id = $1`,
        [id],
      );
      if (!rows[0]) throw notFound('Versión de cuestionario');
      await assertProjectAccess(db, req, rows[0].projectId);
      const validation = parseQuestionnaire(rows[0].definition);
      return { ...rows[0], issues: validation.ok ? [] : validation.issues };
    });
  });

  /** Nueva versión (borrador) a partir de la última. */
  app.post('/questionnaires/:id/versions', { preHandler: requirePermission('questionnaires:manage') }, async (req, reply) => {
    const { id } = parse(Id, req.params);
    const row = await req.db(async (db) => {
      const { rows } = await db.query<{ client_id: string; version: number; definition: unknown; drafts: number }>(
        `SELECT q.client_id, v.version, v.definition,
                (SELECT count(*) FROM questionnaire_versions d WHERE d.questionnaire_id = q.id AND d.status = 'draft')::int AS drafts
           FROM questionnaires q JOIN questionnaire_versions v ON v.questionnaire_id = q.id
          WHERE q.id = $1 ORDER BY v.version DESC LIMIT 1 FOR UPDATE OF q`,
        [id],
      );
      const last = rows[0];
      if (!last) throw notFound('Cuestionario');
      if (last.drafts > 0) throw badRequest('Ya hay un borrador abierto para este cuestionario');
      const v = await db.query(
        `INSERT INTO questionnaire_versions (client_id, questionnaire_id, version, definition)
         VALUES ($1, $2, $3, $4) RETURNING id, version, status`,
        [last.client_id, id, last.version + 1, JSON.stringify(last.definition)],
      );
      await audit(db, req.actor, { action: 'new_version', entity: 'questionnaire', entityId: id, clientId: last.client_id, data: { version: last.version + 1 } });
      return v.rows[0];
    });
    return reply.status(201).send(row);
  });

  app.put('/questionnaire-versions/:id', { preHandler: requirePermission('questionnaires:manage') }, async (req) => {
    const { id } = parse(Id, req.params);
    const body = parse(z.object({ definition: z.record(z.string(), z.unknown()) }), req.body);
    if (JSON.stringify(body.definition).length > 512_000) throw badRequest('El cuestionario es demasiado grande');
    return req.db(async (db) => {
      const { rows } = await db.query<{ status: string; client_id: string }>(
        'SELECT status, client_id FROM questionnaire_versions WHERE id = $1 FOR UPDATE',
        [id],
      );
      if (!rows[0]) throw notFound('Versión de cuestionario');
      if (rows[0].status !== 'draft') throw badRequest('Solo se pueden editar borradores. Creá una versión nueva.');
      await db.query('UPDATE questionnaire_versions SET definition = $2 WHERE id = $1', [id, JSON.stringify(body.definition)]);
      await audit(db, req.actor, { action: 'update', entity: 'questionnaire_version', entityId: id, clientId: rows[0].client_id });
      const validation = parseQuestionnaire(body.definition);
      return { id, status: 'draft', issues: validation.ok ? [] : validation.issues };
    });
  });

  app.post('/questionnaire-versions/:id/publish', { preHandler: requirePermission('questionnaires:manage') }, async (req) => {
    const { id } = parse(Id, req.params);
    return req.db(async (db) => {
      const { rows } = await db.query<{ status: string; client_id: string; questionnaire_id: string; definition: unknown }>(
        'SELECT status, client_id, questionnaire_id, definition FROM questionnaire_versions WHERE id = $1 FOR UPDATE',
        [id],
      );
      const v = rows[0];
      if (!v) throw notFound('Versión de cuestionario');
      if (v.status !== 'draft') throw badRequest('Esta versión ya fue publicada');
      const validation = parseQuestionnaire(v.definition);
      if (!validation.ok) throw badRequest('El cuestionario tiene errores y no puede publicarse', validation.issues);
      // Se guarda la definición normalizada (con valores por defecto explícitos): lo que valida es lo que se usa.
      await db.query(`UPDATE questionnaire_versions SET status = 'retired' WHERE questionnaire_id = $1 AND status = 'published'`, [v.questionnaire_id]);
      await db.query(
        `UPDATE questionnaire_versions SET definition = $2, status = 'published', published_at = now(), published_by = $3 WHERE id = $1`,
        [id, JSON.stringify(validation.definition), req.actor.id],
      );
      await audit(db, req.actor, { action: 'publish', entity: 'questionnaire_version', entityId: id, clientId: v.client_id });
      return { id, status: 'published' };
    });
  });

  /** Lo que descarga la app: la versión publicada vigente de cada cuestionario del proyecto. */
  app.get('/projects/:id/questionnaires/active', { preHandler: requirePermission('questionnaires:read') }, async (req) => {
    const { id } = parse(Id, req.params);
    return req.db(async (db) => {
      await assertProjectAccess(db, req, id);
      const { rows } = await db.query(
        `SELECT ${versionCols}, v.definition, q.name
           FROM questionnaire_versions v JOIN questionnaires q ON q.id = v.questionnaire_id
          WHERE q.project_id = $1 AND v.status = 'published' ORDER BY q.created_at`,
        [id],
      );
      return rows;
    });
  });
}
