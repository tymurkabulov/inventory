import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export interface Migrator {
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  exec(sql: string): Promise<unknown>;
}

export function migrationsDir(): string {
  if (process.env.MIGRATIONS_DIR) return resolve(process.env.MIGRATIONS_DIR);
  // src/ и dist/ лежат рядом, db/ — на уровень выше server/
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../db/migrations');
}

export async function migrate(db: Migrator, dir = migrationsDir(), log: (m: string) => void = console.log) {
  await db.exec(`create table if not exists public.horizon_migrations (
    name text primary key, applied_at timestamptz not null default now())`);
  const applied = new Set(
    (await db.query('select name from public.horizon_migrations')).rows.map((r) => String(r.name)),
  );
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(join(dir, file), 'utf8');
    log(`migrate: ${file}`);
    await db.exec('begin');
    try {
      await db.exec(sql);
      await db.query('insert into public.horizon_migrations (name) values ($1)', [file]);
      await db.exec('commit');
    } catch (err) {
      await db.exec('rollback');
      throw new Error(`migration ${file} failed: ${(err as Error).message}`);
    }
  }
}

// Пароли логинов берём из окружения, в миграциях их нет.
async function setPassword(client: pg.Client, role: 'horizon_api', password: string) {
  if (!password) return;
  await client.query(`select set_config('horizon.tmp_pw', $1, false)`, [password]);
  await client.query(`do $$ begin
    execute format('alter role ${role} password %L', current_setting('horizon.tmp_pw'));
  end $$`);
  await client.query(`select set_config('horizon.tmp_pw', '', false)`);
}

async function main() {
  const { loadConfig } = await import('./config.js');
  const config = loadConfig();
  const client = new pg.Client({ connectionString: config.databaseAdminUrl });
  await client.connect();
  try {
    await migrate({ query: (s, p) => client.query(s, p), exec: (s) => client.query(s) });
    await setPassword(client, 'horizon_api', config.apiPassword);
    console.log('migrate: done');
  } finally {
    await client.end();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
