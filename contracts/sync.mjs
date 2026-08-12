#!/usr/bin/env node
// Тянем контракт ЯДРА строго из origin/main: локальный чекаут отстаёт (спека §0).
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { argv } from 'node:process';

// Дефолт резолвится ОТ РАСПОЛОЖЕНИЯ СКРИПТА (как TARGET ниже), а не от cwd
// процесса: npm-скрипт вызывается из backend/ (`cd backend && npm run
// contracts:sync`), и относительный '../ai-conversation-core' от cwd
// backend/ упирался бы в несуществующий ai-site-widget/ai-conversation-core
// вместо реального соседа ai-site-widget — на уровень выше.
const CORE_REPO = process.env.CORE_REPO ?? new URL('../../ai-conversation-core', import.meta.url).pathname;
const TARGET = new URL('./openapi.core.yaml', import.meta.url).pathname;

execFileSync('git', ['-C', CORE_REPO, 'fetch', 'origin', '--quiet'], { stdio: 'inherit' });
const fresh = execFileSync('git', ['-C', CORE_REPO, 'show', 'origin/main:contracts/openapi.yaml'], {
  encoding: 'utf8',
  maxBuffer: 32 * 1024 * 1024,
});
const sha = execFileSync('git', ['-C', CORE_REPO, 'rev-parse', '--short', 'origin/main'], { encoding: 'utf8' }).trim();

if (argv.includes('--check')) {
  const current = readFileSync(TARGET, 'utf8');
  if (current !== fresh) {
    console.error(`Контракт ядра разъехался с origin/main (${sha}). Запусти: node contracts/sync.mjs`);
    process.exit(1);
  }
  console.log(`Контракт совпадает с origin/main (${sha}).`);
} else {
  writeFileSync(TARGET, fresh);
  console.log(`Контракт обновлён до origin/main (${sha}).`);
}
