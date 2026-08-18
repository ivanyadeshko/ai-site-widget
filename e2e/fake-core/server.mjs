// e2e/fake-core/server.mjs — фейк ядра ТОЛЬКО для e2e. Живой node:http,
// без зависимостей: точно так же, как backend/test/helpers/fakeCore.ts,
// и по той же причине (Constraint 6) — CoreClient ходит глобальным fetch.
import { createHmac, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

const SECRET = process.env.CORE_WEBHOOK_SECRET ?? 'e2e-core-webhook-secret';
const BFF_URL = process.env.BFF_URL ?? 'http://backend:8200';
const USAGE = { chat_tokens_in: 1200, chat_tokens_out: 340, session_seconds: 95 };
const CREDITS = 12;                       // INTEGER-колонка, не дробное

/** session_id → карточка; client_reference помним, чтобы финализировать по нему. */
const sessions = new Map();
const byRef = new Map();

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(status === 204 ? '' : JSON.stringify(body));
};

const readJson = async (req) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
};

const token = () => ({
  token: 'e2e.fake.jwt', identity: `respondent-${randomUUID()}`,
  livekit_url: 'wss://livekit.invalid',
  expires_at: new Date(Date.now() + 3_600_000).toISOString(),
});

/** Подпись ядра: t=<unix>,v1=hex(hmac(secret, "<t>." + СЫРЫЕ байты тела)) — signature.ts:35-37. */
const sign = (raw) => {
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac('sha256', SECRET)
    .update(Buffer.concat([Buffer.from(`${t}.`, 'utf8'), raw])).digest('hex');
  return `t=${t},v1=${v1}`;
};

/** Доставка session.finalized СИНХРОННО: тест ждёт ответ BFF, а не таймер. */
const deliverFinalized = async (card) => {
  card.status = 'finalized';
  const envelope = {
    api_version: 'v1',
    event_id: randomUUID(),               // дедуп у BFF идёт по event_id
    type: 'session.finalized',
    created: new Date().toISOString(),
    data: {
      session_id: card.session_id,
      client_reference: card.client_reference,
      status: 'finalized',
      duration_s: USAGE.session_seconds,
      credits_total: CREDITS,
      usage_summary: USAGE,
    },
  };
  const raw = Buffer.from(JSON.stringify(envelope), 'utf8');
  const res = await fetch(`${BFF_URL}/w/v1/core-webhooks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-core-signature': sign(raw) },
    body: raw,
  });
  return { bff_status: res.status, bff_body: await res.text() };
};

const handle = async (req, res) => {
  const path = new URL(req.url ?? '/', 'http://fake-core').pathname;
  const one = (re) => re.exec(path)?.[1];

  if (req.method === 'POST' && path === '/api/v1/sessions') {
    const body = await readJson(req);
    const id = `sess_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const card = {
      session_id: id, channel: body.channel ?? 'chat', status: 'active',
      client_reference: body.client_reference ?? null,
    };
    sessions.set(id, card);
    if (card.client_reference) byRef.set(card.client_reference, card);
    return json(res, 201, { session_id: id, participant_token: token() });
  }

  const tokenFor = one(/^\/api\/v1\/sessions\/([^/]+)\/participant-tokens$/);
  if (req.method === 'POST' && tokenFor) {
    return sessions.has(tokenFor)
      ? json(res, 201, token())
      : json(res, 404, { error: { code: 'session_not_found', message: 'нет такой сессии' } });
  }

  const ending = one(/^\/api\/v1\/sessions\/([^/]+)\/end$/);
  if (req.method === 'POST' && ending) {
    const card = sessions.get(ending);
    if (card) card.status = 'finalized';   // карточка сведена; деньги — вебхуком
    return json(res, 204, null);
  }

  const transcript = one(/^\/api\/v1\/sessions\/([^/]+)\/transcript$/);
  if (req.method === 'GET' && transcript) return json(res, 200, { messages: [], has_more: false });

  const card = one(/^\/api\/v1\/sessions\/([^/]+)$/);
  if (req.method === 'GET' && card) {
    const found = sessions.get(card);
    if (!found) return json(res, 404, { error: { code: 'session_not_found', message: 'нет такой сессии' } });
    const settled = found.status === 'finalized';
    return json(res, 200, {
      session_id: found.session_id,
      channel: found.channel,
      status: found.status,
      ...(found.client_reference ? { client_reference: found.client_reference } : {}),
      duration_s: settled ? USAGE.session_seconds : 0,
      credits_total: settled ? CREDITS : 0,
      usage_summary: settled ? USAGE : {},
    });
  }

  // ── СЛУЖЕБНАЯ ручка фейка (в прод-коде её нет и быть не может) ──
  if (req.method === 'POST' && path === '/__test__/finalize') {
    const { client_reference: ref } = await readJson(req);
    const target = byRef.get(ref);
    if (!target) return json(res, 404, { error: { code: 'unknown_reference', message: ref } });
    return json(res, 200, await deliverFinalized(target));
  }

  return json(res, 404, { error: { code: 'not_found', message: path } });
};

createServer((req, res) => {
  void handle(req, res).catch((err) => json(res, 500, { error: { code: 'fake_crash', message: String(err) } }));
}).listen(8000, '0.0.0.0');
