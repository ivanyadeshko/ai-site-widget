import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyCoreSignature } from '../src/core/signature.ts';

const SECRET = 'секрет-длиной-больше-шестнадцати';
const RAW = Buffer.from('{"api_version":"v1","event_id":"evt_1","type":"session.finalized"}', 'utf8');
const NOW = 1_760_000_000_000;

const sign = (t: number, raw = RAW, secret = SECRET): string =>
  `t=${t},v1=${createHmac('sha256', secret).update(Buffer.concat([Buffer.from(`${t}.`), raw])).digest('hex')}`;

describe('verifyCoreSignature', () => {
  it('принимает валидную подпись', () => {
    const t = Math.floor(NOW / 1000);
    expect(verifyCoreSignature(RAW, sign(t), SECRET, NOW)).toEqual({ ok: true });
  });

  it('разбирает заголовок ПО КЛЮЧАМ — лишние версии не мешают', () => {
    const t = Math.floor(NOW / 1000);
    const header = `${sign(t)},v2=deadbeef`;
    expect(verifyCoreSignature(RAW, header, SECRET, NOW)).toEqual({ ok: true });
  });

  it('порядок ключей тоже не важен', () => {
    const t = Math.floor(NOW / 1000);
    const [tPart, v1Part] = sign(t).split(',');
    expect(verifyCoreSignature(RAW, `${v1Part},${tPart}`, SECRET, NOW)).toEqual({ ok: true });
  });

  it('отвергает подпись чужим секретом', () => {
    const t = Math.floor(NOW / 1000);
    const res = verifyCoreSignature(RAW, sign(t, RAW, 'другой-секрет-подлиннее'), SECRET, NOW);
    expect(res).toEqual({ ok: false, reason: 'hmac_mismatch' });
  });

  it('отвергает повтор старше окна ±300с', () => {
    const t = Math.floor(NOW / 1000) - 301;
    expect(verifyCoreSignature(RAW, sign(t), SECRET, NOW)).toEqual({ ok: false, reason: 'timestamp_out_of_window' });
  });

  it('отвергает метку из будущего дальше окна', () => {
    const t = Math.floor(NOW / 1000) + 301;
    expect(verifyCoreSignature(RAW, sign(t), SECRET, NOW)).toEqual({ ok: false, reason: 'timestamp_out_of_window' });
  });

  it('подпись считается по СЫРЫМ байтам: пересериализация тела её ломает', () => {
    const t = Math.floor(NOW / 1000);
    const header = sign(t);
    const reserialized = Buffer.from(JSON.stringify(JSON.parse(RAW.toString('utf8')), null, 2), 'utf8');
    expect(verifyCoreSignature(reserialized, header, SECRET, NOW)).toEqual({ ok: false, reason: 'hmac_mismatch' });
  });

  it('без заголовка и с мусором — отказ', () => {
    expect(verifyCoreSignature(RAW, undefined, SECRET, NOW)).toEqual({ ok: false, reason: 'missing_header' });
    expect(verifyCoreSignature(RAW, 'мусор', SECRET, NOW)).toEqual({ ok: false, reason: 'malformed_header' });
    expect(verifyCoreSignature(RAW, 't=abc,v1=ff', SECRET, NOW)).toEqual({ ok: false, reason: 'malformed_header' });
  });

  it('подпись неверной ДЛИНЫ отвергается до сравнения, а не кидает исключение', () => {
    const t = Math.floor(NOW / 1000);
    // timingSafeEqual кидает RangeError на буферах разной длины — реализация
    // обязана проверить длину САМА и вернуть вердикт, а не упасть.
    expect(verifyCoreSignature(RAW, `t=${t},v1=ab`, SECRET, NOW)).toEqual({ ok: false, reason: 'hmac_mismatch' });
  });
});
