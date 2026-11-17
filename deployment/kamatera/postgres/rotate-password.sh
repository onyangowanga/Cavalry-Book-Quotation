#!/usr/bin/env bash
set -euo pipefail

DEPLOY_DIR=/opt/cavalry-bookshop-db
cd "$DEPLOY_DIR"

secret="$(openssl rand -hex 32)"
printf "ALTER ROLE cavalry_app WITH PASSWORD '%s';\n" "$secret" |
  docker exec -i cavalry-books-db sh -c \
    'PGPASSWORD="$POSTGRES_PASSWORD" psql -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1'

umask 077
temporary_env="$(mktemp .env.XXXXXX)"
printf '%s\n' \
  'POSTGRES_DB=cavalry_books' \
  'POSTGRES_USER=cavalry_app' \
  "POSTGRES_PASSWORD=$secret" > "$temporary_env"
unset secret
chmod 600 "$temporary_env"
mv -f "$temporary_env" .env

docker compose --project-name cavalry-bookshop --project-directory "$DEPLOY_DIR" \
  --file compose.yaml up -d --force-recreate --wait --wait-timeout 120
docker exec cavalry-books-db sh -c \
  'PGPASSWORD="$POSTGRES_PASSWORD" psql -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atqc "SELECT current_database(), current_user"'
