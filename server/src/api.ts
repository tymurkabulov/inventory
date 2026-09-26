import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool } from './db.js';

const config = loadConfig();
const pool = createPool(config.databaseUrl);
const app = await buildApp({ config, pool });

let stopping = false;
const shutdown = async () => {
  if (stopping) return; // второй сигнал не должен запускать закрытие заново
  stopping = true;
  // Зависшее закрытие не должно держать контейнер до SIGKILL.
  setTimeout(() => process.exit(1), 10_000).unref();
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await app.listen({ port: config.port, host: config.host });

// Видно в логах при старте: с неверным числом прыжков адресом клиента станет
// адрес прокси, и лимиты входа окажутся общими на всех.
app.log.info({ trustProxyHops: config.trustProxyHops }, 'доверяем X-Forwarded-For');
