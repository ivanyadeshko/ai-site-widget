import { execFileSync } from 'node:child_process';

export default function setup(): void {
  process.env.DATABASE_URL ??= 'postgres://widget:widget@127.0.0.1:55433/widget_test';
  // Мигрируем ОДИН раз на прогон: node-pg-migrate идемпотентен.
  execFileSync('npx', ['node-pg-migrate', '-m', 'migrations', 'up'], {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
  });
}
