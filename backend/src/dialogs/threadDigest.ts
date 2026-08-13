/** Потолок ядра: инструкции уезжают в метаданные комнаты LiveKit. */
export const INSTRUCTIONS_MAX = 32_000;
/** Сколько последних реплик нити кладём в выжимку (P1-8 спеки). */
export const DIGEST_MAX_MESSAGES = 30;

export type ThreadLine = { role: 'user' | 'agent'; text: string };

const HEADER =
  '\n\n[Ниже — краткая выжимка предыдущей части этого же разговора с посетителем. ' +
  'Это память, а не реплика: не зачитывай её вслух и не пересказывай.]\n';
const PENDING_PREFIX = '\n[Ещё не попавшая в историю последняя реплика посетителя: ';

const render = (line: ThreadLine): string =>
  `${line.role === 'user' ? 'Посетитель' : 'Аватар'}: ${line.text}`;

/**
 * `continue_from` НЕтранзитивен и засевает лишь ~24 реплики предшественника, а
 * нить виджета дробится idle-закрытиями. «Одна правда» о нити живёт у BFF,
 * поэтому выжимку в инструкции досыпаем мы.
 */
export function buildContinuationInstructions(
  base: string,
  thread: ThreadLine[],
  pendingUserText?: string,
): string {
  if (base.length >= INSTRUCTIONS_MAX) return base.slice(0, INSTRUCTIONS_MAX);
  if (thread.length === 0 && !pendingUserText) return base;

  const tail = thread.slice(-DIGEST_MAX_MESSAGES);
  const pending = pendingUserText ? `${PENDING_PREFIX}«${pendingUserText}»]` : '';

  // Режем выжимку С ГОЛОВЫ (старое менее ценно), база и хвост неприкосновенны.
  for (let from = 0; from <= tail.length; from += 1) {
    const lines = tail.slice(from).map(render).join('\n');
    const candidate = lines === '' && pending === ''
      ? base
      : `${base}${HEADER}${lines}${pending}`;
    if (candidate.length <= INSTRUCTIONS_MAX) return candidate;
  }
  // Даже пустая выжимка не влезла — значит место съел pending: отдаём базу.
  return base.slice(0, INSTRUCTIONS_MAX);
}
