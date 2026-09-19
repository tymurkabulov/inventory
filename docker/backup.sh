#!/bin/sh
# Ежедневный pg_dump в ./backups. Время — BACKUP_AT (ЧЧ:ММ, TZ контейнера), хранение — BACKUP_KEEP_DAYS.
#   docker compose exec backup /backup.sh now   — снять дамп прямо сейчас
set -eu
: "${BACKUP_AT:=03:30}"
: "${BACKUP_KEEP_DAYS:=14}"
mkdir -p /backups

# BACKUP_PASSPHRASE задан — дамп шифруется (AES-256, PBKDF2). В дампе телефоны,
# хеши паролей и секреты приложения, поэтому копию за пределы сервера выносят только шифрованной.
#   расшифровать: openssl enc -d -aes-256-cbc -pbkdf2 -in file.dump.enc -out file.dump -pass env:BACKUP_PASSPHRASE
dump() {
  ts=$(date +%Y%m%d-%H%M%S)
  if [ -n "${BACKUP_PASSPHRASE:-}" ]; then
    command -v openssl >/dev/null 2>&1 || apk add --no-cache openssl >/dev/null 2>&1 || true
    f="/backups/horizon-$ts.dump.enc"
    ok=$(pg_dump -Fc | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass env:BACKUP_PASSPHRASE -out "$f.part" && echo yes)
  else
    f="/backups/horizon-$ts.dump"
    ok=$(pg_dump -Fc -f "$f.part" && echo yes)
  fi
  if [ "$ok" = yes ]; then
    mv "$f.part" "$f"
    chmod 600 "$f"
    echo "backup: $f ($(du -h "$f" | cut -f1))"
  else
    rm -f "$f.part"
    echo "backup: FAILED" >&2
    return 1
  fi
  find /backups -name 'horizon-*.dump' -mtime +"$BACKUP_KEEP_DAYS" -delete
  find /backups -name 'horizon-*.dump.enc' -mtime +"$BACKUP_KEEP_DAYS" -delete
}

num() { echo "$1" | tr -d ':' | sed 's/^0*//;s/^$/0/'; }

if [ "${1:-}" = "now" ]; then
  dump
  exit $?
fi

at=$(num "$BACKUP_AT")
echo "backup: daily at $BACKUP_AT, keep $BACKUP_KEEP_DAYS days"
while true; do
  if [ "$(num "$(date +%H%M)")" -ge "$at" ] && ! ls /backups/horizon-"$(date +%Y%m%d)"-*.dump >/dev/null 2>&1; then
    dump || true
  fi
  sleep 60
done
