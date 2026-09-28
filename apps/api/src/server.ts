import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { buildApp } from './app.js';

const config = loadConfig();
const pool = createPool(config.DATABASE_URL);
const app = await buildApp(config, pool);

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'Cerrando');
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ port: config.PORT, host: config.HOST });
