// Первый полный админ и аварийный сброс. Работает под владельцем схемы.
//   node dist/cli.js create-admin <логин> <позывной>
//   node dist/cli.js reset-access <логин>
import pg from 'pg';
import { loadConfig } from './config.js';
import { hashInviteCode, newInviteCode } from './crypto.js';

const [cmd, ...args] = process.argv.slice(2);
const config = loadConfig();

function usage(): never {
  console.error('usage:\n  cli create-admin <логин> <позывной>\n  cli reset-access <логин>');
  process.exit(2);
}

if (!cmd) usage();
const login = (args[0] ?? '').trim().toLowerCase();
if (!login) usage();

const client = new pg.Client({ connectionString: config.databaseAdminUrl });
await client.connect();

try {
  const code = newInviteCode();
  await client.query('begin');
  if (cmd === 'create-admin') {
    const [, callsign] = args;
    if (!callsign) usage();
    const { rows } = await client.query<{ id: string }>(
      `insert into horizon.users (login, callsign, invite_code_hash, invite_expires_at)
       values ($1, $2, $3, now() + make_interval(hours => $4)) returning id`,
      [login, callsign, hashInviteCode(code, config.appSecret), config.inviteValidHours],
    );
    const id = rows[0]!.id;
    await client.query(`insert into horizon.admin_scopes (user_id, scope) values ($1, 'full')`, [id]);
    await client.query(
      `insert into horizon.audit_log (action, target_user_id, details) values ('cli_create_admin', $1, '{}')`,
      [id],
    );
  } else if (cmd === 'reset-access') {
    const { rows } = await client.query<{ id: string }>(
      `update horizon.users set password_hash = null, totp_secret = null, totp_last_step = null, invite_code_hash = $2,
              invite_expires_at = now() + make_interval(hours => $3),
              is_active = true
        where lower(login) = lower($1) returning id`,
      [login, hashInviteCode(code, config.appSecret), config.inviteValidHours],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error(`логин ${login} не найден`);
    await client.query('update horizon.sessions set revoked_at = now() where user_id = $1 and revoked_at is null', [id]);
    await client.query(
      `insert into horizon.audit_log (action, target_user_id, details) values ('cli_reset_access', $1, '{}')`,
      [id],
    );
  } else {
    usage();
  }
  await client.query('commit');
  console.log(`\n  Логин: ${login}\n  Одноразовый код: ${code}\n  Действует: ${config.inviteValidHours} ч\n`);
} catch (err) {
  await client.query('rollback').catch(() => {});
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await client.end();
}
