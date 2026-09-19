-- Движение остатка храним только последнее: одна строка «было → стало» на
-- единицу имущества. Полная история в поле не нужна, а таблица росла на каждую
-- правку остатка — по строке с каждого нажатия «Зберегти».

-- Схлопываем накопленное: у каждой строки имущества оставляем самую свежую запись.
delete from horizon.stock_movements m
 using horizon.stock_movements newer
 where m.item_id = newer.item_id
   and (newer.created_at, newer.id) > (m.created_at, m.id);

drop index horizon.stock_movements_item;
create unique index stock_movements_item on horizon.stock_movements (item_id);

-- upsert_item: то же, что и раньше, но движение не добавляется, а перезаписывается.
create or replace function horizon.upsert_item(
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
