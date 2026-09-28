import type { SurveySyncItem, SyncItemResult } from '../sync-contract.js';

/**
 * Cola de salida (outbox) para trabajar sin conectividad.
 *
 * Todo relevamiento se guarda primero en el dispositivo. La cola lo envía
 * cuando hay red, reintenta con espera exponencial, y SOLO marca como
 * sincronizado lo que el servidor confirmó. Nunca borra nada por sí misma:
 * lo rechazado queda para revisión, no se pierde.
 */

export type OutboxStatus = 'pending' | 'synced' | 'rejected';

export interface OutboxEntry {
  id: string; // = clientUuid del relevamiento
  payload: SurveySyncItem;
  status: OutboxStatus;
  attempts: number;
  /** Epoch ms a partir del cual se puede reintentar. */
  nextAttemptAt: number;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

/** Almacenamiento persistente de la cola. En la app: SQLite. En tests: memoria. */
export interface OutboxStore {
  upsert(entry: OutboxEntry): Promise<void>;
  get(id: string): Promise<OutboxEntry | null>;
  listByStatus(status: OutboxStatus, limit?: number): Promise<OutboxEntry[]>;
  count(status: OutboxStatus): Promise<number>;
}

/** Envío al servidor. Lanza si no hay red o el servidor no respondió. */
export interface SyncTransport {
  send(items: SurveySyncItem[]): Promise<SyncItemResult[]>;
}

export interface OutboxOptions {
  batchSize: number;
  baseDelayMs: number;
  maxDelayMs: number;
  now: () => number;
}

const DEFAULTS: OutboxOptions = {
  batchSize: 20,
  baseDelayMs: 5_000,
  maxDelayMs: 10 * 60_000,
  now: () => Date.now(),
};

export interface FlushReport {
  sent: number;
  synced: number;
  rejected: number;
  deferred: number;
  networkError: string | null;
}

export class Outbox {
  private readonly opts: OutboxOptions;
  private flushing: Promise<FlushReport> | null = null;

  constructor(
    private readonly store: OutboxStore,
    private readonly transport: SyncTransport,
    opts: Partial<OutboxOptions> = {},
  ) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  /** Encola (o reemplaza, si todavía no se sincronizó) un relevamiento. */
  async enqueue(payload: SurveySyncItem): Promise<void> {
    const now = this.opts.now();
    const existing = await this.store.get(payload.clientUuid);
    if (existing?.status === 'synced') {
      throw new Error('El relevamiento ya fue sincronizado y no puede modificarse');
    }
    await this.store.upsert({
      id: payload.clientUuid,
      payload,
      status: 'pending',
      attempts: existing?.attempts ?? 0,
      nextAttemptAt: now,
      lastError: null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
  }

  pendingCount(): Promise<number> {
    return this.store.count('pending');
  }

  /** Envía lo pendiente. Llamadas concurrentes comparten la misma ejecución. */
  flush(): Promise<FlushReport> {
    this.flushing ??= this.doFlush().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async doFlush(): Promise<FlushReport> {
    const report: FlushReport = { sent: 0, synced: 0, rejected: 0, deferred: 0, networkError: null };
    const now = this.opts.now();
    const pending = await this.store.listByStatus('pending');
    const due = pending.filter((e) => e.nextAttemptAt <= now);
    report.deferred = pending.length - due.length;

    for (let i = 0; i < due.length; i += this.opts.batchSize) {
      const batch = due.slice(i, i + this.opts.batchSize);
      let results: SyncItemResult[];
      try {
        results = await this.transport.send(batch.map((e) => e.payload));
      } catch (err) {
        report.networkError = err instanceof Error ? err.message : String(err);
        // Sin red: todo lo que faltaba queda pendiente con espera.
        for (const e of due.slice(i)) await this.backoff(e, report.networkError);
        report.deferred += due.length - i;
        return report;
      }
      report.sent += batch.length;
      const byId = new Map(results.map((r) => [r.clientUuid, r]));
      for (const e of batch) {
        const r = byId.get(e.id);
        const t = this.opts.now();
        if (!r) {
          await this.backoff(e, 'El servidor no informó resultado');
          report.deferred += 1;
        } else if (r.status === 'accepted' || r.status === 'duplicate') {
          await this.store.upsert({ ...e, status: 'synced', lastError: null, updatedAt: t });
          report.synced += 1;
        } else {
          await this.store.upsert({ ...e, status: 'rejected', lastError: r.error, updatedAt: t });
          report.rejected += 1;
        }
      }
    }
    return report;
  }

  private async backoff(e: OutboxEntry, error: string) {
    const attempts = e.attempts + 1;
    const delay = Math.min(this.opts.maxDelayMs, this.opts.baseDelayMs * 2 ** (attempts - 1));
    const t = this.opts.now();
    await this.store.upsert({ ...e, attempts, nextAttemptAt: t + delay, lastError: error, updatedAt: t });
  }
}

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/** Implementación en memoria (tests y desarrollo). */
export class MemoryOutboxStore implements OutboxStore {
  private readonly rows = new Map<string, OutboxEntry>();
  async upsert(entry: OutboxEntry) {
    this.rows.set(entry.id, clone(entry));
  }
  async get(id: string) {
    const r = this.rows.get(id);
    return r ? clone(r) : null;
  }
  async listByStatus(status: OutboxStatus, limit = 1000) {
    return [...this.rows.values()]
      .filter((r) => r.status === status)
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, limit)
      .map((r) => clone(r));
  }
  async count(status: OutboxStatus) {
    return [...this.rows.values()].filter((r) => r.status === status).length;
  }
}
