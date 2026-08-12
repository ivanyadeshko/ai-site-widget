import pg, { type Pool, type PoolClient } from 'pg';

export type Queryable = Pool | PoolClient;

// JSONB приезжает разобранным по умолчанию; int8 (BIGSERIAL) — строкой, и это
// правильно, но seq у нас int4, а id журнала наружу не отдаётся.
export const createPool = (databaseUrl: string): Pool =>
  new pg.Pool({ connectionString: databaseUrl, max: 10, idleTimeoutMillis: 30_000 });
