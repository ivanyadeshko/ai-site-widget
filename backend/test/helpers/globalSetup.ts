import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export default function setup(): void {
  process.env.DATABASE_URL ??= 'postgres://widget:widget@127.0.0.1:55433/widget_test';
  // Мигрируем ОДИН раз на прогон: node-pg-migrate идемпотентен.
  execFileSync('npx', ['node-pg-migrate', '-m', 'migrations', 'up'], {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
  });
  ensureAppShellPlaceholder();
  ensurePanelShellPlaceholder();
}

/**
 * embed/app/dist/index.html — собранный shell iframe-приложения; появится
 * только после T6 (`vite build` в embed/app). appPageRoutes (T5) читает его
 * напрямую с диска синхронно с первым запросом: без файла КАЖДЫЙ тест
 * `GET /app/:token` падает ENOENT ещё до проверяемой логики (CSP/frame-
 * ancestors/токен). `dist/` — build-артефакт и намеренно не коммитится
 * (корневой .gitignore), поэтому синтетическая заглушка та же, что опишет T6
 * в `embed/app/index.html` (`<div id="app" data-widget-token="">`),
 * создаётся здесь при старте тестового прогона и НЕ трогает git — T6
 * перезапишет её настоящей сборкой через `vite build`.
 */
function ensureAppShellPlaceholder(): void {
  const dir = fileURLToPath(new URL('../../../embed/app/dist/', import.meta.url));
  const file = `${dir}index.html`;
  if (existsSync(file)) return;
  mkdirSync(`${dir}assets`, { recursive: true });
  writeFileSync(
    file,
    '<!doctype html><html lang="ru"><head><meta charset="UTF-8" /></head>'
      + '<body><div id="app" data-widget-token=""></div></body></html>\n',
  );
}

/**
 * То же самое для SPA кабинета: `panel/dist/` — build-артефакт (`vite build`
 * в воркспейсе `panel`), в git его нет, а `@fastify/static` в panelApp.ts
 * падает ПРИ РЕГИСТРАЦИИ, если корня не существует — то есть без заглушки не
 * поднимается ВЕСЬ тестовый инстанс, а не только тесты панели. Каталог
 * `assets/` нужен отдельно: на нём стоит проверка «протухший чанк отдаёт 404».
 */
function ensurePanelShellPlaceholder(): void {
  const dir = fileURLToPath(new URL('../../../panel/dist/', import.meta.url));
  mkdirSync(`${dir}assets`, { recursive: true });
  // Хэшированный чанк с ИМЕНЕМ ПО ШАБЛОНУ Vite 7 (`<имя>-<хэш>.js`): на нём
  // держится проверка иммутабельного кэша, и без него правило заголовков
  // можно было бы сломать, ничего не уронив.
  const chunk = `${dir}assets/${PANEL_TEST_CHUNK}`;
  if (!existsSync(chunk)) writeFileSync(chunk, 'export const placeholder = true;\n');

  const file = `${dir}index.html`;
  if (existsSync(file)) return;
  writeFileSync(
    file,
    '<!doctype html><html lang="ru"><head><meta charset="UTF-8" /><title>Vell — кабинет</title></head>'
      + '<body><div id="panel"></div></body></html>\n',
  );
}

/** Имя чанка-заглушки: используется тестом раздачи панели. */
export const PANEL_TEST_CHUNK = 'placeholder-Zz09Aa18.js';
