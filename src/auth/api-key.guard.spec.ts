import "reflect-metadata";
import { ExecutionContext, HttpException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Public } from "../common/decorators/public.decorator";
import { AppConfigService } from "../config/app-config.service";
import { ApiKeyGuard } from "./api-key.guard";
import { ApiKeyService, ValidatedKey } from "./api-key.service";

class Routes {
  @Public()
  health(): void {}

  locked(): void {}
}

function httpContext(
  handler: () => void,
  headers: Record<string, string>,
  url = "/v2/downloads",
): ExecutionContext {
  const request = {
    url,
    originalUrl: url,
    header(name: string) {
      return headers[name.toLowerCase()];
    },
    apiKey: undefined as ValidatedKey | undefined,
  };
  return {
    getHandler: () => handler,
    getClass: () => Routes,
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({}),
      getNext: () => undefined,
    }),
    getType: () => "http",
    getArgs: () => [request],
    getArgByIndex: () => request,
    switchToRpc: () => {
      throw new Error("not rpc");
    },
    switchToWs: () => {
      throw new Error("not ws");
    },
  } as ExecutionContext;
}

function config(partial: Partial<AppConfigService>): AppConfigService {
  return {
    isProduction: false,
    authDisabled: false,
    frontendSecret: "",
    allowedOrigins: [],
    ...partial,
  } as AppConfigService;
}

describe("ApiKeyGuard", () => {
  const key: ValidatedKey = {
    id: "key-1",
    name: "test",
    rateLimitPerMinute: 10,
    maxDurationSeconds: 3600,
  };

  function guardFor(
    partial: Partial<AppConfigService>,
    apiKeys: Partial<ApiKeyService> = {},
  ): ApiKeyGuard {
    return new ApiKeyGuard(new Reflector(), config(partial), {
      validate: jest.fn().mockResolvedValue(null),
      consumeQuota: jest.fn().mockReturnValue(1),
      ...apiKeys,
    } as ApiKeyService);
  }

  it("rejects a missing key when auth is not explicitly disabled", async () => {
    const guard = guardFor({ isProduction: false, authDisabled: false });
    await expect(guard.canActivate(httpContext(Routes.prototype.locked, {}))).rejects.toBeInstanceOf(
      HttpException,
    );
  });

  it("does not treat development as an opt-out", async () => {
    const guard = guardFor({ isProduction: false, authDisabled: false });
    await expect(guard.canActivate(httpContext(Routes.prototype.locked, {}))).rejects.toBeInstanceOf(
      HttpException,
    );
  });

  it("allows anonymous requests only when AUTH_DISABLED is set", async () => {
    const guard = guardFor({ isProduction: false, authDisabled: true });
    await expect(guard.canActivate(httpContext(Routes.prototype.locked, {}))).resolves.toBe(true);
  });

  it("still rejects an invalid key when auth is disabled", async () => {
    const guard = guardFor({ authDisabled: true }, { validate: jest.fn().mockResolvedValue(null) });
    await expect(
      guard.canActivate(httpContext(Routes.prototype.locked, { "x-api-key": "sb_bad" })),
    ).rejects.toBeInstanceOf(HttpException);
  });

  it("accepts a valid key and enforces its quota", async () => {
    const validate = jest.fn().mockResolvedValue(key);
    const consumeQuota = jest.fn().mockReturnValue(1);
    const guard = guardFor({ authDisabled: false, isProduction: true }, { validate, consumeQuota });
    const context = httpContext(Routes.prototype.locked, { authorization: "Bearer sb_good" });
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(validate).toHaveBeenCalledWith("sb_good");
    expect(context.switchToHttp().getRequest<{ apiKey?: ValidatedKey }>().apiKey).toEqual(key);

    consumeQuota.mockReturnValue(-1);
    await expect(
      guard.canActivate(httpContext(Routes.prototype.locked, { "x-api-key": "sb_good" })),
    ).rejects.toBeInstanceOf(HttpException);
  });

  it("skips auth and key lookup for the liveness probe", async () => {
    const validate = jest.fn().mockResolvedValue(null);
    const guard = guardFor({ isProduction: true, authDisabled: false, frontendSecret: "proxy-secret" }, {
      validate,
    });
    await expect(
      guard.canActivate(httpContext(Routes.prototype.locked, { "x-api-key": "sb_bad" }, "/api/health")),
    ).resolves.toBe(true);
    await expect(
      guard.canActivate(httpContext(Routes.prototype.locked, {}, "/api/health?ready=1")),
    ).resolves.toBe(true);
    expect(validate).not.toHaveBeenCalled();
  });

  it("allows public routes and the frontend secret without a key", async () => {
    const guard = guardFor({ frontendSecret: "proxy-secret", isProduction: true });
    await expect(guard.canActivate(httpContext(Routes.prototype.health, {}))).resolves.toBe(true);
    await expect(
      guard.canActivate(httpContext(Routes.prototype.locked, { "x-frontend-key": "proxy-secret" })),
    ).resolves.toBe(true);
    await expect(
      guard.canActivate(httpContext(Routes.prototype.locked, { "x-frontend-key": "nope" })),
    ).rejects.toBeInstanceOf(HttpException);
  });

  it("uses the origin allowlist only in production when no proxy secret is set", async () => {
    const open = guardFor({
      isProduction: true,
      authDisabled: false,
      frontendSecret: "",
      allowedOrigins: ["https://app.example.com"],
    });
    await expect(
      open.canActivate(httpContext(Routes.prototype.locked, { origin: "https://app.example.com" })),
    ).resolves.toBe(true);
    await expect(
      open.canActivate(httpContext(Routes.prototype.locked, { origin: "https://evil.example" })),
    ).rejects.toBeInstanceOf(HttpException);

    const dev = guardFor({
      isProduction: false,
      authDisabled: false,
      frontendSecret: "",
      allowedOrigins: ["https://app.example.com"],
    });
    await expect(
      dev.canActivate(httpContext(Routes.prototype.locked, { origin: "https://app.example.com" })),
    ).rejects.toBeInstanceOf(HttpException);
  });
});
