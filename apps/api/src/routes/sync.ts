import type { FastifyInstance } from 'fastify';
import {
  coerceValue,
  parseQuestionnaire,
  SyncRequestSchema,
  type SurveySyncItem,
  type SyncItemResult,
  type QuestionnaireDefinition,
} from '@releva/core';
import { authenticate, requirePermission } from '../http/auth.js';
import { parse } from '../http/errors.js';
import { audit } from '../services/audit.js';
import type { Actor, Db } from '../db/pool.js';

class ItemRejected extends Error {}

/**
 * Recepción de relevamientos desde la app.
 *
 * - Idempotente por clientUuid (generado en el celular): reenviar no duplica.
 * - Cada ítem se procesa en su propio SAVEPOINT: uno inválido no bloquea al resto.
 * - Los datos se validan con el mismo motor que usó la app. Lo que no valida se
 *   rechaza con un motivo claro y queda en el celular para revisión: no se pierde.
 * - Deduplicación de puntos por cercanía (PostGIS), dentro del mismo proyecto.
 */
export async function syncRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  app.post(
    '/sync/surveys',
    { preHandler: requirePermission('surveys:create'), bodyLimit: 5 * 1024 * 1024 },
    async (req) => {
      const body = parse(SyncRequestSchema, req.body);
      const results = await req.db(async (db) => {
        const out: SyncItemResult[] = [];
        const definitions = new Map<string, QuestionnaireDefinition>();
        for (const item of body.items) {
          await db.query('SAVEPOINT item');
          try {
            out.push(await ingest(db, req.actor, item, definitions));
            await db.query('RELEASE SAVEPOINT item');
          } catch (err) {
            await db.query('ROLLBACK TO SAVEPOINT item');
            if (err instanceof ItemRejected) {
              out.push({ clientUuid: item.clientUuid, status: 'rejected', error: err.message });
            } else {
              req.log.error({ err, clientUuid: item.clientUuid }, 'Error sincronizando relevamiento');
              out.push({ clientUuid: item.clientUuid, status: 'rejected', error: 'Error del servidor al guardar; se reintentará' });
            }
          }
        }
        return out;
      });
      return { results };
    },
  );
}

async function ingest(
  db: Db,
  actor: Extract<Actor, { kind: 'user' }>,
  item: SurveySyncItem,
  definitions: Map<string, QuestionnaireDefinition>,
): Promise<SyncItemResult> {
  // 1. Idempotencia.
  const dup = await db.query<{ id: string; point_id: string }>('SELECT id, point_id FROM surveys WHERE client_uuid = $1', [item.clientUuid]);
  if (dup.rows[0]) return { clientUuid: item.clientUuid, status: 'duplicate', surveyId: dup.rows[0].id, pointId: dup.rows[0].point_id };

  // 2. Proyecto visible y relevador asignado.
  const proj = await db.query<{ client_id: string; dedupe_radius_m: number; status: string }>(
    `SELECT p.client_id, p.dedupe_radius_m, p.status FROM projects p
      WHERE p.id = $1 AND ($2 <> 'surveyor' OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id = $3))`,
    [item.projectId, actor.role, actor.id],
  );
  const project = proj.rows[0];
  if (!project) throw new ItemRejected('Proyecto inexistente o no asignado a este usuario');
  if (project.status !== 'active') throw new ItemRejected('El proyecto está archivado');

  // 3. Recorrido (opcional) del mismo proyecto.
  if (item.routeId) {
    const r = await db.query('SELECT 1 FROM routes WHERE id = $1 AND project_id = $2', [item.routeId, item.projectId]);
    if (!r.rowCount) throw new ItemRejected('Recorrido inexistente en este proyecto');
  }

  // 4. Versión de cuestionario del proyecto, publicada (o retirada: el celular pudo haber relevado offline con la anterior).
  let def = definitions.get(item.questionnaireVersionId);
  if (!def) {
    const v = await db.query<{ definition: unknown; status: string }>(
      `SELECT v.definition, v.status FROM questionnaire_versions v JOIN questionnaires q ON q.id = v.questionnaire_id
        WHERE v.id = $1 AND q.project_id = $2`,
      [item.questionnaireVersionId, item.projectId],
    );
    const row = v.rows[0];
    if (!row) throw new ItemRejected('Versión de cuestionario inexistente en este proyecto');
    if (row.status === 'draft') throw new ItemRejected('La versión de cuestionario no está publicada');
    const parsed = parseQuestionnaire(row.definition);
    if (!parsed.ok) throw new ItemRejected('La versión de cuestionario es inválida');
    def = parsed.definition;
    definitions.set(item.questionnaireVersionId, def);
  }

  // 5. Los datos deben corresponder al cuestionario. Nada inventado ni fuera de rango.
  const fields = new Map(def.fields.map((f) => [f.key, f]));
  const seen = new Set<string>();
  for (const fact of item.facts) {
    const field = fields.get(fact.fieldKey);
    if (!field) throw new ItemRejected(`Campo inexistente en el cuestionario: ${fact.fieldKey}`);
    if (seen.has(fact.fieldKey)) throw new ItemRejected(`Campo repetido: ${fact.fieldKey}`);
    seen.add(fact.fieldKey);
    if (fact.status === 'unknown') {
      if (fact.value !== null) throw new ItemRejected(`El dato desconocido ${fact.fieldKey} no puede tener valor`);
      continue;
    }
    const c = coerceValue(field, fact.value);
    if (!c.ok) throw new ItemRejected(`Valor inválido en ${fact.fieldKey}: ${c.reason}`);
    fact.value = c.value;
  }

  // 6. ¿Corresponde a un punto existente? El más cercano dentro del radio del proyecto.
  const loc = [item.location.lng, item.location.lat] as const;
  // Serializa la deduplicación por proyecto: dos envíos simultáneos del mismo lugar no crean dos puntos.
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [item.projectId]);
  const near = await db.query<{ id: string }>(
    `SELECT id FROM points
      WHERE project_id = $1 AND ST_DWithin(location, ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography, $4)
      ORDER BY location <-> ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography
      LIMIT 1 FOR UPDATE`,
    [item.projectId, loc[0], loc[1], project.dedupe_radius_m],
  );
  let pointId: string;
  const matchedExistingPoint = Boolean(near.rows[0]);
  if (near.rows[0]) {
    pointId = near.rows[0].id;
    await db.query(
      `UPDATE points SET survey_count = survey_count + 1,
              first_seen_at = least(first_seen_at, $2), last_seen_at = greatest(last_seen_at, $2)
        WHERE id = $1`,
      [pointId, item.location.capturedAt],
    );
  } else {
    const p = await db.query<{ id: string }>(
      `INSERT INTO points (client_id, project_id, location, accuracy_m, first_seen_at, last_seen_at, survey_count)
       VALUES ($1, $2, ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography, $5, $6, $6, 1) RETURNING id`,
      [project.client_id, item.projectId, loc[0], loc[1], item.location.accuracy, item.location.capturedAt],
    );
    pointId = p.rows[0]!.id;
  }

  // 7. Relevamiento, datos y transcripción.
  const s = await db.query<{ id: string }>(
    `INSERT INTO surveys (client_id, project_id, point_id, route_id, questionnaire_version_id, surveyor_id, client_uuid, status,
                          location, accuracy_m, altitude_m, captured_at, started_at, completed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, ST_SetSRID(ST_MakePoint($9, $10), 4326)::geography, $11, $12, $13, $14, $15)
     RETURNING id`,
    [
      project.client_id,
      item.projectId,
      pointId,
      item.routeId ?? null,
      item.questionnaireVersionId,
      actor.role === 'super_admin' ? null : actor.id,
      item.clientUuid,
      item.status,
      loc[0],
      loc[1],
      item.location.accuracy,
      item.location.altitude ?? null,
      item.location.capturedAt,
      item.startedAt,
      item.completedAt ?? null,
    ],
  );
  const surveyId = s.rows[0]!.id;

  if (item.facts.length) {
    await db.query(
      `INSERT INTO survey_facts (client_id, survey_id, field_key, value, status, source, question_key, raw_answer, recorded_at)
       SELECT $1, $2, f.field_key, f.value, f.status, f.source, f.question_key, f.raw_answer, f.recorded_at
         FROM jsonb_to_recordset($3::jsonb) AS f(field_key text, value jsonb, status text, source text,
                                                 question_key text, raw_answer text, recorded_at timestamptz)`,
      [
        project.client_id,
        surveyId,
        JSON.stringify(
          item.facts.map((f) => ({
            field_key: f.fieldKey,
            value: f.status === 'unknown' ? null : f.value,
            status: f.status,
            source: f.source,
            question_key: f.questionKey ?? null,
            raw_answer: f.rawAnswer ?? null,
            recorded_at: f.recordedAt,
          })),
        ),
      ],
    );
  }
  if (item.utterances.length) {
    await db.query(
      `INSERT INTO survey_utterances (client_id, survey_id, seq, speaker, text, at)
       SELECT $1, $2, u.seq, u.speaker, u.text, u.at
         FROM ROWS FROM (jsonb_to_recordset($3::jsonb) AS (speaker text, text text, at timestamptz))
              WITH ORDINALITY AS u(speaker, text, at, seq)`,
      [project.client_id, surveyId, JSON.stringify(item.utterances)],
    );
  }

  await audit(db, actor, {
    action: 'sync',
    entity: 'survey',
    entityId: surveyId,
    clientId: project.client_id,
    data: { clientUuid: item.clientUuid, pointId, matchedExistingPoint, facts: item.facts.length },
  });

  return { clientUuid: item.clientUuid, status: 'accepted', surveyId, pointId, matchedExistingPoint };
}
