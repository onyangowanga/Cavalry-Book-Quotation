#!/usr/bin/env bash
set -euo pipefail

DEPLOY_DIR=/opt/cavalry-bookshop-db
cd "$DEPLOY_DIR"

if [[ ! -d api-backend ]]; then
  echo "The API source directory is missing from $DEPLOY_DIR/api-backend."
  exit 1
fi

container_id="$(docker ps -aq --filter name=^/cavalry-books-db$)"
if [[ ! -f .env ]] ||
  ! grep -qx 'POSTGRES_DB=cavalry_books' .env ||
  ! grep -qx 'POSTGRES_USER=cavalry_app' .env ||
  ! grep -q '^POSTGRES_PASSWORD=.' .env; then
  if [[ -n "$container_id" ]]; then
    echo "The existing database container has no valid credentials file; refusing to rotate credentials."
    exit 1
  fi
  secret="$(openssl rand -hex 32)"
  umask 077
  printf '%s\n' \
    'POSTGRES_DB=cavalry_books' \
    'POSTGRES_USER=cavalry_app' \
    "POSTGRES_PASSWORD=$secret" > .env
  unset secret
fi

chmod 600 .env
docker compose --project-name cavalry-bookshop --project-directory "$DEPLOY_DIR" \
  --file compose.yaml config --quiet
docker compose --project-name cavalry-bookshop --project-directory "$DEPLOY_DIR" \
  --file compose.yaml build cavalry-books-api
docker compose --project-name cavalry-bookshop --project-directory "$DEPLOY_DIR" \
  --file compose.yaml up -d --wait --wait-timeout 120

docker exec cavalry-books-db sh -c \
  'PGPASSWORD="$POSTGRES_PASSWORD" psql -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atqc "SELECT current_database(), current_user"'
docker exec cavalry-books-api node -e \
  "fetch('http://127.0.0.1:3000/healthz').then(async r=>{console.log(await r.text());if(!r.ok)process.exit(1)}).catch(e=>{console.error(e.message);process.exit(1)})"
printf 'Database port binding: '
docker port cavalry-books-db 5432/tcp
printf 'API port binding: '
docker port cavalry-books-api 3000/tcp
printf 'Docker network is internal: '
docker network inspect --format '{{.Internal}}' cavalry-books-private
