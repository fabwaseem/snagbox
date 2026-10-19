import { z } from "zod";

const booleanish = (defaultValue: "true" | "false") =>
  z
    .string()
    .optional()
    .default(defaultValue)
    .transform((v) => v === "true" || v === "1");

export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3001),
  /**
   * How long to keep accepting traffic after SIGTERM/SIGINT before the
   * listener closes. Probes return 503 during this window. The process
   * force-exits 25s after the signal regardless. Empty uses 9000.
   */
  SHUTDOWN_DRAIN_MS: z.preprocess((value) => {
    if (value === undefined || value === "") return 9_000;
    return value;
  }, z.coerce.number().int().min(0).max(20_000)),
  // No default: a silently-wrong connection string is worse than a boot failure.
  DATABASE_URL: z.string().min(1),
  ALLOWED_ORIGINS: z.string().optional().default(""),
  /**
   * Shared secret between the Next.js proxy and this API. The web app injects
   * it as X-Frontend-Key on every proxied request; requests that carry neither
   * this secret nor a valid API key are rejected in production.
   */
  FRONTEND_SECRET: z.string().optional().default(""),
  /**
   * Explicit opt-out of API authentication. Requests without an API key or the
   * frontend secret are allowed only when this is true. NODE_ENV is not
   * consulted — development and test stay locked unless the flag is set.
   */
  AUTH_DISABLED: booleanish("false"),
  /**
   * HMAC secret for finished-file links. Empty falls back to BETTER_AUTH_SECRET,
   * then a hash of DATABASE_URL, so links stay unguessable without a new secret.
   */
  FILE_LINK_SECRET: z.string().optional().default(""),
  /** Redis for the job queue, API-key rate limits, the throttler and the media cache. Empty uses in-memory fallbacks. */
  REDIS_URL: z.string().optional().default(""),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).optional().default("info"),
  ADMIN_TOKEN: z.string().optional().default(""),
  /** Signing secret for Better Auth sessions/tokens. Required in production. */
  BETTER_AUTH_SECRET: z.string().optional().default(""),
  /** Public origin of the frontend, e.g. https://example.com (OAuth callbacks build on it). */
  BETTER_AUTH_URL: z.string().optional().default("http://localhost:3000"),
  GOOGLE_CLIENT_ID: z.string().optional().default(""),
  GOOGLE_CLIENT_SECRET: z.string().optional().default(""),
  GITHUB_CLIENT_ID: z.string().optional().default(""),
  GITHUB_CLIENT_SECRET: z.string().optional().default(""),
  /** SMTP for OTP / verification mail. Unset in dev = OTP is logged to console. */
  SMTP_HOST: z.string().optional().default(""),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: z.string().optional().default(""),
  SMTP_PASS: z.string().optional().default(""),
  SMTP_FROM: z.string().optional().default("Snagbox <no-reply@snagbox.local>"),
  /** Expose /docs (Swagger). On unless set to false. */
  SWAGGER_ENABLED: booleanish("true"),
  /** Accept any public http(s) URL yt-dlp supports, not only the built-in platforms. */
  ALLOW_GENERIC_URLS: booleanish("false"),
  /** HMAC secret for job webhooks. Empty uses FILE_LINK_SECRET, then BETTER_AUTH_SECRET. */
  WEBHOOK_SECRET: z.string().optional().default(""),
  THROTTLE_TTL_SECONDS: z.coerce.number().int().positive().default(60),
  THROTTLE_LIMIT: z.coerce.number().int().positive().default(60),
  MAX_CONCURRENT_JOBS: z.coerce.number().int().min(1).max(10).default(3),
  /** Duration cap for anonymous visitors. */
  MAX_DURATION_SECONDS: z.coerce.number().int().positive().default(3600),
  /** Duration cap for signed-in users — higher, but still bounded. */
  AUTH_MAX_DURATION_SECONDS: z.coerce.number().int().positive().default(14400),
  FILE_TTL_MINUTES: z.coerce.number().int().positive().default(4320),
  /**
   * Where finished files live. "local" keeps them on the container's disk
   * (fine for development, lost on every redeploy); "r2" offloads them to an
   * S3-compatible bucket and serves them by presigned URL.
   */
  STORAGE_DRIVER: z.enum(["local", "r2"]).default("local"),
  R2_ACCOUNT_ID: z.string().optional().default(""),
  /** Overrides the derived https://<account>.r2.cloudflarestorage.com endpoint. */
  R2_ENDPOINT: z.string().optional().default(""),
  R2_ACCESS_KEY_ID: z.string().optional().default(""),
  R2_SECRET_ACCESS_KEY: z.string().optional().default(""),
  R2_BUCKET: z.string().optional().default("snagbox-downloads"),
  /**
   * Lifetime of a download link. Long enough to survive a paused download and
   * a resume attempt, short enough that a leaked URL stops working.
   */
  SIGNED_URL_TTL_SECONDS: z.coerce.number().int().min(60).max(604800).default(21600),
  /**
   * Hard ceiling on bytes held in the bucket. Retention bounds how long a file
   * lives but not how many arrive, so this is what actually keeps storage
   * inside a free allowance: once it is reached, the oldest finished downloads
   * are evicted to make room. Default 8 GiB, under R2's 10 GB free tier.
   */
  STORAGE_QUOTA_BYTES: z.coerce.number().int().positive().default(8 * 1024 ** 3),
  MEDIA_CACHE_TTL_SECONDS: z.coerce.number().int().min(0).default(300),
  DOWNLOADS_DIR: z.string().optional().default(""),
  BIN_DIR: z.string().optional().default(""),
  COOKIES_FILE: z.string().optional().default(""),
  /** Base64-encoded Netscape cookies.txt — for hosts without file mounts. */
  COOKIES_B64: z.string().optional().default(""),
  /** Explicit binary overrides; skip auto-detection entirely when set. */
  YTDLP_PATH: z.string().optional().default(""),
  /**
   * yt-dlp release to download when no binary is installed (YYYY.MM.DD).
   * Empty uses the version pinned in BinariesService.
   */
  YTDLP_VERSION: z.string().optional().default(""),
  /** Wall-clock limit for a provider direct download, in milliseconds. */
  DIRECT_DOWNLOAD_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(300_000),
  /** Hard cap on bytes read from a provider direct download. Default 2 GiB. */
  DIRECT_DOWNLOAD_MAX_BYTES: z.coerce.number().int().positive().default(2 * 1024 ** 3),
  FFMPEG_PATH: z.string().optional().default(""),
  /** Forwarded to yt-dlp as --proxy (helps with datacenter-IP blocks). */
  YTDLP_PROXY: z.string().optional().default(""),
  /** Extra yt-dlp args, whitespace-separated (e.g. extractor tuning). */
  YTDLP_EXTRA_ARGS: z.string().optional().default(""),
  YTDLP_FORCE_IPV4: booleanish("false"),
  /**
   * JS runtime yt-dlp uses to solve YouTube's `n` challenge (see --js-runtimes).
   * Empty = auto: prefer `deno` on PATH, else the Node running this API.
   * "none" disables the flag entirely and leaves yt-dlp on its own defaults.
   */
  YTDLP_JS_RUNTIME: z.string().optional().default(""),
  /**
   * Base URL of a bgutil proof-of-origin token provider, e.g.
   * http://bgutil.railway.internal:4416. YouTube refuses some videos to
   * clients that cannot present a PO token, and enforces it hardest against
   * server IPs; empty disables the integration and those videos stay blocked.
   */
  YTDLP_POT_BASE_URL: z.string().optional().default(""),
  /**
   * Runs yt-dlp with -v and logs its full stderr when an extraction fails.
   * Off by default because it is noisy, but without it the only thing that
   * reaches the logs is the ERROR line — which says nothing about whether
   * plugins loaded or a PO token was fetched, exactly when that matters.
   */
  YTDLP_VERBOSE: booleanish("false"),
  YTDLP_AUTO_UPDATE: booleanish("true"),
  YTDLP_CONCURRENT_FRAGMENTS: z.coerce.number().int().min(1).max(16).default(4),
  /**
   * Total yt-dlp tries per extraction or download, including the first.
   * Kept deliberately low: a platform that is actively refusing to serve its
   * watch page will refuse it again a second later, and the real recovery path
   * is the alternate extractors in ExtractionService, not more attempts.
   * 1 disables the ladder.
   */
  YTDLP_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(5).default(2),
  /** Base for the exponential backoff between attempts, in milliseconds. */
  YTDLP_RETRY_BASE_MS: z.coerce.number().int().min(0).max(30_000).default(800),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  const result = envSchema.safeParse(config);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return result.data;
}
