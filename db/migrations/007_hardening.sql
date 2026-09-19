-- Horizon · защита входа и сессий
--
-- 1. Лимиты попыток по паре «IP + позывной», по IP и по аккаунту — вместо блокировки
--    аккаунта на 15 минут. Блокировка была оружием: зная позывной, человека можно было
--    держать снаружи, посылая неверные пароли.
-- 2. Сессия привязана к устройству и раз в сутки меняет токен. Всплывший старый токен
--    считается кражей: все сессии человека гаснут.

-- ---------------------------------------------------------------------------
-- Попытки входа
-- ---------------------------------------------------------------------------
create table horizon.auth_attempts (
  id         bigint generated always as identity primary key,
  ip         text not null,
  callsign   text not null,
  created_at timestamptz not null default now()
);
create index auth_attempts_ip on horizon.auth_attempts (ip, created_at desc);
create index auth_attempts_pair on horizon.auth_attempts (ip, lower(callsign), created_at desc);
create index auth_attempts_callsign on horizon.auth_attempts (lower(callsign), created_at desc);
alter table horizon.auth_attempts enable row level security;

/**
 * Сколько секунд ждать перед следующей попыткой; 0 — можно пробовать.
 * Задержка на пару «IP + позывной» растёт как 1, 2, 4 … 60 секунд.
 * IP целиком: не больше p_ip_limit неудач в час. Аккаунт: при шквале с разных IP — 60 секунд.
 */
create function horizon.auth_gate(p_ip text, p_callsign text, p_ip_limit int default 20,
                                  p_user_limit int default 50)
returns int language sql stable security definer set search_path = horizon, pg_temp as $$
  with pair as (
    select count(*) as n, max(created_at) as last_at
      from auth_attempts
     where ip = p_ip and lower(callsign) = lower(trim(p_callsign))
       and created_at > now() - interval '15 minutes'
  ),
  -- Первая ошибка бесплатна (опечатка), дальше 1, 2, 4 … 60 секунд.
  pair_wait as (
    select greatest(0, ceil(extract(epoch from
             (p.last_at + make_interval(secs => least(60, power(2, p.n - 2))) ) - now())))::int as w
      from pair p where p.n >= 2
  ),
  ip_wait as (
    select greatest(0, ceil(extract(epoch from (min(t.created_at) + interval '1 hour') - now())))::int as w
      from (select created_at from auth_attempts
             where ip = p_ip and created_at > now() - interval '1 hour'
             order by created_at desc limit p_ip_limit) t
     having count(*) >= p_ip_limit
  ),
  user_wait as (
    select 60 as w from auth_attempts
     where lower(callsign) = lower(trim(p_callsign)) and created_at > now() - interval '1 hour'
    having count(*) >= p_user_limit
  )
  select greatest(
    coalesce((select w from pair_wait), 0),
    coalesce((select w from ip_wait), 0),
    coalesce((select w from user_wait), 0)
  )
$$;

create function horizon.auth_note_fail(p_ip text, p_callsign text) returns void
language sql security definer set search_path = horizon, pg_temp as $$
  insert into auth_attempts (ip, callsign) values (left(p_ip, 45), left(trim(p_callsign), 32))
$$;

/** Удачный вход — счётчик пары обнуляется, чтобы человек не догонял свою же задержку. */
create function horizon.auth_note_success(p_ip text, p_callsign text) returns void
language sql security definer set search_path = horizon, pg_temp as $$
  delete from auth_attempts where ip = p_ip and lower(callsign) = lower(trim(p_callsign))
$$;

-- Счётчик ошибок остаётся для карточки человека, но вход больше не блокирует:
-- блокировкой можно было пользоваться против своих.
create or replace function horizon.auth_fail(p_user uuid) returns timestamptz
language plpgsql security definer set search_path = horizon, pg_temp as $$
begin
  update users set failed_attempts = failed_attempts + 1 where id = p_user;
  return null;
end $$;

-- ---------------------------------------------------------------------------
-- Сессии: привязка к устройству, ротация токена, обнаружение кражи
-- ---------------------------------------------------------------------------
alter table horizon.sessions add column prev_token_hash text;
alter table horizon.sessions add column rotated_at timestamptz not null default now();
create unique index sessions_prev_token on horizon.sessions (prev_token_hash) where prev_token_hash is not null;

drop function horizon.auth_session_resolve(text);

/**
 * Проверка сессии на каждый запрос. Возвращает владельца и признак того,
 * что токен только что заменён (тогда API кладёт новый в cookie).
 * Пустой результат — сессии нет, она чужая или сгорела.
 */
create function horizon.auth_session_touch(p_token_hash text, p_device text, p_new_token_hash text,
                                           p_rotate_hours int default 24, p_grace_seconds int default 120)
returns table (user_id uuid, rotated boolean)
language plpgsql security definer set search_path = horizon, pg_temp as $$
declare s sessions;
begin
  select * into s from sessions
   where token_hash = p_token_hash or prev_token_hash = p_token_hash
   for update;
  if not found or s.revoked_at is not null or s.expires_at <= now() then
    return;
  end if;
  if not exists (select 1 from users u where u.id = s.user_id and u.is_active) then
    return;
  end if;

  -- Cookie сессии без cookie устройства — либо перенесли токен, либо чистили браузер.
  if coalesce(p_device, '') <> '' and s.device_id <> '' and s.device_id <> p_device then
    insert into audit_log (action, target_user_id, details)
    values ('session_device_mismatch', s.user_id, jsonb_build_object('session', s.id));
    return;
  end if;

  -- Старый токен после ротации: короткая фора на параллельные запросы, дальше — кража.
  if s.prev_token_hash = p_token_hash and s.rotated_at < now() - make_interval(secs => p_grace_seconds) then
    update sessions set revoked_at = now() where user_id = s.user_id and revoked_at is null;
    insert into audit_log (action, target_user_id, details)
    values ('session_token_reuse', s.user_id, jsonb_build_object('session', s.id));
    return;
  end if;

  if s.last_seen_at < now() - interval '5 minutes' then
    update sessions set last_seen_at = now() where id = s.id;
  end if;

  if p_new_token_hash is not null and s.rotated_at < now() - make_interval(hours => p_rotate_hours) then
    update sessions
       set prev_token_hash = s.token_hash, token_hash = p_new_token_hash, rotated_at = now()
     where id = s.id;
    return query select s.user_id, true;
  end if;

  return query select s.user_id, false;
end $$;

-- Телефон админу нужен для оповещений бота: кодов подтверждения устройства больше нет.
create or replace function horizon.grant_admin(p_user uuid, p_full boolean, p_positions uuid[])
returns void language plpgsql security definer set search_path = horizon, pg_temp as $$
declare v_user users;
begin
  perform horizon.require_uid();
  if not horizon.is_full_admin() then
    raise exception 'только полный админ' using errcode = 'HZ403';
  end if;
  -- Два админа не должны одновременно разжаловать друг друга.
  lock table admin_scopes in share row exclusive mode;
  v_user := horizon.lock_user(p_user);

  if not p_full then
    perform horizon.assert_not_last_full_admin(p_user);
  end if;
  if (p_full or coalesce(cardinality(p_positions), 0) > 0) and v_user.phone_e164 is null then
    raise exception 'админу нужен телефон бота — на него приходят оповещения'
      using errcode = 'HZ422';
  end if;

  delete from admin_scopes where user_id = p_user;
  if p_full then
    insert into admin_scopes (user_id, scope, granted_by) values (p_user, 'full', horizon.uid());
  else
    insert into admin_scopes (user_id, scope, position_id, granted_by)
    select p_user, 'positions', p.id, horizon.uid()
      from positions p where p.id = any(coalesce(p_positions, '{}'));
  end if;
  perform horizon.audit('grant_admin', p_user, null,
    jsonb_build_object('full', p_full, 'positions', to_jsonb(coalesce(p_positions, '{}'))));
end $$;

-- Пароль админа строже: возвращаем признак в auth_lookup.
drop function horizon.auth_lookup(text);

create function horizon.auth_lookup(p_callsign text)
returns table (id uuid, password_hash text, totp_secret text, totp_last_step bigint,
               invite_code_hash text, invite_expires_at timestamptz,
               is_active boolean, locked_until timestamptz, is_admin boolean)
language sql stable security definer set search_path = horizon, pg_temp as $$
  select u.id, u.password_hash, u.totp_secret, u.totp_last_step, u.invite_code_hash, u.invite_expires_at,
         u.is_active, u.locked_until,
         exists (select 1 from admin_scopes s where s.user_id = u.id)
    from users u where lower(u.callsign) = lower(trim(p_callsign))
$$;

create or replace function horizon.worker_cleanup() returns void
language sql security definer set search_path = horizon, pg_temp as $$
  delete from sessions where expires_at < now() - interval '30 days';
  delete from notifications where created_at < now() - interval '90 days' and status <> 'pending';
  delete from auth_attempts where created_at < now() - interval '1 day';
$$;

revoke execute on function
  horizon.auth_gate(text, text, int, int),
  horizon.auth_note_fail(text, text),
  horizon.auth_note_success(text, text),
  horizon.auth_session_touch(text, text, text, int, int),
  horizon.auth_lookup(text),
  horizon.grant_admin(uuid, boolean, uuid[])
  from public;

grant execute on function
  horizon.auth_gate(text, text, int, int),
  horizon.auth_note_fail(text, text),
  horizon.auth_note_success(text, text),
  horizon.auth_session_touch(text, text, text, int, int),
  horizon.auth_lookup(text)
to horizon_api;

grant execute on function horizon.grant_admin(uuid, boolean, uuid[]) to horizon_user;
grant execute on function horizon.worker_cleanup() to horizon_worker;
