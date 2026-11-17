# Kamatera PostgreSQL

This Compose project runs PostgreSQL 16 and a small read-only catalogue API in dedicated containers. PostgreSQL uses a named persistent volume and is bound only to `127.0.0.1:55432`; it is not publicly reachable. The API joins the `cavalry-books-private` Docker network, syncs the catalogue from Apps Script every five minutes, and serves the most recently successful snapshot at `/api/v1/catalog`. It binds to `127.0.0.1:3100` on the VPS for Nginx reverse proxying.

The database has a 384 MiB memory limit and a 0.5 CPU limit; the API has a 192 MiB memory limit and a 0.5 CPU limit. Failed or empty catalogue syncs leave the last-known snapshot intact. Invoice and payment writes continue to use Apps Script; the API is only for catalogue reads in this migration phase. The frontend tries the API first and falls back to Apps Script if the API is unavailable.

The deployment generates `/opt/cavalry-bookshop-db/.env` on the server with restrictive permissions. Do not copy the password into source control, frontend JavaScript, or public documentation.

Copy `api-backend/` beside `compose.yaml` on the VPS before running `bash deploy.sh`. The API is configured for `api.cavalrypublishers.co.ke`; create an `A` record pointing that hostname to the VPS, then configure Nginx and TLS to proxy to `http://127.0.0.1:3100`.

Run `bash rotate-password.sh` on the VPS to rotate the database password and recreate the containers without removing the data volume.
