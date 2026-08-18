#!/usr/bin/env node
/**
 * Аварийная разблокировка аккаунта витрины.
 *
 *   DATABASE_URL=... node backend/scripts/unblock-account.mjs <email>
 *   docker compose exec widget-backend npm run unblock-account -- <email>
 *
 * ПОЧЕМУ ЭТОТ СКРИПТ ОБЯЗАН СУЩЕСТВОВАТЬ. Разблокировка живёт в админке
 * (`POST /api/v1/admin/accounts/:id/unblock`), но админка требует ЖИВОЙ
 * админской сессии — а блокировка админа её немедленно отзывает. Дальше
 * арифметика: `cannot_block_self` защищает оператора только от себя самого, и
 * при двух администраторах взаимная (или последовательная) блокировка запирает
 * витрину целиком — войти некому. Тот же тупик даёт e2e с сид-админами на
 * дев-стенде. Без скрипта выход отсюда — SQL руками на проде, то есть ровно то,
 * что уже признано неприемлемым для login-lock (см. unlock-login, Task 18).
 *
 * Снимает ОБА замка разом — `blocked_at` и счётчик неудачных входов: человек,
 * которого только что разблокировали, обычно перед этим долбился в пароль, и
 * второй заход в ту же стену выглядит как «скрипт не сработал».
 *
 * Сессии НЕ восстанавливаются: отозванные — отозваны, вход заново. То же
 * поведение, что и у ручки админки, — двух разных семантик у одной операции
 * быть не должно.
 *
 * `.mjs`, а не `.ts`: скрипт запускается голым Node в рантайм-образе
 * (`node:22-alpine`, `npm ci --omit=dev`), где нет ни tsc, ни vitest, а
 * `--experimental-strip-types` умеет только стирать типы (Constraint 8).
 */
import process from 'node:process';
import pg from 'pg';

const email = process.argv[2];

if (!email) {
  process.stderr.write('Использование: node scripts/unblock-account.mjs <email>\n');
  process.exit(2);
}
if (!process.env.DATABASE_URL) {
  process.stderr.write('Не задана переменная окружения DATABASE_URL.\n');
  process.exit(2);
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

try {
  // lower() с обеих сторон — тот же предикат, что и в accounts_email_unique:
  // адрес в другом регистре обязан находить тот же аккаунт, что и форма входа.
  const { rows } = await pool.query(
    'UPDATE accounts SET blocked_at = NULL WHERE lower(email) = lower($1) RETURNING id, email, is_admin',
    [email],
  );
  const account = rows[0];
  if (!account) {
    process.stderr.write(`Аккаунт с почтой ${email} не найден.\n`);
    process.exit(1);
  }

  // Ключ счётчика собирается ровно так же, как в routes/panel/auth.ts, — из
  // email в НИЖНЕМ регистре. В БД лежит исходное написание, поэтому lower()
  // здесь обязателен: иначе скрипт чистил бы несуществующий ключ и «ничего не
  // делал» ровно в тот момент, когда от него ждут результата.
  const cleared = await pool.query(
    'DELETE FROM auth_failures WHERE subject_key = $1',
    [`login:${account.email.toLowerCase()}`],
  );

  process.stdout.write(
    `Аккаунт разблокирован: ${account.email} (${account.id})${account.is_admin ? ', администратор' : ''}.\n`
    + `Блокировок входа снято: ${cleared.rowCount ?? 0}.\n`
    + 'Ранее отозванные сессии не восстанавливаются — нужен повторный вход в панель.\n',
  );
} finally {
  await pool.end();
}
