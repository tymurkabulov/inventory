-- Horizon · RLS и права (ТЗ v2.1, раздел 8)
--
-- horizon_user только читает, и только то, что разрешают политики.
-- Любая запись — через функции раздела 9 (security definer + явная проверка прав).
-- Уникальный индекс открытой привязки работает даже для прямых INSERT в обход UI.

revoke all on all tables in schema horizon from public;
revoke execute on all functions in schema horizon from public;
alter default privileges in schema horizon revoke execute on functions from public;

-- ---------------------------------------------------------------------------
-- Чтение
-- ---------------------------------------------------------------------------
grant select on horizon.positions, horizon.assignments, horizon.items, horizon.stock_movements,
                horizon.admin_scopes
  to horizon_user;
-- Телефон, хеши, счётчики попыток не видны никому, кроме функций.
grant select (id, callsign, is_active) on horizon.users to horizon_user;

alter table horizon.users           enable row level security;
alter table horizon.positions       enable row level security;
alter table horizon.admin_scopes    enable row level security;
alter table horizon.assignments     enable row level security;
alter table horizon.items           enable row level security;
alter table horizon.stock_movements enable row level security;
alter table horizon.sessions        enable row level security;
alter table horizon.known_devices   enable row level security;
alter table horizon.login_challenges enable row level security;
alter table horizon.notifications   enable row level security;
alter table horizon.audit_log       enable row level security;

-- Человек видит себя, коллег по своему единственному месту; админ — всех.
create policy users_read on horizon.users for select to horizon_user using (
  id = horizon.uid()
  or horizon.is_admin()
  or exists (select 1 from horizon.assignments a
              where a.user_id = users.id and a.date_to is null
                and a.position_id = horizon.current_position_id())
);

create policy positions_read on horizon.positions for select to horizon_user using (
  horizon.can_read_position(id)
);

create policy admin_scopes_read on horizon.admin_scopes for select to horizon_user using (
  user_id = horizon.uid() or horizon.is_full_admin()
);

-- Свою историю, шапку своего места, привязки мест своей зоны.
create policy assignments_read on horizon.assignments for select to horizon_user using (
  user_id = horizon.uid()
  or horizon.can_admin_position(position_id)
  or (date_to is null and position_id = horizon.current_position_id())
);

-- Нет открытой привязки → current_position_id() = null → пусто.
create policy items_read on horizon.items for select to horizon_user using (
  deleted_at is null and horizon.can_read_position(position_id)
);

create policy stock_movements_read on horizon.stock_movements for select to horizon_user using (
  horizon.can_read_position(position_id)
);

-- Для sessions, known_devices, login_challenges, notifications, audit_log политик
-- для horizon_user нет: RLS включён, grant нет — доступа нет.

-- ---------------------------------------------------------------------------
-- Функции
-- ---------------------------------------------------------------------------
grant execute on function
  horizon.uid(),
  horizon.require_uid(),
  horizon.is_full_admin(),
  horizon.is_admin(),
  horizon.can_admin_position(uuid),
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
  horizon.upsert_position(uuid, text, text, int, boolean),
  horizon.upsert_item(uuid, uuid, text, text, text, numeric, numeric, numeric, numeric, text, text, text),
  horizon.delete_item(uuid),
  horizon.notify_position(uuid, text),
  horizon.me(),
  horizon.admin_overview(),
  horizon.admin_people(),
  horizon.user_history(uuid)
to horizon_user;

grant execute on function
  horizon.auth_lookup(text),
  horizon.auth_fail(uuid),
  horizon.auth_session_create(uuid, text, text, text, int),
  horizon.auth_complete_invite(uuid, text, text, text, text, text, int),
  horizon.auth_device_known(uuid, text),
  horizon.auth_challenge_create(uuid, text, text, text),
  horizon.auth_challenge_verify(uuid, text, text, text, text, int),
  horizon.auth_session_resolve(text),
  horizon.auth_session_revoke(text)
to horizon_api;

grant execute on function
  horizon.quiet_release(timestamptz, int, int, text),
  horizon.scan_stale(timestamptz, int, int, int, int, text),
  horizon.worker_claim(int),
  horizon.worker_finish(bigint[], text, int),
  horizon.worker_skip(bigint[], text),
  horizon.worker_cleanup()
to horizon_worker;
