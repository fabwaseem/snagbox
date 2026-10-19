import { INestApplication, VersioningType } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import request from "supertest";
import { HealthController } from "../src/health/health.controller";
import { beginDraining, resetDraining } from "../src/health/health-probe";
import { LivenessController } from "../src/health/liveness.controller";
import { PlaygroundController } from "../src/playground/playground.controller";
import { BinariesService } from "../src/engine/binaries.service";
import { PrismaService } from "../src/prisma/prisma.service";
import { StorageService } from "../src/storage/storage.service";
import { StorageQuotaService } from "../src/storage/storage-quota.service";
import { RedisService } from "../src/redis/redis.service";

describe("Health (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [HealthController, LivenessController, PlaygroundController],
      providers: [
        {
          provide: BinariesService,
          useValue: {
            versions: async () => ({
              ytdlp: "2026.08.19",
              ytdlpSource: "system",
              pluginDir: null,
              ffmpeg: true,
              jsRuntime: "node",
              error: null,
            }),
          },
        },
        { provide: PrismaService, useValue: { $queryRaw: jest.fn(async () => 1) } },
        { provide: StorageService, useValue: { remote: false } },
        { provide: StorageQuotaService, useValue: { status: async () => ({}) } },
        { provide: RedisService, useValue: { enabled: false, ping: async () => false } },
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: "2" });
    await app.init();
  });

  afterAll(async () => {
    resetDraining();
    if (app) await app.close();
  });

  afterEach(() => {
    resetDraining();
  });

  it("GET /api/health is a cheap liveness probe", () => {
    return request(app.getHttpServer())
      .get("/api/health")
      .expect(200)
      .expect("Cache-Control", "no-store")
      .expect({ status: "ok" });
  });

  it("GET /api/health returns 503 while draining and skips the database", async () => {
    const prisma = app.get(PrismaService);
    const before = (prisma.$queryRaw as jest.Mock).mock.calls.length;
    beginDraining();
    await request(app.getHttpServer())
      .get("/api/health")
      .expect(503)
      .expect("Cache-Control", "no-store")
      .expect({ status: "draining" });
    await request(app.getHttpServer()).get("/v2/health").expect(503);
    expect((prisma.$queryRaw as jest.Mock).mock.calls.length).toBe(before);
  });

  it("GET /v2/health returns engine status", () => {
    return request(app.getHttpServer())
      .get("/v2/health")
      .expect(200)
      .expect((res) => {
        expect(res.body.service).toBe("snagbox");
        expect(res.body.status).toBe("ok");
        expect(res.body.database).toBe(true);
        expect(res.body.engine.ytdlpVersion).toBe("2026.08.19");
      });
  });

  it("GET / serves the playground", () => {
    return request(app.getHttpServer())
      .get("/")
      .expect(200)
      .expect("content-type", /html/)
      .expect((res) => {
        expect(res.text).toContain("Snagbox");
        expect(res.text).toContain("/assets/brand/logo-light.svg");
        expect(res.text).toContain("/assets/brand/logo-dark.svg");
        expect(res.text).toContain("/assets/brand/favicon-32.png");
        expect(res.text).toContain("/assets/brand/icon.svg");
      });
  });
});
