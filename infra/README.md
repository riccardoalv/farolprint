# Production deployment

Files:

- `docker-compose.prod.yml` — runs the published image `ghcr.io/riccardoalv/farolprint` from GitHub Container Registry (recommended)
- `docker-compose.yml` — same service, plus a `build` section to build from source (`infra/Dockerfile`, context = repo root)
- `.env.example` — configuration template (copy to `.env`)
- `Dockerfile` (+ `Dockerfile.dockerignore`, the ignore file Docker reads for this Dockerfile) — built and pushed to GitHub Container Registry on every push to `main` and on every release

## Published image (no clone)

```bash
mkdir farolprint && cd farolprint
curl -fsSLO https://raw.githubusercontent.com/riccardoalv/farolprint/main/infra/docker-compose.prod.yml
curl -fsSL https://raw.githubusercontent.com/riccardoalv/farolprint/main/infra/.env.example -o .env
# set BETTER_AUTH_URL in .env
docker compose -f docker-compose.prod.yml up -d
```

Pin a version with `FAROLPRINT_IMAGE=ghcr.io/riccardoalv/farolprint:<version>` in `.env`. Tags: `<version>`, `<major>.<minor>`, `latest`, `sha-<commit>`
(linux/amd64, linux/arm64).

## Build from source

```bash
cd infra
cp .env.example .env
docker compose up -d --build
```

## Runtime

- UI + API: `http://<host>:7100`
- Moonraker: one port per printer starting at `7125` (range `7125-7140` exposed, i.e. 16 printers)
- Persistent data (SQLite, gcodes, timelapses, `.auth-secret`): `farolprint-data` volume
- Healthcheck on `/api/auth/ok`, logs rotated (json-file, 3 × 10 MB)

## Update

```bash
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```

Prisma migrations are applied automatically at startup. The dashboard (Settings → System) also
checks GitHub releases (`FAROLPRINT_UPDATE_REPO`) and can produce a backup archive of the data directory.

## Backup

```bash
docker run --rm -v farolprint_farolprint-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/farolprint-data.tgz -C /data .
```

## Reverse proxy

Set `FAROLPRINT_BIND=127.0.0.1` and `BETTER_AUTH_URL=https://farolprint.example.com`.
Moonraker ports are reached directly by OrcaSlicer (HTTP + WebSocket); they do not go through the proxy.
