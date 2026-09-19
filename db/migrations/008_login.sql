-- Horizon · логин отдельно от позывного
--
-- Позывной — то, как человека зовут в эфире и как его видно в таблицах: кириллица, пробелов нет.
-- Логин — то, чем он входит: только латиница, цифры и . _ -, чтобы вводить с любой раскладки.
-- Оба уникальны.

alter table horizon.users add column login text;

-- Перенос: логин собираем из позывного транслитерацией, чтобы никому не пришлось
-- ничего придумывать вручную. Если получилось пусто или коротко — берём кусок id.
create function horizon.translit(p text) returns text
language sql immutable as $$
  select regexp_replace(
    lower(translate(p,
      'абвгґдезиійклмнопрстуфхцыэАБВГҐДЕЗИІЙКЛМНОПРСТУФХЦЫЭ',
      'abvggdeziijklmnoprstufhcyeabvggdeziijklmnoprstufhcye')),
    '[^a-z0-9._-]', '', 'g')
$$;

update horizon.users u
   set login = case
         when length(horizon.translit(u.callsign)) >= 3 then horizon.translit(u.callsign)
         else 'u' || left(replace(u.id::text, '-', ''), 8)
       end;

-- Коллизии после транслитерации («Сокіл» и «Сокол») разводим номером.
with dup as (
  select id, login, row_number() over (partition by login order by created_at) as n
    from horizon.users
)
update horizon.users u set login = u.login || dup.n::text
  from dup where dup.id = u.id and dup.n > 1;

alter table horizon.users alter column login set not null;
alter table horizon.users add constraint users_login_format
  check (login ~ '^[0-9a-z._-]{3,32}$');
create unique index users_login_unique on horizon.users (lower(login));

-- Вход теперь по логину.
drop function horizon.auth_lookup(text);

create function horizon.auth_lookup(p_login text)
returns table (id uuid, password_hash text, totp_secret text, totp_last_step bigint,
               invite_code_hash text, invite_expires_at timestamptz,
               is_active boolean, locked_until timestamptz, is_admin boolean)
language sql stable security definer set search_path = horizon, pg_temp as $$
  select u.id, u.password_hash, u.totp_secret, u.totp_last_step, u.invite_code_hash, u.invite_expires_at,
         u.is_active, u.locked_until,
         exists (select 1 from admin_scopes s where s.user_id = u.id)
    from users u where lower(u.login) = lower(trim(p_login))
$$;

-- Приглашение: админ задаёт и логин, и позывной.
drop function horizon.invite_user(text, text, text, int);

create function horizon.invite_user(p_login text, p_callsign text, p_phone text, p_code_hash text,
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
  insert into users (login, callsign, phone_e164, invite_code_hash, invite_expires_at, created_by)
  values (lower(trim(p_login)), trim(p_callsign), nullif(trim(p_phone), ''), p_code_hash,
          now() + make_interval(hours => p_valid_hours), horizon.uid())
  returning id into v_id;
  perform horizon.audit('invite_user', v_id, null,
    jsonb_build_object('login', lower(trim(p_login)), 'callsign', trim(p_callsign)));
  return v_id;
exception
  when check_violation then
    raise exception 'логин: 3–32 символа (латиница, цифры, . _ -); позывной: 2–32 символа; телефон в формате +XXXXXXXXXXX'
      using errcode = 'HZ422';
end $$;

-- Логин виден администратору в списке людей и человеку в своём профиле.
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

create or replace function horizon.me() returns jsonb
language sql stable security definer set search_path = horizon, pg_temp as $$
  select jsonb_build_object(
    'id', u.id,
    'login', u.login,
    'callsign', u.callsign,
    'locale', u.locale,
    'admin', jsonb_build_object(
      'full', exists (select 1 from admin_scopes s where s.user_id = u.id and s.scope = 'full'),
      'position_ids', coalesce((select jsonb_agg(s.position_id) from admin_scopes s
                                 where s.user_id = u.id and s.scope = 'positions'), '[]')),
    'assignment', (select jsonb_build_object('position_id', p.id, 'name', p.name, 'type', p.type,
                                             'date_from', a.date_from)
                     from assignments a join positions p on p.id = a.position_id
                    where a.user_id = u.id and a.date_to is null))
  from users u where u.id = horizon.uid() and u.is_active
$$;

revoke execute on function
  horizon.auth_lookup(text),
  horizon.invite_user(text, text, text, text, int),
  horizon.admin_people(),
  horizon.me(),
  horizon.translit(text)
  from public;

grant execute on function horizon.auth_lookup(text) to horizon_api;
grant execute on function
  horizon.invite_user(text, text, text, text, int),
  horizon.admin_people(),
  horizon.me()
to horizon_user;
