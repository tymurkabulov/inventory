#!/usr/bin/env bash
# Тесты → (staging) → prod → health.
#   PROD=user@host ./scripts/deploy.sh                      один сервер
#   STAGING=user@stage PROD=user@host ./scripts/deploy.sh   с промежуточным
# На хостах: Docker, каталог $DIR с заполненным .env.
set -euo pipefail
DIR=${DIR:-/opt/horizon}
STAGING=${STAGING:-}
: "${PROD:?укажите PROD=user@host}"

echo "== тесты (status(), вторая открытая assignment, сценарий приёмки)"
npm test

ship() {
  local host=$1
  echo "== $host: выкладка"
  git archive --format=tar HEAD | ssh "$host" "mkdir -p $DIR && tar -x -C $DIR"
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

# Перед выкладкой — свежий дамп: откатываться будет с чего.
ssh "$PROD" "cd $DIR && [ -f docker-compose.yml ] && docker compose exec -T backup /bin/sh /backup.sh now || true"
ship "$PROD"
echo "== готово"
