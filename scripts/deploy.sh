#!/usr/bin/env bash
# Тесты → (staging) → prod → health.
#   PROD=user@host ./scripts/deploy.sh                      один сервер
#   STAGING=user@stage PROD=user@host ./scripts/deploy.sh   с промежуточным
# На хостах: Docker, каталог $DIR с заполненным .env.
set -euo pipefail
DIR=${DIR:-/opt/horizon}
STAGING=${STAGING:-}
: "${PROD:?укажите PROD=user@host}"

# git archive берёт HEAD, а не рабочее дерево: выкладка с несохранёнными правками
# ставит на сервер не то, что видно в редакторе. ALLOW_DIRTY=1 — если так и надо.
if [ -z "${ALLOW_DIRTY:-}" ] && ! git diff --quiet HEAD; then
  echo "в рабочем дереве есть несохранённые правки — закоммитьте или ALLOW_DIRTY=1" >&2
  exit 1
fi

echo "== тесты (status(), вторая открытая assignment, сценарий приёмки)"
npm test

ship() {
  local host=$1
  echo "== $host: выкладка"
  # Архив сначала целиком доезжает и распаковывается рядом, и только потом
  # подменяются каталоги. Простой tar поверх старого оставлял бы удалённые файлы:
  # переименованная миграция продолжала бы лежать в db/migrations и применяться.
  git archive --format=tar HEAD | ssh "$host" "
    set -e
    rm -rf '$DIR.incoming'; mkdir -p '$DIR.incoming' '$DIR'
    tar -x -C '$DIR.incoming'
    for d in db server web docker scripts .github; do rm -rf '$DIR'/\$d; done
    cp -a '$DIR.incoming/.' '$DIR/'
    rm -rf '$DIR.incoming'
  "
  ssh "$host" "cd $DIR && docker compose up -d --build --remove-orphans"
  echo "== $host: health"
  for i in $(seq 1 30); do
    if ssh "$host" "curl -fsS http://127.0.0.1:\${HTTP_PORT:-8080}/api/health" >/dev/null 2>&1; then
      echo "   ok"
      return 0
    fi
    sleep 2
  done
  echo "   health не ответил — остановка" >&2
  ssh "$host" "cd $DIR && docker compose ps && docker compose logs --tail 50 api migrate" >&2
  return 1
}

if [ -n "$STAGING" ]; then
  ship "$STAGING"
  read -r -p "Staging в порядке. Выкатить на prod? [y/N] " yes
  [ "$yes" = "y" ] || { echo "отменено"; exit 1; }
fi

# Перед выкладкой — свежий дамп: откатываться будет с чего. Миграции назад не
# откатываются, поэтому без дампа выкладку не начинаем. Первая выкладка (compose
# ещё нет) — единственное исключение.
if ssh "$PROD" "[ -f '$DIR/docker-compose.yml' ]"; then
  echo "== $PROD: дамп перед выкладкой"
  if ! ssh "$PROD" "cd $DIR && docker compose exec -T backup /bin/sh /backup.sh now"; then
    echo "дамп не снялся — выкладка остановлена (SKIP_BACKUP=1, если так и надо)" >&2
    [ -n "${SKIP_BACKUP:-}" ] || exit 1
  fi
fi
if ! ship "$PROD"; then
  echo "откат: последний дамп — ssh $PROD 'ls -t $DIR/backups | head -1'; восстановление — README, раздел «Бэкап»" >&2
  exit 1
fi
echo "== готово"
