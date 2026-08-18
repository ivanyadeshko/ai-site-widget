import type { Queryable } from '../pool.ts';

export type AuthFailureRow = {
  subject_key: string;
  failures: number;
  first_failure_at: Date;
  locked_until: Date | null;
};

/**
 * Инкремент счётчика неудач ОДНИМ statement'ом: параллельные попытки не должны
 * терять инкременты (read-modify-write в приложении их теряет). По достижении
 * порога ставится окно блокировки. Возвращает состояние ПОСЛЕ инкремента.
 *
 * ⚠️ ОТСИДЕВШЕЕ ОКНО ОБНУЛЯЕТ СЧЁТЧИК (фикс DoS, находка кросс-ревью потока I).
 * Раньше `failures` рос вечно, а значит КАЖДАЯ неудача после порога заново
 * отодвигала `locked_until`: посторонний, знающий чужой email, одной неверной
 * попыткой раз в 15 минут держал владельца вне панели бесконечно — при том,
 * что восстановления пароля у витрины нет вовсе (D-4). Теперь первая неудача
 * ПОСЛЕ истечения окна начинает отсчёт заново, ровно как у пришедшего впервые:
 * ключ счётчика задаёт АТАКУЮЩИЙ (это email из тела запроса), поэтому
 * «наказание копится» било по жертве, а не по нему.
 *
 * Настоящий перебор от этого не выигрывает: чтобы снова закрыть вход, ему
 * по-прежнему нужны `maxFailures` попыток, и все — внутри одного окна.
 */
export async function bumpFailure(
  db: Queryable,
  key: string,
  maxFailures: number,
  lockMinutes: number,
): Promise<{ failures: number; lockedUntil: Date | null }> {
  const { rows } = await db.query<{ failures: number; locked_until: Date | null }>(
    // «Окно отсидено» = `locked_until` БЫЛО и уже прошло. Отсутствие окна
    // (NULL) отсидкой не считается — иначе счётчик до порога обнулялся бы на
    // каждой попытке и блокировка не наступала бы никогда. Условие повторено в
    // трёх ветках, а не вынесено: в одном statement'е сослаться на соседнее
    // присваивание нельзя, а разложить на CTE — потерять атомарность UPSERT'а.
    `INSERT INTO auth_failures (subject_key, failures, first_failure_at)
     VALUES ($1, 1, now())
     ON CONFLICT (subject_key) DO UPDATE
       SET failures = CASE
             WHEN auth_failures.locked_until IS NOT NULL AND auth_failures.locked_until <= now() THEN 1
             ELSE auth_failures.failures + 1
           END,
           first_failure_at = CASE
             WHEN auth_failures.locked_until IS NOT NULL AND auth_failures.locked_until <= now() THEN now()
             ELSE auth_failures.first_failure_at
           END,
           locked_until = CASE
             WHEN (CASE
                     WHEN auth_failures.locked_until IS NOT NULL AND auth_failures.locked_until <= now() THEN 1
                     ELSE auth_failures.failures + 1
                   END) >= $2 THEN now() + ($3 || ' minutes')::interval
             WHEN auth_failures.locked_until IS NOT NULL AND auth_failures.locked_until <= now() THEN NULL
             ELSE auth_failures.locked_until
           END
     RETURNING failures, locked_until`,
    [key, maxFailures, String(lockMinutes)],
  );
  const row = rows[0]!;
  return { failures: row.failures, lockedUntil: row.locked_until };
}

export async function isLocked(db: Queryable, key: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `SELECT 1 FROM auth_failures WHERE subject_key = $1 AND locked_until > now()`,
    [key],
  );
  return (rowCount ?? 0) > 0;
}

/** Успешный вход = чистый лист. Строку удаляем: держать её незачем. */
export async function clearFailures(db: Queryable, key: string): Promise<void> {
  await db.query(`DELETE FROM auth_failures WHERE subject_key = $1`, [key]);
}

/**
 * Ключ субъекта задаёт АТАКУЮЩИЙ (это произвольный email из тела запроса), то
 * есть таблица растёт настолько, насколько ему хватит терпения. Метём строки,
 * у которых и окно блокировки истекло, и последней активности давно не было.
 */
export async function purgeStaleAuthFailures(db: Queryable, keepDays: number): Promise<number> {
  const { rowCount } = await db.query(
    `DELETE FROM auth_failures
      WHERE (locked_until IS NULL OR locked_until <= now())
        AND first_failure_at < now() - ($1 || ' days')::interval`,
    [String(keepDays)],
  );
  return rowCount ?? 0;
}
