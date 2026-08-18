#!/usr/bin/env node
// Синхронизация вендорённой копии контракта ЯДРА (contracts/openapi.core.yaml)
// с ПИНОМ — contracts/core.pin.json.
//
// Почему пин, а не `origin/main` ядра (как было до этого файла):
//
//   1. Дрейф не ловился. Источником была ПЛАВАЮЩАЯ ссылка origin/main: любой
//      мёрж в ядро сдвигал её, и `--check` начинал падать на ветке виджета,
//      которую никто не трогал. Красный CI без изменений в репозитории — это
//      не гейт, это шум, который приучают игнорировать. С пином источник
//      неподвижен: спека меняется только вместе с core.pin.json, отдельным
//      коммитом (обычно авто-PR из core-pin-bump.yml), и красный `--check`
//      всегда означает ровно одно — вендорённая копия разъехалась с пином.
//
//   2. Проверка была структурно незапускаема в CI. `git -C ../ai-conversation-core`
//      требует СОСЕДНЕГО ЧЕКАУТА ядра рядом с чекаутом виджета. На раннере его
//      нет и быть не может (ядро — приватный репозиторий), поэтому шаг
//      `contracts:check` в ci.yml просто не существовал: гейт жил только в
//      голове разработчика. Отсюда второй режим получения спеки — GitHub
//      Contents API по тому же пину, работающий где угодно, был бы токен.
//
// Режимы получения спеки (CORE_CONTRACTS_SOURCE=auto|git|api, по умолчанию auto):
//   git — локальный чекаут/worktree ядра: `git show <core_sha>:contracts/openapi.yaml`.
//         Быстро, без сети и без токена; берётся, если чекаут есть и в нём
//         ЕСТЬ запиненный коммит (иначе — попытка fetch, потом откат на api).
//   api — GitHub Contents API с ?ref=<core_sha> и токеном GH_TOKEN/GITHUB_TOKEN.
//         Единственный рабочий путь в CI.
//
// Поверх ЛЮБОГО режима — сверка sha256 полученных байтов с `spec_sha256` пина.
// Пин самопроверяем: подменённый по дороге файл (кривой ref, чужой форк,
// перезаписанная история ядра) отваливается ДО того, как попадёт в репозиторий.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { argv, env, exit } from 'node:process';

// Все пути резолвятся ОТ РАСПОЛОЖЕНИЯ СКРИПТА, а не от cwd процесса: npm-скрипт
// вызывается из backend/ (`npm run contracts:sync -w @aski/site-widget-backend`),
// и относительный путь от cwd backend/ упирался бы не туда.
const PIN_PATH = new URL('./core.pin.json', import.meta.url).pathname;
const TARGET = new URL('./openapi.core.yaml', import.meta.url).pathname;
// Сосед ЧЕКАУТА ВИДЖЕТА (на уровень выше корня репозитория), а не соседняя
// папка внутри него.
const CORE_REPO = env.CORE_REPO ?? new URL('../../ai-conversation-core', import.meta.url).pathname;
const CORE_SLUG = env.CORE_REPO_SLUG ?? 'ivanyadeshko/ai-conversation-core';
const SPEC_PATH = 'contracts/openapi.yaml';
const SOURCE = env.CORE_CONTRACTS_SOURCE ?? 'auto';
const CHECK = argv.includes('--check');

const die = (msg) => {
  console.error(msg);
  exit(1);
};

// ---------------------------------------------------------------- пин
if (!existsSync(PIN_PATH)) {
  die(`Нет файла пина ${PIN_PATH}. Он обязателен: без него неизвестно, какой коммит ядра считать правдой.`);
}
let pin;
try {
  pin = JSON.parse(readFileSync(PIN_PATH, 'utf8'));
} catch (e) {
  die(`Пин ${PIN_PATH} не читается как JSON: ${e.message}`);
}
// Формат проверяем строго: пин уезжает в shell-команды и в URL, а обновляет его
// в том числе автоматика (core-pin-bump.yml по repository_dispatch от ядра).
if (!/^[0-9a-f]{40}$/.test(pin.core_sha ?? '')) {
  die(`Пин: core_sha должен быть полным 40-символьным sha, получено ${JSON.stringify(pin.core_sha)}`);
}
if (!/^[0-9a-f]{64}$/.test(pin.spec_sha256 ?? '')) {
  die(`Пин: spec_sha256 должен быть 64-символьным hex sha256, получено ${JSON.stringify(pin.spec_sha256)}`);
}
const shortSha = pin.core_sha.slice(0, 7);

// ------------------------------------------------- источник (а): локальный git
function coreCheckoutHasPin() {
  try {
    execFileSync('git', ['-C', CORE_REPO, 'cat-file', '-e', `${pin.core_sha}^{commit}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function fromGit() {
  // Локальный чекаут может отставать от пина (пин обновляется авто-PR'ом сразу
  // после релиза ядра) — тогда один fetch и повторная проверка.
  if (!coreCheckoutHasPin()) {
    try {
      execFileSync('git', ['-C', CORE_REPO, 'fetch', 'origin', '--quiet'], { stdio: 'inherit' });
    } catch {
      /* нет сети/прав — решит следующая проверка */
    }
    if (!coreCheckoutHasPin()) return null;
  }
  return execFileSync('git', ['-C', CORE_REPO, 'show', `${pin.core_sha}:${SPEC_PATH}`], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
}

// ------------------------------------------------------ источник (б): GitHub API
async function fromApi() {
  // Токен ОБЯЗАТЕЛЕН: ядро — приватный репозиторий, анонимный запрос получит 404
  // (GitHub не подтверждает существование приватных репозиториев).
  const token = env.GH_TOKEN || env.GITHUB_TOKEN;
  if (!token) {
    die(
      [
        'Нет ни локального чекаута ядра, ни токена — спеку взять неоткуда.',
        `Локально: держите чекаут ядра рядом (${CORE_REPO}) или укажите CORE_REPO=<путь>.`,
        'В CI: заведите секрет CORE_CONTRACTS_TOKEN (fine-grained PAT, read-only Contents на',
        `${CORE_SLUG}) и пробросьте его как GH_TOKEN.`,
      ].join('\n'),
    );
  }
  const url = `https://api.github.com/repos/${CORE_SLUG}/contents/${SPEC_PATH}?ref=${pin.core_sha}`;
  // Штатный fetch Node 22+, а не curl: токен не попадает в argv (и значит — в
  // `ps` и в трейсы шелла), а обработка кодов ответа осмысленная.
  let res;
  try {
    res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        // raw — ровно те байты файла, без base64-обёртки Contents API.
        Accept: 'application/vnd.github.raw',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'ai-site-widget/contracts-sync',
      },
    });
  } catch (e) {
    die(`Сеть до api.github.com недоступна: ${e.message}`);
  }
  if (res.status === 401) {
    die('GitHub API 401: токен невалиден или протух (GH_TOKEN/GITHUB_TOKEN).');
  }
  if (res.status === 403) {
    die(`GitHub API 403: токену не хватает прав на ${CORE_SLUG} (нужен read-only Contents) либо исчерпан лимит.`);
  }
  if (res.status === 404) {
    die(
      [
        `GitHub API 404 на ${CORE_SLUG}@${shortSha}:${SPEC_PATH}.`,
        'Причин две, обе вероятны: (1) токен не видит приватное ядро — так ведёт себя',
        'штатный github.token публичного репозитория виджета, ему нужен CORE_CONTRACTS_TOKEN;',
        '(2) коммита из пина в ядре нет (переписанная история, чужой форк).',
      ].join('\n'),
    );
  }
  if (!res.ok) {
    die(`GitHub API ${res.status} ${res.statusText} на ${url}`);
  }
  return await res.text();
}

// ------------------------------------------------------------------ получение
let spec = null;
let via = null;

if (SOURCE !== 'api' && existsSync(CORE_REPO)) {
  spec = fromGit();
  if (spec !== null) via = `локальный чекаут ${CORE_REPO}`;
  else if (SOURCE === 'git') die(`Чекаут ${CORE_REPO} есть, но коммита ${shortSha} в нём нет даже после fetch.`);
}
if (spec === null) {
  if (SOURCE === 'git') die(`CORE_CONTRACTS_SOURCE=git, но локального чекаута ядра нет: ${CORE_REPO}`);
  spec = await fromApi();
  via = `GitHub API ${CORE_SLUG}@${shortSha}`;
}

// --------------------------------------------------------- самопроверка пина
const got = createHash('sha256').update(spec, 'utf8').digest('hex');
if (got !== pin.spec_sha256) {
  die(
    [
      `ПИН ЛЖЁТ: spec_sha256 в core.pin.json не совпал с фактическим содержимым ${SPEC_PATH} ядра.`,
      `  пин:  ${pin.spec_sha256}`,
      `  факт: ${got}`,
      `  коммит ядра: ${pin.core_sha}`,
      `  источник: ${via}`,
      'Это НЕ рядовой дрейф контракта, а испорченный пин: sha256 обязан быть посчитан',
      'по файлу ровно на этом коммите. Пересоберите пин или откатите его изменение.',
    ].join('\n'),
  );
}

// ------------------------------------------------------------ сверка / запись
if (CHECK) {
  const current = existsSync(TARGET) ? readFileSync(TARGET, 'utf8') : null;
  if (current !== spec) {
    die(
      [
        `Контракт ядра разъехался с пином (${shortSha}, образ ${pin.core_image_tag ?? '—'}).`,
        `Вендорённая копия ${TARGET} не совпадает с ${SPEC_PATH}@${pin.core_sha}.`,
        'Почини: npm run contracts:sync -w @aski/site-widget-backend (и закоммить contracts/).',
      ].join('\n'),
    );
  }
  console.log(`Контракт совпадает с пином ${shortSha} (${pin.core_image_tag ?? '—'}), источник: ${via}.`);
} else {
  writeFileSync(TARGET, spec);
  console.log(`Контракт обновлён до пина ${shortSha} (${pin.core_image_tag ?? '—'}), источник: ${via}.`);
}
