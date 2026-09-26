-- Horizon · схема данных (ТЗ v2.1)
--
-- Одна миграция вместо истории 001–018: база разворачивается с нуля. Следующие
-- изменения — новыми файлами 002_…, 003_… поверх этой.
--
-- Инвариант раздела 2: один человек — одно место (assignments_one_open_per_user).
--
-- Роли:
--   horizon_api  — логин API. Сам по себе умеет только auth_* и cleanup().
--   horizon_user — роль запроса человека (SET LOCAL ROLE): только читает, в пределах RLS.
-- Миграции и CLI работают под владельцем схемы.
--
-- Коды ошибок (SQLSTATE), которые API превращает в HTTP:
--   HZ401 не авторизован · HZ403 нет прав · HZ404 не найдено
--   HZ409 конфликт       · HZ422 неверные данные · HZ429 слишком часто

create schema if not exists horizon;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'horizon_user') then
    create role horizon_user nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'horizon_api') then
    create role horizon_api login noinherit;
  end if;
end $$;

grant horizon_user to horizon_api;
grant usage on schema horizon to horizon_api, horizon_user;

-- ===========================================================================
-- Таблицы
-- ===========================================================================

-- Позывной — как человека видно в таблицах (кириллица). Логин — чем он входит:
-- латиница, чтобы вводить с любой раскладки. Телефонов, ФИО, координат нет.
create table horizon.users (
  id                uuid primary key default gen_random_uuid(),
  login             text not null,
  callsign          text not null,
  password_hash     text,
  -- Секрет TOTP, AES-256-GCM на ключе APP_SECRET: дамп сам по себе не даёт кодов.
  totp_secret       text,
  -- Номер использованного 30-секундного интервала: один код нельзя применить дважды.
  totp_last_step    bigint,
  -- HMAC кода входа на ключе APP_SECRET.
  invite_code_hash  text,
  invite_expires_at timestamptz,
  is_active         boolean not null default true,
  -- Язык интерфейса; список допустимых живёт в коде, база проверяет только форму.
  locale            text,
  created_at        timestamptz not null default now(),
  created_by        uuid references horizon.users(id),
  constraint users_login_format check (login ~ '^[0-9a-z._-]{3,32}$'),
  constraint users_callsign_format check (callsign ~ '^[0-9A-Za-zА-Яа-яЁёІіЇїЄєҐґ._-]{2,32}$'),
  constraint users_locale check (locale ~ '^[a-z]{2}$')
);
create unique index users_login_unique on horizon.users (lower(login));
create unique index users_callsign_unique on horizon.users (lower(callsign));

create table horizon.positions (
  id                uuid primary key default gen_random_uuid(),
  name              text not null check (length(trim(name)) between 1 and 64),
  is_active         boolean not null default true,
  stale_after_hours int not null default 24 check (stale_after_hours between 1 and 720),
  created_at        timestamptz not null default now()
);
create unique index positions_name_unique on horizon.positions (lower(name));

create table horizon.admin_scopes (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references horizon.users(id) on delete cascade,
  scope       text not null check (scope in ('full', 'positions')),
  position_id uuid references horizon.positions(id) on delete cascade,
  granted_by  uuid references horizon.users(id),
  created_at  timestamptz not null default now(),
  constraint admin_scopes_shape check ((scope = 'full') = (position_id is null))
);
create unique index admin_scopes_full_unique on horizon.admin_scopes (user_id) where scope = 'full';
create unique index admin_scopes_pos_unique on horizon.admin_scopes (user_id, position_id) where scope = 'positions';

-- История мест. Закрытые строки не удаляются.
create table horizon.assignments (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references horizon.users(id),
  position_id uuid not null references horizon.positions(id),
  date_from   date not null,
  date_to     date,
  assigned_by uuid references horizon.users(id),
  closed_by   uuid references horizon.users(id),
  created_at  timestamptz not null default now(),
  closed_at   timestamptz,
  constraint assignments_dates check (date_to is null or date_to >= date_from)
);
-- Политика раздела 2: не более одной открытой привязки на человека. Навсегда.
create unique index assignments_one_open_per_user on horizon.assignments (user_id) where date_to is null;
create index assignments_open_by_position on horizon.assignments (position_id) where date_to is null;
create index assignments_user_history on horizon.assignments (user_id, date_from desc);

create function horizon.forbid_delete() returns trigger
language plpgsql as $$
begin
  raise exception 'удаление % запрещено', tg_table_name using errcode = 'P0001';
end $$;

create trigger assignments_no_delete before delete on horizon.assignments
  for each row execute function horizon.forbid_delete();

-- Категории — закрытый справочник, один на роту. Правится только здесь.
-- Порядок задаём числом: сортировка по тексту зависит от локали базы.
create table horizon.item_categories (
  name text primary key check (length(name) between 1 and 40),
  sort smallint not null default 100
);
insert into horizon.item_categories (name, sort) values
  ('БПЛА', 10), ('Витратні', 20), ('Вода', 30), ('Енергетика', 40), ('Залишки', 50),
  ('Захист', 60), ('Звʼязок', 70), ('Інструмент', 80), ('Маскування', 90), ('НРК', 100),
  ('Паливо', 110), ('Спорядження', 120), ('Транспорт', 130);

create table horizon.items (
  id             uuid primary key default gen_random_uuid(),
  position_id    uuid not null references horizon.positions(id),
  name           text not null check (length(trim(name)) between 1 and 80),
  category       text not null default '' check (length(category) <= 40),
  unit           text not null default 'шт' check (length(unit) between 1 and 12),
  qty            numeric(12, 2) not null default 0 check (qty >= 0),
  min_qty        numeric(12, 2) not null,
  acceptable_qty numeric(12, 2) not null,
  ideal_qty      numeric(12, 2) not null,
  condition      text not null default 'ok' check (condition in ('ok', 'repair', 'broken')),
  comment        text not null default '' check (length(comment) <= 280),
  -- 0 = red, 1 = yellow, 2 = green. Цвет не храним, только ранг для сортировки.
  stock_rank     smallint generated always as (
                   case when qty < min_qty then 0
                        when qty < acceptable_qty then 1
                        else 2 end
                 ) stored,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  updated_by     uuid references horizon.users(id),
  deleted_at     timestamptz,
  -- Раздел 5: min ≥ 0 и min < acceptable ≤ ideal
  constraint items_thresholds check (min_qty >= 0 and min_qty < acceptable_qty and acceptable_qty <= ideal_qty)
);
create index items_board on horizon.items (position_id, stock_rank, name) where deleted_at is null;
create unique index items_name_per_position on horizon.items (position_id, lower(name)) where deleted_at is null;
create index items_position_updated_by on horizon.items (position_id, updated_by) where deleted_at is null;

-- Последнее движение остатка: одна строка «было → стало» на единицу имущества.
create table horizon.stock_movements (
  id          bigint generated always as identity primary key,
  item_id     uuid not null references horizon.items(id),
  position_id uuid not null references horizon.positions(id),
  qty_before  numeric(12, 2),
  qty_after   numeric(12, 2) not null,
  delta       numeric(12, 2) generated always as (qty_after - coalesce(qty_before, 0)) stored,
  reason      text not null default '',
  created_by  uuid references horizon.users(id),
  created_at  timestamptz not null default now()
);
create unique index stock_movements_item on horizon.stock_movements (item_id);
create index stock_movements_position_created_by on horizon.stock_movements (position_id, created_by);

-- Сессия привязана к устройству и раз в SESSION_ROTATE_HOURS меняет токен.
-- В базе только хеши токенов.
create table horizon.sessions (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references horizon.users(id) on delete cascade,
  token_hash         text not null unique,
  prev_token_hash    text,
  device_id          text not null,
  user_agent         text not null default '',
  created_at         timestamptz not null default now(),
  last_seen_at       timestamptz not null default now(),
  rotated_at         timestamptz not null default now(),
  -- Новый токен после ротации хоть раз вернулся от клиента.
  rotation_confirmed boolean not null default true,
  expires_at         timestamptz not null,
  revoked_at         timestamptz
);
create index sessions_user on horizon.sessions (user_id) where revoked_at is null;
create unique index sessions_prev_token on horizon.sessions (prev_token_hash) where prev_token_hash is not null;

-- Неудачные попытки входа. Колонка callsign хранит логин, как его ввели.
create table horizon.auth_attempts (
  id         bigint generated always as identity primary key,
  ip         text not null,
  callsign   text not null,
  created_at timestamptz not null default now()
);
create index auth_attempts_ip on horizon.auth_attempts (ip, created_at desc);
create index auth_attempts_pair on horizon.auth_attempts (ip, lower(callsign), created_at desc);
create index auth_attempts_callsign on horizon.auth_attempts (lower(callsign), created_at desc);

create table horizon.audit_log (
  id             bigint generated always as identity primary key,
  actor_id       uuid references horizon.users(id),
  action         text not null,
  target_user_id uuid references horizon.users(id),
  position_id    uuid references horizon.positions(id),
  details        jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now()
);
create index audit_log_created on horizon.audit_log (created_at desc);

create trigger audit_log_no_delete before delete on horizon.audit_log
  for each row execute function horizon.forbid_delete();

-- ===========================================================================
-- Контекст запроса и права
-- ===========================================================================
create function horizon.uid() returns uuid
language sql stable as $$
  select nullif(current_setting('horizon.uid', true), '')::uuid
$$;

create function horizon.require_uid() returns uuid
language plpgsql stable as $$
declare v uuid := horizon.uid();
begin
  if v is null then
    raise exception 'не авторизован' using errcode = 'HZ401';
  end if;
  return v;
end $$;

create function horizon.is_full_admin() returns boolean
language sql stable security definer set search_path = horizon, pg_temp as $$
  select exists (
    select 1 from admin_scopes s join users u on u.id = s.user_id
    where s.user_id = horizon.uid() and s.scope = 'full' and u.is_active)
$$;

create function horizon.is_admin() returns boolean
language sql stable security definer set search_path = horizon, pg_temp as $$
  select exists (
    select 1 from admin_scopes s join users u on u.id = s.user_id
    where s.user_id = horizon.uid() and u.is_active)
$$;

create function horizon.can_admin_position(p_position uuid) returns boolean
language sql stable security definer set search_path = horizon, pg_temp as $$
  select exists (
    select 1 from admin_scopes s join users u on u.id = s.user_id
    where s.user_id = horizon.uid() and u.is_active
      and (s.scope = 'full' or s.position_id = p_position))
$$;

-- Места, где человек — админ зоны. Для RLS: одно вычисление на запрос.
create function horizon.my_admin_position_ids() returns uuid[]
language sql stable security definer set search_path = horizon, pg_temp as $$
  select coalesce(array_agg(s.position_id), '{}')
    from admin_scopes s join users u on u.id = s.user_id
   where s.user_id = horizon.uid() and u.is_active and s.scope = 'positions'
$$;

-- Единственная открытая привязка текущего человека (или null — экран ожидания).
create function horizon.current_position_id() returns uuid
language sql stable security definer set search_path = horizon, pg_temp as $$
  select a.position_id
  from assignments a join users u on u.id = a.user_id
  where a.user_id = horizon.uid() and a.date_to is null and u.is_active
$$;

create function horizon.can_read_position(p_position uuid) returns boolean
language sql stable as $$
  select p_position = horizon.current_position_id() or horizon.can_admin_position(p_position)
$$;

create function horizon.audit(p_action text, p_target uuid, p_position uuid, p_details jsonb default '{}')
returns void language sql security definer set search_path = horizon, pg_temp as $$
  insert into audit_log (actor_id, action, target_user_id, position_id, details)
  values (horizon.uid(), p_action, p_target, p_position, coalesce(p_details, '{}'))
$$;

-- ===========================================================================
-- Раздел 5. Цвет
-- ===========================================================================
create function horizon.status(p_qty numeric, p_min numeric, p_acceptable numeric, p_ideal numeric)
returns text language sql immutable as $$
  select case when p_qty < p_min then 'red'
              when p_qty < p_acceptable then 'yellow'
              else 'green' end
$$;

create function horizon.is_full_stock(p_qty numeric, p_ideal numeric)
returns boolean language sql immutable as $$
  select p_qty >= p_ideal
$$;

create function horizon.thresholds_valid(p_min numeric, p_acceptable numeric, p_ideal numeric)
returns boolean language sql immutable as $$
  select p_min >= 0 and p_min < p_acceptable and p_acceptable <= p_ideal
$$;

-- ===========================================================================
-- Раздел 9. Люди и места
-- ===========================================================================
create function horizon.lock_user(p_user uuid) returns horizon.users
language plpgsql security definer set search_path = horizon, pg_temp as $$
declare v users;
begin
  select * into v from users where id = p_user for update;
  if not found then
    raise exception 'человек не найден' using errcode = 'HZ404';
  end if;
  return v;
end $$;

-- for share: выключение места (for update в upsert_position) ждёт, пока посадка
-- или новая строка на этом месте не закоммитятся, и уже видит их.
create function horizon.require_active_position(p_position uuid) returns horizon.positions
language plpgsql security definer set search_path = horizon, pg_temp as $$
declare v positions;
begin
  select * into v from positions where id = p_position for share;
  if not found then
    raise exception 'место не найдено' using errcode = 'HZ404';
  end if;
  if not v.is_active then
    raise exception 'место «%» выключено', v.name using errcode = 'HZ409';
  end if;
  return v;
end $$;

-- Приглашение: админ задаёт логин и позывной, код показывается один раз.
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

-- Сброс доступа: новый одноразовый код, пароль и приложение стираются, сессии гаснут.
create function horizon.reset_access(p_user uuid, p_code_hash text, p_valid_hours int default 72)
returns void language plpgsql security definer set search_path = horizon, pg_temp as $$
begin
  perform horizon.require_uid();
  if not horizon.is_full_admin() then
    raise exception 'только полный админ' using errcode = 'HZ403';
  end if;
  update users
     set password_hash = null, totp_secret = null, totp_last_step = null,
         invite_code_hash = p_code_hash,
         invite_expires_at = now() + make_interval(hours => p_valid_hours)
   where id = p_user;
  if not found then
    raise exception 'человек не найден' using errcode = 'HZ404';
  end if;
  update sessions set revoked_at = now() where user_id = p_user and revoked_at is null;
  perform horizon.audit('reset_access', p_user, null);
end $$;

create function horizon.assign_to_position(p_user uuid, p_position uuid, p_date_from date)
returns uuid language plpgsql security definer set search_path = horizon, pg_temp as $$
declare
  v_user users;
  v_id uuid;
  v_last date;
begin
  perform horizon.require_uid();
  if not horizon.can_admin_position(p_position) then
    raise exception 'нет прав на это место' using errcode = 'HZ403';
  end if;
  perform horizon.require_active_position(p_position);
  v_user := horizon.lock_user(p_user);
  if not v_user.is_active then
    raise exception 'человек отключён' using errcode = 'HZ409';
  end if;
  if not horizon.is_full_admin()
     and exists (select 1 from admin_scopes where user_id = p_user and scope = 'full') then
    raise exception 'полного админа сажает только полный админ' using errcode = 'HZ403';
  end if;
  if exists (select 1 from assignments where user_id = p_user and date_to is null) then
    raise exception 'у человека уже есть место — сначала переведите или снимите' using errcode = 'HZ409';
  end if;
  -- История мест не перекрывается: заход не раньше, чем закончилось прошлое место.
  select max(date_to) into v_last from assignments where user_id = p_user;
  if v_last is not null and coalesce(p_date_from, current_date) < v_last then
    raise exception 'дата захода раньше конца прошлого места (%)', to_char(v_last, 'DD.MM.YYYY')
      using errcode = 'HZ422';
  end if;
  insert into assignments (user_id, position_id, date_from, assigned_by)
  values (p_user, p_position, coalesce(p_date_from, current_date), horizon.uid())
  returning id into v_id;
  perform horizon.audit('assign', p_user, p_position, jsonb_build_object('date_from', p_date_from));
  return v_id;
exception
  when unique_violation then
    raise exception 'у человека уже есть место — сначала переведите или снимите' using errcode = 'HZ409';
end $$;

-- Атомарно: закрыть текущую, открыть новую. Функция = одна транзакция.
create function horizon.transfer_user(p_user uuid, p_position uuid, p_date date)
returns uuid language plpgsql security definer set search_path = horizon, pg_temp as $$
declare
  v_open assignments;
  v_date date := coalesce(p_date, current_date);
  v_id uuid;
begin
  perform horizon.require_uid();
  perform horizon.lock_user(p_user);
  select * into v_open from assignments where user_id = p_user and date_to is null for update;
  if not found then
    raise exception 'человек не посажен — используйте посадку' using errcode = 'HZ409';
  end if;
  if not (horizon.can_admin_position(v_open.position_id) and horizon.can_admin_position(p_position)) then
    raise exception 'нужны права и на текущее, и на новое место' using errcode = 'HZ403';
  end if;
  if v_open.position_id = p_position then
    raise exception 'человек уже на этом месте' using errcode = 'HZ409';
  end if;
  perform horizon.require_active_position(p_position);
  if v_date < v_open.date_from then
    raise exception 'дата перевода раньше даты захода (%)', to_char(v_open.date_from, 'DD.MM.YYYY')
      using errcode = 'HZ422';
  end if;

  update assignments set date_to = v_date, closed_by = horizon.uid(), closed_at = now()
   where id = v_open.id;
  insert into assignments (user_id, position_id, date_from, assigned_by)
  values (p_user, p_position, v_date, horizon.uid())
  returning id into v_id;

  perform horizon.audit('transfer', p_user, p_position,
    jsonb_build_object('from_position', v_open.position_id, 'date', v_date));
  return v_id;
end $$;

create function horizon.unassign_user(p_user uuid, p_date date)
returns void language plpgsql security definer set search_path = horizon, pg_temp as $$
declare
  v_open assignments;
  v_date date := coalesce(p_date, current_date);
begin
  perform horizon.require_uid();
  perform horizon.lock_user(p_user);
  select * into v_open from assignments where user_id = p_user and date_to is null for update;
  if not found then
    raise exception 'человек и так без места' using errcode = 'HZ409';
  end if;
  if not horizon.can_admin_position(v_open.position_id) then
    raise exception 'нет прав на текущее место человека' using errcode = 'HZ403';
  end if;
  if v_date < v_open.date_from then
    raise exception 'дата снятия раньше даты захода (%)', to_char(v_open.date_from, 'DD.MM.YYYY')
      using errcode = 'HZ422';
  end if;
  update assignments set date_to = v_date, closed_by = horizon.uid(), closed_at = now()
   where id = v_open.id;
  perform horizon.audit('unassign', p_user, v_open.position_id, jsonb_build_object('date', v_date));
end $$;

create function horizon.assert_not_last_full_admin(p_user uuid)
returns void language plpgsql security definer set search_path = horizon, pg_temp as $$
begin
  if exists (select 1 from admin_scopes where user_id = p_user and scope = 'full')
     and not exists (
       select 1 from admin_scopes s join users u on u.id = s.user_id
        where s.scope = 'full' and u.is_active and s.user_id <> p_user) then
    raise exception 'нельзя снять последнего полного админа' using errcode = 'HZ409';
  end if;
end $$;

-- grant_admin: заменяет права человека целиком.
create function horizon.grant_admin(p_user uuid, p_full boolean, p_positions uuid[])
returns void language plpgsql security definer set search_path = horizon, pg_temp as $$
begin
  perform horizon.require_uid();
  if not horizon.is_full_admin() then
    raise exception 'только полный админ' using errcode = 'HZ403';
  end if;
  -- Два админа не должны одновременно разжаловать друг друга.
  lock table admin_scopes in share row exclusive mode;
  perform horizon.lock_user(p_user);

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

create function horizon.set_user_active(p_user uuid, p_active boolean)
returns void language plpgsql security definer set search_path = horizon, pg_temp as $$
begin
  perform horizon.require_uid();
  if not horizon.is_full_admin() then
    raise exception 'только полный админ' using errcode = 'HZ403';
  end if;
  lock table admin_scopes in share row exclusive mode;
  perform horizon.lock_user(p_user);
  if not p_active then
    if p_user = horizon.uid() then
      raise exception 'нельзя отключить самого себя' using errcode = 'HZ409';
    end if;
    perform horizon.assert_not_last_full_admin(p_user);
    update assignments set date_to = greatest(current_date, date_from),
                           closed_by = horizon.uid(), closed_at = now()
     where user_id = p_user and date_to is null;
    update sessions set revoked_at = now() where user_id = p_user and revoked_at is null;
  end if;
  update users set is_active = p_active where id = p_user;
  perform horizon.audit(case when p_active then 'activate' else 'deactivate' end, p_user, null);
end $$;

create function horizon.revoke_sessions(p_user uuid)
returns int language plpgsql security definer set search_path = horizon, pg_temp as $$
declare n int;
begin
  perform horizon.require_uid();
  if p_user <> horizon.uid() and not horizon.is_full_admin() then
    raise exception 'только полный админ' using errcode = 'HZ403';
  end if;
  update sessions set revoked_at = now() where user_id = p_user and revoked_at is null;
  get diagnostics n = row_count;
  perform horizon.audit('revoke_sessions', p_user, null, jsonb_build_object('count', n));
  return n;
end $$;

create function horizon.set_my_locale(p_locale text)
returns void language plpgsql security definer set search_path = horizon, pg_temp as $$
begin
  if p_locale is null or p_locale !~ '^[a-z]{2}$' then
    raise exception 'язык: код из двух латинских букв' using errcode = 'HZ422';
  end if;
  update users set locale = p_locale where id = horizon.require_uid();
end $$;

-- ===========================================================================
-- Места
-- ===========================================================================
create function horizon.upsert_position(p_id uuid, p_name text, p_stale_after_hours int, p_is_active boolean)
returns uuid language plpgsql security definer set search_path = horizon, pg_temp as $$
declare v_id uuid;
begin
  perform horizon.require_uid();
  if not horizon.is_full_admin() then
    raise exception 'только полный админ' using errcode = 'HZ403';
  end if;
  if p_id is null then
    insert into positions (name, stale_after_hours, is_active)
    values (trim(p_name), coalesce(p_stale_after_hours, 24), coalesce(p_is_active, true))
    returning id into v_id;
  else
    perform 1 from positions where id = p_id for update;
    if p_is_active = false and exists (select 1 from assignments where position_id = p_id and date_to is null) then
      raise exception 'на месте есть люди — сначала переведите или снимите их' using errcode = 'HZ409';
    end if;
    update positions
       set name = coalesce(trim(p_name), name),
           stale_after_hours = coalesce(p_stale_after_hours, stale_after_hours),
           is_active = coalesce(p_is_active, is_active)
     where id = p_id
    returning id into v_id;
    if v_id is null then
      raise exception 'место не найдено' using errcode = 'HZ404';
    end if;
  end if;
  perform horizon.audit('upsert_position', null, v_id, jsonb_build_object('name', p_name));
  return v_id;
exception
  when unique_violation then
    raise exception 'место «%» уже есть', trim(p_name) using errcode = 'HZ409';
  when check_violation then
    raise exception 'название 1–64 символа, порог устаревания 1–720 ч' using errcode = 'HZ422';
end $$;

-- ===========================================================================
-- Имущество
-- ===========================================================================
-- null в полях при обновлении = «не менять». Сохранение всегда освежает
-- updated_at — «подтвердил, что остаток тот же» тоже обновление.
-- p_expected_updated_at — снимок карточки; p_expected_qty — число, от которого
-- считал степпер. Не совпали — HZ409 вместо молчаливого «последний победил».
create function horizon.upsert_item(
  p_id uuid, p_position uuid, p_name text, p_category text, p_unit text,
  p_qty numeric, p_min numeric, p_acceptable numeric, p_ideal numeric,
  p_condition text, p_comment text, p_reason text default '',
  p_expected_updated_at timestamptz default null,
  p_expected_qty numeric default null)
returns horizon.items language plpgsql security definer set search_path = horizon, pg_temp as $$
declare
  v_old items;
  v_new items;
  v_min numeric; v_acc numeric; v_ideal numeric;
  v_category text;
begin
  perform horizon.require_uid();

  if p_id is null then
    if p_position is null or not horizon.can_read_position(p_position) then
      raise exception 'нет доступа к этому месту' using errcode = 'HZ403';
    end if;
    perform horizon.require_active_position(p_position);
    if p_min is null or p_acceptable is null or p_ideal is null then
      raise exception 'нужны три порога: мин, приемлемый, идеал' using errcode = 'HZ422';
    end if;
    v_min := p_min; v_acc := p_acceptable; v_ideal := p_ideal;
  else
    select * into v_old from items where id = p_id and deleted_at is null for update;
    if not found or not horizon.can_read_position(v_old.position_id) then
      raise exception 'строка не найдена' using errcode = 'HZ404';
    end if;
    -- Драйвер pg отдаёт timestamptz как JS Date: микросекунды до клиента не доезжают.
    if p_expected_updated_at is not null
       and date_trunc('milliseconds', v_old.updated_at)
        <> date_trunc('milliseconds', p_expected_updated_at) then
      raise exception 'строку уже изменили — откройте её заново' using errcode = 'HZ409';
    end if;
    if p_expected_qty is not null and v_old.qty <> p_expected_qty then
      raise exception 'остаток уже изменили: сейчас %', trim_scale(v_old.qty) using errcode = 'HZ409';
    end if;
    v_min := coalesce(p_min, v_old.min_qty);
    v_acc := coalesce(p_acceptable, v_old.acceptable_qty);
    v_ideal := coalesce(p_ideal, v_old.ideal_qty);
  end if;

  v_category := coalesce(trim(p_category), '');
  if v_category <> '' and not exists (select 1 from item_categories where name = v_category) then
    raise exception 'категории «%» нет в справочнике', v_category using errcode = 'HZ422';
  end if;

  if not horizon.thresholds_valid(v_min, v_acc, v_ideal) then
    raise exception 'пороги: мин ≥ 0 и мин < приемлемый ≤ идеал' using errcode = 'HZ422';
  end if;
  if coalesce(p_qty, 0) < 0 then
    raise exception 'остаток не может быть отрицательным' using errcode = 'HZ422';
  end if;

  if p_id is null then
    insert into items (position_id, name, category, unit, qty, min_qty, acceptable_qty, ideal_qty,
                       condition, comment, updated_by)
    values (p_position, trim(p_name), v_category, coalesce(nullif(trim(p_unit), ''), 'шт'),
            coalesce(p_qty, 0), v_min, v_acc, v_ideal,
            coalesce(p_condition, 'ok'), coalesce(p_comment, ''), horizon.uid())
    returning * into v_new;
    insert into stock_movements (item_id, position_id, qty_before, qty_after, reason, created_by)
    values (v_new.id, v_new.position_id, null, v_new.qty, coalesce(p_reason, 'создание'), horizon.uid());
  else
    update items
       set name = coalesce(trim(p_name), name),
           category = case when p_category is null then category else v_category end,
           unit = coalesce(nullif(trim(p_unit), ''), unit),
           qty = coalesce(p_qty, qty),
           min_qty = v_min, acceptable_qty = v_acc, ideal_qty = v_ideal,
           condition = coalesce(p_condition, condition),
           comment = coalesce(p_comment, comment),
           updated_at = now(),
           updated_by = horizon.uid()
     where id = p_id
    returning * into v_new;
    if v_new.qty <> v_old.qty then
      insert into stock_movements (item_id, position_id, qty_before, qty_after, reason, created_by)
      values (v_new.id, v_new.position_id, v_old.qty, v_new.qty, coalesce(p_reason, ''), horizon.uid())
      on conflict (item_id) do update
        set position_id = excluded.position_id,
            qty_before  = excluded.qty_before,
            qty_after   = excluded.qty_after,
            reason      = excluded.reason,
            created_by  = excluded.created_by,
            created_at  = now();
    end if;
  end if;

  return v_new;
exception
  when unique_violation then
    raise exception 'строка «%» на этом месте уже есть', coalesce(trim(p_name), v_old.name) using errcode = 'HZ409';
  when check_violation then
    raise exception 'проверьте поля: название 1–80, категория ≤ 40, ед. 1–12, комментарий ≤ 280, состояние ok|repair|broken'
      using errcode = 'HZ422';
end $$;

create function horizon.delete_item(p_id uuid)
returns void language plpgsql security definer set search_path = horizon, pg_temp as $$
declare v items;
begin
  perform horizon.require_uid();
  select * into v from items where id = p_id and deleted_at is null for update;
  if not found or not horizon.can_read_position(v.position_id) then
    raise exception 'строка не найдена' using errcode = 'HZ404';
  end if;
  update items set deleted_at = now(), updated_by = horizon.uid() where id = p_id;
  perform horizon.audit('delete_item', null, v.position_id, jsonb_build_object('item', v.name));
end $$;

-- ===========================================================================
-- Чтение для UI
-- ===========================================================================
create function horizon.me() returns jsonb
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
    'assignment', (select jsonb_build_object('position_id', p.id, 'name', p.name, 'date_from', a.date_from)
                     from assignments a join positions p on p.id = a.position_id
                    where a.user_id = u.id and a.date_to is null))
  from users u where u.id = horizon.uid() and u.is_active
$$;

create function horizon.admin_overview() returns jsonb
language plpgsql stable security definer set search_path = horizon, pg_temp as $$
declare
  v_tiles jsonb;
  v_red jsonb;
begin
  perform horizon.require_uid();
  if not horizon.is_admin() then
    raise exception 'нужны права админа' using errcode = 'HZ403';
  end if;

  select coalesce(jsonb_agg(t order by t.red desc, t.stale desc, lower(t.name)), '[]') into v_tiles
  from (
    select p.id, p.name, p.is_active, p.stale_after_hours,
           (select count(*) from assignments a where a.position_id = p.id and a.date_to is null) as people,
           count(i.id) filter (where i.stock_rank = 0) as red,
           count(i.id) filter (where i.stock_rank = 1) as yellow,
           count(i.id) filter (where i.stock_rank = 2) as green,
           max(i.updated_at) as last_update,
           coalesce(max(i.updated_at) < now() - make_interval(hours => p.stale_after_hours), false) as stale
      from positions p
      left join items i on i.position_id = p.id and i.deleted_at is null
     where horizon.can_admin_position(p.id)
     group by p.id
  ) t;

  select coalesce(jsonb_agg(x order by x.updated_at), '[]') into v_red
  from (
    select i.id, i.name, i.unit, i.qty, i.min_qty, i.updated_at, p.id as position_id, p.name as position_name
      from items i join positions p on p.id = i.position_id
     where i.deleted_at is null and i.stock_rank = 0 and p.is_active
       and horizon.can_admin_position(p.id)
  ) x;

  return jsonb_build_object('tiles', v_tiles, 'red', v_red);
end $$;

create function horizon.admin_people() returns jsonb
language plpgsql stable security definer set search_path = horizon, pg_temp as $$
declare
  v_full boolean := horizon.is_full_admin();
  v_me uuid := horizon.uid();
begin
  perform horizon.require_uid();
  if not horizon.is_admin() then
    raise exception 'нужны права админа' using errcode = 'HZ403';
  end if;
  return (
    select coalesce(jsonb_agg(x order by x.is_active desc, lower(x.callsign)), '[]')
    from (
      -- Логин — половина входа. Админ зоны видит его только у тех, кого завёл сам:
      -- иначе список неназначенных раздавал бы логины полных админов.
      select u.id,
             case when v_full or u.created_by = v_me or u.id = v_me then u.login end as login,
             u.callsign, u.is_active,
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

create function horizon.user_history(p_user uuid) returns jsonb
language plpgsql stable security definer set search_path = horizon, pg_temp as $$
begin
  perform horizon.require_uid();
  if p_user <> horizon.uid() and not horizon.is_admin() then
    raise exception 'нужны права админа' using errcode = 'HZ403';
  end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', a.id, 'position_id', a.position_id, 'position_name', p.name,
             'date_from', a.date_from, 'date_to', a.date_to,
             'assigned_by', ab.callsign, 'closed_by', cb.callsign)
           order by a.date_from desc, a.created_at desc), '[]')
      from assignments a
      join positions p on p.id = a.position_id
      left join users ab on ab.id = a.assigned_by
      left join users cb on cb.id = a.closed_by
     where a.user_id = p_user
       and (p_user = horizon.uid() or horizon.is_full_admin() or horizon.can_admin_position(a.position_id))
  );
end $$;

-- ===========================================================================
-- Вход. Хеши считает API (scrypt для паролей, sha256 для токенов, HMAC для кодов).
-- Доступно только роли horizon_api.
-- ===========================================================================
create function horizon.auth_lookup(p_login text)
returns table (id uuid, password_hash text, totp_secret text, totp_last_step bigint,
               invite_code_hash text, invite_expires_at timestamptz,
               is_active boolean, is_admin boolean)
language sql stable security definer set search_path = horizon, pg_temp as $$
  select u.id, u.password_hash, u.totp_secret, u.totp_last_step, u.invite_code_hash, u.invite_expires_at,
         u.is_active, exists (select 1 from admin_scopes s where s.user_id = u.id)
    from users u where lower(u.login) = lower(trim(p_login))
$$;

create function horizon.auth_session_create(p_user uuid, p_token_hash text, p_device text, p_ua text, p_ttl_days int)
returns uuid language sql security definer set search_path = horizon, pg_temp as $$
  insert into sessions (user_id, token_hash, device_id, user_agent, expires_at)
  values (p_user, p_token_hash, p_device, left(coalesce(p_ua, ''), 200), now() + make_interval(days => p_ttl_days))
  returning id
$$;

-- Первый вход / после сброса: код сгорает, пароль и секрет TOTP сохраняются, сессия открывается.
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

/**
 * Сколько секунд ждать перед следующей попыткой; 0 — можно пробовать.
 * Пара «IP + логин»: 1, 2, 4 … 60 секунд. IP целиком: не больше p_ip_limit
 * неудач в час. Логин со всех адресов: не больше p_user_limit в час — кроме
 * устройства, с которого человек уже входил: чужие ошибки не держат владельца снаружи.
 */
create function horizon.auth_gate(p_ip text, p_callsign text, p_ip_limit int default 20,
                                  p_user_limit int default 50, p_device text default '')
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
  known as (
    select coalesce(p_device, '') <> '' and exists (
             select 1 from sessions s join users u on u.id = s.user_id
              where lower(u.login) = lower(trim(p_callsign)) and s.device_id = p_device) as k
  ),
  user_wait as (
    select 60 as w from auth_attempts
     where lower(callsign) = lower(trim(p_callsign)) and created_at > now() - interval '1 hour'
       and not (select k from known)
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

/**
 * Проверка сессии на каждый запрос. Возвращает владельца и признак того, что
 * токен только что заменён (тогда API кладёт новый в cookie). Пустой результат —
 * сессии нет, она чужая или сгорела.
 */
create function horizon.auth_session_touch(p_token_hash text, p_device text, p_new_token_hash text,
                                           p_rotate_hours int default 24, p_grace_seconds int default 120)
returns table (user_id uuid, rotated boolean)
language plpgsql security definer set search_path = horizon, pg_temp as $$
declare s sessions;
begin
  -- Колонки везде с псевдонимом: user_id здесь ещё и OUT-параметр функции.
  select * into s from sessions ss
   where ss.token_hash = p_token_hash or ss.prev_token_hash = p_token_hash
   for update;
  if not found or s.revoked_at is not null or s.expires_at <= now() then
    return;
  end if;
  if not exists (select 1 from users u where u.id = s.user_id and u.is_active) then
    return;
  end if;

  -- Токен без своего устройства — его перенесли. Сессию не гасим: владельцу его
  -- cookie устройства всё ещё при нём. В журнал — не чаще раза в 10 минут.
  if coalesce(p_device, '') <> s.device_id then
    if not exists (select 1 from audit_log l
                    where l.action = 'session_device_mismatch' and l.target_user_id = s.user_id
                      and l.created_at > now() - interval '10 minutes'
                      and l.details->>'session' = s.id::text) then
      insert into audit_log (action, target_user_id, details)
      values ('session_device_mismatch', s.user_id,
              jsonb_build_object('session', s.id, 'device_sent', coalesce(p_device, '') <> ''));
    end if;
    return;
  end if;

  if s.prev_token_hash = p_token_hash then
    -- Параллельные запросы, ушедшие до ротации, — короткая фора.
    if s.rotated_at >= now() - make_interval(secs => p_grace_seconds) then
      return query select s.user_id, false;
      return;
    end if;
    -- Новый токен ни разу не вернулся: ответ с ним потерялся. Выдаём заново.
    if not s.rotation_confirmed then
      if p_new_token_hash is null then
        return query select s.user_id, false;
        return;
      end if;
      update sessions ss set token_hash = p_new_token_hash, rotated_at = now() where ss.id = s.id;
      return query select s.user_id, true;
      return;
    end if;
    -- Новым уже пользовались, а старый всплыл снова — его унесли.
    update sessions ss set revoked_at = now() where ss.user_id = s.user_id and ss.revoked_at is null;
    insert into audit_log (action, target_user_id, details)
    values ('session_token_reuse', s.user_id, jsonb_build_object('session', s.id));
    return;
  end if;

  if not s.rotation_confirmed then
    update sessions ss set rotation_confirmed = true where ss.id = s.id;
  end if;
  if s.last_seen_at < now() - interval '5 minutes' then
    update sessions ss set last_seen_at = now() where ss.id = s.id;
  end if;

  if p_new_token_hash is not null and s.rotated_at < now() - make_interval(hours => p_rotate_hours) then
    update sessions ss
       set prev_token_hash = s.token_hash, token_hash = p_new_token_hash,
           rotated_at = now(), rotation_confirmed = false
     where ss.id = s.id;
    return query select s.user_id, true;
    return;
  end if;

  return query select s.user_id, false;
end $$;

-- Выход находит сессию и по прошлому токену: телефон мог не получить новый cookie.
create function horizon.auth_session_revoke(p_token_hash text) returns void
language sql security definer set search_path = horizon, pg_temp as $$
  update sessions set revoked_at = now()
   where (token_hash = p_token_hash or prev_token_hash = p_token_hash) and revoked_at is null
$$;

-- Раз в час из API: протухшие сессии, счётчики попыток, давно удалённое имущество.
create function horizon.cleanup() returns void
language sql security definer set search_path = horizon, pg_temp as $$
  delete from sessions where expires_at < now() - interval '30 days';
  delete from auth_attempts where created_at < now() - interval '1 day';
  -- Движение ссылается на строку, поэтому сначала оно.
  delete from stock_movements m
   using items i
   where i.id = m.item_id and i.deleted_at < now() - interval '1 year';
  delete from items where deleted_at < now() - interval '1 year';
$$;

-- ===========================================================================
-- RLS
-- ===========================================================================
-- horizon_user только читает, и только то, что разрешают политики. Любая
-- запись — через функции выше (security definer + явная проверка прав).
-- Функции прав в политиках обёрнуты в (select …): так они считаются один раз
-- на запрос (InitPlan), а не на каждую строку.
alter table horizon.users           enable row level security;
alter table horizon.positions       enable row level security;
alter table horizon.admin_scopes    enable row level security;
alter table horizon.assignments     enable row level security;
alter table horizon.items           enable row level security;
alter table horizon.item_categories enable row level security;
alter table horizon.stock_movements enable row level security;
alter table horizon.sessions        enable row level security;
alter table horizon.auth_attempts   enable row level security;
alter table horizon.audit_log       enable row level security;

-- Человек видит себя, коллег по месту и тех, чья подпись стоит на его доске
-- (иначе после перевода автора подпись «кто обновил» исчезала); админ — всех.
create policy users_read on horizon.users for select to horizon_user using (
  id = (select horizon.uid())
  or (select horizon.is_admin())
  or exists (select 1 from horizon.assignments a
              where a.user_id = users.id and a.date_to is null
                and a.position_id = (select horizon.current_position_id()))
  or exists (select 1 from horizon.items i
              where i.updated_by = users.id and i.deleted_at is null
                and i.position_id = (select horizon.current_position_id()))
  or exists (select 1 from horizon.stock_movements m
              where m.created_by = users.id
                and m.position_id = (select horizon.current_position_id()))
);

create policy positions_read on horizon.positions for select to horizon_user using (
  id = (select horizon.current_position_id())
  or (select horizon.is_full_admin())
  or id = any ((select horizon.my_admin_position_ids())::uuid[])
);

create policy admin_scopes_read on horizon.admin_scopes for select to horizon_user using (
  user_id = (select horizon.uid()) or (select horizon.is_full_admin())
);

-- Свою историю, шапку своего места, привязки мест своей зоны.
create policy assignments_read on horizon.assignments for select to horizon_user using (
  user_id = (select horizon.uid())
  or (select horizon.is_full_admin())
  or position_id = any ((select horizon.my_admin_position_ids())::uuid[])
  or (date_to is null and position_id = (select horizon.current_position_id()))
);

-- Нет открытой привязки → current_position_id() = null → пусто.
create policy items_read on horizon.items for select to horizon_user using (
  deleted_at is null and (
    position_id = (select horizon.current_position_id())
    or (select horizon.is_full_admin())
    or position_id = any ((select horizon.my_admin_position_ids())::uuid[]))
);

create policy stock_movements_read on horizon.stock_movements for select to horizon_user using (
  position_id = (select horizon.current_position_id())
  or (select horizon.is_full_admin())
  or position_id = any ((select horizon.my_admin_position_ids())::uuid[])
);

-- Справочник видят все: в нём нет ничего, кроме названий.
create policy item_categories_read on horizon.item_categories for select to horizon_user using (true);

-- Для sessions, auth_attempts, audit_log политик нет: RLS включён, grant нет — доступа нет.

-- ===========================================================================
-- Права
-- ===========================================================================
-- Функции Postgres по умолчанию открыты PUBLIC. Закрываем всё и выдаём поимённо;
-- каждая следующая миграция, создающая функцию, обязана сделать то же самое
-- (сторож — тест «наружу не торчит ни одна функция схемы» и шаг в CI).
revoke all on all tables in schema horizon from public;
revoke execute on all functions in schema horizon from public;

grant select on horizon.positions, horizon.assignments, horizon.items, horizon.stock_movements,
                horizon.admin_scopes, horizon.item_categories
  to horizon_user;
-- Хеши, секреты и логин не видны никому, кроме функций.
grant select (id, callsign, is_active) on horizon.users to horizon_user;

grant execute on function
  horizon.uid(),
  horizon.require_uid(),
  horizon.is_full_admin(),
  horizon.is_admin(),
  horizon.can_admin_position(uuid),
  horizon.my_admin_position_ids(),
  horizon.current_position_id(),
  horizon.can_read_position(uuid),
  horizon.status(numeric, numeric, numeric, numeric),
  horizon.is_full_stock(numeric, numeric),
  horizon.thresholds_valid(numeric, numeric, numeric),
  horizon.invite_user(text, text, text, int),
  horizon.reset_access(uuid, text, int),
  horizon.assign_to_position(uuid, uuid, date),
  horizon.transfer_user(uuid, uuid, date),
  horizon.unassign_user(uuid, date),
  horizon.grant_admin(uuid, boolean, uuid[]),
  horizon.set_user_active(uuid, boolean),
  horizon.revoke_sessions(uuid),
  horizon.set_my_locale(text),
  horizon.upsert_position(uuid, text, int, boolean),
  horizon.upsert_item(uuid, uuid, text, text, text, numeric, numeric, numeric, numeric, text, text, text, timestamptz, numeric),
  horizon.delete_item(uuid),
  horizon.me(),
  horizon.admin_overview(),
  horizon.admin_people(),
  horizon.user_history(uuid)
to horizon_user;

grant execute on function
  horizon.auth_lookup(text),
  horizon.auth_session_create(uuid, text, text, text, int),
  horizon.auth_complete_invite(uuid, text, text, text, text, text, text, int),
  horizon.auth_totp_consume(uuid, bigint),
  horizon.auth_gate(text, text, int, int, text),
  horizon.auth_note_fail(text, text),
  horizon.auth_note_success(text, text),
  horizon.auth_session_touch(text, text, text, int, int),
  horizon.auth_session_revoke(text),
  horizon.cleanup()
to horizon_api;

-- /api/health называет последнюю применённую миграцию.
grant select on public.horizon_migrations to horizon_api;
