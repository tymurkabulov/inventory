-- Horizon · языки: ru / uk / en
--
-- Язык человека хранится в users.locale (null — язык по умолчанию воркера).
-- Уведомления несут params, воркер собирает текст на языке получателя.
-- body остаётся русским запасным текстом.

-- Украинские буквы в позывных: і ї є ґ.
alter table horizon.users drop constraint users_callsign_format;
alter table horizon.users add constraint users_callsign_format
  check (callsign ~ '^[0-9A-Za-zА-Яа-яЁёІіЇїЄєҐґ._-]{2,32}$');

alter table horizon.users add column locale text
  constraint users_locale check (locale in ('ru', 'uk', 'en'));

alter table horizon.notifications add column params jsonb not null default '{}'::jsonb;

create function horizon.set_my_locale(p_locale text)
returns void language plpgsql security definer set search_path = horizon, pg_temp as $$
begin
  if p_locale not in ('ru', 'uk', 'en') then
    raise exception 'язык: ru, uk или en' using errcode = 'HZ422';
  end if;
  update users set locale = p_locale where id = horizon.require_uid();
end $$;

create or replace function horizon.me() returns jsonb
language sql stable security definer set search_path = horizon, pg_temp as $$
  select jsonb_build_object(
    'id', u.id,
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

-- ---------------------------------------------------------------------------
-- Тексты бота: те же функции, плюс params
-- ---------------------------------------------------------------------------
create or replace function horizon.items_critical_red() returns trigger
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

  insert into notifications (kind, recipient_id, position_id, item_id, body, params)
  select 'critical_red', r, new.position_id, new.id, v_body,
         jsonb_build_object('position', v_pos.name, 'item', new.name, 'unit', new.unit,
                            'qty', trim_scale(new.qty), 'min', trim_scale(new.min_qty))
    from horizon.position_recipients(new.position_id, true, true) r;

  update items set last_red_notified_at = now() where id = new.id;
  return null;
end $$;

create or replace function horizon.scan_stale(
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
  v_params jsonb;
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
    v_params := jsonb_build_object('position', r.name, 'hours', v_hours);
    continue when v_age <= make_interval(hours => r.stale_after_hours);

    insert into notifications (kind, recipient_id, position_id, body, params, dedupe_key, not_before)
    select 'daily_stale', u, r.id,
           format('⏳ %s: таблицу не обновляли %s ч. Проверьте остатки.', r.name, v_hours), v_params,
           'stale:' || r.id || ':' || v_epoch, v_release
      from horizon.position_recipients(r.id, true, false) u
    on conflict (recipient_id, dedupe_key) where dedupe_key is not null do nothing;
    get diagnostics v_k = row_count; v_n := v_n + v_k;

    if v_age > make_interval(hours => r.stale_after_hours + p_repeat_hours) then
      insert into notifications (kind, recipient_id, position_id, body, params, dedupe_key, not_before)
      select 'stale_repeat', u, r.id,
             format('⏳ Повтор. %s: таблицу не обновляли %s ч.', r.name, v_hours), v_params,
             'stale-repeat:' || r.id || ':' || v_epoch, v_release
        from horizon.position_recipients(r.id, true, false) u
      on conflict (recipient_id, dedupe_key) where dedupe_key is not null do nothing;
      get diagnostics v_k = row_count; v_n := v_n + v_k;
    end if;

    if v_age > make_interval(hours => r.stale_after_hours + p_escalate_hours) then
      insert into notifications (kind, recipient_id, position_id, body, params, dedupe_key, not_before)
      select 'stale_admin', u, r.id,
             format('⚠️ %s: таблицу не обновляли %s ч, напоминания без ответа.', r.name, v_hours), v_params,
             'stale-admin:' || r.id || ':' || v_epoch, v_release
        from horizon.position_recipients(r.id, false, true) u
      on conflict (recipient_id, dedupe_key) where dedupe_key is not null do nothing;
      get diagnostics v_k = row_count; v_n := v_n + v_k;
    end if;
  end loop;
  return v_n;
end $$;

create or replace function horizon.notify_position(p_position uuid, p_text text)
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
  insert into notifications (kind, recipient_id, position_id, body, params)
  select 'manual', r, p_position, format('📣 %s: %s', v_pos.name, trim(p_text)),
         jsonb_build_object('position', v_pos.name, 'text', trim(p_text))
    from horizon.position_recipients(p_position, true, false) r;
  get diagnostics n = row_count;
  perform horizon.audit('notify_position', null, p_position, jsonb_build_object('recipients', n));
  return n;
end $$;

create or replace function horizon.auth_challenge_create(p_user uuid, p_device text, p_code_hash text, p_code text)
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
  insert into notifications (kind, recipient_id, body, params)
  values ('device_code', p_user,
          format('🔐 Horizon: код входа с нового устройства %s. Никому не сообщайте.', p_code),
          jsonb_build_object('code', p_code));
  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- Очередь: отдаём язык и параметры, код входа стираем и из params
-- ---------------------------------------------------------------------------
drop function horizon.worker_claim(int);

create function horizon.worker_claim(p_limit int)
returns table (id bigint, kind text, recipient_id uuid, body text, params jsonb, attempts int,
               phone text, active boolean, locale text)
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
  returning n.id, n.kind, n.recipient_id, n.body, n.params, n.attempts, u.phone_e164, u.is_active, u.locale
$$;

create or replace function horizon.worker_finish(p_ids bigint[], p_error text, p_max_attempts int)
returns void language sql security definer set search_path = horizon, pg_temp as $$
  update notifications
     set status = case when p_error is null then 'sent'
                       when attempts >= p_max_attempts then 'failed'
                       else status end,
         sent_at = case when p_error is null then now() else sent_at end,
         last_error = left(p_error, 500),
         body = case when kind = 'device_code' and (p_error is null or attempts >= p_max_attempts)
                     then '[код скрыт]' else body end,
         params = case when kind = 'device_code' and (p_error is null or attempts >= p_max_attempts)
                       then '{}'::jsonb else params end
   where id = any(p_ids)
$$;

create or replace function horizon.worker_skip(p_ids bigint[], p_reason text)
returns void language sql security definer set search_path = horizon, pg_temp as $$
  update notifications
     set status = 'skipped', last_error = p_reason,
         body = case when kind = 'device_code' then '[код скрыт]' else body end,
         params = case when kind = 'device_code' then '{}'::jsonb else params end
   where id = any(p_ids)
$$;

-- Коды входа, которые уже нельзя использовать, не держим и в недоставленном виде.
update horizon.notifications set body = '[код скрыт]', params = '{}'
 where kind = 'device_code' and status <> 'pending';

revoke execute on function horizon.set_my_locale(text), horizon.worker_claim(int) from public;
grant execute on function horizon.set_my_locale(text) to horizon_user;
grant execute on function horizon.worker_claim(int) to horizon_worker;
