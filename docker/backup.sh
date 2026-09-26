#!/bin/sh
# Ежедневный pg_dump в ./backups. Время — BACKUP_AT (ЧЧ:ММ, TZ контейнера), хранение — BACKUP_KEEP_DAYS.
#   docker compose exec backup /backup.sh now   — снять дамп прямо сейчас
set -eu
# Без pipefail код `pg_dump | openssl` — это код openssl: pg_dump падал на
# середине, обрезанный дамп считался удачным, и наблюдатель получал «всё хорошо».
set -o pipefail
# Дамп и его .part — только для владельца, в том числе пока пишутся.
umask 077
: "${BACKUP_AT:=03:30}"
: "${BACKUP_KEEP_DAYS:=14}"
mkdir -p /backups

# BACKUP_PASSPHRASE задан — дамп шифруется (AES-256, PBKDF2). В дампе
# хеши паролей и секреты приложения, поэтому копию за пределы сервера выносят только шифрованной.
#   расшифровать: openssl enc -d -aes-256-cbc -pbkdf2 -in file.dump.enc -out file.dump -pass env:BACKUP_PASSPHRASE
dump() {
  ts=$(date +%Y%m%d-%H%M%S)
  # ok присваиваем через if: при set -e падение в $(...) завершило бы скрипт
  # молча, не дойдя до ветки с сообщением об ошибке.
  if [ -n "${BACKUP_PASSPHRASE:-}" ]; then
    command -v openssl >/dev/null 2>&1 || apk add --no-cache openssl >/dev/null 2>&1 || true
    f="/backups/horizon-$ts.dump.enc"
    if pg_dump -Fc | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass env:BACKUP_PASSPHRASE -out "$f.part"; then ok=yes; else ok=no; fi
  else
    f="/backups/horizon-$ts.dump"
    # pg_restore -l читает оглавление: обрезанный или битый архив не пройдёт.
    if pg_dump -Fc -f "$f.part" && pg_restore -l "$f.part" >/dev/null; then ok=yes; else ok=no; fi
  fi
  if [ "$ok" = yes ]; then
    mv "$f.part" "$f"
    chmod 600 "$f"
    echo "backup: $f ($(du -h "$f" | cut -f1))"
    ping_ok
  else
    rm -f "$f.part"
    echo "backup: FAILED" >&2
    return 1
  fi
  find /backups -name 'horizon-*.dump' -mtime +"$BACKUP_KEEP_DAYS" -delete
  find /backups -name 'horizon-*.dump.enc' -mtime +"$BACKUP_KEEP_DAYS" -delete
}

# Сигнал наблюдателю, что дамп снялся. Смысл обратный обычной проверке: внешний
# сервис ждёт этот сигнал и ругается, когда тот не пришёл. Иначе про сломанный
# бэкап узнают в день, когда он понадобился.
ping_ok() {
  [ -n "${BACKUP_PING_URL:-}" ] || return 0
  if command -v curl >/dev/null 2>&1; then
    curl -fsS --max-time 10 "$BACKUP_PING_URL" >/dev/null 2>&1 || echo "backup: ping не прошёл" >&2
  elif command -v wget >/dev/null 2>&1; then
    wget -q -T 10 -O /dev/null "$BACKUP_PING_URL" || echo "backup: ping не прошёл" >&2
  else
    echo "backup: нечем дёрнуть BACKUP_PING_URL" >&2
  fi
}

num() { echo "$1" | tr -d ':' | sed 's/^0*//;s/^$/0/'; }

# Снимали ли дамп за эту дату. Проверяем существование файлов, а не код возврата
# ls: с двумя масками он ненулевой, если не совпала хотя бы одна, — и шифрованный
# дамп выглядел бы как «сегодня ещё не снимали».
dumped_today() {
  for p in /backups/horizon-"$1"-*.dump /backups/horizon-"$1"-*.dump.enc; do
    if [ -e "$p" ]; then return 0; fi
  done
  return 1
}

if [ "${1:-}" = "now" ]; then
  dump
  exit $?
fi

at=$(num "$BACKUP_AT")
echo "backup: daily at $BACKUP_AT, keep $BACKUP_KEEP_DAYS days"
while true; do
  if [ "$(num "$(date +%H%M)")" -ge "$at" ] && ! dumped_today "$(date +%Y%m%d)"; then
    dump || true
  fi
  sleep 60
done
