#!/usr/bin/env node
/**
 * Выдача прав администратора витрины.
 *
 *   DATABASE_URL=... node backend/scripts/grant-admin.mjs <email>
 *   docker compose exec widget-backend npm run grant-admin -- <email>
 *
 * ПОЧЕМУ CLI, А НЕ ЭКРАН В ПАНЕЛИ. Первого админа назначить неоткуда: админка
 * требует админа. Правило «первый зарегистрировавшийся становится админом»
 * на публичном URL — это дыра размером с продукт (любой, кто откроет свежий
 * стенд раньше владельца, получает оператора витрины). Значит — доступ к
 * серверу как доказательство прав.
 *
 * `.mjs`, а не `.ts`: скрипт запускается голым Node в рантайм-образе
 * (`node:22-alpine`, `npm ci --omit=dev`) — там нет ни tsc, ни vitest, а
 * `--experimental-strip-types` умеет только стирать типы (Constraint 8).
 * Обычный JS снимает вопрос целиком.
 */
import process from 'node:process';
import pg from 'pg';

const email = process.argv[2];

if (!email) {
  process.stderr.write('Использование: node scripts/grant-admin.mjs <email>\n');
  process.exit(2);
}
if (!process.env.DATABASE_URL) {
  process.stderr.write('Не задана переменная окружения DATABASE_URL.\n');
  process.exit(2);
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

try {
  // lower() с обеих сторон — тот же предикат, что и в уникальном индексе
  // accounts_email_unique: адрес, введённый оператором в другом регистре,
  // обязан находить тот же аккаунт, что и форма входа.
  const { rows } = await pool.query(
    'UPDATE accounts SET is_admin = TRUE WHERE lower(email) = lower($1) RETURNING id, email, is_admin',
    [email],
  );
  const account = rows[0];
  if (!account) {
    process.stderr.write(`Аккаунт с почтой ${email} не найден — сначала зарегистрируйтесь в панели.\n`);
    process.exit(1);
  }
  process.stdout.write(`Права администратора выданы: ${account.email} (${account.id}).\n`);
} finally {
  await pool.end();
}
