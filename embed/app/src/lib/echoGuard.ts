/** Воркер шлёт обратно и реплику посетителя (transcript speaker=respondent). */
export const normalizeEcho = (text: string): string => text.trim().replace(/\s+/g, ' ').toLowerCase();

export type EchoGuard = { remember(text: string): void; isEcho(text: string): boolean };

export function createEchoGuard(opts: { windowMs: number; now: () => number }): EchoGuard {
  const pending: { key: string; at: number }[] = [];
  return {
    remember(text) {
      pending.push({ key: normalizeEcho(text), at: opts.now() });
    },
    isEcho(text) {
      const key = normalizeEcho(text);
      const now = opts.now();
      const index = pending.findIndex((item) => item.key === key && now - item.at <= opts.windowMs);
      if (index === -1) return false;
      // Гасим ОДНУ запись: повторное такое же сообщение — уже настоящая реплика.
      pending.splice(index, 1);
      return true;
    },
  };
}
