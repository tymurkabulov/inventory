-- Horizon · у позиции остаются название, статус и частота обновления
--
-- Тип («позиция / мастерская / склад / штаб») ни на что не влиял: ни на права,
-- ни на оповещения, ни на пороги — а заполнять его приходилось при каждом создании.

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

drop function horizon.upsert_position(uuid, text, text, int, boolean);

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
    'assignment', (select jsonb_build_object('position_id', p.id, 'name', p.name, 'date_from', a.date_from)
                     from assignments a join positions p on p.id = a.position_id
                    where a.user_id = u.id and a.date_to is null))
  from users u where u.id = horizon.uid() and u.is_active
$$;

create or replace function horizon.admin_overview() returns jsonb
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

alter table horizon.positions drop column type;

revoke execute on function
  horizon.upsert_position(uuid, text, int, boolean),
  horizon.admin_overview(),
  horizon.me()
  from public;

grant execute on function
  horizon.upsert_position(uuid, text, int, boolean),
  horizon.admin_overview(),
  horizon.me()
to horizon_user;
