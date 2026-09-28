import pg from 'pg';
import type { Role } from '@releva/core';

// Devolver bigint/numeric como number y fechas como ISO string, de forma consistente.
pg.types.setTypeParser(20, (v) => Number(v)); // int8
pg.types.setTypeParser(1700, (v) => Number(v)); // numeric
pg.types.setTypeParser(1184, (v) => new Date(v).toISOString()); // timestamptz

export type Db = pg.PoolClient;

/** Quién está operando. Determina qué filas ve la base (Row Level Security). */
export type Actor =
  | { kind: 'user'; id: string; role: Role; clientId: string | null }
  | { kind: 'system'; reason: string };

export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString, max: 10, idleTimeoutMillis: 30_000 });
}

/**
 * Ejecuta `fn` en una transacción con el contexto de tenant seteado.
 * Todas las consultas de la API pasan por acá: la base filtra por cliente
 * aunque una consulta olvide hacerlo.
 */
export async function withActor<T>(pool: pg.Pool, actor: Actor, fn: (db: Db) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const isSuper = actor.kind === 'system' || actor.role === 'super_admin';
    const clientId = actor.kind === 'user' ? actor.clientId ?? '' : '';
    await client.query(
      `SELECT set_config('app.is_super', $1, true), set_config('app.client_id', $2, true), set_config('app.actor_id', $3, true)`,
      [isSuper ? 'true' : 'false', clientId, actor.kind === 'user' ? actor.id : ''],
    );
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
