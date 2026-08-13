import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { CoreClient } from './core/client.ts';
import { createPool } from './db/pool.ts';
import { startSweeper } from './jobs/sweeper.ts';

const config = loadConfig(process.env);
const pool = createPool(config.databaseUrl);
const core = new CoreClient({ baseUrl: config.coreBaseUrl, tenantKey: config.coreTenantKey, timeoutMs: 45_000 });
const app = await buildApp({ config, pool, core });

await app.listen({ port: config.port, host: '0.0.0.0' });

// Свипер поднимаем ЗДЕСЬ, а не в buildApp (бриф называл app.ts в списке
// файлов, но код давал server.ts — и код прав): buildApp зовут ещё и тесты,
// а фоновый крон в фабрике означал бы, что каждый тестовый инстанс начинает
// сам ходить в общую тестовую БД и в очередь фейка ядра мимо сценария.
// Точка запуска процесса — единственное место, где такой таймер уместен.
const sweeper = startSweeper({ config, pool, core, log: app.log });

let closing = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    // ПЕРВЫМ шагом глушим свипер: иначе очередной тик стартует новый проход в
    // ядро и в пул уже во время закрытия — и упрётся в закрытый pool.
    sweeper.stop();
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
