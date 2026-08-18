import type { WidgetRow } from '../db/repositories/widgets.ts';

/** Нормализация: схема+хост в нижний регистр, хвостовой слэш срезан, порт значим. */
export function normalizeOrigin(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}`;
  } catch {
    return raw.trim().replace(/\/+$/, '').toLowerCase();
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD']);

export function originVerdict(
  widget: Pick<WidgetRow, 'allowed_origins'>,
  // `appOrigin` — origin, с которого отдаётся сам iframe `/app/:token`, и он
  // доверен ВСЕГДА: запрос из нашей собственной страницы обязан проходить,
  // даже если владелец сайта не вписал наш домен в свой `allowed_origins`.
  // На мультидоменной раскладке это именно APP-хост, а не CDN: с cdn.vell.pro
  // в API не ходит никто (там только статика), и доверять ему было бы
  // расширением guard'а впустую.
  ctx: { origin: string | undefined; appOrigin: string; method: string },
): 'allow' | 'deny' {
  // Пустой список = виджет не настроен ни на один сайт → закрыт весь публичный
  // путь. Это ЯВНОЕ отличие от монолита, где пустой список значил «любой».
  if (widget.allowed_origins.length === 0) return 'deny';

  if (ctx.origin === undefined) {
    // Fetch-спека обязывает браузер слать Origin на КАЖДЫЙ не-GET запрос, в том
    // числе same-origin. Значит отсутствие заголовка на POST — это не браузер, а
    // curl: отказываем. На GET заголовка честно может не быть (same-origin), и
    // там пропускаем — иначе iframe не прочитает собственную историю.
    return SAFE_METHODS.has(ctx.method.toUpperCase()) ? 'allow' : 'deny';
  }

  const wanted = normalizeOrigin(ctx.origin);
  const allowed = widget.allowed_origins.map(normalizeOrigin);
  return wanted === normalizeOrigin(ctx.appOrigin) || allowed.includes(wanted) ? 'allow' : 'deny';
}
