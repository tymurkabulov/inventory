#!/usr/bin/env bash
# Проверка, что дамп живой: разворачиваем его в одноразовую базу и спрашиваем данные.
# Бэкап, который ни разу не восстанавливали, — это не бэкап, а предположение.
#
#   ./scripts/restore-check.sh backups/horizon-20260921-092755.dump
#   ./scripts/restore-check.sh backups/horizon-...dump --migrate
#   BACKUP_PASSPHRASE=... ./scripts/restore-check.sh backups/horizon-...dump.enc
#
# С --migrate поверх копии боевых данных прогоняются непринятые миграции: это
# репетиция выкладки, а не проверка на пустой базе, где ломается далеко не всё.
# Нужны docker и node на машине, откуда запускаете.
#
# Наружу печатаются только числа: в дампе личный состав, и светить его в логе
# проверки незачем.
set -euo pipefail

dump=${1:-}
mode=${2:-}
[ -n "$dump" ] && [ -f "$dump" ] || { echo "укажите файл дампа" >&2; exit 2; }

image=${PG_IMAGE:-postgres:16-alpine}
port=${PG_PORT:-55432}
name="horizon-restore-check-$$"
work=$(mktemp -d)
cleanup() {
  docker rm -f "$name" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

plain="$work/dump"
case "$dump" in
  *.enc)
    : "${BACKUP_PASSPHRASE:?для шифрованного дампа нужен BACKUP_PASSPHRASE}"
    openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_PASSPHRASE -in "$dump" -out "$plain"
    ;;
  *) cp "$dump" "$plain" ;;
esac

psql_q() { docker exec -i "$name" psql -U postgres -d horizon -v ON_ERROR_STOP=1 "$@"; }

counts() {
  psql_q -tA -F' ' -c "
    select 'миграций', count(*) from public.horizon_migrations
    union all select 'людей',   count(*) from horizon.users
    union all select 'активных', count(*) from horizon.users where is_active
    union all select 'мест',    count(*) from horizon.positions
    union all select 'строк имущества', count(*) from horizon.items where deleted_at is null
    union all select 'открытых привязок', count(*) from horizon.assignments where date_to is null
    union all select 'полных админов', count(*) from horizon.admin_scopes where scope = 'full'"
}

invariants() {
  psql_q -tA -c "
    do \$\$
    declare n int;
    begin
      select count(*) into n from (
        select user_id from horizon.assignments where date_to is null group by user_id having count(*) > 1) x;
      if n > 0 then raise exception 'у % человек больше одной открытой привязки', n; end if;

      select count(*) into n from horizon.items
       where deleted_at is null and not horizon.thresholds_valid(min_qty, acceptable_qty, ideal_qty);
      if n > 0 then raise exception 'у % строк пороги вне правила', n; end if;

      if not exists (select 1 from horizon.admin_scopes where scope = 'full') then
        raise exception 'в дампе нет ни одного полного админа — войти будет некому';
      end if;
    end \$\$;" >/dev/null
  echo "   инварианты целы"
}

# Ни одна функция схемы не должна быть доступна PUBLIC: каждая выдаётся поимённо.
grants() {
  local leaked
  leaked=$(psql_q -tA -c "
    select coalesce(string_agg(p.proname, ', '), '')
      from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = 'horizon' and has_function_privilege('public', p.oid, 'execute')" | tr -d '\r')
  if [ -n "$leaked" ]; then
    echo "   public может выполнять: $leaked" >&2
    return 1
  else
    echo "   наружу не торчит ни одна функция схемы"
  fi
  return 0
}

run_args=(-d --name "$name" -e POSTGRES_PASSWORD=check -e POSTGRES_DB=horizon)
[ "$mode" = "--migrate" ] && run_args+=(-p "$port:5432")

echo "== поднимаем одноразовый $image"
docker run "${run_args[@]}" "$image" >/dev/null
for _ in $(seq 1 40); do
  docker exec "$name" pg_isready -U postgres -d horizon >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$name" pg_isready -U postgres -d horizon >/dev/null || { echo "база не поднялась" >&2; exit 1; }

echo "== восстанавливаем"
# Дамп подаём на stdin, а не через docker cp: меньше движений и никаких путей
# внутрь контейнера. Роли живут вне базы и в дамп не попадают — создаём заранее,
# иначе owner и grant не применятся.
psql_q -q -c "
  do \$\$ begin
    if not exists (select 1 from pg_roles where rolname = 'horizon_user')   then create role horizon_user nologin; end if;
    if not exists (select 1 from pg_roles where rolname = 'horizon_api')    then create role horizon_api login noinherit; end if;
  end \$\$;"
docker exec -i "$name" pg_restore -U postgres -d horizon --no-owner --exit-on-error < "$plain"

echo "== что внутри"
counts
invariants
grants

if [ "$mode" = "--migrate" ]; then
  echo "== репетиция выкладки: непринятые миграции на копии боевых данных"
  DATABASE_ADMIN_URL="postgres://postgres:check@127.0.0.1:$port/horizon" \
  NODE_ENV=production APP_SECRET=rehearsal-secret-not-for-production \
    npx tsx server/src/migrate.ts
  echo "== после миграций"
  counts
  invariants
  grants
fi

echo
echo "дамп восстанавливается, инварианты целы: $dump"
