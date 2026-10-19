import { Controller, Get, Header, ServiceUnavailableException } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { SkipThrottle } from "@nestjs/throttler";
import { Public } from "../common/decorators/public.decorator";
import { BinariesService } from "../engine/binaries.service";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { StorageQuotaService } from "../storage/storage-quota.service";
import { RedisService } from "../redis/redis.service";
import { YTDLP_VERSION_UNKNOWN } from "../engine/version-cache";
import { isDraining } from "./health-probe";

@ApiTags("Health")
@Controller({ path: "health", version: "2" })
export class HealthController {
  private readonly startedAt = Date.now();

  constructor(
    private readonly binaries: BinariesService,
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly quota: StorageQuotaService,
    private readonly redis: RedisService,
  ) {}

  @Public()
  @SkipThrottle()
  @Get()
  @Header("Cache-Control", "no-store")
  @ApiOperation({ summary: "Service health, engine and database status" })
  async check() {
    if (isDraining()) {
      throw new ServiceUnavailableException({ status: "draining" });
    }

    let database = false;
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      database = true;
    } catch {
      database = false;
    }

    // versions() never waits on yt-dlp. A probe still in flight is "unknown".
    const engine = await this.binaries.versions();

    // Surfaced so the bucket's headroom is observable without opening a
    // dashboard — the whole point of the quota is that nobody has to watch it.
    let storage: Record<string, unknown> = { driver: this.storage.remote ? "r2" : "local" };
    if (this.storage.remote) {
      try {
        storage = { ...storage, ...(await this.quota.status()) };
      } catch {
        storage = { ...storage, error: "quota unavailable" };
      }
    }

    const redis = this.redis.enabled ? ((await this.redis.ping()) ? "up" : "down") : "disabled";

    return {
      service: "snagbox",
      redis,
      storage,
      status: database && engine.ytdlp && engine.ytdlp !== YTDLP_VERSION_UNKNOWN ? "ok" : "degraded",
      uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000),
      database,
      engine: {
        ytdlpVersion: engine.ytdlp,
        ytdlpSource: engine.ytdlpSource,
        ffmpegAvailable: engine.ffmpeg,
        pluginDir: engine.pluginDir,
        jsRuntime: engine.jsRuntime,
        error: engine.error,
      },
      timestamp: new Date().toISOString(),
    };
  }
}
