import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { SAMPLE_QUESTIONNAIRE } from '@releva/core';
import { buildApp } from '../src/app.js';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { loadConfig } from '../src/config.js';

/**
 * Entorno de pruebas: base de datos real (PostgreSQL + PostGIS) recreada desde cero.
 * TEST_ADMIN_URL: conexión de superusuario para crear la base y las extensiones.
 * TEST_DATABASE_URL: conexión del rol de aplicación (no superusuario, RLS aplica).
 */
const ADMIN_URL = process.env.TEST_ADMIN_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres';
const DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://releva_app:releva_app_dev@localhost:5432/releva_test';

export const PASSWORD = 'test-password-123';

export interface TestEnv {
  app: FastifyInstance;
  pool: pg.Pool;
  close(): Promise<void>;
  login(email: string, password?: string): Promise<string>;
  api(token: string | null, method: string, url: string, payload?: unknown): Promise<{ status: number; body: any }>;
  ids: Record<string, string>;
}

async function recreateDatabase() {
  const dbName = new URL(DB_URL).pathname.slice(1);
  const owner = decodeURIComponent(new URL(DB_URL).username);
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${dbName} OWNER ${owner}`);
  await admin.end();
  const u = new URL(ADMIN_URL);
  u.pathname = `/${dbName}`;
  const ext = new pg.Client({ connectionString: u.toString() });
  await ext.connect();
  await ext.query('CREATE EXTENSION postgis; CREATE EXTENSION pgcrypto;');
  await ext.end();
}

export async function setupTestEnv(): Promise<TestEnv> {
  await recreateDatabase();
  await migrate(DB_URL, () => undefined);
  const config = loadConfig({
    DATABASE_URL: DB_URL,
    JWT_SECRET: 'test-secret-test-secret-test-secret-123',
    LOG_LEVEL: 'silent',
    LOGIN_RATE_LIMIT: '1000',
  });
  const pool = createPool(DB_URL);
  const app = await buildApp(config, pool);

  const api: TestEnv['api'] = async (token, method, url, payload) => {
    const res = await app.inject({
      method: method as 'GET',
      url: `/api/v1${url}`,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });
    return { status: res.statusCode, body: res.body ? safeJson(res.body) : null };
  };
  const login = async (email: string, password = PASSWORD) => {
    const r = await api(null, 'POST', '/auth/login', { email, password });
    if (r.status !== 200) throw new Error(`login ${email}: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body.accessToken as string;
  };

  const ids = await fixtures(pool);
  return { app, pool, api, login, ids, close: async () => { await app.close(); await pool.end(); } };
}

function safeJson(s: string) {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

/** Dos clientes completos (A y B) para probar el aislamiento entre ellos. */
async function fixtures(pool: pg.Pool) {
  const { hashPassword } = await import('../src/auth/passwords.js');
  const hash = await hashPassword(PASSWORD);
  const c = await pool.connect();
  const ids: Record<string, string> = {};
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.is_super', 'true', true)`);
    const one = async (sql: string, params: unknown[]) => (await c.query(sql, params)).rows[0].id as string;
    ids.super = await one(`INSERT INTO users (email, name, role, password_hash) VALUES ('super@t.local', 'Super', 'super_admin', $1) RETURNING id`, [hash]);
    for (const k of ['A', 'B']) {
      const low = k.toLowerCase();
      ids[`client${k}`] = await one(`INSERT INTO clients (name, slug) VALUES ($1, $2) RETURNING id`, [`Cliente ${k}`, `cliente-${low}`]);
      const user = (email: string, role: string) =>
        one(`INSERT INTO users (client_id, email, name, role, password_hash) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [
          ids[`client${k}`], email, email, role, hash,
        ]);
      ids[`admin${k}`] = await user(`admin-${low}@t.local`, 'client_admin');
      ids[`analyst${k}`] = await user(`analyst-${low}@t.local`, 'analyst');
      ids[`surveyor${k}`] = await user(`surveyor-${low}@t.local`, 'surveyor');
      ids[`project${k}`] = await one(`INSERT INTO projects (client_id, name) VALUES ($1, $2) RETURNING id`, [ids[`client${k}`], `Proyecto ${k}`]);
      await c.query('INSERT INTO project_members (client_id, project_id, user_id) VALUES ($1, $2, $3)', [
        ids[`client${k}`], ids[`project${k}`], ids[`surveyor${k}`],
      ]);
      ids[`zone${k}`] = await one(
        `INSERT INTO zones (client_id, project_id, name, geom)
         VALUES ($1, $2, 'Centro', ST_Multi(ST_MakeEnvelope(-58.39, -34.61, -58.37, -34.60, 4326))) RETURNING id`,
        [ids[`client${k}`], ids[`project${k}`]],
      );
      ids[`route${k}`] = await one(`INSERT INTO routes (client_id, project_id, name) VALUES ($1, $2, 'R1') RETURNING id`, [
        ids[`client${k}`], ids[`project${k}`],
      ]);
      const q = await one(`INSERT INTO questionnaires (client_id, project_id, name) VALUES ($1, $2, 'Q') RETURNING id`, [
        ids[`client${k}`], ids[`project${k}`],
      ]);
      ids[`questionnaire${k}`] = q;
      ids[`version${k}`] = await one(
        `INSERT INTO questionnaire_versions (client_id, questionnaire_id, version, status, definition, published_at)
         VALUES ($1, $2, 1, 'published', $3, now()) RETURNING id`,
        [ids[`client${k}`], q, JSON.stringify(SAMPLE_QUESTIONNAIRE)],
      );
    }
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
  return ids;
}
