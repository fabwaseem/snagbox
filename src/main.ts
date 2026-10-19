import { Logger, ValidationPipe, VersioningType } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { json, type NextFunction, type Request, type Response } from "express";
import { join } from "path";
import helmet from "helmet";
import { AppModule } from "./app.module";
import { createLogger, PinoNestLogger } from "./logging/pino-logger";
import { AUTH, type Auth } from "./auth/auth.instance";
import { AppConfigService } from "./config/app-config.service";
import { installGracefulShutdown } from "./lifecycle/graceful-shutdown";

async function bootstrap(): Promise<void> {
  // Nest's own body parser is disabled: Better Auth must read the raw request
  // body itself, and a pre-consumed stream would break every auth endpoint.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    bodyParser: false,
  });
  const config = app.get(AppConfigService);
  app.useLogger(new PinoNestLogger(createLogger(config.logLevel)));
  app.useStaticAssets(join(process.cwd(), "assets"), { prefix: "/assets" });

  // All real traffic arrives via the Next.js proxy (and often a platform LB in
  // front of that). Without trust proxy, req.ip is the proxy's address and
  // per-IP rate limiting would throttle every visitor as one client.
  app.set("trust proxy", true);

  // Better Auth owns /api/auth/*; everything else gets JSON parsing as before.
  const { toNodeHandler } = await import("better-auth/node");
  const auth = app.get<Auth>(AUTH);
  const authHandler = toNodeHandler(auth);
  const jsonParser = json({ limit: "1mb" });
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.url.startsWith("/api/auth")) return void authHandler(req, res);
    return jsonParser(req, res, next);
  });

  installGracefulShutdown(app);
  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: "cross-origin" },
      contentSecurityPolicy: config.isProduction ? undefined : false,
    }),
  );

  app.enableVersioning({ type: VersioningType.URI, defaultVersion: "2" });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  const allowed = config.allowedOrigins;
  app.enableCors({
    origin: (
      origin: string | undefined,
      callback: (err: Error | null, allow?: boolean) => void,
    ) => {
      // Non-browser clients (curl, mobile apps) send no Origin header.
      if (!origin) return callback(null, true);

      try {
        const { hostname } = new URL(origin);
        if (!config.isProduction) {
          const devHosts = ["localhost", "127.0.0.1"];
          if (devHosts.includes(hostname) || hostname.startsWith("192.168.")) {
            return callback(null, true);
          }
        }
        const ok = allowed.some((entry) => {
          try {
            const entryHost = entry.includes("://") ? new URL(entry).hostname : entry;
            return hostname === entryHost || hostname.endsWith(`.${entryHost}`);
          } catch {
            return false;
          }
        });
        return ok ? callback(null, true) : callback(new Error("Not allowed by CORS"), false);
      } catch {
        return callback(new Error("Invalid origin"), false);
      }
    },
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-API-Key",
      "X-Admin-Token",
      "X-Request-Id",
      "Accept",
      "Range",
    ],
    exposedHeaders: ["Content-Disposition", "Content-Range", "X-Request-Id"],
    credentials: false,
    maxAge: 3600,
  });

  const swaggerConfig = new DocumentBuilder()
    .setTitle("Snagbox API")
    .setDescription(
      "Paste a link, snag the media. Self-hostable downloader API for public URLs, with live progress, signed file links, and optional webhooks.",
    )
    .setVersion("2.0.0")
    .addApiKey({ type: "apiKey", in: "header", name: "X-API-Key" }, "api-key")
    .addApiKey({ type: "apiKey", in: "header", name: "X-Admin-Token" }, "admin-token")
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  app.getHttpAdapter().get("/openapi.json", ((_req: unknown, res: { json: (body: unknown) => void }) => {
    res.json(document);
  }) as never);
  if (config.swaggerEnabled) {
    SwaggerModule.setup("docs", app, document, {
      swaggerOptions: { persistAuthorization: true, tagsSorter: "alpha" },
    });
  }

  await app.listen(config.port);
  Logger.log(
    `Snagbox API listening on http://localhost:${config.port}` +
      (config.swaggerEnabled ? " (docs at /docs)" : ""),
    "Bootstrap",
  );
}

void bootstrap();
