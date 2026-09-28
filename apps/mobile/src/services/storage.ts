import * as SQLite from 'expo-sqlite';
import type { OutboxEntry, OutboxStatus, OutboxStore, SurveySyncItem } from '@releva/core';
import type { DraftStore } from '../engine/controller';

/**
 * Almacenamiento local (SQLite). Todo lo relevado se escribe acá primero:
 * - outbox: relevamientos terminados esperando sincronización.
 * - drafts: punto en curso, guardado tras cada respuesta.
 * - cache: proyectos, recorridos y cuestionarios para trabajar sin señal.
 */

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

export function db(): Promise<SQLite.SQLiteDatabase> {
  dbPromise ??= (async () => {
    const d = await SQLite.openDatabaseAsync('releva.db');
    await d.execAsync(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS outbox (
        id TEXT PRIMARY KEY NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS outbox_status ON outbox(status, created_at);
      CREATE TABLE IF NOT EXISTS drafts (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
    `);
    return d;
  })();
  return dbPromise;
}

interface OutboxRow {
  id: string;
  payload: string;
  status: OutboxStatus;
  attempts: number;
  next_attempt_at: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

const toEntry = (r: OutboxRow): OutboxEntry => ({
  id: r.id,
  payload: JSON.parse(r.payload) as SurveySyncItem,
  status: r.status,
  attempts: r.attempts,
  nextAttemptAt: r.next_attempt_at,
  lastError: r.last_error,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export class SqliteOutboxStore implements OutboxStore {
  async upsert(e: OutboxEntry) {
    const d = await db();
    await d.runAsync(
      `INSERT INTO outbox (id, payload, status, attempts, next_attempt_at, last_error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, status = excluded.status, attempts = excluded.attempts,
         next_attempt_at = excluded.next_attempt_at, last_error = excluded.last_error, updated_at = excluded.updated_at`,
      [e.id, JSON.stringify(e.payload), e.status, e.attempts, e.nextAttemptAt, e.lastError, e.createdAt, e.updatedAt],
    );
  }
  async get(id: string) {
    const d = await db();
    const r = await d.getFirstAsync<OutboxRow>('SELECT * FROM outbox WHERE id = ?', [id]);
    return r ? toEntry(r) : null;
  }
  async listByStatus(status: OutboxStatus, limit = 1000) {
    const d = await db();
    const rows = await d.getAllAsync<OutboxRow>('SELECT * FROM outbox WHERE status = ? ORDER BY created_at LIMIT ?', [status, limit]);
    return rows.map(toEntry);
  }
  async count(status: OutboxStatus) {
    const d = await db();
    const r = await d.getFirstAsync<{ n: number }>('SELECT count(*) AS n FROM outbox WHERE status = ?', [status]);
    return r?.n ?? 0;
  }
}

export class SqliteDraftStore implements DraftStore {
  async saveDraft(item: SurveySyncItem) {
    const d = await db();
    await d.runAsync(
      'INSERT INTO drafts (id, payload, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at',
      [item.clientUuid, JSON.stringify(item), Date.now()],
    );
  }
  async deleteDraft(id: string) {
    const d = await db();
    await d.runAsync('DELETE FROM drafts WHERE id = ?', [id]);
  }
  /** Puntos que quedaron a medias (p. ej. la app se cerró). Se envían como incompletos. */
  async listDrafts(): Promise<SurveySyncItem[]> {
    const d = await db();
    const rows = await d.getAllAsync<{ payload: string }>('SELECT payload FROM drafts ORDER BY updated_at');
    return rows.map((r) => JSON.parse(r.payload) as SurveySyncItem);
  }
}

export const cache = {
  async get<T>(key: string): Promise<T | null> {
    const d = await db();
    const r = await d.getFirstAsync<{ value: string }>('SELECT value FROM cache WHERE key = ?', [key]);
    return r ? (JSON.parse(r.value) as T) : null;
  },
  async set(key: string, value: unknown) {
    const d = await db();
    await d.runAsync(
      'INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      [key, JSON.stringify(value), Date.now()],
    );
  },
};
