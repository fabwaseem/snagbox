import { Logger, type INestApplication } from "@nestjs/common";
import type { Server, ServerResponse } from "http";
import { beginDraining, isDraining } from "../health/health-probe";
import { flushLogsSync } from "../logging/pino-logger";

/** Keep serving after SIGTERM so Traefik can observe 503 and drop this backend. */
export const DEFAULT_SHUTDOWN_DRAIN_MS = 9_000;
/** Leave a few seconds inside the 25s budget for server.close and pool shutdown. */
export const MAX_SHUTDOWN_DRAIN_MS = 20_000;
export const SHUTDOWN_DEADLINE_MS = 25_000;
/**
 * Longer than a typical proxy idle timeout (60s) so the proxy closes its
 * pooled socket first. headersTimeout stays a second above that.
 */
export const KEEP_ALIVE_TIMEOUT_MS = 65_000;
export const HEADERS_TIMEOUT_MS = 66_000;
/** In-flight requests get this long after close() before their sockets are dropped. */
export const CLOSE_INFLIGHT_GRACE_MS = 5_000;

const SHUTDOWN_SIGNALS: NodeJS.Signals[] = ["SIGTERM", "SIGINT"];

const inflightCounts = new WeakMap<Server, { n: number }>();

export function shutdownDrainMs(raw: string | undefined = process.env.SHUTDOWN_DRAIN_MS): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_SHUTDOWN_DRAIN_MS;
  if (!/^\d+$/.test(raw.trim())) return DEFAULT_SHUTDOWN_DRAIN_MS;
  return Math.min(Number(raw), MAX_SHUTDOWN_DRAIN_MS);
}

export interface GracefulShutdownOptions {
  drainMs: number;
  deadlineMs: number;
  closeServer: () => Promise<number | void>;
  closeResources: () => Promise<void>;
  exit: (code: number) => void;
  log?: (level: "log" | "error", message: string) => void;
}

/**
 * Flip the drain flag, keep accepting connections for `drainMs`, then stop the
 * listener, wait for in-flight requests, close resources, and exit.
 * A deadline forces the process out if close hangs.
 */
export function runGracefulShutdown(options: GracefulShutdownOptions): Promise<void> {
  beginDraining();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(force);
      options.exit(code);
      resolve();
    };

    const force = setTimeout(() => {
      options.log?.("error", "Shutdown exceeded 25s; forcing exit");
      finish(1);
    }, options.deadlineMs);

    void (async () => {
      try {
        await delay(options.drainMs);
        if (settled) return;
        options.log?.("log", "closing server");
        const inflight = await options.closeServer();
        if (settled) return;
        const count = typeof inflight === "number" && Number.isFinite(inflight) ? inflight : 0;
        options.log?.("log", `closed, in-flight=${count}`);
        await options.closeResources();
        if (settled) return;
        options.log?.("log", "exiting 0");
        finish(0);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        options.log?.("error", `Shutdown failed: ${message}`);
        finish(1);
      }
    })();
  });
}

/**
 * `closeIdleConnections` first so Traefik's pooled sockets are not reused into
 * a listener that is about to stop, then `close` so in-flight work can finish.
 * Anything still open after the grace period is dropped before the 25s exit.
 */
export function closeHttpServer(server: Server, graceMs = CLOSE_INFLIGHT_GRACE_MS): Promise<number> {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve(0);
      return;
    }

    server.closeIdleConnections();
    const inflight = inflightCounts.get(server)?.n ?? 0;

    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(dropAll);
      resolve(inflight);
    };

    server.close(() => finish());
    const dropAll = setTimeout(() => {
      if (settled) return;
      server.closeAllConnections();
    }, graceMs);
  });
}

/**
 * Nest's own signal listener closes pools immediately and re-raises the signal
 * (non-zero status). Enable the hooks so `app.close()` still runs them, then
 * replace the listeners with a drain delay and a flushed exit.
 */
export function installGracefulShutdown(app: INestApplication): () => void {
  const preexisting = new Map<NodeJS.Signals, Set<NodeJS.SignalsListener>>();
  for (const signal of SHUTDOWN_SIGNALS) {
    preexisting.set(signal, new Set(signalListeners(signal)));
  }

  app.enableShutdownHooks(SHUTDOWN_SIGNALS);

  for (const signal of SHUTDOWN_SIGNALS) {
    const keep = preexisting.get(signal) ?? new Set<NodeJS.SignalsListener>();
    for (const listener of signalListeners(signal)) {
      if (!keep.has(listener)) process.removeListener(signal, listener);
    }
  }

  const server = app.getHttpServer() as Server;
  configureHttpServer(server);

  const logger = new Logger("Shutdown");
  let started = false;
  const onSignal = (signal: NodeJS.Signals) => {
    if (started) return;
    started = true;
    const drainMs = shutdownDrainMs();
    logger.log(`Received ${signal}; draining for ${drainMs}ms`);
    void runGracefulShutdown({
      drainMs,
      deadlineMs: SHUTDOWN_DEADLINE_MS,
      closeServer: () => closeHttpServer(server),
      closeResources: () => app.close(),
      exit: (code) => {
        process.exitCode = code;
        flushLogsSync();
        if (code !== 0) process.exit(code);
      },
      log: (level, message) => {
        if (level === "error") logger.error(message);
        else logger.log(message);
      },
    });
  };

  for (const signal of SHUTDOWN_SIGNALS) process.on(signal, onSignal);

  return () => {
    for (const signal of SHUTDOWN_SIGNALS) process.removeListener(signal, onSignal);
  };
}

/**
 * Timeouts are set for the life of the process. The request hook arms
 * `Connection: close` so a response that finishes during the drain tells
 * Traefik to drop that pooled socket instead of sending the next request on it.
 */
export function configureHttpServer(server: Server): void {
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  if (inflightCounts.has(server)) return;

  const state = { n: 0 };
  inflightCounts.set(server, state);
  server.prependListener("request", (_req, res) => {
    state.n += 1;
    let open = true;
    const done = () => {
      if (!open) return;
      open = false;
      state.n -= 1;
    };
    res.on("finish", done);
    res.on("close", done);
    armConnectionClose(res);
  });
}

function armConnectionClose(res: ServerResponse): void {
  const apply = (): void => {
    if (!isDraining() || res.headersSent) return;
    res.shouldKeepAlive = false;
    try {
      res.setHeader("Connection", "close");
    } catch {
      // A racing write already flushed the headers.
    }
  };

  const end = res.end;
  const write = res.write;
  const writeHead = res.writeHead;
  res.end = ((...args: unknown[]) => {
    apply();
    return end.apply(res, args as Parameters<ServerResponse["end"]>);
  }) as ServerResponse["end"];
  res.write = ((...args: unknown[]) => {
    apply();
    return write.apply(res, args as Parameters<ServerResponse["write"]>);
  }) as ServerResponse["write"];
  res.writeHead = ((...args: unknown[]) => {
    apply();
    return writeHead.apply(res, args as Parameters<ServerResponse["writeHead"]>);
  }) as ServerResponse["writeHead"];
}

function signalListeners(signal: NodeJS.Signals): NodeJS.SignalsListener[] {
  // Node's listener union is not assignable to itself under strict function types.
  return process.listeners(signal) as unknown as NodeJS.SignalsListener[];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
