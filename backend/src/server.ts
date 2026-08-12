import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { CoreClient } from './core/client.ts';
import { createPool } from './db/pool.ts';

const config = loadConfig(process.env);
const pool = createPool(config.databaseUrl);
const core = new CoreClient({ baseUrl: config.coreBaseUrl, tenantKey: config.coreTenantKey, timeoutMs: 45_000 });
const app = await buildApp({ config, pool, core });

await app.listen({ port: config.port, host: '0.0.0.0' });

let closing = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, 'останавливаемся: дорабатываем принятые запросы');
    void app
      .close()
      .then(() => pool.end())
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        app.log.error({ err }, 'graceful shutdown сорвался');
        process.exit(1);
      });
  });
}
