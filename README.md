<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/brand/logo-dark.svg">
    <img alt="Snagbox" src="assets/brand/logo-light.svg" width="420">
  </picture>
</p>

<p align="center">
  <strong>Paste a link, snag the media: a self-hostable downloader API.</strong>
</p>

<p align="center">
  <a href="https://github.com/fabwaseem/snagbox/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/fabwaseem/snagbox/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-111827.svg"></a>
  <a href="https://github.com/fabwaseem/snagbox/releases"><img alt="Release" src="https://img.shields.io/github/v/release/fabwaseem/snagbox?color=FF2D87"></a>
  <a href="https://github.com/fabwaseem/snagbox/pkgs/container/snagbox"><img alt="GHCR" src="https://img.shields.io/badge/ghcr.io-fabwaseem%2Fsnagbox-FF5E3A.svg"></a>
  <a href="https://github.com/fabwaseem/snagbox/stargazers"><img alt="Stars" src="https://img.shields.io/github/stars/fabwaseem/snagbox?style=social"></a>
</p>

<p align="center">
  <a href="https://railway.com/new/template?template=https://github.com/fabwaseem/snagbox"><img alt="Deploy on Railway" src="https://railway.com/button.svg"></a>
</p>

Snagbox turns a public URL into a file. It is a NestJS API: you queue a job, watch progress over server-sent events, and download the result from a signed link. yt-dlp and ffmpeg are resolved for you. Storage can stay on disk or move to any S3-compatible bucket.

Colors and the arrow-into-tray mark live in [`assets/brand/`](assets/brand/palette.md).

## Features

<table>
<tr>
<td width="33%">

**Queue a job**
One URL or a batch. Workers pull from Redis, or from memory when Redis is unset.

</td>
<td width="33%">

**Watch it land**
SSE progress, Prometheus metrics, and structured logs. Health reports the engine.

</td>
<td width="33%">

**Take the file**
Signed links, local disk or S3/R2, optional HMAC webhooks when a job finishes.

</td>
</tr>
<tr>
<td>

**Pick the shape**
Video or audio, quality, GIF, H.264, subtitles, thumbnails, and a time clip.

</td>
<td>

**Bring your own key**
API keys with rate limits and duration caps. Better Auth is optional.

</td>
<td>

**Stay on your machine**
Docker Compose, Railway, or any host that can run Node 22 and Postgres.

</td>
</tr>
</table>

## Platforms

| Platform | Video | Audio | Paste |
| --- | --- | --- | --- |
| YouTube | Yes | Yes | Watch, shorts, playlists, clips |
| Instagram | Yes | Yes | Posts and reels |
| TikTok | Yes | Yes | Videos and photo posts |
| X / Twitter | Yes | Yes | Status links |
| Facebook | Yes | Yes | Watch, reels, shares |
| Reddit | Yes | Yes | Posts and `v.redd.it` |
| Vimeo | Yes | Yes | Public videos |
| Bluesky | Yes | Yes | Post links |
| Threads | Yes | Yes | Post links |
| Pinterest | Yes | Yes | Pins |
| Twitch | Yes | — | Clips |
| SoundCloud | — | Yes | Tracks |
| Snapchat | Yes | Yes | Spotlight and stories |

Set `ALLOW_GENERIC_URLS=true` to accept any other public http(s) URL yt-dlp supports. Private, loopback, and link-local addresses are still rejected.

## Quick start

About a minute, with Postgres and Redis in Compose. Node 22 and pnpm are only needed if you skip Docker.

```bash
git clone https://github.com/fabwaseem/snagbox.git
cd snagbox
cp .env.example .env
openssl rand -base64 32
```

Paste that value into `.env` as `BETTER_AUTH_SECRET`. Compose reads `.env` and refuses to start while the secret is empty. For local testing, set `AUTH_DISABLED=true` in `.env` (the Compose file also sets `AUTH_DISABLED=true` on the API service, so a local trial needs no API key). Turn `AUTH_DISABLED` off before the port is reachable by anyone else.

```bash
docker compose up
```

- API: `http://localhost:3001`
- Playground: `http://localhost:3001/`
- Swagger: `http://localhost:3001/docs`
- OpenAPI: `http://localhost:3001/openapi.json`
- Metrics: `http://localhost:3001/metrics`

Migrations run on startup.

Image tags from a `v2.0.0` release: `ghcr.io/fabwaseem/snagbox:2.0.0` and `ghcr.io/fabwaseem/snagbox:latest`.

## API examples

Create a key when auth is on (`ADMIN_TOKEN` in `.env`):

```bash
curl -X POST http://localhost:3001/v2/admin/keys \
  -H "X-Admin-Token: $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"local","rateLimitPerMinute":60}'
```

Media info:

```bash
curl "http://localhost:3001/v2/media/info?url=https://www.youtube.com/watch?v=dQw4w9WgXcQ" \
  -H "X-API-Key: sb_your_key"
```

Start a download (`202 Accepted`):

```bash
curl -X POST http://localhost:3001/v2/downloads \
  -H "X-API-Key: sb_your_key" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ","kind":"video","quality":"720p","format":"mp4"}'
```

Follow progress (events: `status`, `progress`, `complete`, `error`, `ping`):

```bash
curl -N "http://localhost:3001/v2/downloads/JOB_ID/events" \
  -H "X-API-Key: sb_your_key"
```

Save the file. The job's `fileUrl` carries `exp` and `sig`; the filename is not part of the URL.

```bash
curl -L -O -J "http://localhost:3001/v2/files/JOB_ID?exp=1710000000&sig=..."
```

Batch up to the queue cap:

```bash
curl -X POST http://localhost:3001/v2/downloads/batch \
  -H "X-API-Key: sb_your_key" \
  -H "Content-Type: application/json" \
  -d '{"urls":["https://www.youtube.com/watch?v=dQw4w9WgXcQ","https://vimeo.com/76979871"],"kind":"audio","format":"mp3"}'
```

`POST /v2/downloads` also accepts `embedSubtitles`, `writeSubtitles`, `subtitleLang`, `writeThumbnail`, `embedThumbnail`, `embedMetadata`, `videoCodec` (`h264`), `clipStart`, `clipEnd`, and `callbackUrl`. A finished or failed job POSTs JSON to `callbackUrl`, signed with `X-Downloader-Signature: sha256=…` (`WEBHOOK_SECRET`).

yt-dlp failures use stable `code` values: `BLOCKED`, `PRIVATE`, `GEO_RESTRICTED`, `LOGIN_REQUIRED`, `UNAVAILABLE`, `UNSUPPORTED`.

Requests need `X-API-Key`, `X-Frontend-Key`, or `AUTH_DISABLED=true`. `NODE_ENV` does not open the API.

## Architecture

```mermaid
flowchart LR
  client[Client or playground] --> api[Snagbox API]
  api --> queue[Redis queue or in-memory fallback]
  queue --> worker[Job runner]
  worker --> ytdlp[yt-dlp and ffmpeg]
  worker --> db[(Postgres)]
  worker --> files[Signed file link]
  worker --> hook[HMAC webhook]
  api --> metrics["/metrics"]
```

## Configuration

Copy `.env.example` to `.env`. Every variable has a default except `DATABASE_URL`. Names below are stable; existing deployments can keep the same variables.

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `3001` | HTTP port |
| `DATABASE_URL` | — | Postgres connection string, required |
| `REDIS_URL` | empty | Queue, rate limits, throttler, media cache. Empty uses memory |
| `AUTH_DISABLED` | `false` | Allow requests with no API key |
| `ADMIN_TOKEN` | empty | Unlocks `/v2/admin`. Empty disables admin |
| `FRONTEND_SECRET` | empty | Shared secret for `X-Frontend-Key` |
| `BETTER_AUTH_SECRET` | empty | Session signing. Required in production and by Compose |
| `SWAGGER_ENABLED` | `true` | Swagger UI at `/docs`. OpenAPI is always at `/openapi.json` |
| `ALLOW_GENERIC_URLS` | `false` | Accept public URLs outside the matrix |
| `STORAGE_DRIVER` | `local` | `local` or `r2` (any S3-compatible endpoint) |
| `R2_BUCKET` | `snagbox-downloads` | Bucket name when `STORAGE_DRIVER=r2` |
| `FILE_TTL_MINUTES` | `4320` | How long finished files are kept |
| `WEBHOOK_SECRET` | empty | HMAC for job callbacks. Falls back to the file-link secret |
| `YTDLP_PATH` / `FFMPEG_PATH` | empty | Skip auto-download and use these binaries |

Auth providers (`GOOGLE_*`, `GITHUB_*`), SMTP, cookies, proxies, and yt-dlp tuning are documented in `.env.example`.

## Self-hosting

**Docker.** The image is multi-stage. The runtime installs ffmpeg and a pinned yt-dlp binary, and uses Node 22 as the JavaScript runtime YouTube needs. Copy `.env.example` to `.env`, set `BETTER_AUTH_SECRET` (`openssl rand -base64 32`), and set `AUTH_DISABLED=true` for local testing, then `docker compose up` starts the API, Postgres, and Redis. Optional profiles:

```bash
docker compose --profile bgutil up --build
docker compose --profile minio up --build
```

With MinIO, set `MINIO_ROOT_USER` and `MINIO_ROOT_PASSWORD`, then point Snagbox at the bucket with `STORAGE_DRIVER=r2` and `R2_ENDPOINT=http://minio:9000`.

**Railway.** Use the button at the top. The service health check is `GET /api/health` (`railway.toml`). `GET /v2/health` is the deeper engine check. Set `DATABASE_URL`, `BETTER_AUTH_SECRET`, and unset `AUTH_DISABLED` on any deploy that is not only yours.

**Elsewhere.** `pnpm install`, `pnpm prisma:deploy`, `pnpm build`, `node dist/main`. On a read-only filesystem set `YTDLP_PATH` and `FFMPEG_PATH`.

Published images:

```bash
docker pull ghcr.io/fabwaseem/snagbox:2.0.0
docker pull ghcr.io/fabwaseem/snagbox:latest
```

## Roadmap

- More first-class site plugins, beyond generic yt-dlp mode
- A small admin UI for keys and job history
- Official client libraries

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

Releases are tagged manually (`git tag vX.Y.Z` on main), which triggers the GHCR publish workflow. A `vX.Y.Z` tag publishes `ghcr.io/fabwaseem/snagbox:X.Y.Z` and `:latest`.

## Legal

Snagbox downloads media you already have the right to access. You are responsible for complying with the terms of each site and with copyright law. The authors do not grant any license to third-party content.

MIT
