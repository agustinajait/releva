import type { Actor, Db } from '../db/pool.js';

export interface AuditEntry {
  action: string;
  entity: string;
  entityId?: string | null;
  clientId?: string | null;
  data?: Record<string, unknown>;
  ip?: string | null;
}

/**
 * Registra una acción en la auditoría, dentro de la misma transacción que la
 * acción: si la acción se revierte, el registro también (y viceversa).
 * Nunca guardar contraseñas ni tokens en `data`.
 */
export async function audit(db: Db, actor: Actor, e: AuditEntry): Promise<void> {
  const clientId = e.clientId !== undefined ? e.clientId : actor.kind === 'user' ? actor.clientId : null;
  await db.query(
    `INSERT INTO audit_log (client_id, actor_id, actor_role, action, entity, entity_id, data, ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      clientId,
      actor.kind === 'user' ? actor.id : null,
      actor.kind === 'user' ? actor.role : `system:${actor.reason}`,
      e.action,
      e.entity,
      e.entityId ?? null,
      JSON.stringify(e.data ?? {}),
      e.ip ?? null,
    ],
  );
}
