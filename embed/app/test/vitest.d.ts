import 'vitest';

// Порядковый матчер (в vitest его нет из коробки; регистрируется в helpers/mount.ts).
// invocationCallOrder первого вызова received должен быть меньше, чем у other.
interface CallOrderMatchers<R = void> {
  toHaveBeenCalledBefore(other: unknown): R;
}

declare module 'vitest' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  interface Matchers<T = any> extends CallOrderMatchers<T> {}
}
