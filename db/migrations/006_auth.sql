-- Horizon · вход: позывной + пароль + одноразовый код из приложения (TOTP, RFC 6238)
--
-- Вместо PIN — пароль, вместо кода из мессенджера — TOTP. Способ входа один для всех,
-- он не зависит ни от связи с ботом, ни от внешних сервисов.
-- Секрет TOTP лежит зашифрованным (AES-256-GCM, ключ APP_SECRET), сервер его только расшифровывает.

alter table horizon.users rename column pin_hash to password_hash;
alter table horizon.users add column totp_secret text;
-- Номер использованного 30-секундного интервала: один код нельзя применить дважды.
alter table horizon.users add column totp_last_step bigint;

-- PIN в пароль не превращается, а TOTP ещё никто не подключал: все заводят доступ заново
-- по одноразовому коду (админ — «Новий код входу», первый админ — cli reset-access).
update horizon.users set password_hash = null;

-- Подтверждение входа кодом из мессенджера заменено на TOTP.
drop function horizon.auth_challenge_create(uuid, text, text, text);
drop function horizon.auth_challenge_verify(uuid, text, text, text, text, int);
drop function horizon.auth_device_known(uuid, text);
drop table horizon.login_challenges;
drop table horizon.known_devices;

drop function horizon.auth_lookup(text);

create function horizon.auth_lookup(p_callsign text)
returns table (id uuid, password_hash text, totp_secret text, totp_last_step bigint,
               invite_code_hash text, invite_expires_at timestamptz,
               is_active boolean, locked_until timestamptz)
language sql stable security definer set search_path = horizon, pg_temp as $$
  select u.id, u.password_hash, u.totp_secret, u.totp_last_step, u.invite_code_hash, u.invite_expires_at,
         u.is_active, u.locked_until
    from users u where lower(u.callsign) = lower(trim(p_callsign))
$$;

create or replace function horizon.auth_session_create(p_user uuid, p_token_hash text, p_device text, p_ua text, p_ttl_days int)
returns uuid language plpgsql security definer set search_path = horizon, pg_temp as $$
declare v_id uuid;
begin
  update users set failed_attempts = 0, locked_until = null where id = p_user;
  insert into sessions (user_id, token_hash, device_id, user_agent, expires_at)
  values (p_user, p_token_hash, p_device, left(coalesce(p_ua, ''), 200), now() + make_interval(days => p_ttl_days))
  returning id into v_id;
  return v_id;
end $$;

-- Первый вход / после сброса: код сгорает, пароль и секрет TOTP сохраняются, сессия открывается.
drop function horizon.auth_complete_invite(uuid, text, text, text, text, text, int);

create function horizon.auth_complete_invite(p_user uuid, p_code_hash text, p_password_hash text,
                                             p_totp_secret text, p_token_hash text, p_device text,
                                             p_ua text, p_ttl_days int)
returns uuid language plpgsql security definer set search_path = horizon, pg_temp as $$
begin
  update users
     set password_hash = p_password_hash, totp_secret = p_totp_secret, totp_last_step = null,
         invite_code_hash = null, invite_expires_at = null
   where id = p_user and is_active
     and invite_code_hash = p_code_hash and invite_expires_at > now();
  if not found then
    raise exception 'код недействителен' using errcode = 'HZ401';
  end if;
  return horizon.auth_session_create(p_user, p_token_hash, p_device, p_ua, p_ttl_days);
end $$;

-- Один код — один вход: интервал должен быть строго больше использованного.
create function horizon.auth_totp_consume(p_user uuid, p_step bigint) returns boolean
language plpgsql security definer set search_path = horizon, pg_temp as $$
begin
  update users set totp_last_step = p_step
   where id = p_user and (totp_last_step is null or totp_last_step < p_step);
  return found;
end $$;

create or replace function horizon.reset_access(p_user uuid, p_code_hash text, p_valid_hours int default 72)
returns void language plpgsql security definer set search_path = horizon, pg_temp as $$
begin
  perform horizon.require_uid();
  if not horizon.is_full_admin() then
    raise exception 'только полный админ' using errcode = 'HZ403';
  end if;
  update users
     set password_hash = null, totp_secret = null, totp_last_step = null,
         invite_code_hash = p_code_hash,
         invite_expires_at = now() + make_interval(hours => p_valid_hours),
         failed_attempts = 0, locked_until = null
   where id = p_user;
  if not found then
    raise exception 'человек не найден' using errcode = 'HZ404';
  end if;
  update sessions set revoked_at = now() where user_id = p_user and revoked_at is null;
  perform horizon.audit('reset_access', p_user, null);
end $$;

create or replace function horizon.worker_cleanup() returns void
language sql security definer set search_path = horizon, pg_temp as $$
  delete from sessions where expires_at < now() - interval '30 days';
  delete from notifications where created_at < now() - interval '90 days' and status <> 'pending';
$$;

-- В списке людей «PIN задан» превращается в «пароль задан».
create or replace function horizon.admin_people() returns jsonb
language plpgsql stable security definer set search_path = horizon, pg_temp as $$
declare
  v_full boolean := horizon.is_full_admin();
begin
  perform horizon.require_uid();
  if not horizon.is_admin() then
    raise exception 'нужны права админа' using errcode = 'HZ403';
  end if;
  return (
    select coalesce(jsonb_agg(x order by x.is_active desc, lower(x.callsign)), '[]')
    from (
      select u.id, u.callsign, u.is_active,
             u.password_hash is not null as has_password,
             u.invite_code_hash is not null as invite_pending,
             case when v_full and u.phone_e164 is not null
                  then '•••' || right(u.phone_e164, 4) end as phone_tail,
             exists (select 1 from admin_scopes s where s.user_id = u.id and s.scope = 'full') as is_full_admin,
             coalesce((select jsonb_agg(s.position_id) from admin_scopes s
                        where s.user_id = u.id and s.scope = 'positions'), '[]') as admin_position_ids,
             a.position_id, p.name as position_name, a.date_from,
             (select count(*) from sessions s
               where s.user_id = u.id and s.revoked_at is null and s.expires_at > now()) as sessions,
             (select max(s.last_seen_at) from sessions s where s.user_id = u.id) as last_seen_at
        from users u
        left join assignments a on a.user_id = u.id and a.date_to is null
        left join positions p on p.id = a.position_id
       where v_full
          or (a.position_id is null and u.is_active)
          or horizon.can_admin_position(a.position_id)
    ) x
  );
end $$;

revoke execute on function
  horizon.auth_lookup(text),
  horizon.auth_complete_invite(uuid, text, text, text, text, text, text, int),
  horizon.auth_totp_consume(uuid, bigint),
  horizon.admin_people()
  from public;

grant execute on function horizon.admin_people() to horizon_user;

grant execute on function
  horizon.auth_lookup(text),
  horizon.auth_complete_invite(uuid, text, text, text, text, text, text, int),
  horizon.auth_totp_consume(uuid, bigint)
to horizon_api;
