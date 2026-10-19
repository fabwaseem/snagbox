import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { execFile } from "child_process";
import extract from "extract-zip";
import * as fsSync from "fs";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { promisify } from "util";
import { AppConfigService } from "../config/app-config.service";
import { StorageService } from "../storage/storage.service";
import { cookieDigest, looksLikeCookieJar } from "./binaries/cookies";
import { downloadVerifiedFile } from "./binaries/download";
import { pinnedChecksum, resolveYtdlpVersion, standaloneAssetName, ytdlpAssetUrl } from "./binaries/release";
import { VersionCache, YTDLP_VERSION_UNKNOWN } from "./version-cache";

export { looksLikeCookieJar } from "./binaries/cookies";
export { PINNED_YTDLP_VERSION } from "./binaries/release";

const execFileAsync = promisify(execFile);

/**
 * Where the cookie jar lives in the bucket.
 *
 * Namespaced away from media so the files endpoint cannot serve it — that
 * endpoint refuses any key containing a separator for exactly this reason.
 */
const COOKIE_OBJECT_KEY = "internal/cookies.txt";

const FFMPEG_URLS: Partial<Record<string, string>> = {
  "win32:x64":
    "https://github.com/iqbal-rashed/ytdlp-nodejs/releases/download/ffmpeg-release/ffmpeg-win64.zip",
  "win32:ia32":
    "https://github.com/iqbal-rashed/ytdlp-nodejs/releases/download/ffmpeg-release/ffmpeg-win32.zip",
  "linux:x64":
    "https://github.com/iqbal-rashed/ytdlp-nodejs/releases/download/ffmpeg-release/ffmpeg-linux64.zip",
  "darwin:x64":
    "https://github.com/iqbal-rashed/ytdlp-nodejs/releases/download/ffmpeg-release/ffmpeg-macos.zip",
  "darwin:arm64":
    "https://github.com/iqbal-rashed/ytdlp-nodejs/releases/download/ffmpeg-release/ffmpeg-macos.zip",
};

/** How yt-dlp is invoked: `command [...argsPrefix, ...ytdlpArgs]`. */
export interface YtdlpInvocation {
  command: string;
  argsPrefix: string[];
  /** Where the executable came from — surfaced in /health for diagnostics. */
  source: "env" | "system" | "managed-binary" | "python-module" | "managed-zipimport";
}

/**
 * Resolves working yt-dlp + ffmpeg executables under any deployment condition.
 *
 * Every candidate is verified by actually running `--version` before it is
 * accepted, because the failure modes differ per host: Alpine/musl containers
 * can't run the glibc standalone binary, slim images lack Python for the
 * zipimport build, read-only filesystems reject the managed download, and PATH
 * setups vary. The chain tries, in order:
 *
 *   1. YTDLP_PATH env override
 *   2. `yt-dlp` on PATH (apt/apk/brew/pip installs)
 *   3. previously downloaded managed binary
 *   4. `python3 -m yt_dlp` (pip-installed module)
 *   5. fresh download of the standalone binary for this OS/arch
 *   6. fresh download of the zipimport build, run through Python
 *
 * Setup failures never crash boot; they are retried with a cooldown on the
 * next request and reported through /health.
 */
@Injectable()
export class BinariesService implements OnModuleInit {
  private readonly logger = new Logger(BinariesService.name);

  private invocation: YtdlpInvocation | null = null;
  private _ffmpegPath = "";
  private _cookiesPath = "";
  private _jsRuntime = "";
  private pythonCmd: string | null = null;

  private cookieDigest = "";
  private setupPromise: Promise<void> | null = null;
  private lastError: string | null = null;
  private lastAttemptAt = 0;
  private static readonly RETRY_COOLDOWN_MS = 30_000;
  /** One shared --version probe. Health reads it and never waits on a spawn. */
  private readonly versionCache = new VersionCache(() => this.probeVersion());

  constructor(
    private readonly config: AppConfigService,
    private readonly storage: StorageService,
  ) {}

  get ytdlp(): YtdlpInvocation {
    if (!this.invocation) {
      throw new Error(
        `The download engine is not ready${this.lastError ? `: ${this.lastError}` : ""}. It retries automatically — please try again shortly.`,
      );
    }
    return this.invocation;
  }

  get ffmpegPath(): string {
    return this._ffmpegPath;
  }

  /**
   * Directory holding yt-dlp plugins, when one is present.
   *
   * Passed to yt-dlp explicitly rather than relying on it being discovered
   * beside the executable: the standalone build resolves that location from
   * the frozen binary, which is not somewhere we control, and a plugin that
   * silently fails to load looks exactly like a plugin that is not installed.
   */
  get pluginDir(): string {
    const dir = path.join(this.config.binDir, "yt-dlp-plugins");
    return fsSync.existsSync(dir) ? dir : "";
  }

  /** Resolved cookies file (COOKIES_FILE, or COOKIES_B64 written to disk). */
  get cookiesPath(): string {
    return this._cookiesPath;
  }

  /**
   * Value for yt-dlp's `--js-runtimes`, e.g. `deno` or `node:/usr/bin/node`.
   * Empty when disabled or when no runtime could be found.
   */
  get jsRuntime(): string {
    return this._jsRuntime;
  }

  async onModuleInit(): Promise<void> {
    // Kick off setup but never block or crash boot on it — a temporary GitHub
    // outage must not take the whole API down.
    void this.ensureReady().catch(() => undefined);
  }

  /** Await this before spawning any process. Retries failed setups with a cooldown. */
  async ensureReady(): Promise<void> {
    if (this.invocation) return;

    if (!this.setupPromise) {
      const now = Date.now();
      if (this.lastError && now - this.lastAttemptAt < BinariesService.RETRY_COOLDOWN_MS) {
        throw new Error(`Download engine unavailable: ${this.lastError}`);
      }
      this.lastAttemptAt = now;
      this.setupPromise = this.setup()
        .then(() => {
          this.lastError = null;
        })
        .catch((err: Error) => {
          this.lastError = err.message;
          this.logger.error(`Engine setup failed: ${err.message}`);
          throw err;
        })
        .finally(() => {
          this.setupPromise = null;
        });
    }
    await this.setupPromise;
  }

  /**
   * Engine snapshot for /v2/health.
   *
   * The yt-dlp version is whatever was captured at boot (or the last refresh).
   * A missing or stale value starts at most one background `--version`; this
   * method does not wait for it. While that probe is the first one, the
   * version is `"unknown"`. Nothing else on the health or status routes
   * spawns a process per request — liveness is a flag read, metrics are
   * in-process counters, and admin stats are database counts.
   */
  async versions(): Promise<{
    ytdlp: string | null;
    ytdlpSource: string | null;
    pluginDir: string | null;
    ffmpeg: boolean;
    jsRuntime: string | null;
    error: string | null;
  }> {
    if (this.invocation) this.versionCache.refresh();
    // Boot's own --version is the single probe. Until it finishes, say so
    // without starting another one.
    const cached = this.versionCache.current();
    const ytdlp =
      cached ?? (this.setupPromise || this.versionCache.inFlight ? YTDLP_VERSION_UNKNOWN : null);
    return {
      ytdlp,
      ytdlpSource: this.invocation?.source ?? null,
      pluginDir: this.pluginDir || null,
      ffmpeg: Boolean(this._ffmpegPath),
      jsRuntime: this._jsRuntime || null,
      error: this.lastError,
    };
  }

  /** yt-dlp extractors break often; stale versions are the #1 cause of production failures. */
  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async autoUpdate(): Promise<void> {
    if (!this.config.ytdlpAutoUpdate || !this.invocation) return;
    try {
      const updated = await this.updateYtdlp();
      this.logger.log(`yt-dlp auto-update: ${updated.split("\n").at(-1)}`);
    } catch (err) {
      this.logger.warn(`yt-dlp auto-update failed: ${(err as Error).message}`);
    }
  }

  async updateYtdlp(): Promise<string> {
    const output = await this.runUpdate();
    // The binary changed. One background probe picks up the new version;
    // callers keep the previous string until it lands.
    this.versionCache.refresh(true);
    return output;
  }

  private async runUpdate(): Promise<string> {
    const inv = this.ytdlp;
    if (inv.source === "managed-binary" || inv.source === "env") {
      return (await this.runYtdlp(["-U"])).trim();
    }
    if (inv.source === "python-module" && this.pythonCmd) {
      const { stdout } = await execFileAsync(
        this.pythonCmd,
        ["-m", "pip", "install", "--upgrade", "yt-dlp"],
        { timeout: 120_000, windowsHide: true },
      );
      return stdout.trim();
    }
    if (inv.source === "managed-zipimport") {
      // Re-download the latest zipimport build in place.
      await this.downloadAsset("yt-dlp", inv.argsPrefix[0]);
      return "re-downloaded latest zipimport build";
    }
    return "system-managed installation — update it through your package manager";
  }

  /** Background `--version`. Failures leave the previous cache in place. */
  private async probeVersion(): Promise<string | null> {
    if (!this.invocation) return null;
    try {
      const version = (await this.runYtdlp(["--version"])).trim();
      return version || null;
    } catch {
      return null;
    }
  }

  private async runYtdlp(args: string[]): Promise<string> {
    const inv = this.ytdlp;
    const { stdout } = await execFileAsync(inv.command, [...inv.argsPrefix, ...args], {
      timeout: 30_000,
      windowsHide: true,
    });
    return stdout;
  }

  // ---------------------------------------------------------------- setup --

  private async setup(): Promise<void> {
    const binDir = this.config.binDir;
    await fs.mkdir(binDir, { recursive: true }).catch((err) => {
      this.logger.warn(`Cannot create bin dir ${binDir}: ${err.message}`);
    });

    this.pythonCmd = await this.detectPython();
    await this.resolveCookies(binDir);
    await this.resolveJsRuntime();
    await this.resolveFfmpeg(binDir);
    this.invocation = await this.resolveYtdlp(binDir);
    this.logger.log(
      `yt-dlp ready via ${this.invocation.source} (${this.invocation.command} ${this.invocation.argsPrefix.join(" ")})`.trim(),
    );
  }

  private async verify(command: string, argsPrefix: string[]): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync(command, [...argsPrefix, "--version"], {
        timeout: 20_000,
        windowsHide: true,
      });
      const version = stdout.trim();
      if (!/^\d{4}\.\d{2}/.test(version)) return false;
      // Boot already ran --version to accept this binary. Remember it so the
      // first health checks do not spawn another process.
      this.versionCache.remember(version);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Picks the JS runtime yt-dlp uses to solve YouTube's `n` challenge.
   *
   * Without one, YouTube strips every real format and the extractor reports
   * "Sign in to confirm you're not a bot" — a misleading message that sends
   * operators chasing cookies and proxies for what is actually a missing
   * dependency. yt-dlp only enables `deno` by default, so Node (which we always
   * have — it is running this process) must be opted in explicitly.
   *
   * We pass the absolute path of our own interpreter rather than the bare name
   * so this keeps working in containers and under process managers that strip
   * PATH. Node must be >= 22 per yt-dlp's EJS requirements.
   */
  private async resolveJsRuntime(): Promise<void> {
    const configured = this.config.ytdlpJsRuntime;
    if (configured.toLowerCase() === "none") {
      this._jsRuntime = "";
      this.logger.warn("JS runtime disabled (YTDLP_JS_RUNTIME=none) — YouTube formats may be missing");
      return;
    }
    if (configured) {
      this._jsRuntime = configured;
      this.logger.log(`JS runtime pinned to ${configured}`);
      return;
    }

    // Deno first — it is yt-dlp's own default and best-tested target.
    try {
      await execFileAsync("deno", ["--version"], { timeout: 10_000, windowsHide: true });
      this._jsRuntime = "deno";
      this.logger.log("JS runtime: deno (PATH)");
      return;
    } catch {
      // fall through to Node
    }

    const major = Number(process.versions.node.split(".")[0]);
    if (major >= 22) {
      this._jsRuntime = `node:${process.execPath}`;
      this.logger.log(`JS runtime: node ${process.versions.node} (${process.execPath})`);
      return;
    }

    this._jsRuntime = "";
    this.logger.warn(
      `No usable JS runtime: Node ${process.versions.node} is below the required 22 and deno is not on PATH. ` +
        "YouTube will return no downloadable formats — install deno, or upgrade Node.",
    );
  }

  private async detectPython(): Promise<string | null> {
    for (const cmd of ["python3", "python"]) {
      try {
        const { stdout } = await execFileAsync(cmd, ["--version"], {
          timeout: 10_000,
          windowsHide: true,
        });
        if (/Python 3\.(9|1\d)/.test(stdout)) return cmd;
      } catch {
        // keep trying
      }
    }
    return null;
  }

  private async resolveYtdlp(binDir: string): Promise<YtdlpInvocation> {
    const failures: string[] = [];

    // 1. Explicit override.
    const override = this.config.ytdlpPath;
    if (override) {
      if (await this.verify(override, [])) {
        return { command: override, argsPrefix: [], source: "env" };
      }
      failures.push(`YTDLP_PATH (${override}) did not run`);
    }

    // 2. System installation.
    if (await this.verify("yt-dlp", [])) {
      return { command: "yt-dlp", argsPrefix: [], source: "system" };
    }

    // 3. Previously downloaded managed binary.
    const ext = os.platform() === "win32" ? ".exe" : "";
    const managed = path.join(binDir, `yt-dlp${ext}`);
    if (fsSync.existsSync(managed) && (await this.verify(managed, []))) {
      return { command: managed, argsPrefix: [], source: "managed-binary" };
    }

    // 4. Python module (pip install yt-dlp).
    if (this.pythonCmd && (await this.verify(this.pythonCmd, ["-m", "yt_dlp"]))) {
      return { command: this.pythonCmd, argsPrefix: ["-m", "yt_dlp"], source: "python-module" };
    }

    // 5. Download the pinned standalone binary for this OS/arch.
    const asset = this.standaloneAsset();
    if (asset) {
      try {
        this.logger.log(`Downloading yt-dlp ${this.ytdlpVersion()} (${asset})…`);
        await this.downloadAsset(asset, managed);
        if (os.platform() !== "win32") await fs.chmod(managed, 0o755);
        if (await this.verify(managed, [])) {
          return { command: managed, argsPrefix: [], source: "managed-binary" };
        }
        failures.push("standalone binary downloaded but failed to run (musl/glibc mismatch?)");
      } catch (err) {
        failures.push(`standalone download failed: ${(err as Error).message}`);
      }
    }

    // 6. Zipimport build through Python — works on any libc as long as
    //    Python ≥3.9 exists (Alpine: apk add python3).
    if (this.pythonCmd) {
      const zipimport = path.join(binDir, "yt-dlp-zipimport");
      try {
        this.logger.log(`Downloading yt-dlp ${this.ytdlpVersion()} zipimport build…`);
        await this.downloadAsset("yt-dlp", zipimport);
        if (await this.verify(this.pythonCmd, [zipimport])) {
          return {
            command: this.pythonCmd,
            argsPrefix: [zipimport],
            source: "managed-zipimport",
          };
        }
        failures.push("zipimport build failed to run");
      } catch (err) {
        failures.push(`zipimport download failed: ${(err as Error).message}`);
      }
    } else {
      failures.push("no Python ≥3.9 on PATH for the zipimport fallback");
    }

    throw new Error(
      `No working yt-dlp found. Tried: env override, system PATH, managed binary, python module, fresh downloads. ` +
        `Details: ${failures.join("; ") || "n/a"}. ` +
        `Fix: install yt-dlp in the image (e.g. "pip install yt-dlp" or "apk add yt-dlp") or set YTDLP_PATH.`,
    );
  }

  private ytdlpVersion(): string {
    return resolveYtdlpVersion(this.config.ytdlpVersion);
  }

  private standaloneAsset(): string | null {
    return standaloneAssetName();
  }

  private async downloadAsset(name: string, savePath: string): Promise<void> {
    const version = this.ytdlpVersion();
    await downloadVerifiedFile(ytdlpAssetUrl(version, name), savePath, pinnedChecksum(version, name));
  }

  private async resolveFfmpeg(binDir: string): Promise<void> {
    // 1. Explicit override.
    const override = this.config.ffmpegPathOverride;
    if (override) {
      this._ffmpegPath = override;
      return;
    }

    // 2. System install.
    try {
      await execFileAsync("ffmpeg", ["-version"], { timeout: 10_000, windowsHide: true });
      this._ffmpegPath = "ffmpeg";
      this.logger.log("Using system ffmpeg");
      return;
    } catch {
      // fall through
    }

    // 3. Managed download.
    const ext = os.platform() === "win32" ? ".exe" : "";
    const managed = path.join(binDir, `ffmpeg${ext}`);
    if (fsSync.existsSync(managed)) {
      this._ffmpegPath = managed;
      return;
    }
    const url = FFMPEG_URLS[`${os.platform()}:${os.arch()}`];
    if (!url) {
      this.logger.warn(
        `No ffmpeg build for ${os.platform()}/${os.arch()} — merging/conversion will fail. Install ffmpeg in the image.`,
      );
      return;
    }
    try {
      this.logger.log("Downloading ffmpeg…");
      const zipPath = path.join(binDir, "ffmpeg.zip");
      await downloadVerifiedFile(url, zipPath);
      await extract(zipPath, { dir: binDir });
      await fs.unlink(zipPath).catch(() => undefined);
      if (os.platform() !== "win32") await fs.chmod(managed, 0o755).catch(() => undefined);
      this._ffmpegPath = managed;
      this.logger.log("ffmpeg ready");
    } catch (err) {
      this.logger.warn(`ffmpeg download failed: ${(err as Error).message}`);
    }
  }

  /**
   * Resolves the cookie jar, preferring the copy kept in object storage.
   *
   * A cookie file is not static: YouTube rotates session cookies on use and
   * yt-dlp writes the refreshed jar back. That is what keeps a session alive
   * for months in a browser — and what a container cannot do on its own, since
   * every redeploy discards the refreshed copy and falls back to the original
   * COOKIES_B64 export, which ages out within weeks. Persisting the jar to the
   * bucket closes that loop: the freshest version survives restarts, so the
   * session rolls forward instead of decaying back to a fixed snapshot.
   *
   * Order is deliberate: storage first (freshest), then an explicit file, then
   * the seed. The seed is only ever a starting point.
   */
  private async resolveCookies(binDir: string): Promise<void> {
    const target = path.join(binDir, "cookies.txt");

    const stored = await this.storage.getText(COOKIE_OBJECT_KEY).catch(() => null);
    if (stored && looksLikeCookieJar(stored)) {
      await fs.writeFile(target, stored, { mode: 0o600 });
      this._cookiesPath = target;
      this.cookieDigest = cookieDigest(stored);
      this.logger.log("Cookies restored from object storage");
      return;
    }

    const file = this.config.cookiesFile;
    if (file && fsSync.existsSync(file)) {
      this._cookiesPath = file;
      // Same reason as the seed below: leave the digest empty so this jar is
      // actually uploaded the first time rather than assumed to be stored.
      this.cookieDigest = "";
      await this.persistCookies();
      return;
    }

    const b64 = this.config.cookiesB64;
    if (b64) {
      try {
        const text = Buffer.from(b64, "base64").toString("utf8");
        if (!looksLikeCookieJar(text)) {
          this.logger.warn("COOKIES_B64 is not a Netscape cookie jar — ignoring it");
          return;
        }
        await fs.writeFile(target, text, { mode: 0o600 });
        this._cookiesPath = target;
        // Digest deliberately left unset: persistCookies() skips uploads whose
        // digest already matches, so recording it here would mark the seed as
        // "already stored" and the first upload would never happen — leaving
        // every restart to fall back to this same ageing snapshot.
        this.cookieDigest = "";
        this.logger.log("Cookies seeded from COOKIES_B64");
        await this.persistCookies();
      } catch (err) {
        this.logger.warn(`Failed to write cookies from COOKIES_B64: ${(err as Error).message}`);
      }
    }
  }

  /**
   * Writes the refreshed jar back to storage when it has changed.
   *
   * Runs on a timer rather than after each extraction because yt-dlp rewrites
   * the file at the end of every run, and uploading on each one would cost far
   * more requests than the handful of bytes justify.
   */
  @Cron(CronExpression.EVERY_10_MINUTES)
  async persistCookies(): Promise<void> {
    if (!this._cookiesPath || !this.storage.remote) return;
    let text: string;
    try {
      text = await fs.readFile(this._cookiesPath, "utf8");
    } catch {
      return;
    }

    // Never let a truncated or half-written jar replace a good one: a
    // concurrent yt-dlp run can be mid-write, and overwriting storage with
    // that would destroy the very session this exists to preserve.
    if (!looksLikeCookieJar(text)) {
      this.logger.warn("Local cookie jar looks malformed — keeping the stored copy");
      return;
    }

    const current = cookieDigest(text);
    if (current === this.cookieDigest) return;

    try {
      await this.storage.putText(COOKIE_OBJECT_KEY, text);
      this.cookieDigest = current;
      this.logger.log("Refreshed cookies persisted to object storage");
    } catch (err) {
      this.logger.warn(`Could not persist cookies: ${(err as Error).message}`);
    }
  }

}
