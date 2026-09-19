import pg from 'pg';
import { codeForDbMessage, type ErrorParams } from './errors.js';

// numeric → number (остатки ≤ 12 знаков, точности double хватает); date → 'YYYY-MM-DD'.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => Number(v));
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

export type Pool = pg.Pool;
export type Client = pg.PoolClient;

export function createPool(connectionString: string, max = 10): pg.Pool {
  const pool = new pg.Pool({ connectionString, max, idleTimeoutMillis: 30_000 });
  pool.on('error', (err) => console.error('pg pool error', err));
  return pool;
}

export class AppError extends Error {
  constructor(
    public status: number,
    message: string,
    /** Ключ перевода на клиенте: err.<code> */
    public code = 'error',
    public params?: ErrorParams,
  ) {
    super(message);
  }
}

const SQLSTATE_TO_HTTP: Record<string, number> = {
  HZ401: 401,
  HZ403: 403,
  HZ404: 404,
  HZ409: 409,
  HZ422: 422,
  HZ429: 429,
  '23505': 409, // unique_violation — последний рубеж, например вторая открытая привязка
  '23514': 422, // check_violation
  '22P02': 422, // invalid_text_representation (кривой uuid и т.п.)
  '42501': 403, // insufficient_privilege
};

export function toAppError(err: unknown): AppError | null {
  if (err instanceof AppError) return err;
  const code = (err as { code?: string } | null)?.code;
  if (!code) return null;
  const status = SQLSTATE_TO_HTTP[code];
  if (!status) return null;
  if (code === '23505') return new AppError(status, 'конфликт: такая запись уже есть', 'conflict');
  if (code === '23514') return new AppError(status, 'неверные данные', 'invalid');
  if (code === '22P02') return new AppError(status, 'неверный формат данных', 'bad_format');
  if (code === '42501') return new AppError(status, 'нет прав', 'forbidden');
  const message = (err as Error).message;
  const known = codeForDbMessage(message);
  return new AppError(status, message, known?.code ?? 'error', known?.params);
}

async function inTransaction<T>(pool: Pool, setup: (c: Client) => Promise<void>, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await setup(client);
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Запрос от имени человека: роль horizon_user, RLS действует, horizon.uid() = userId. */
export function asUser<T>(pool: Pool, userId: string, fn: (c: Client) => Promise<T>): Promise<T> {
  return inTransaction(
    pool,
    async (c) => {
      await c.query('set local role horizon_user');
      await c.query(`select set_config('horizon.uid', $1, true)`, [userId]);
    },
    fn,
  );
}

/** Запрос до входа: только auth_* функции, доступные horizon_api. */
export function asApi<T>(pool: Pool, fn: (c: Client) => Promise<T>): Promise<T> {
  return inTransaction(pool, async () => {}, fn);
}
