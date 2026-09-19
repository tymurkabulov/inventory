-- Horizon · языки: uk / en, без ru
--
-- Список допустимых языков живёт в коде (server/src/i18n.ts, web/src/locales),
-- база проверяет только форму кода — новый язык не требует миграции.

-- Кто выбрал русский, получает язык по умолчанию (DEFAULT_LOCALE воркера).
update horizon.users set locale = null where locale = 'ru';

alter table horizon.users drop constraint users_locale;
alter table horizon.users add constraint users_locale check (locale ~ '^[a-z]{2}$');

create or replace function horizon.set_my_locale(p_locale text)
returns void language plpgsql security definer set search_path = horizon, pg_temp as $$
begin
  if p_locale is null or p_locale !~ '^[a-z]{2}$' then
    raise exception 'язык: код из двух латинских букв' using errcode = 'HZ422';
  end if;
  update users set locale = p_locale where id = horizon.require_uid();
end $$;
