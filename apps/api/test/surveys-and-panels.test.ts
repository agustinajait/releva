import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SAMPLE_QUESTIONNAIRE, type SurveySyncItem } from '@releva/core';
import { setupTestEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
let surveyorA: string;
let analystA: string;
let adminA: string;

beforeAll(async () => {
  env = await setupTestEnv();
  surveyorA = await env.login('surveyor-a@t.local');
  analystA = await env.login('analyst-a@t.local');
  adminA = await env.login('admin-a@t.local');
});
afterAll(async () => env?.close());

const NOW = '2026-09-28T23:10:00.000-03:00';

function survey(over: Partial<SurveySyncItem> = {}, facts?: SurveySyncItem['facts']): SurveySyncItem {
  return {
    clientUuid: randomUUID(),
    projectId: env.ids.projectA!,
    routeId: env.ids.routeA!,
    questionnaireVersionId: env.ids.versionA!,
    location: { lat: -34.6037, lng: -58.3816, accuracy: 7, altitude: 25, capturedAt: NOW },
    status: 'completed',
    startedAt: NOW,
    completedAt: NOW,
    facts: facts ?? [
      { fieldKey: 'personas', value: 1, status: 'confirmed', source: 'voice', questionKey: 'que_ves', rawAnswer: 'Hay una persona sola', recordedAt: NOW },
      { fieldKey: 'menores', value: false, status: 'confirmed', source: 'voice', recordedAt: NOW },
      { fieldKey: 'pertenencias', value: true, status: 'confirmed', source: 'voice', recordedAt: NOW },
      { fieldKey: 'pertenencias_tipo', value: ['mochila'], status: 'confirmed', source: 'voice', recordedAt: NOW },
      { fieldKey: 'animales', value: true, status: 'confirmed', source: 'voice', recordedAt: NOW },
      { fieldKey: 'animales_tipo', value: ['perro'], status: 'mentioned', source: 'voice', recordedAt: NOW },
    ],
    utterances: [
      { speaker: 'releva', text: '¿Qué estás viendo?', at: NOW },
      { speaker: 'surveyor', text: 'Hay una persona sola', at: NOW },
    ],
    ...over,
  };
}

const sync = (token: string, items: SurveySyncItem[]) => env.api(token, 'POST', '/sync/surveys', { items });

describe('sincronización desde la app', () => {
  let first: SurveySyncItem;
  let firstPointId: string;

  it('acepta un relevamiento, crea el punto y le asigna la zona', async () => {
    first = survey();
    const r = await sync(surveyorA, [first]);
    expect(r.status).toBe(200);
    expect(r.body.results[0]).toMatchObject({ status: 'accepted', matchedExistingPoint: false });
    firstPointId = r.body.results[0].pointId;
    const p = await env.api(analystA, 'GET', `/points/${firstPointId}?transcript=true`);
    expect(p.body).toMatchObject({ zoneId: env.ids.zoneA, zoneName: 'Centro' });
    expect(p.body.lat).toBeCloseTo(-34.6037, 5);
    expect(p.body.surveys[0].facts).toHaveLength(6);
    expect(p.body.surveys[0].transcript).toHaveLength(2);
    expect(p.body.fieldLabels[env.ids.versionA!].personas.label).toBe('Personas');
  });

  it('es idempotente: reenviar el mismo relevamiento no lo duplica', async () => {
    const r = await sync(surveyorA, [first]);
    expect(r.body.results[0]).toMatchObject({ status: 'duplicate', pointId: firstPointId });
    const p = await env.api(analystA, 'GET', `/points/${firstPointId}`);
    expect(p.body.surveys).toHaveLength(1);
  });

  it('una captura cercana (<25 m) se asocia al punto existente y conserva el historial', async () => {
    const r = await sync(surveyorA, [survey({ location: { lat: -34.60372, lng: -58.38162, accuracy: 9, capturedAt: '2026-09-29T23:00:00.000-03:00' } })]);
    expect(r.body.results[0]).toMatchObject({ status: 'accepted', matchedExistingPoint: true, pointId: firstPointId });
    const p = await env.api(analystA, 'GET', `/points/${firstPointId}`);
    expect(p.body.surveys).toHaveLength(2);
    expect(p.body.lastSeenAt).toBe('2026-09-30T02:00:00.000Z');
  });

  it('una captura lejana crea un punto nuevo (fuera de toda zona: sin zona)', async () => {
    const r = await sync(surveyorA, [survey({ location: { lat: -34.58, lng: -58.43, accuracy: 5, capturedAt: NOW } })]);
    expect(r.body.results[0]).toMatchObject({ status: 'accepted', matchedExistingPoint: false });
    const p = await env.api(analystA, 'GET', `/points/${r.body.results[0].pointId}`);
    expect(p.body.zoneId).toBeNull();
  });

  it('rechaza datos que no corresponden al cuestionario, sin afectar al resto del lote', async () => {
    const bad1 = survey({}, [{ fieldKey: 'nombre_persona', value: 'Juan', status: 'mentioned', source: 'voice', recordedAt: NOW }]);
    const bad2 = survey({}, [{ fieldKey: 'personas', value: 999, status: 'mentioned', source: 'voice', recordedAt: NOW }]);
    const bad3 = survey({}, [{ fieldKey: 'menores', value: true, status: 'unknown', source: 'voice', recordedAt: NOW }]);
    const good = survey({ location: { lat: -34.605, lng: -58.375, accuracy: 5, capturedAt: NOW } });
    const r = await sync(surveyorA, [bad1, bad2, good, bad3]);
    expect(r.body.results.map((x: any) => x.status)).toEqual(['rejected', 'rejected', 'accepted', 'rejected']);
    expect(r.body.results[0].error).toBe('Campo inexistente en el cuestionario: nombre_persona');
    expect(r.body.results[1].error).toBe('Valor inválido en personas: mayor que 50');
    expect(r.body.results[3].error).toBe('El dato desconocido menores no puede tener valor');
  });

  it('guarda lo desconocido como desconocido (sin valor)', async () => {
    const item = survey({ location: { lat: -34.6071, lng: -58.3791, accuracy: 5, capturedAt: NOW } }, [
      { fieldKey: 'personas', value: 2, status: 'extracted', source: 'voice', recordedAt: NOW },
      { fieldKey: 'menores', value: null, status: 'unknown', source: 'voice', rawAnswer: 'no se ve bien', recordedAt: NOW },
    ]);
    const r = await sync(surveyorA, [item]);
    const p = await env.api(analystA, 'GET', `/points/${r.body.results[0].pointId}`);
    const menores = p.body.surveys[0].facts.find((f: any) => f.fieldKey === 'menores');
    expect(menores).toMatchObject({ status: 'unknown', value: null, rawAnswer: 'no se ve bien' });
  });

  it('rechaza relevamientos de un proyecto no asignado o de otro cliente', async () => {
    const r = await sync(surveyorA, [survey({ projectId: env.ids.projectB!, questionnaireVersionId: env.ids.versionB! })]);
    expect(r.body.results[0]).toMatchObject({ status: 'rejected', error: 'Proyecto inexistente o no asignado a este usuario' });
  });

  it('un UUID ya usado en otro proyecto no revela nada del otro relevamiento', async () => {
    const r = await sync(surveyorA, [{ ...first, projectId: env.ids.projectB!, questionnaireVersionId: env.ids.versionB! }]);
    expect(r.body.results[0].status).toBe('rejected');
    expect(r.body.results[0].surveyId).toBeUndefined();
  });

  it('la unicidad del UUID es por cliente: otro cliente puede usar el mismo', async () => {
    const surveyorB = await env.login('surveyor-b@t.local');
    const r = await sync(surveyorB, [{ ...first, projectId: env.ids.projectB!, routeId: env.ids.routeB!, questionnaireVersionId: env.ids.versionB! }]);
    expect(r.body.results[0].status).toBe('accepted');
  });

  it('rechaza versiones de cuestionario de otro proyecto', async () => {
    const r = await sync(surveyorA, [survey({ questionnaireVersionId: env.ids.versionB! })]);
    expect(r.body.results[0].status).toBe('rejected');
  });

  it('valida el formato del lote', async () => {
    expect((await env.api(surveyorA, 'POST', '/sync/surveys', { items: [] })).status).toBe(400);
    expect((await env.api(surveyorA, 'POST', '/sync/surveys', { items: [{ clientUuid: 'x' }] })).status).toBe(400);
  });
});

describe('panel: puntos e indicadores', () => {
  it('los puntos se entregan como GeoJSON con el último relevamiento', async () => {
    const r = await env.api(analystA, 'GET', `/projects/${env.ids.projectA}/points`);
    expect(r.body.type).toBe('FeatureCollection');
    expect(r.body.features.length).toBe(4);
    const f = r.body.features[0];
    expect(f.geometry.type).toBe('Point');
    expect(f.properties.facts).toBeTypeOf('object');
  });

  it('filtra por zona', async () => {
    const r = await env.api(analystA, 'GET', `/projects/${env.ids.projectA}/points?zoneId=${env.ids.zoneA}`);
    expect(r.body.features.every((f: any) => f.properties.zoneId === env.ids.zoneA)).toBe(true);
    expect(r.body.features.length).toBe(3);
  });

  it('los indicadores salen del cuestionario, no de código fijo', async () => {
    const r = await env.api(analystA, 'GET', `/projects/${env.ids.projectA}/indicators`);
    expect(r.status).toBe(200);
    expect(r.body.totals).toEqual({ points: 4, surveys: 5 });
    const keys = r.body.indicators.map((i: any) => i.key).sort();
    const expected = SAMPLE_QUESTIONNAIRE.fields.filter((f) => f.indicator).map((f) => f.key).sort();
    expect(keys).toEqual(expected);
    const personas = r.body.indicators.find((i: any) => i.key === 'personas');
    expect(personas).toMatchObject({ aggregate: 'sum', label: 'Personas relevadas', value: 6 });
    const pert = r.body.indicators.find((i: any) => i.key === 'pertenencias_tipo');
    expect(pert.distribution).toEqual([{ option: 'mochila', label: 'mochila', count: 4 }]);
    const byZone = Object.fromEntries(r.body.byZone.map((z: any) => [z.zoneName, z.points]));
    expect(byZone).toEqual({ Centro: 3, 'Sin zona': 1 });
  });
});

describe('cuestionarios', () => {
  let questionnaireId: string;
  let draftId: string;

  it('crea un borrador que puede guardarse incompleto', async () => {
    const r = await env.api(adminA, 'POST', `/projects/${env.ids.projectA}/questionnaires`, { name: 'Nuevo' });
    expect(r.status).toBe(201);
    questionnaireId = r.body.id;
    draftId = r.body.versions[0].id;
    const v = await env.api(adminA, 'GET', `/questionnaire-versions/${draftId}`);
    expect(v.body.status).toBe('draft');
    expect(v.body.issues.length).toBeGreaterThan(0);
  });

  it('no permite publicar un cuestionario con errores', async () => {
    const r = await env.api(adminA, 'POST', `/questionnaire-versions/${draftId}/publish`);
    expect(r.status).toBe(400);
    expect(r.body.details.length).toBeGreaterThan(0);
  });

  it('publica cuando es válido, y lo publicado no se puede editar', async () => {
    expect((await env.api(adminA, 'PUT', `/questionnaire-versions/${draftId}`, { definition: SAMPLE_QUESTIONNAIRE })).body.issues).toEqual([]);
    expect((await env.api(adminA, 'POST', `/questionnaire-versions/${draftId}/publish`)).status).toBe(200);
    const edit = await env.api(adminA, 'PUT', `/questionnaire-versions/${draftId}`, { definition: SAMPLE_QUESTIONNAIRE });
    expect(edit.status).toBe(400);
  });

  it('la base impide modificar una versión publicada aunque se saltee la API', async () => {
    const c = await env.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.is_super', 'true', true)`);
      await expect(c.query(`UPDATE questionnaire_versions SET definition = '{}' WHERE id = $1`, [draftId])).rejects.toThrow(
        'Una versión publicada no puede modificarse',
      );
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });

  it('una nueva versión retira la anterior al publicarse; la app recibe solo la vigente', async () => {
    const v2 = await env.api(adminA, 'POST', `/questionnaires/${questionnaireId}/versions`);
    expect(v2.body.version).toBe(2);
    expect((await env.api(adminA, 'POST', `/questionnaires/${questionnaireId}/versions`)).status).toBe(400);
    expect((await env.api(adminA, 'POST', `/questionnaire-versions/${v2.body.id}/publish`)).status).toBe(200);
    const active = await env.api(surveyorA, 'GET', `/projects/${env.ids.projectA}/questionnaires/active`);
    const mine = active.body.filter((x: any) => x.questionnaireId === questionnaireId);
    expect(mine).toHaveLength(1);
    expect(mine[0].version).toBe(2);
  });

  it('el relevador no puede editar cuestionarios', async () => {
    expect((await env.api(surveyorA, 'PUT', `/questionnaire-versions/${draftId}`, { definition: {} })).status).toBe(403);
  });
});

describe('zonas y recorridos', () => {
  it('crea zonas desde GeoJSON y rechaza geometrías inválidas', async () => {
    const ok = await env.api(adminA, 'POST', `/projects/${env.ids.projectA}/zones`, {
      name: 'Norte',
      color: '#10b981',
      geometry: { type: 'Polygon', coordinates: [[[-58.44, -34.57], [-58.42, -34.57], [-58.42, -34.59], [-58.44, -34.59], [-58.44, -34.57]]] },
    });
    expect(ok.status).toBe(201);
    // El punto lejano ya existente queda asignado a la nueva zona.
    const pts = await env.api(analystA, 'GET', `/projects/${env.ids.projectA}/points?zoneId=${ok.body.id}`);
    expect(pts.body.features).toHaveLength(1);

    const bowtie = await env.api(adminA, 'POST', `/projects/${env.ids.projectA}/zones`, {
      name: 'Moño',
      geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 1], [1, 0], [0, 1], [0, 0]]] },
    });
    expect(bowtie.status).toBe(400);
    expect(bowtie.body.message).toMatch(/Geometría inválida/);
  });

  it('el relevador no puede operar recorridos de proyectos no asignados', async () => {
    const other = await env.api(adminA, 'POST', '/projects', { name: 'Proyecto ajeno' });
    const route = await env.api(adminA, 'POST', `/projects/${other.body.id}/routes`, { name: 'Oculto' });
    expect((await env.api(surveyorA, 'POST', `/routes/${route.body.id}/start`)).status).toBe(404);
  });

  it('el relevador inicia y finaliza su recorrido', async () => {
    const start = await env.api(surveyorA, 'POST', `/routes/${env.ids.routeA}/start`);
    expect(start.body.status).toBe('in_progress');
    const fin = await env.api(surveyorA, 'POST', `/routes/${env.ids.routeA}/finish`);
    expect(fin.body.status).toBe('finished');
    expect((await env.api(surveyorA, 'POST', `/routes/${env.ids.routeA}/start`)).status).toBe(400);
  });
});

describe('auditoría', () => {
  it('registra las acciones y no puede alterarse', async () => {
    const r = await env.api(adminA, 'GET', '/audit?limit=500');
    const actions = new Set(r.body.map((a: any) => `${a.entity}:${a.action}`));
    for (const a of ['survey:sync', 'questionnaire_version:publish', 'zone:create', 'route:start', 'user:login']) {
      expect(actions).toContain(a);
    }
    const c = await env.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.is_super', 'true', true)`);
      const before = (await c.query('SELECT count(*)::int AS n FROM audit_log')).rows[0].n;
      // Sin política de borrado/edición, RLS no expone ninguna fila para modificar...
      expect((await c.query('DELETE FROM audit_log')).rowCount).toBe(0);
      expect((await c.query(`UPDATE audit_log SET action = 'x'`)).rowCount).toBe(0);
      expect((await c.query('SELECT count(*)::int AS n FROM audit_log')).rows[0].n).toBe(before);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });

  it('cada cliente ve solo su auditoría', async () => {
    const b = await env.login('admin-b@t.local');
    const r = await env.api(b, 'GET', '/audit?limit=500');
    expect(r.body.length).toBeGreaterThan(0);
    expect(r.body.every((a: any) => a.clientName === 'Cliente B' || a.clientName === null)).toBe(true);
    const aSurveys = await env.api(adminA, 'GET', '/audit?entity=survey&limit=500');
    const bIds = new Set(r.body.map((a: any) => a.id));
    expect(aSurveys.body.some((a: any) => bIds.has(a.id))).toBe(false);
  });
});
