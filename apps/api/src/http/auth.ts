import type { FastifyReply, FastifyRequest } from 'fastify';
import { can, ROLES, type Permission, type Role } from '@releva/core';
import { forbidden, HttpError } from './errors.js';
import { withActor, type Actor, type Db } from '../db/pool.js';

export interface AccessClaims {
  sub: string;
  role: Role;
  cid: string | null;
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: AccessClaims;
    user: AccessClaims;
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    actor: Extract<Actor, { kind: 'user' }>;
    /** Transacción con el contexto de tenant del usuario autenticado. */
    db<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  }
}

/** preHandler: exige un token de acceso válido. */
export async function authenticate(req: FastifyRequest, _reply: FastifyReply) {
  try {
    await req.jwtVerify();
  } catch {
    throw new HttpError(401, 'Sesión inválida o vencida', 'unauthorized');
  }
  const { sub, role, cid } = req.user;
  if (!(ROLES as readonly string[]).includes(role)) throw new HttpError(401, 'Sesión inválida', 'unauthorized');
  req.actor = { kind: 'user', id: sub, role, clientId: cid };
  const pool = req.server.pool;
  req.db = (fn) => withActor(pool, req.actor, fn);
}

/** preHandler: exige un permiso del rol. */
export function requirePermission(...permissions: Permission[]) {
  return async (req: FastifyRequest) => {
    if (!permissions.every((p) => can(req.actor.role, p))) throw forbidden();
  };
}

/**
 * Cliente sobre el que se opera. Un usuario de cliente opera siempre sobre el suyo
 * (se ignora lo que mande). Un super admin debe indicarlo explícitamente.
 */
export function targetClientId(req: FastifyRequest, requested?: string | null): string {
  if (req.actor.role !== 'super_admin') return req.actor.clientId!;
  if (!requested) throw new HttpError(400, 'Indicá el cliente (clientId)', 'client_required');
  return requested;
}
