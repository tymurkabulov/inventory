-- Horizon · схема данных (ТЗ v2.1, раздел 7)
-- Инвариант: один человек — одно место. См. assignments_one_open_per_user.

create schema if not exists horizon;

-- ---------------------------------------------------------------------------
-- Роли
--   horizon_api   — логин API. Сам по себе умеет только auth_* функции.
--   horizon_user  — роль запроса аутентифицированного человека (SET LOCAL ROLE).
--   horizon_worker — логин воркера. Только функции worker_* и scan_stale.
-- Миграции и CLI работают под владельцем схемы.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'horizon_user') then
    create role horizon_user nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'horizon_api') then
    create role horizon_api login noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'horizon_worker') then
    create role horizon_worker login noinherit;
  end if;
end $$;

grant horizon_user to horizon_api;
grant usage on schema horizon to horizon_api, horizon_user, horizon_worker;

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------
create table horizon.users (
  id                uuid primary key default gen_random_uuid(),
  callsign          text not null,
  phone_e164        text,
  pin_hash          text,
  invite_code_hash  text,
  invite_expires_at timestamptz,
  is_active         boolean not null default true,
  failed_attempts   int not null default 0,
  locked_until      timestamptz,
  created_at        timestamptz not null default now(),
  created_by        uuid references horizon.users(id),
  constraint users_callsign_format check (callsign ~ '^[0-9A-Za-zА-Яа-яЁё._-]{2,32}$'),
  constraint users_phone_format check (phone_e164 is null or phone_e164 ~ '^\+[1-9][0-9]{6,14}$')
);
create unique index users_callsign_unique on horizon.users (lower(callsign));

-- ---------------------------------------------------------------------------
-- positions
-- ---------------------------------------------------------------------------
create table horizon.positions (
  id                uuid primary key default gen_random_uuid(),
  name              text not null check (length(trim(name)) between 1 and 64),
  type              text not null default 'position'
                    check (type in ('position', 'workshop', 'depot', 'hq')),
  is_active         boolean not null default true,
  stale_after_hours int not null default 24 check (stale_after_hours between 1 and 720),
  created_at        timestamptz not null default now()
);
create unique index positions_name_unique on horizon.positions (lower(name));

-- ---------------------------------------------------------------------------
-- admin_scopes
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- assignments — история мест. Закрытые строки не удаляются.
-- ---------------------------------------------------------------------------
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
create unique index assignments_one_open_per_user
  on horizon.assignments (user_id) where date_to is null;
create index assignments_open_by_position
  on horizon.assignments (position_id) where date_to is null;
create index assignments_user_history on horizon.assignments (user_id, date_from desc);

-- Историю не удаляют.
create function horizon.forbid_delete() returns trigger
language plpgsql as $$
begin
  raise exception 'удаление % запрещено', tg_table_name using errcode = 'P0001';
end $$;

create trigger assignments_no_delete before delete on horizon.assignments
  for each row execute function horizon.forbid_delete();

-- ---------------------------------------------------------------------------
-- items
-- ---------------------------------------------------------------------------
create table horizon.items (
  id                   uuid primary key default gen_random_uuid(),
  position_id          uuid not null references horizon.positions(id),
  name                 text not null check (length(trim(name)) between 1 and 80),
  category             text not null default '' check (length(category) <= 40),
  unit                 text not null default 'шт' check (length(unit) between 1 and 12),
  qty                  numeric(12, 2) not null default 0 check (qty >= 0),
  min_qty              numeric(12, 2) not null,
  acceptable_qty       numeric(12, 2) not null,
  ideal_qty            numeric(12, 2) not null,
  condition            text not null default 'ok' check (condition in ('ok', 'repair', 'broken')),
  comment              text not null default '' check (length(comment) <= 280),
  metadata             jsonb not null default '{}'::jsonb,
  -- 0 = red, 1 = yellow, 2 = green. Цвет не храним, только ранг для сортировки.
  stock_rank           smallint generated always as (
                         case when qty < min_qty then 0
                              when qty < acceptable_qty then 1
                              else 2 end
                       ) stored,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  updated_by           uuid references horizon.users(id),
  deleted_at           timestamptz,
  last_red_notified_at timestamptz,
  -- Раздел 5: min ≥ 0 и min < acceptable ≤ ideal
  constraint items_thresholds check (min_qty >= 0 and min_qty < acceptable_qty and acceptable_qty <= ideal_qty)
);
create index items_board on horizon.items (position_id, stock_rank, name) where deleted_at is null;
create unique index items_name_per_position on horizon.items (position_id, lower(name)) where deleted_at is null;

-- ---------------------------------------------------------------------------
-- stock_movements
-- ---------------------------------------------------------------------------
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
create index stock_movements_item on horizon.stock_movements (item_id, created_at desc);

-- ---------------------------------------------------------------------------
-- sessions, устройства, коды подтверждения нового девайса админа
-- ---------------------------------------------------------------------------
create table horizon.sessions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references horizon.users(id) on delete cascade,
  token_hash   text not null unique,
  device_id    text not null default '',
  user_agent   text not null default '',
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at   timestamptz not null,
  revoked_at   timestamptz
);
create index sessions_user on horizon.sessions (user_id) where revoked_at is null;

create table horizon.known_devices (
  user_id    uuid not null references horizon.users(id) on delete cascade,
  device_id  text not null,
  first_seen timestamptz not null default now(),
  primary key (user_id, device_id)
);

create table horizon.login_challenges (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references horizon.users(id) on delete cascade,
  device_id  text not null,
  code_hash  text not null,
  attempts   int not null default 0,
  expires_at timestamptz not null,
  used_at    timestamptz,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- notifications — очередь бота. UI в неё только пишет, воркер разбирает.
-- ---------------------------------------------------------------------------
create table horizon.notifications (
  id           bigint generated always as identity primary key,
  kind         text not null check (kind in ('critical_red', 'daily_stale', 'stale_repeat',
                                             'stale_admin', 'device_code', 'manual')),
  recipient_id uuid not null references horizon.users(id) on delete cascade,
  position_id  uuid references horizon.positions(id),
  item_id      uuid references horizon.items(id),
  body         text not null,
  dedupe_key   text,
  status       text not null default 'pending' check (status in ('pending', 'sent', 'failed', 'skipped')),
  not_before   timestamptz not null default now(),
  attempts     int not null default 0,
  last_error   text,
  created_at   timestamptz not null default now(),
  sent_at      timestamptz
);
create index notifications_queue on horizon.notifications (not_before) where status = 'pending';
create unique index notifications_dedupe on horizon.notifications (recipient_id, dedupe_key)
  where dedupe_key is not null;

-- ---------------------------------------------------------------------------
-- audit_log
-- ---------------------------------------------------------------------------
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
