# syntax=docker/dockerfile:1

FROM node:25-bookworm-slim AS build
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates openssl \
  && rm -rf /var/lib/apt/lists/*
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@10.33.4 --activate
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/package.json
RUN pnpm install --frozen-lockfile
COPY . .
ENV DATABASE_URL=postgresql://postgres:postgres@localhost:5432/downloader
RUN pnpm --filter @snagbox/shared build \
  && pnpm exec prisma generate \
  && pnpm exec nest build

FROM node:25-bookworm-slim AS runtime
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl ffmpeg python3 \
  && rm -rf /var/lib/apt/lists/*
# Pinned yt-dlp. Node 22 (this image) is the JS runtime for YouTube's n challenge.
ARG YTDLP_VERSION=2026.08.19
ARG TARGETARCH
RUN set -eu; \
  arch="${TARGETARCH:-}"; \
  if [ -z "$arch" ]; then \
    case "$(uname -m)" in \
      x86_64) arch=amd64 ;; \
      aarch64|arm64) arch=arm64 ;; \
      *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;; \
    esac; \
  fi; \
  case "$arch" in \
    amd64) asset=yt-dlp_linux; sum=58162f9bfdc27458ea47bfcb311cf47028f17d8154a8bf7d689861d46399230a ;; \
    arm64) asset=yt-dlp_linux_aarch64; sum=b16e4dab368a816cd05d477d698a605a6ae87ccee1c8ffd38fa21d7254141fcc ;; \
    *) echo "unsupported architecture: $arch" >&2; exit 1 ;; \
  esac; \
  curl -fsSL -o /usr/local/bin/yt-dlp \
    "https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/${asset}"; \
  echo "${sum}  /usr/local/bin/yt-dlp" | sha256sum -c -; \
  chmod 755 /usr/local/bin/yt-dlp; \
  yt-dlp --version
WORKDIR /app
COPY --from=build /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml /app/prisma.config.ts ./
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/packages ./packages
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/assets ./assets
LABEL org.opencontainers.image.title="Snagbox" \
      org.opencontainers.image.description="Paste a link, snag the media: a self-hostable downloader API." \
      org.opencontainers.image.url="https://github.com/fabwaseem/snagbox" \
      org.opencontainers.image.source="https://github.com/fabwaseem/snagbox" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="2.0.0"
ENV NODE_ENV=production \
  PORT=3001 \
  YTDLP_PATH=/usr/local/bin/yt-dlp \
  FFMPEG_PATH=/usr/bin/ffmpeg \
  YTDLP_VERSION=2026.08.19
EXPOSE 3001
# exec replaces the shell so node is PID 1 and receives SIGTERM on rollout.
CMD ["sh", "-c", "./node_modules/.bin/prisma migrate deploy && exec node dist/main"]
