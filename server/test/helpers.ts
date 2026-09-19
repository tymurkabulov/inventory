import { PGlite, type Transaction } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import pg from 'pg';
import '../src/db.js'; // парсеры типов pg
import { migrate } from '../src/migrate.js';

export async function freshDb(): Promise<PGlite> {
  const db = await PGlite.create();
  await migrate(
    { query: (s, p) => db.query(s, p) as never, exec: (s) => db.exec(s) },
    undefined,
    () => {},
  );
  return db;
}

/** Выполнить fn от имени человека: роль horizon_user + horizon.uid. */
export function as<T>(db: PGlite, uid: string, fn: (tx: Transaction) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.exec('set local role horizon_user');
    await tx.query(`select set_config('horizon.uid', $1, true)`, [uid]);
    return fn(tx);
  });
}

export async function one<T = Record<string, unknown>>(
  q: { query: PGlite['query'] } | Transaction,
  sql: string,
  params: unknown[] = [],
): Promise<T> {
  const { rows } = await q.query<T>(sql, params);
  return rows[0] as T;
}

export async function seedUser(
  db: PGlite,
  callsign: string,
  opts: { full?: boolean; zone?: string[]; login?: string } = {},
) {
  // Логин обязателен и уникален; в тестах хватает автогенерации.
  const login = opts.login ?? `u${Math.random().toString(36).slice(2, 10)}`;
  const { id } = await one<{ id: string }>(
    db,
    `insert into horizon.users (login, callsign) values ($1, $2) returning id`,
    [login, callsign],
  );
  if (opts.full) await db.query(`insert into horizon.admin_scopes (user_id, scope) values ($1, 'full')`, [id]);
  for (const p of opts.zone ?? []) {
    await db.query(`insert into horizon.admin_scopes (user_id, scope, position_id) values ($1, 'positions', $2)`, [id, p]);
  }
  return id;
}

export async function seedPosition(db: PGlite, name: string) {
  const { id } = await one<{ id: string }>(db, `insert into horizon.positions (name) values ($1) returning id`, [name]);
  return id;
}

/** PGlite, доступный по TCP, чтобы API ходил в него обычным pg.Pool. */
export async function socketDb() {
  const db = await freshDb();
  const port = 40000 + Math.floor(Math.random() * 20000);
  const server = new PGLiteSocketServer({ db, port, host: '127.0.0.1', maxConnections: 1 });
  await server.start();
  // У PGlite одна сессия на всех: одно соединение, запросы строго по очереди.
  const pool = new pg.Pool({ connectionString: `postgres://postgres@127.0.0.1:${port}/postgres`, max: 1 });
  return {
    db,
    pool,
    async close() {
      await pool.end();
      await server.stop();
      await db.close();
    },
  };
}
