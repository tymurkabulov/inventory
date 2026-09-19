-- Horizon · функции (ТЗ v2.1, разделы 5, 8, 9, 12)
--
-- Коды ошибок (SQLSTATE), которые API превращает в HTTP:
--   HZ401 не авторизован · HZ403 нет прав · HZ404 не найдено
--   HZ409 конфликт       · HZ422 неверные данные · HZ429 слишком часто

-- ---------------------------------------------------------------------------
-- Контекст запроса
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- Раздел 5. Цвет
-- ---------------------------------------------------------------------------
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

-- Кому писать по месту: люди с открытой привязкой и/или админы этого места.
create function horizon.position_recipients(p_position uuid, p_people boolean, p_admins boolean)
returns setof uuid language sql stable security definer set search_path = horizon, pg_temp as $$
  select a.user_id from assignments a join users u on u.id = a.user_id
   where p_people and a.position_id = p_position and a.date_to is null and u.is_active
  union
  select s.user_id from admin_scopes s join users u on u.id = s.user_id
   where p_admins and u.is_active and (s.scope = 'full' or s.position_id = p_position)
$$;

create function horizon.status_label(p_qty numeric, p_unit text)
returns text language sql immutable as $$
  select trim_scale(p_qty)::text || ' ' || p_unit
$$;

-- ---------------------------------------------------------------------------
-- Раздел 9. Люди и места
-- ---------------------------------------------------------------------------
create function horizon.invite_user(p_callsign text, p_phone text, p_code_hash text, p_valid_hours int default 72)
returns uuid language plpgsql security definer set search_path = horizon, pg_temp as $$
declare v_id uuid;
begin
  perform horizon.require_uid();
  if not horizon.is_admin() then
    raise exception 'нужны права админа' using errcode = 'HZ403';
  end if;
  if exists (select 1 from users where lower(callsign) = lower(trim(p_callsign))) then
    raise exception 'позывной «%» уже занят', trim(p_callsign) using errcode = 'HZ409';
  end if;
  insert into users (callsign, phone_e164, invite_code_hash, invite_expires_at, created_by)
  values (trim(p_callsign), nullif(trim(p_phone), ''), p_code_hash,
          now() + make_interval(hours => p_valid_hours), horizon.uid())
  returning id into v_id;
  perform horizon.audit('invite_user', v_id, null, jsonb_build_object('callsign', trim(p_callsign)));
  return v_id;
exception
  when check_violation then
    raise exception 'позывной: 2–32 символа (буквы, цифры, . _ -); телефон в формате +XXXXXXXXXXX'
      using errcode = 'HZ422';
end $$;

-- Сброс доступа: новый одноразовый код, PIN стирается, все сессии гаснут.
create function horizon.reset_access(p_user uuid, p_code_hash text, p_valid_hours int default 72)
returns void language plpgsql security definer set search_path = horizon, pg_temp as $$
begin
  perform horizon.require_uid();
  if not horizon.is_full_admin() then
    raise exception 'только полный админ' using errcode = 'HZ403';
  end if;
  update users
     set pin_hash = null, invite_code_hash = p_code_hash,
         invite_expires_at = now() + make_interval(hours => p_valid_hours),
         failed_attempts = 0, locked_until = null
   where id = p_user;
  if not found then
    raise exception 'человек не найден' using errcode = 'HZ404';
  end if;
  update sessions set revoked_at = now() where user_id = p_user and revoked_at is null;
  delete from known_devices where user_id = p_user;
  perform horizon.audit('reset_access', p_user, null);
end $$;

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

create function horizon.require_active_position(p_position uuid) returns horizon.positions
language plpgsql security definer set search_path = horizon, pg_temp as $$
declare v positions;
begin
  select * into v from positions where id = p_position;
  if not found then
    raise exception 'место не найдено' using errcode = 'HZ404';
  end if;
  if not v.is_active then
    raise exception 'место «%» выключено', v.name using errcode = 'HZ409';
  end if;
  return v;
end $$;

create function horizon.assign_to_position(p_user uuid, p_position uuid, p_date_from date)
returns uuid language plpgsql security definer set search_path = horizon, pg_temp as $$
declare
  v_user users;
  v_id uuid;
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
  if exists (select 1 from assignments where user_id = p_user and date_to is null) then
    raise exception 'у человека уже есть место — сначала переведите или снимите' using errcode = 'HZ409';
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
    raise exception 'админу нужен телефон бота — на него приходит код нового устройства'
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

-- ---------------------------------------------------------------------------
-- Места
-- ---------------------------------------------------------------------------
create function horizon.upsert_position(p_id uuid, p_name text, p_type text, p_stale_after_hours int, p_is_active boolean)
returns uuid language plpgsql security definer set search_path = horizon, pg_temp as $$
declare v_id uuid;
begin
  perform horizon.require_uid();
  if not horizon.is_full_admin() then
    raise exception 'только полный админ' using errcode = 'HZ403';
  end if;
  if p_id is null then
    insert into positions (name, type, stale_after_hours, is_active)
    values (trim(p_name), coalesce(p_type, 'position'), coalesce(p_stale_after_hours, 24), coalesce(p_is_active, true))
    returning id into v_id;
  else
    if p_is_active = false and exists (select 1 from assignments where position_id = p_id and date_to is null) then
      raise exception 'на месте есть люди — сначала переведите или снимите их' using errcode = 'HZ409';
    end if;
    update positions
       set name = coalesce(trim(p_name), name),
           type = coalesce(p_type, type),
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
    raise exception 'название 1–64 символа, тип position|workshop|depot|hq, stale 1–720 ч' using errcode = 'HZ422';
end $$;

-- ---------------------------------------------------------------------------
-- Имущество
-- ---------------------------------------------------------------------------
-- upsert_item: null в полях при обновлении = «не менять». Сохранение всегда
-- освежает updated_at — «подтвердил, что остаток тот же» тоже обновление.
create function horizon.upsert_item(
  p_id uuid, p_position uuid, p_name text, p_category text, p_unit text,
  p_qty numeric, p_min numeric, p_acceptable numeric, p_ideal numeric,
  p_condition text, p_comment text, p_reason text default '')
returns horizon.items language plpgsql security definer set search_path = horizon, pg_temp as $$
declare
  v_old items;
  v_new items;
  v_min numeric; v_acc numeric; v_ideal numeric;
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
    v_min := coalesce(p_min, v_old.min_qty);
    v_acc := coalesce(p_acceptable, v_old.acceptable_qty);
    v_ideal := coalesce(p_ideal, v_old.ideal_qty);
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
    values (p_position, trim(p_name), coalesce(trim(p_category), ''), coalesce(nullif(trim(p_unit), ''), 'шт'),
            coalesce(p_qty, 0), v_min, v_acc, v_ideal,
            coalesce(p_condition, 'ok'), coalesce(p_comment, ''), horizon.uid())
    returning * into v_new;
    insert into stock_movements (item_id, position_id, qty_before, qty_after, reason, created_by)
    values (v_new.id, v_new.position_id, null, v_new.qty, coalesce(p_reason, 'создание'), horizon.uid());
  else
    update items
       set name = coalesce(trim(p_name), name),
           category = coalesce(trim(p_category), category),
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
      values (v_new.id, v_new.position_id, v_old.qty, v_new.qty, coalesce(p_reason, ''), horizon.uid());
    end if;
  end if;

  -- Триггер мог проставить last_red_notified_at — вернуть актуальную строку.
  select * into v_new from items where id = v_new.id;
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

-- Раздел 4.2 / 12: вход в red → critical_red сразу, не чаще раза в 3 часа на строку.
create function horizon.items_critical_red() returns trigger
language plpgsql security definer set search_path = horizon, pg_temp as $$
declare
  v_pos positions;
  v_body text;
begin
  if new.deleted_at is not null or new.stock_rank <> 0 then
    return null;
  end if;
  if tg_op = 'UPDATE' and old.stock_rank = 0 and old.deleted_at is null then
    return null; -- уже была красной
  end if;
  if new.last_red_notified_at is not null and new.last_red_notified_at > now() - interval '3 hours' then
    return null;
  end if;

  select * into v_pos from positions where id = new.position_id;
  v_body := format('🔴 %s: %s — %s (мин %s)', v_pos.name, new.name,
                   horizon.status_label(new.qty, new.unit), horizon.status_label(new.min_qty, new.unit));

  insert into notifications (kind, recipient_id, position_id, item_id, body)
  select 'critical_red', r, new.position_id, new.id, v_body
    from horizon.position_recipients(new.position_id, true, true) r;

  update items set last_red_notified_at = now() where id = new.id;
  return null;
end $$;

create trigger items_critical_red
  after insert or update of qty, min_qty, acceptable_qty, deleted_at on horizon.items
  for each row execute function horizon.items_critical_red();

-- ---------------------------------------------------------------------------
-- Раздел 4.4. Протухшие данные. Вызывает воркер (владелец схемы).
-- ---------------------------------------------------------------------------
create function horizon.quiet_release(p_now timestamptz, p_quiet_from int, p_quiet_to int, p_tz text)
returns timestamptz language plpgsql stable as $$
declare
  v_local timestamp := p_now at time zone p_tz;
  v_hour int := extract(hour from v_local);
  v_end timestamp;
begin
  if p_quiet_from = p_quiet_to then
    return p_now;
  end if;
  if (p_quiet_from > p_quiet_to and (v_hour >= p_quiet_from or v_hour < p_quiet_to))
     or (p_quiet_from < p_quiet_to and v_hour >= p_quiet_from and v_hour < p_quiet_to) then
    v_end := date_trunc('day', v_local) + make_interval(hours => p_quiet_to);
    if v_end <= v_local then
      v_end := v_end + interval '1 day';
    end if;
    return v_end at time zone p_tz;
  end if;
  return p_now;
end $$;

create function horizon.scan_stale(
  p_now timestamptz, p_repeat_hours int, p_escalate_hours int,
  p_quiet_from int, p_quiet_to int, p_tz text)
returns int language plpgsql security definer set search_path = horizon, pg_temp as $$
declare
  r record;
  v_release timestamptz := horizon.quiet_release(p_now, p_quiet_from, p_quiet_to, p_tz);
  v_n int := 0;
  v_k int;
  v_age interval;
  v_epoch text;
  v_hours int;
begin
  for r in
    select p.id, p.name, p.stale_after_hours, max(i.updated_at) as last_update
      from positions p
      join items i on i.position_id = p.id and i.deleted_at is null
     where p.is_active
       and exists (select 1 from assignments a join users u on u.id = a.user_id
                    where a.position_id = p.id and a.date_to is null and u.is_active)
     group by p.id
  loop
    v_age := p_now - r.last_update;
    v_hours := floor(extract(epoch from v_age) / 3600);
    v_epoch := extract(epoch from r.last_update)::bigint::text;
    continue when v_age <= make_interval(hours => r.stale_after_hours);

    insert into notifications (kind, recipient_id, position_id, body, dedupe_key, not_before)
    select 'daily_stale', u, r.id,
           format('⏳ %s: таблицу не обновляли %s ч. Проверьте остатки.', r.name, v_hours),
           'stale:' || r.id || ':' || v_epoch, v_release
      from horizon.position_recipients(r.id, true, false) u
    on conflict (recipient_id, dedupe_key) where dedupe_key is not null do nothing;
    get diagnostics v_k = row_count; v_n := v_n + v_k;

    if v_age > make_interval(hours => r.stale_after_hours + p_repeat_hours) then
      insert into notifications (kind, recipient_id, position_id, body, dedupe_key, not_before)
      select 'stale_repeat', u, r.id,
             format('⏳ Повтор. %s: таблицу не обновляли %s ч.', r.name, v_hours),
             'stale-repeat:' || r.id || ':' || v_epoch, v_release
        from horizon.position_recipients(r.id, true, false) u
      on conflict (recipient_id, dedupe_key) where dedupe_key is not null do nothing;
      get diagnostics v_k = row_count; v_n := v_n + v_k;
    end if;

    if v_age > make_interval(hours => r.stale_after_hours + p_escalate_hours) then
      insert into notifications (kind, recipient_id, position_id, body, dedupe_key, not_before)
      select 'stale_admin', u, r.id,
             format('⚠️ %s: таблицу не обновляли %s ч, напоминания без ответа.', r.name, v_hours),
             'stale-admin:' || r.id || ':' || v_epoch, v_release
        from horizon.position_recipients(r.id, false, true) u
      on conflict (recipient_id, dedupe_key) where dedupe_key is not null do nothing;
      get diagnostics v_k = row_count; v_n := v_n + v_k;
    end if;
  end loop;
  return v_n;
end $$;

-- Ручная рассылка полного админа (раздел 3: «бот вручную»).
create function horizon.notify_position(p_position uuid, p_text text)
returns int language plpgsql security definer set search_path = horizon, pg_temp as $$
declare
  v_pos positions;
  n int;
begin
  perform horizon.require_uid();
  if not horizon.is_full_admin() then
    raise exception 'только полный админ' using errcode = 'HZ403';
  end if;
  if length(trim(coalesce(p_text, ''))) not between 1 and 500 then
    raise exception 'текст 1–500 символов' using errcode = 'HZ422';
  end if;
  select * into v_pos from positions where id = p_position;
  if not found then
    raise exception 'место не найдено' using errcode = 'HZ404';
  end if;
  insert into notifications (kind, recipient_id, position_id, body)
  select 'manual', r, p_position, format('📣 %s: %s', v_pos.name, trim(p_text))
    from horizon.position_recipients(p_position, true, false) r;
  get diagnostics n = row_count;
  perform horizon.audit('notify_position', null, p_position, jsonb_build_object('recipients', n));
  return n;
end $$;

-- ---------------------------------------------------------------------------
-- Чтение для UI
-- ---------------------------------------------------------------------------
create function horizon.me() returns jsonb
language sql stable security definer set search_path = horizon, pg_temp as $$
  select jsonb_build_object(
    'id', u.id,
    'callsign', u.callsign,
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
    select p.id, p.name, p.type, p.is_active, p.stale_after_hours,
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
begin
  perform horizon.require_uid();
  if not horizon.is_admin() then
    raise exception 'нужны права админа' using errcode = 'HZ403';
  end if;
  return (
    select coalesce(jsonb_agg(x order by x.is_active desc, lower(x.callsign)), '[]')
    from (
      select u.id, u.callsign, u.is_active,
             u.pin_hash is not null as has_pin,
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

-- ---------------------------------------------------------------------------
-- Аутентификация. Хеши считает API (scrypt для PIN, sha256 для токенов/кодов).
-- Доступно только роли horizon_api, не horizon_user.
-- ---------------------------------------------------------------------------
create function horizon.auth_lookup(p_callsign text)
returns table (id uuid, pin_hash text, invite_code_hash text, invite_expires_at timestamptz,
               is_active boolean, locked_until timestamptz, is_admin boolean)
language sql stable security definer set search_path = horizon, pg_temp as $$
  select u.id, u.pin_hash, u.invite_code_hash, u.invite_expires_at, u.is_active, u.locked_until,
         exists (select 1 from admin_scopes s where s.user_id = u.id)
    from users u where lower(u.callsign) = lower(trim(p_callsign))
$$;

-- 5 неверных попыток → блок на 15 минут.
create function horizon.auth_fail(p_user uuid) returns timestamptz
language plpgsql security definer set search_path = horizon, pg_temp as $$
declare v timestamptz;
begin
  update users
     set failed_attempts = case when failed_attempts + 1 >= 5 then 0 else failed_attempts + 1 end,
         locked_until = case when failed_attempts + 1 >= 5 then now() + interval '15 minutes' else locked_until end
   where id = p_user
  returning locked_until into v;
  return v;
end $$;

create function horizon.auth_session_create(p_user uuid, p_token_hash text, p_device text, p_ua text, p_ttl_days int)
returns uuid language plpgsql security definer set search_path = horizon, pg_temp as $$
declare v_id uuid;
begin
  update users set failed_attempts = 0, locked_until = null where id = p_user;
  insert into known_devices (user_id, device_id) values (p_user, p_device) on conflict do nothing;
  insert into sessions (user_id, token_hash, device_id, user_agent, expires_at)
  values (p_user, p_token_hash, p_device, left(coalesce(p_ua, ''), 200), now() + make_interval(days => p_ttl_days))
  returning id into v_id;
  return v_id;
end $$;

-- Первый вход / после сброса: код сгорает, PIN ставится, сессия открывается.
create function horizon.auth_complete_invite(p_user uuid, p_code_hash text, p_pin_hash text,
                                             p_token_hash text, p_device text, p_ua text, p_ttl_days int)
returns uuid language plpgsql security definer set search_path = horizon, pg_temp as $$
begin
  update users
     set pin_hash = p_pin_hash, invite_code_hash = null, invite_expires_at = null
   where id = p_user and is_active
     and invite_code_hash = p_code_hash and invite_expires_at > now();
  if not found then
    raise exception 'код недействителен' using errcode = 'HZ401';
  end if;
  return horizon.auth_session_create(p_user, p_token_hash, p_device, p_ua, p_ttl_days);
end $$;

create function horizon.auth_device_known(p_user uuid, p_device text) returns boolean
language sql stable security definer set search_path = horizon, pg_temp as $$
  select exists (select 1 from known_devices where user_id = p_user and device_id = p_device)
$$;

create function horizon.auth_challenge_create(p_user uuid, p_device text, p_code_hash text, p_code text)
returns uuid language plpgsql security definer set search_path = horizon, pg_temp as $$
declare v_id uuid;
begin
  if (select count(*) from login_challenges
       where user_id = p_user and created_at > now() - interval '15 minutes') >= 3 then
    raise exception 'слишком много запросов кода, подождите 15 минут' using errcode = 'HZ429';
  end if;
  update login_challenges set used_at = now() where user_id = p_user and used_at is null;
  insert into login_challenges (user_id, device_id, code_hash, expires_at)
  values (p_user, p_device, p_code_hash, now() + interval '10 minutes')
  returning id into v_id;
  insert into notifications (kind, recipient_id, body)
  values ('device_code', p_user, format('🔐 Horizon: код входа с нового устройства %s. Никому не сообщайте.', p_code));
  return v_id;
end $$;

create function horizon.auth_challenge_verify(p_id uuid, p_device text, p_code_hash text,
                                              p_token_hash text, p_ua text, p_ttl_days int)
returns uuid language plpgsql security definer set search_path = horizon, pg_temp as $$
declare v login_challenges;
begin
  select * into v from login_challenges where id = p_id for update;
  if not found or v.used_at is not null or v.expires_at < now()
     or v.device_id <> p_device or v.attempts >= 5 then
    raise exception 'код устарел — войдите заново' using errcode = 'HZ401';
  end if;
  if v.code_hash <> p_code_hash then
    update login_challenges set attempts = attempts + 1 where id = p_id;
    return null;
  end if;
  update login_challenges set used_at = now() where id = p_id;
  perform horizon.auth_session_create(v.user_id, p_token_hash, p_device, p_ua, p_ttl_days);
  return v.user_id;
end $$;

create function horizon.auth_session_resolve(p_token_hash text) returns uuid
language plpgsql security definer set search_path = horizon, pg_temp as $$
declare
  v_session uuid;
  v_user uuid;
  v_seen timestamptz;
begin
  select s.id, s.user_id, s.last_seen_at into v_session, v_user, v_seen
    from sessions s join users u on u.id = s.user_id
   where s.token_hash = p_token_hash and s.revoked_at is null
     and s.expires_at > now() and u.is_active;
  if v_session is not null and v_seen < now() - interval '5 minutes' then
    update sessions set last_seen_at = now() where id = v_session;
  end if;
  return v_user;
end $$;

create function horizon.auth_session_revoke(p_token_hash text) returns void
language sql security definer set search_path = horizon, pg_temp as $$
  update sessions set revoked_at = now() where token_hash = p_token_hash and revoked_at is null
$$;

-- ---------------------------------------------------------------------------
-- Очередь бота. Доступно только роли horizon_worker.
-- ---------------------------------------------------------------------------
-- Забрать созревшие и сразу сдвинуть not_before (backoff): упавший посреди
-- отправки воркер не зациклит повторы, а два воркера не возьмут одно и то же.
create function horizon.worker_claim(p_limit int)
returns table (id bigint, kind text, recipient_id uuid, body text, attempts int, phone text, active boolean)
language sql security definer set search_path = horizon, pg_temp as $$
  with c as (
    select n.id from notifications n
     where n.status = 'pending' and n.not_before <= now()
     order by (n.kind in ('critical_red', 'device_code')) desc, n.id
     limit p_limit
     for update skip locked)
  update notifications n
     set attempts = n.attempts + 1,
         not_before = now() + make_interval(secs => least(3600, 30 * power(2, n.attempts)))
    from c, users u
   where n.id = c.id and u.id = n.recipient_id
  returning n.id, n.kind, n.recipient_id, n.body, n.attempts, u.phone_e164, u.is_active
$$;

-- Код входа не храним дольше, чем нужно для доставки.
create function horizon.worker_finish(p_ids bigint[], p_error text, p_max_attempts int)
returns void language sql security definer set search_path = horizon, pg_temp as $$
  update notifications
     set status = case when p_error is null then 'sent'
                       when attempts >= p_max_attempts then 'failed'
                       else status end,
         sent_at = case when p_error is null then now() else sent_at end,
         last_error = left(p_error, 500),
         body = case when kind = 'device_code' and (p_error is null or attempts >= p_max_attempts)
                     then '[код скрыт]' else body end
   where id = any(p_ids)
$$;

create function horizon.worker_skip(p_ids bigint[], p_reason text)
returns void language sql security definer set search_path = horizon, pg_temp as $$
  update notifications
     set status = 'skipped', last_error = p_reason,
         body = case when kind = 'device_code' then '[код скрыт]' else body end
   where id = any(p_ids)
$$;

create function horizon.worker_cleanup()
returns void language sql security definer set search_path = horizon, pg_temp as $$
  delete from sessions where expires_at < now() - interval '30 days';
  delete from login_challenges where created_at < now() - interval '1 day';
$$;
