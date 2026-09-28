import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import type pg from 'pg';
import type { Config } from './config.js';
import { registerErrorHandler } from './http/errors.js';
import { authRoutes } from './routes/auth.js';
import { adminRoutes } from './routes/admin.js';
import { projectRoutes } from './routes/projects.js';
import { questionnaireRoutes } from './routes/questionnaires.js';
import { syncRoutes } from './routes/sync.js';
import { dataRoutes } from './routes/data.js';

declare module 'fastify' {
  interface FastifyInstance {
    pool: pg.Pool;
    config: Config;
  }
}

export async function buildApp(config: Config, pool: pg.Pool): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      // Nunca loguear credenciales ni tokens.
      redact: ['req.headers.authorization', 'req.body.password', 'req.body.refreshToken'],
    },
    // Confía solo en la cantidad de proxies configurada (X-Forwarded-For no es falsificable más allá).
    trustProxy: (_address: string, hop: number) => hop < config.TRUST_PROXY_HOPS,
    bodyLimit: 1024 * 1024,
  });

  app.decorate('pool', pool);
  app.decorate('config', config);

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, { origin: config.CORS_ORIGINS, credentials: false });
  await app.register(rateLimit, { global: true, max: 600, timeWindow: '1 minute' });
  await app.register(jwt, { secret: config.JWT_SECRET, sign: { algorithm: 'HS256' }, verify: { algorithms: ['HS256'] } });

  registerErrorHandler(app);

  app.get('/health', async () => {
    await pool.query('SELECT 1');
    return { ok: true, service: 'releva-api' };
  });

  await app.register(async (api) => {
    await api.register(authRoutes);
    await api.register(adminRoutes);
    await api.register(projectRoutes);
    await api.register(questionnaireRoutes);
    await api.register(syncRoutes);
    await api.register(dataRoutes);
  }, { prefix: '/api/v1' });

  return app;
}
