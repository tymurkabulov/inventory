-- Оповещений в системе нет: ни бота, ни рассылки, ни напоминаний о просрочке.
-- Всё происходит внутри платформы, поэтому телефон человеку больше не нужен.
-- Вместе с очередью уходит и отдельный процесс-воркер: чистку переносим в API.

drop trigger if exists items_critical_red on horizon.items;
drop function if exists horizon.items_critical_red();
drop function if exists horizon.scan_stale(timestamptz, int, int, int, int, text);
drop function if exists horizon.quiet_release(timestamptz, int, int, text);
drop function if exists horizon.notify_position(uuid, text);
drop function if exists horizon.worker_claim(int);
drop function if exists horizon.worker_finish(bigint[], text, int);
drop function if exists horizon.worker_skip(bigint[], text);
drop table if exists horizon.notifications;

-- Чистка переезжает в API: воркера больше нет.
create or replace function horizon.worker_cleanup() returns void
language sql security definer set search_path = horizon, pg_temp as $$
  delete from sessions where expires_at < now() - interval '30 days';
  delete from auth_attempts where created_at < now() - interval '1 day';
$$;
grant execute on function horizon.worker_cleanup() to horizon_api;

-- Права админа больше не требуют телефона.
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

-- Приглашение: логин и позывной, телефон больше не спрашиваем.
drop function if exists horizon.invite_user(text, text, text, text, int);
create function horizon.invite_user(p_login text, p_callsign text, p_code_hash text,
                                    p_valid_hours int default 72)
returns uuid language plpgsql security definer set search_path = horizon, pg_temp as $$
declare v_id uuid;
begin
  perform horizon.require_uid();
  if not horizon.is_admin() then
    raise exception 'нужны права админа' using errcode = 'HZ403';
  end if;
  if exists (select 1 from users where lower(login) = lower(trim(p_login))) then
    raise exception 'логин «%» уже занят', trim(p_login) using errcode = 'HZ409';
  end if;
  if exists (select 1 from users where lower(callsign) = lower(trim(p_callsign))) then
    raise exception 'позывной «%» уже занят', trim(p_callsign) using errcode = 'HZ409';
  end if;
  insert into users (login, callsign, invite_code_hash, invite_expires_at, created_by)
  values (lower(trim(p_login)), trim(p_callsign), p_code_hash,
          now() + make_interval(hours => p_valid_hours), horizon.uid())
  returning id into v_id;
  perform horizon.audit('invite_user', v_id, null,
    jsonb_build_object('login', lower(trim(p_login)), 'callsign', trim(p_callsign)));
  return v_id;
exception
  when check_violation then
    raise exception 'логин: 3–32 символа (латиница, цифры, . _ -); позывной: 2–32 символа'
      using errcode = 'HZ422';
end $$;

-- Список людей без телефона.
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
      select u.id, u.login, u.callsign, u.is_active,
             u.password_hash is not null as has_password,
             u.invite_code_hash is not null as invite_pending,
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

alter table horizon.users drop constraint if exists users_phone_format;
alter table horizon.users drop column if exists phone_e164;
