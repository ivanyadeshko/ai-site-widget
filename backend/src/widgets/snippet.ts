/**
 * Готовый `<script>` для вставки на сайт владельца.
 *
 * Это ЕДИНСТВЕННОЕ место, где собирается сниппет: панель, README и e2e берут
 * его отсюда, а не склеивают у себя. Сегодня собрать его руками — гэп 14
 * разведки: владельцу приходилось знать и адрес CDN, и когда нужен `data-host`.
 *
 * ⚠️ Отклонение от буквы интерфейса плана (`buildEmbedSnippet({token, cdnOrigin})`):
 * функция принимает ещё и `publicOrigin`. Без него нельзя выполнить второе
 * требование той же задачи — «при cdnOrigin, отличном от publicOrigin,
 * добавить data-host»: сравнивать было бы не с чем.
 */

/**
 * Экранирование значения HTML-атрибута.
 *
 * `generatePublishToken` (Task 6) кавычек не порождает, но функция обязана быть
 * безопасной сама по себе: её зовут из панели, из e2e и позовут из шаблона
 * лендинга, а токен туда может приехать откуда угодно.
 */
const attr = (value: string): string => value
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;');

export function buildEmbedSnippet(input: {
  token: string; cdnOrigin: string; publicOrigin: string;
}): string {
  const cdn = input.cdnOrigin.replace(/\/+$/, '');
  const api = input.publicOrigin.replace(/\/+$/, '');
  // data-host нужен ТОЛЬКО на разъехавшихся доменах. Шим считает base из
  // `me.src` (embed/loader/scripts/make-shim.mjs:13), поэтому на раскладке
  // cdn.vell.pro + app.vell.pro без него лоадер бил бы `/w/v1/...` в CDN-хост,
  // где API нет вовсе. На однодоменной раскладке атрибут был бы шумом в чужом
  // HTML — и лишним поводом ошибиться при ручной правке.
  const host = cdn === api ? '' : ` data-host="${attr(`${api}/`)}"`;
  return `<script src="${attr(`${cdn}/w.js`)}" data-widget="${attr(input.token)}"${host} async></script>`;
}
