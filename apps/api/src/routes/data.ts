import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseQuestionnaire, type Field } from '@releva/core';
import { authenticate, requirePermission } from '../http/auth.js';
import { notFound, parse } from '../http/errors.js';
import { assertProjectAccess } from './projects.js';

const Id = z.object({ id: z.string().uuid() });
const Filters = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  zoneId: z.string().uuid().optional(),
  routeId: z.string().uuid().optional(),
});

/** Puntos, ficha de punto, indicadores y auditoría: lo que consumen los paneles. */
export async function dataRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  /** Puntos del proyecto como GeoJSON, con el resumen del último relevamiento. */
  app.get('/projects/:id/points', { preHandler: requirePermission('points:read') }, async (req) => {
    const { id } = parse(Id, req.params);
    const f = parse(Filters, req.query);
    return req.db(async (db) => {
      await assertProjectAccess(db, req, id);
      const { rows } = await db.query(
        `WITH filtered AS (
           SELECT s.* FROM surveys s
            WHERE s.project_id = $1 AND s.status <> 'discarded'
              AND ($2::timestamptz IS NULL OR s.captured_at >= $2)
              AND ($3::timestamptz IS NULL OR s.captured_at < $3)
              AND ($5::uuid IS NULL OR s.route_id = $5)
         ), latest AS (
           SELECT DISTINCT ON (point_id) point_id, id, captured_at FROM filtered ORDER BY point_id, captured_at DESC
         )
         SELECT json_build_object('type', 'FeatureCollection', 'features', coalesce(json_agg(json_build_object(
                  'type', 'Feature', 'id', p.id,
                  'geometry', ST_AsGeoJSON(p.location, 6)::json,
                  'properties', json_build_object(
                    'id', p.id, 'zoneId', p.zone_id, 'zoneName', z.name,
                    'surveyCount', (SELECT count(*) FROM filtered fs WHERE fs.point_id = p.id),
                    'lastSurveyAt', l.captured_at,
                    'facts', (SELECT coalesce(json_object_agg(sf.field_key, sf.value), '{}'::json)
                                FROM survey_facts sf WHERE sf.survey_id = l.id AND sf.status <> 'unknown')
                  )) ORDER BY l.captured_at), '[]'::json)) AS fc
           FROM latest l JOIN points p ON p.id = l.point_id LEFT JOIN zones z ON z.id = p.zone_id
          WHERE ($4::uuid IS NULL OR p.zone_id = $4)`,
        [id, f.from ?? null, f.to ?? null, f.zoneId ?? null, f.routeId ?? null],
      );
      return rows[0]!.fc;
    });
  });

  /** Ficha de punto: ubicación, zona e historial de relevamientos con sus datos. */
  app.get('/points/:id', { preHandler: requirePermission('points:read') }, async (req) => {
    const { id } = parse(Id, req.params);
    const q = parse(z.object({ transcript: z.enum(['true', 'false']).optional() }), req.query);
    return req.db(async (db) => {
      const { rows } = await db.query(
        `SELECT p.id, p.project_id AS "projectId", ST_Y(p.location::geometry) AS lat, ST_X(p.location::geometry) AS lng,
                p.accuracy_m AS "accuracyM", p.first_seen_at AS "firstSeenAt", p.last_seen_at AS "lastSeenAt",
                p.zone_id AS "zoneId", z.name AS "zoneName"
           FROM points p LEFT JOIN zones z ON z.id = p.zone_id WHERE p.id = $1`,
        [id],
      );
      const point = rows[0];
      if (!point) throw notFound('Punto');
      await assertProjectAccess(db, req, point.projectId);
      const surveys = await db.query(
        `SELECT s.id, s.status, s.captured_at AS "capturedAt", s.started_at AS "startedAt", s.completed_at AS "completedAt",
                s.accuracy_m AS "accuracyM", s.questionnaire_version_id AS "questionnaireVersionId",
                r.name AS "routeName", u.name AS "surveyorName",
                coalesce((SELECT json_agg(json_build_object('fieldKey', f.field_key, 'value', f.value, 'status', f.status,
                          'source', f.source, 'questionKey', f.question_key, 'rawAnswer', f.raw_answer, 'recordedAt', f.recorded_at)
                          ORDER BY f.id) FROM survey_facts f WHERE f.survey_id = s.id), '[]') AS facts,
                CASE WHEN $2 THEN coalesce((SELECT json_agg(json_build_object('speaker', t.speaker, 'text', t.text, 'at', t.at)
                          ORDER BY t.seq) FROM survey_utterances t WHERE t.survey_id = s.id), '[]') END AS transcript
           FROM surveys s LEFT JOIN routes r ON r.id = s.route_id LEFT JOIN users u ON u.id = s.surveyor_id
          WHERE s.point_id = $1 ORDER BY s.captured_at DESC`,
        [id, q.transcript === 'true'],
      );
      // Etiquetas de campos según la versión de cuestionario de cada relevamiento.
      const versionIds = [...new Set(surveys.rows.map((s) => s.questionnaireVersionId as string))];
      const defs = await db.query<{ id: string; definition: unknown }>(
        'SELECT id, definition FROM questionnaire_versions WHERE id = ANY($1::uuid[])',
        [versionIds],
      );
      const labels: Record<string, Record<string, { label: string; category?: string; options?: Record<string, string> }>> = {};
      for (const d of defs.rows) {
        const parsed = parseQuestionnaire(d.definition);
        if (!parsed.ok) continue;
        labels[d.id] = Object.fromEntries(
          parsed.definition.fields.map((fl) => [
            fl.key,
            { label: fl.label, category: fl.category, options: fl.options && Object.fromEntries(fl.options.map((o) => [o.value, o.label])) },
          ]),
        );
      }
      return { ...point, surveys: surveys.rows, fieldLabels: labels };
    });
  });

  /**
   * Indicadores generados a partir del cuestionario (campos con `indicator`),
   * no programados a mano. Agregan sobre los relevamientos completos del período.
   */
  app.get('/projects/:id/indicators', { preHandler: requirePermission('indicators:read') }, async (req) => {
    const { id } = parse(Id, req.params);
    const f = parse(Filters, req.query);
    return req.db(async (db) => {
      await assertProjectAccess(db, req, id);
      const params = [id, f.from ?? null, f.to ?? null, f.zoneId ?? null];
      /** FROM + WHERE comunes a todos los indicadores; `join` agrega tablas antes del WHERE. */
      const scope = (join = '') => `FROM surveys s JOIN points p ON p.id = s.point_id ${join}
        WHERE s.project_id = $1 AND s.status = 'completed'
          AND ($2::timestamptz IS NULL OR s.captured_at >= $2) AND ($3::timestamptz IS NULL OR s.captured_at < $3)
          AND ($4::uuid IS NULL OR p.zone_id = $4)`;
      const factJoin = `JOIN survey_facts f ON f.survey_id = s.id AND f.field_key = $5 AND f.status <> 'unknown'`;

      const totals = (
        await db.query(`SELECT count(DISTINCT s.point_id)::int AS points, count(*)::int AS surveys ${scope()}`, params)
      ).rows[0];
      const byZone = (
        await db.query(
          `SELECT p.zone_id AS "zoneId", coalesce(z.name, 'Sin zona') AS "zoneName", count(DISTINCT s.point_id)::int AS points
             ${scope('LEFT JOIN zones z ON z.id = p.zone_id')}
            GROUP BY p.zone_id, z.name ORDER BY points DESC`,
          params,
        )
      ).rows;
      const byDay = (
        await db.query(
          `SELECT to_char(s.captured_at AT TIME ZONE 'America/Argentina/Buenos_Aires', 'YYYY-MM-DD') AS day, count(*)::int AS surveys
             ${scope()} GROUP BY 1 ORDER BY 1`,
          params,
        )
      ).rows;

      // Campos-indicador de todas las versiones publicadas (o retiradas) del proyecto.
      const versions = await db.query<{ definition: unknown }>(
        `SELECT v.definition FROM questionnaire_versions v JOIN questionnaires q ON q.id = v.questionnaire_id
          WHERE q.project_id = $1 AND v.status <> 'draft' ORDER BY v.version`,
        [id],
      );
      const indicatorFields = new Map<string, Field>();
      for (const v of versions.rows) {
        const parsed = parseQuestionnaire(v.definition);
        if (parsed.ok) for (const fl of parsed.definition.fields) if (fl.indicator) indicatorFields.set(fl.key, fl);
      }

      const indicators = [];
      for (const field of indicatorFields.values()) {
        const agg = field.indicator!.aggregate;
        const base = { key: field.key, label: field.indicator!.label ?? field.label, aggregate: agg };
        if (agg === 'sum' || agg === 'average') {
          const fn = agg === 'sum' ? 'sum' : 'avg';
          const r = await db.query(
            `SELECT ${fn}((f.value #>> '{}')::numeric) AS value, count(f.id)::int AS n
               ${scope(factJoin)}`,
            [...params, field.key],
          );
          indicators.push({ ...base, value: r.rows[0].value === null ? 0 : Math.round(Number(r.rows[0].value) * 100) / 100, n: r.rows[0].n });
        } else if (agg === 'count_true') {
          const r = await db.query(
            `SELECT count(*) FILTER (WHERE f.value = 'true'::jsonb)::int AS value, count(f.id)::int AS n
               ${scope(factJoin)}`,
            [...params, field.key],
          );
          indicators.push({ ...base, value: r.rows[0].value, n: r.rows[0].n });
        } else {
          const r = await db.query<{ option: string; count: number }>(
            `SELECT o.option, count(*)::int AS count
               ${scope(`${factJoin}
                  CROSS JOIN LATERAL (SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(f.value) = 'array' THEN f.value ELSE jsonb_build_array(f.value) END) AS option) o`)}
              GROUP BY o.option ORDER BY count DESC`,
            [...params, field.key],
          );
          const labels = new Map((field.options ?? []).map((o) => [o.value, o.label]));
          indicators.push({ ...base, distribution: r.rows.map((x) => ({ option: x.option, label: labels.get(x.option) ?? x.option, count: x.count })) });
        }
      }

      return { totals, byZone, byDay, indicators };
    });
  });

  app.get('/audit', { preHandler: requirePermission('audit:read') }, async (req) => {
    const q = parse(
      z.object({
        entity: z.string().max(40).optional(),
        entityId: z.string().max(80).optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
        before: z.coerce.number().int().positive().optional(),
      }),
      req.query,
    );
    return req.db(
      async (db) =>
        (
          await db.query(
            `SELECT a.id, a.at, a.action, a.entity, a.entity_id AS "entityId", a.actor_role AS "actorRole",
                    u.name AS "actorName", u.email AS "actorEmail", c.name AS "clientName", a.data
               FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id LEFT JOIN clients c ON c.id = a.client_id
              WHERE ($1::text IS NULL OR a.entity = $1) AND ($2::text IS NULL OR a.entity_id = $2)
                AND ($4::bigint IS NULL OR a.id < $4)
              ORDER BY a.id DESC LIMIT $3`,
            [q.entity ?? null, q.entityId ?? null, q.limit, q.before ?? null],
          )
        ).rows,
    );
  });
}
