import { CanActivate, ExecutionContext, HttpStatus, Injectable, Logger } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { timingSafeEqual } from "crypto";
import type { Request } from "express";
import { AppConfigService } from "../config/app-config.service";
import { IS_PUBLIC_KEY } from "../common/decorators/public.decorator";
import { ApiException, ErrorCode } from "../common/errors";
import { isLivenessRequest } from "../health/health-probe";
import { ApiKeyService, ValidatedKey } from "./api-key.service";

export type AuthedRequest = Request & { apiKey?: ValidatedKey };

/**
 * Gatekeeper for every route. A request is allowed in when it satisfies any of:
 *
 *  1. It carries a valid API key (X-API-Key or Bearer) — per-key rate limits apply.
 *  2. It carries the frontend proxy secret (X-Frontend-Key). The Next.js server
 *     injects this header on every proxied /api request; browsers never see it,
 *     so unlike Origin it cannot be spoofed by third-party clients.
 *  3. The route is marked @Public (health, admin — the latter has its own guard).
 *  4. AUTH_DISABLED is explicitly set. NODE_ENV is not an opt-out: a
 *     development or test process stays locked unless that flag is true.
 *  5. Production without FRONTEND_SECRET configured: fall back to matching
 *     Origin/Referer against ALLOWED_ORIGINS so a half-configured deploy
 *     degrades to CORS-grade protection instead of locking everyone out.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly logger = new Logger(ApiKeyGuard.name);
  private warnedMissingSecret = false;

  constructor(
    private readonly reflector: Reflector,
    private readonly config: AppConfigService,
    private readonly apiKeys: ApiKeyService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const request = context.switchToHttp().getRequest<AuthedRequest>();

    // Liveness is polled by the proxy with no credentials and must not touch the database.
    if (isLivenessRequest(request.originalUrl || request.url)) return true;

    // 1. Explicit API key — validated even on public routes so per-key
    //    attribution and limits still apply to keyed clients.
    const rawKey =
      request.header("x-api-key") ??
      request.header("authorization")?.replace(/^Bearer\s+/i, "") ??
      "";
    if (rawKey) {
      const key = await this.apiKeys.validate(rawKey);
      if (!key) {
        throw new ApiException(
          ErrorCode.INVALID_API_KEY,
          "Invalid, expired or blocked API key",
          HttpStatus.UNAUTHORIZED,
        );
      }
      if ((await this.apiKeys.consumeQuota(key)) < 0) {
        throw new ApiException(
          ErrorCode.RATE_LIMITED,
          "API key rate limit exceeded",
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      request.apiKey = key;
      return true;
    }

    if (isPublic) return true;

    // 2. Frontend proxy secret.
    const secret = this.config.frontendSecret;
    if (secret && safeEquals(request.header("x-frontend-key") ?? "", secret)) {
      return true;
    }

    // 3. Explicit opt-out. Never implied by NODE_ENV.
    if (this.config.authDisabled) return true;

    // 4. Origin-allowlist fallback when production has no proxy secret.
    if (this.config.isProduction && !secret) {
      if (!this.warnedMissingSecret) {
        this.warnedMissingSecret = true;
        this.logger.warn(
          "FRONTEND_SECRET is not set — falling back to Origin/Referer checks. " +
            "Set FRONTEND_SECRET (API) and API_PROXY_SECRET (web) to the same value to fully lock down the API.",
        );
      }
      if (this.matchesAllowedOrigin(request)) return true;
    }

    throw new ApiException(
      ErrorCode.INVALID_API_KEY,
      "This API requires an API key (X-API-Key header) or must be accessed through the official frontend.",
      HttpStatus.UNAUTHORIZED,
    );
  }

  private matchesAllowedOrigin(request: Request): boolean {
    const source = request.header("origin") ?? request.header("referer") ?? "";
    if (!source) return false;
    try {
      const { hostname } = new URL(source);
      return this.config.allowedOrigins.some((entry) => {
        try {
          const entryHost = entry.includes("://") ? new URL(entry).hostname : entry;
          return hostname === entryHost || hostname.endsWith(`.${entryHost}`);
        } catch {
          return false;
        }
      });
    } catch {
      return false;
    }
  }
}

function safeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
