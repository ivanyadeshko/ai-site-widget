/**
 * client_ready / resume_welcome теряются, если воркер вошёл в комнату позже нас:
 * LiveKit data-фреймы не буферизуются. Гасим ПОСЛЕ очередной отправки — фрейм
 * воркера доказывает лишь, что он в комнате, а не что НАШ фрейм доехал.
 */
export function createResender(
  send: () => void,
  opts: { intervalMs: number; maxAttempts: number },
): { start(): void; stop(): void; bump(): void } {
  let timer: ReturnType<typeof setInterval> | null = null;
  let sent = 0;
  let acked = false;

  const stop = (): void => {
    if (timer !== null) { clearInterval(timer); timer = null; }
  };

  return {
    start() {
      if (timer !== null) return;
      send(); sent = 1;
      timer = setInterval(() => {
        if (sent >= opts.maxAttempts) { stop(); return; }
        send(); sent += 1;
        if (acked) stop();
      }, opts.intervalMs);
    },
    stop,
    bump() { acked = true; },
  };
}
