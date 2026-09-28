/**
 * Datos de demostración para desarrollo local. Idempotente: si el cliente demo
 * ya existe, no hace nada. NO usar en producción.
 *
 * Los relevamientos de ejemplo se cargan por el mismo endpoint de sincronización
 * que usa la app, así el seed también ejercita el camino real.
 */
import { randomUUID } from 'node:crypto';
import { SAMPLE_QUESTIONNAIRE, parseQuestionnaire, type SurveySyncItem } from '@releva/core';
import { loadConfig } from './config.js';
import { createPool, withActor } from './db/pool.js';
import { hashPassword } from './auth/passwords.js';
import { buildApp } from './app.js';

const PASSWORD = process.env.SEED_PASSWORD ?? 'releva-demo-2026';

export const DEMO_USERS = {
  super: 'super@releva.local',
  admin: 'admin@demo.releva.local',
  analyst: 'gobierno@demo.releva.local',
  surveyor: 'relevador@demo.releva.local',
};

// Polígonos aproximados en CABA (lng, lat).
const ZONES = [
  {
    name: 'Microcentro',
    code: 'Z01',
    color: '#2563eb',
    ring: [[-58.3835, -34.6000], [-58.3690, -34.6000], [-58.3690, -34.6105], [-58.3835, -34.6105], [-58.3835, -34.6000]],
  },
  {
    name: 'San Telmo',
    code: 'Z02',
    color: '#d97706',
    ring: [[-58.3780, -34.6105], [-58.3640, -34.6105], [-58.3640, -34.6250], [-58.3780, -34.6250], [-58.3780, -34.6105]],
  },
];

type Demo = { lat: number; lng: number; night: number; facts: Record<string, unknown> };
const DEMO_POINTS: Demo[] = [
  { lat: -34.6037, lng: -58.3781, night: 0, facts: { personas: 1, composicion: 'sola', menores: false, colchon: true, mantas: 2, pertenencias: true, pertenencias_tipo: ['mochila'], animales: true, animales_tipo: ['perro'], animales_cantidad: 1 } },
  { lat: -34.6061, lng: -58.3755, night: 0, facts: { personas: 2, composicion: 'grupo_familiar', menores: true, menores_cantidad: 1, pertenencias: true, pertenencias_tipo: ['bolsos'], animales: false } },
  { lat: -34.6082, lng: -58.3712, night: 0, facts: { personas: 3, composicion: 'grupo', menores: false, colchon: true, mantas: 4, pertenencias: true, pertenencias_tipo: ['carro', 'ropa'], animales: false } },
  { lat: -34.6018, lng: -58.3809, night: 1, facts: { personas: 1, composicion: 'sola', menores: false, pertenencias: false, animales: false } },
  { lat: -34.6149, lng: -58.3725, night: 1, facts: { personas: 2, composicion: 'pareja', menores: false, colchon: true, mantas: 3, pertenencias: true, pertenencias_tipo: ['bolsos'], animales: true, animales_tipo: ['perro', 'gato'], animales_cantidad: 2 } },
  { lat: -34.6203, lng: -58.3702, night: 1, facts: { personas: 1, composicion: 'sola', menores: false, pertenencias: true, pertenencias_tipo: ['mochila'], animales: false } },
  { lat: -34.6178, lng: -58.3681, night: 2, facts: { personas: 4, composicion: 'grupo_familiar', menores: true, menores_cantidad: 2, colchon: true, mantas: 5, pertenencias: true, pertenencias_tipo: ['bolsos', 'ropa'], animales: false } },
  // Mismo lugar que el primero, otra noche: se asocia al punto existente (historial).
  { lat: -34.60372, lng: -58.37812, night: 2, facts: { personas: 1, composicion: 'sola', menores: false, colchon: true, mantas: 1, pertenencias: true, pertenencias_tipo: ['mochila'], animales: true, animales_tipo: ['perro'], animales_cantidad: 1 } },
];

async function main() {
  const config = loadConfig();
  const pool = createPool(config.DATABASE_URL);
  const system = { kind: 'system', reason: 'seed' } as const;

  const exists = await withActor(pool, system, async (db) => (await db.query(`SELECT 1 FROM clients WHERE slug = 'demo'`)).rowCount);
  if (exists) {
    console.log('El cliente demo ya existe; no se modifica nada.');
    await pool.end();
    return;
  }

  const hash = await hashPassword(PASSWORD);
  const ids = await withActor(pool, system, async (db) => {
    const one = async <T = { id: string }>(sql: string, params: unknown[]) => (await db.query(sql, params)).rows[0] as T;
    await db.query(
      `INSERT INTO users (email, name, role, password_hash) VALUES ($1, 'Super Admin', 'super_admin', $2) ON CONFLICT (email) DO NOTHING`,
      [DEMO_USERS.super, hash],
    );
    const client = await one(`INSERT INTO clients (name, slug) VALUES ('Gobierno Demo', 'demo') RETURNING id`, []);
    const org = await one(`INSERT INTO organizations (client_id, name) VALUES ($1, 'Dirección de Atención Inmediata') RETURNING id`, [client.id]);
    const mk = (email: string, name: string, role: string) =>
      one(`INSERT INTO users (client_id, organization_id, email, name, role, password_hash) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`, [
        client.id, org.id, email, name, role, hash,
      ]);
    await mk(DEMO_USERS.admin, 'Admin Demo', 'client_admin');
    await mk(DEMO_USERS.analyst, 'Analista Gobierno', 'analyst');
    const surveyor = await mk(DEMO_USERS.surveyor, 'Relevador Demo', 'surveyor');

    const project = await one(
      `INSERT INTO projects (client_id, organization_id, name, description) VALUES ($1, $2, 'Relevamiento nocturno — Demo', 'Proyecto de demostración') RETURNING id`,
      [client.id, org.id],
    );
    await db.query('INSERT INTO project_members (client_id, project_id, user_id) VALUES ($1, $2, $3)', [client.id, project.id, surveyor.id]);

    const zoneIds: string[] = [];
    for (const z of ZONES) {
      const zone = await one(
        `INSERT INTO zones (client_id, project_id, name, code, color, geom)
         VALUES ($1, $2, $3, $4, $5, ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON($6), 4326))) RETURNING id`,
        [client.id, project.id, z.name, z.code, z.color, JSON.stringify({ type: 'Polygon', coordinates: [z.ring] })],
      );
      zoneIds.push(zone.id);
    }
    const route = await one(
      `INSERT INTO routes (client_id, project_id, zone_id, name, surveyor_id) VALUES ($1, $2, $3, 'Recorrido Centro', $4) RETURNING id`,
      [client.id, project.id, zoneIds[0], surveyor.id],
    );

    const parsed = parseQuestionnaire(SAMPLE_QUESTIONNAIRE);
    if (!parsed.ok) throw new Error('El cuestionario de ejemplo es inválido');
    const q = await one(`INSERT INTO questionnaires (client_id, project_id, name) VALUES ($1, $2, 'Cuestionario nocturno') RETURNING id`, [
      client.id, project.id,
    ]);
    const version = await one(
      `INSERT INTO questionnaire_versions (client_id, questionnaire_id, version, status, definition, published_at)
       VALUES ($1, $2, 1, 'published', $3, now()) RETURNING id`,
      [client.id, q.id, JSON.stringify(parsed.definition)],
    );
    return { projectId: project.id, routeId: route.id, versionId: version.id };
  });

  // Relevamientos de ejemplo por el endpoint real de sincronización.
  const app = await buildApp({ ...config, LOG_LEVEL: 'warn' }, pool);
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: DEMO_USERS.surveyor, password: PASSWORD } });
  const { accessToken } = login.json();
  const base = new Date();
  base.setHours(23, 0, 0, 0);
  const items: SurveySyncItem[] = DEMO_POINTS.map((p, i) => {
    const at = new Date(base.getTime() - (2 - p.night) * 86_400_000 + i * 7 * 60_000).toISOString();
    return {
      clientUuid: randomUUID(),
      projectId: ids.projectId,
      routeId: ids.routeId,
      questionnaireVersionId: ids.versionId,
      location: { lat: p.lat, lng: p.lng, accuracy: 6 + (i % 4), altitude: 25, capturedAt: at },
      status: 'completed',
      startedAt: at,
      completedAt: at,
      facts: Object.entries(p.facts).map(([fieldKey, value]) => ({
        fieldKey,
        value: value as never,
        status: 'confirmed' as const,
        source: 'voice' as const,
        recordedAt: at,
      })),
      utterances: [
        { speaker: 'releva', text: '¿Qué estás viendo?', at },
        { speaker: 'surveyor', text: '(dato de demostración)', at },
      ],
    };
  });
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/sync/surveys',
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { items },
  });
  const results = res.json().results as { status: string }[];
  await app.close();
  await pool.end();

  console.log(`\nDatos de demostración cargados (${results.filter((r) => r.status === 'accepted').length} relevamientos).\n`);
  console.log(`Contraseña de todos los usuarios: ${PASSWORD}`);
  for (const [role, email] of Object.entries(DEMO_USERS)) console.log(`  ${role.padEnd(9)} ${email}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
