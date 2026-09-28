import type { FastifyError, FastifyInstance } from 'fastify';
import { ZodError, type ZodType } from 'zod';

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly code = 'error',
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what = 'Recurso') => new HttpError(404, `${what} no encontrado`, 'not_found');
export const forbidden = (msg = 'No tenés permiso para esta acción') => new HttpError(403, msg, 'forbidden');
export const badRequest = (msg: string, details?: unknown) => new HttpError(400, msg, 'bad_request', details);

/** Valida la entrada con Zod y responde 400 con el detalle si no es válida. */
export function parse<T>(schema: ZodType<T>, data: unknown): T {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw new HttpError(400, 'Datos inválidos', 'validation', r.error.issues.map((i) => ({ path: i.path, message: i.message })));
  }
  return r.data;
}

interface PgError {
  code?: string;
  constraint?: string;
  message: string;
}

/** Traduce errores a respuestas HTTP sin filtrar detalles internos. */
export function registerErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((err: FastifyError & PgError, req, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.statusCode).send({ error: err.code, message: err.message, details: err.details });
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: 'validation', message: 'Datos inválidos', details: err.issues });
    }
    switch (err.code) {
      case '23505':
        return reply.status(409).send({ error: 'conflict', message: 'Ya existe un registro con esos datos' });
      case '23503':
        return reply.status(400).send({ error: 'invalid_reference', message: 'Referencia a un registro inexistente o de otro cliente' });
      case '23514':
      case 'P0001':
        return reply.status(400).send({ error: 'constraint', message: err.message.startsWith('new row') ? 'Datos inválidos' : err.message });
      case '42501':
        return reply.status(403).send({ error: 'forbidden', message: 'No tenés permiso para esta acción' });
      case '22P02':
      case 'XX000':
        return reply.status(400).send({ error: 'bad_request', message: 'Datos con formato inválido' });
    }
    if (err.validation) {
      return reply.status(400).send({ error: 'validation', message: err.message });
    }
    if (typeof err.statusCode === 'number' && err.statusCode < 500) {
      return reply.status(err.statusCode).send({ error: 'request', message: err.message });
    }
    req.log.error({ err }, 'Error no controlado');
    return reply.status(500).send({ error: 'internal', message: 'Error interno' });
  });
}
