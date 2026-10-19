import { envSchema } from "./env.validation";

describe("env schema auth flag", () => {
  const base = { DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/downloader" };

  it("stays locked unless AUTH_DISABLED is set, regardless of NODE_ENV", () => {
    expect(envSchema.parse(base).AUTH_DISABLED).toBe(false);
    expect(envSchema.parse({ ...base, NODE_ENV: "development" }).AUTH_DISABLED).toBe(false);
    expect(envSchema.parse({ ...base, NODE_ENV: "test" }).AUTH_DISABLED).toBe(false);
    expect(envSchema.parse({ ...base, NODE_ENV: "production" }).AUTH_DISABLED).toBe(false);
    expect(envSchema.parse({ ...base, AUTH_DISABLED: "true" }).AUTH_DISABLED).toBe(true);
    expect(envSchema.parse({ ...base, AUTH_DISABLED: "1", NODE_ENV: "development" }).AUTH_DISABLED).toBe(
      true,
    );
  });

  it("defaults the shutdown drain and rejects an oversized window", () => {
    expect(envSchema.parse(base).SHUTDOWN_DRAIN_MS).toBe(9_000);
    expect(envSchema.parse({ ...base, SHUTDOWN_DRAIN_MS: "" }).SHUTDOWN_DRAIN_MS).toBe(9_000);
    expect(envSchema.parse({ ...base, SHUTDOWN_DRAIN_MS: "1500" }).SHUTDOWN_DRAIN_MS).toBe(1_500);
    expect(() => envSchema.parse({ ...base, SHUTDOWN_DRAIN_MS: "30000" })).toThrow(
      /SHUTDOWN_DRAIN_MS/,
    );
  });

  it("defaults the direct-download ceiling", () => {
    const env = envSchema.parse(base);
    expect(env.DIRECT_DOWNLOAD_TIMEOUT_MS).toBe(300_000);
    expect(env.DIRECT_DOWNLOAD_MAX_BYTES).toBe(2 * 1024 ** 3);
  });
});
