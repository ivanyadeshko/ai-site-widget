import { createHmac, timingSafeEqual } from 'node:crypto';

export type SignatureVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Проверка подписи ядра. Порядок шагов важен и повторяет инструкцию контракта:
 * заголовок → окно метки → HMAC по СЫРЫМ байтам (до всякого JSON.parse).
 */
export function verifyCoreSignature(
  raw: Buffer,
  header: string | undefined,
  secret: string,
  nowMs: number,
  windowS = 300,
): SignatureVerdict {
  if (!header) return { ok: false, reason: 'missing_header' };

  // Разбор ПО КЛЮЧАМ: рядом с v1 со временем может появиться v2.
  const parts = new Map<string, string>();
  for (const piece of header.split(',')) {
    const eq = piece.indexOf('=');
    if (eq > 0) parts.set(piece.slice(0, eq).trim(), piece.slice(eq + 1).trim());
  }
  const rawT = parts.get('t');
  const v1 = parts.get('v1');
  if (!rawT || !v1 || !/^\d+$/.test(rawT) || !/^[0-9a-f]+$/i.test(v1)) {
    return { ok: false, reason: 'malformed_header' };
  }

  const timestamp = Number.parseInt(rawT, 10);
  if (Math.abs(nowMs / 1000 - timestamp) > windowS) {
    return { ok: false, reason: 'timestamp_out_of_window' };
  }

  const expected = createHmac('sha256', secret)
    .update(Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), raw]))
    .digest();
  const got = Buffer.from(v1, 'hex');
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
    return { ok: false, reason: 'hmac_mismatch' };
  }
  return { ok: true };
}
