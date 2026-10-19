/** How long a remembered yt-dlp version may be served before a background refresh. */
export const YTDLP_VERSION_TTL_MS = 10 * 60 * 1000;

/** Returned while a probe is running and no version has been remembered yet. */
export const YTDLP_VERSION_UNKNOWN = "unknown";

/**
 * In-memory yt-dlp version.
 *
 * Callers never wait on the probe. A refresh is single-flight: a second
 * request joins the one already running instead of spawning another process.
 * The cached string is kept until a probe replaces it, including across an
 * in-flight refresh.
 */
export class VersionCache {
  private value: string | null = null;
  private checkedAt = 0;
  private flight: Promise<void> | null = null;
  private pendingForce = false;

  constructor(
    private readonly probe: () => Promise<string | null>,
    private readonly ttlMs = YTDLP_VERSION_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  remember(version: string, at = this.now()): void {
    const trimmed = version.trim();
    if (!trimmed) return;
    this.value = trimmed;
    this.checkedAt = at;
  }

  /** Cached version, `"unknown"` when a probe is the only thing in progress, or null. */
  current(): string | null {
    if (this.value !== null) return this.value;
    if (this.flight) return YTDLP_VERSION_UNKNOWN;
    return null;
  }

  get inFlight(): boolean {
    return this.flight !== null;
  }

  /**
   * Start a probe when the cache is empty or older than the TTL.
   * `force` runs one even when the cache is fresh (yt-dlp was just updated).
   * Never overlaps another probe.
   */
  refresh(force = false): void {
    if (force) this.pendingForce = true;
    if (this.flight) return;
    const fresh = this.value !== null && this.now() - this.checkedAt < this.ttlMs;
    if (fresh && !this.pendingForce) return;
    this.pendingForce = false;
    this.flight = this.probe()
      .then((version) => {
        if (version?.trim()) this.remember(version);
      })
      .catch(() => undefined)
      .finally(() => {
        this.flight = null;
        if (this.pendingForce) this.refresh(true);
      });
  }

  /** Resolves when every probe started so far has finished. */
  async settled(): Promise<void> {
    while (this.flight) await this.flight;
  }
}
