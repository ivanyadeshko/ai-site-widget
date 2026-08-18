import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { promisify } from 'node:util';

/**
 * Хэширование паролей аккаунтов витрины.
 *
 * Почему scrypt, а не argon2id (решение D-1 плана, отклонение от буквы
 * задания): в `node:crypto` argon2id НЕТ вообще. Внешние пакеты (`argon2`
 * через node-gyp, `@node-rs/argon2` через napi) потребовали бы musl-prebuild
 * ровно под связку node/napi рантайм-стадии образа (`node:22-alpine`,
 * `npm ci --omit=dev`, без python3/make/g++) — новый класс отказов деплоя.
 * scrypt памяте-твёрдый и в дереве Node. Формат версионирован, поэтому
 * переход на argon2id позже — аддитивная правка verifyPassword.
 */
// Явная сигнатура: promisify выбирает перегрузку БЕЗ options и tsc роняет
// вызов с четвёртым аргументом (TS2554), хотя рантайм-контракт node:crypto
// именно четырёхаргументный.
const scrypt = promisify(scryptCb) as (
  password: string, salt: Buffer, keylen: number, options: ScryptOptions,
) => Promise<Buffer>;

const ALGO = 'scrypt';
const N = 32_768;
const R = 8;
const P = 1;
const KEYLEN = 32;
// Дефолтный maxmem Node — 32 МБ, а scrypt требует 128*N*r ≈ 33.5 МБ: без
// явного значения вызов падает ERR_CRYPTO_INVALID_SCRYPT_PARAM.
const MAXMEM = 96 * 1024 * 1024;

export const PASSWORD_MIN = 10;
const PASSWORD_MAX = 200;

/** Формат: `scrypt$N$r$p$<saltB64>$<hashB64>` — параметры читаются из строки. */
export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(plain, salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return [ALGO, N, R, P, salt.toString('base64'), hash.toString('base64')].join('$');
}

/**
 * Никогда не бросает: строка `stored` приходит из БД и может быть чем угодно —
 * в т.ч. 'locked' у системного аккаунта. Исключение здесь превратило бы
 * попытку входа в 500 и стало бы оракулом существования аккаунта.
 */
export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6) return false;
  const [algo, rawN, rawR, rawP, saltB64, hashB64] = parts as [string, string, string, string, string, string];
  if (algo !== ALGO) return false;

  const n = Number(rawN);
  const r = Number(rawR);
  const p = Number(rawP);
  // scrypt требует N — степень двойки > 1; нечисловые/нулевые параметры
  // (например 'scrypt$0$8$1$…') обязаны дать false, а не исключение.
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  if (n < 2 || (n & (n - 1)) !== 0 || r < 1 || p < 1) return false;

  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(hashB64, 'base64');
  // Длина ключа НЕ берётся из самой строки, а прибита к KEYLEN версии `scrypt`.
  // Иначе усечённый хэш проходит проверку: финальный шаг scrypt — PBKDF2, и
  // вывод меньшей длины является ПРЕФИКСОМ полного, то есть обрезав base64 до
  // 30 байт злоумышленник получил бы совпадение на 30 из 32 байт. Смена keylen
  // в будущем = новый тег алгоритма, а не молчаливое ослабление проверки.
  if (salt.length === 0 || expected.length !== KEYLEN) return false;

  let actual: Buffer;
  try {
    actual = await scrypt(plain, salt, KEYLEN, { N: n, r, p, maxmem: MAXMEM });
  } catch {
    return false;
  }
  // timingSafeEqual бросает на буферах РАЗНОЙ длины, поэтому длину сверяем до
  // вызова; сам секрет сравнивается постоянным временем.
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

/** `null` = пароль годен. Кириллица здесь — тело JSON, не заголовок (Constraint 11). */
export function passwordPolicyError(plain: string): string | null {
  if (plain.length < PASSWORD_MIN) return `Пароль короче ${PASSWORD_MIN} символов.`;
  if (plain.length > PASSWORD_MAX) return `Пароль длиннее ${PASSWORD_MAX} символов.`;
  if (/^\d+$/.test(plain)) return 'Пароль не может состоять из одних цифр.';
  return null;
}
