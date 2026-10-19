import { Logger, type INestApplication } from "@nestjs/common";
import type { Server } from "http";
import { beginDraining } from "../health/health-probe";

/** Keep serving after SIGTERM so Traefik can observe 503 and drop this backend. */
export const DEFAULT_SHUTDOWN_DRAIN_MS = 9_000;
/** Leave a few seconds inside the 25s budget for server.close and pool shutdown. */
export const MAX_SHUTDOWN_DRAIN_MS = 20_000;
export const SHUTDOWN_DEADLINE_MS = 25_000;

const SHUTDOWN_SIGNALS: NodeJS.Signals[] = ["SIGTERM", "SIGINT"];

export function shutdownDrainMs(raw: string | undefined = process.env.SHUTDOWN_DRAIN_MS): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_SHUTDOWN_DRAIN_MS;
  if (!/^\d+$/.test(raw.trim())) return DEFAULT_SHUTDOWN_DRAIN_MS;
  return Math.min(Number(raw), MAX_SHUTDOWN_DRAIN_MS);
}

export interface GracefulShutdownOptions {
  drainMs: number;
  deadlineMs: number;
  closeServer: () => Promise<void>;
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
        await options.closeServer();
        if (settled) return;
        await options.closeResources();
        finish(0);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        options.log?.("error", `Shutdown failed: ${message}`);
        finish(1);
      }
    })();
  });
}

export function closeHttpServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
    // Idle keep-alives would otherwise hold server.close() open after in-flight work ends.
    server.closeIdleConnections?.();
  });
}

/**
 * Nest's own signal listener closes pools immediately and re-raises the signal
 * (non-zero status). Enable the hooks so `app.close()` still runs them, then
 * replace the listeners with a drain delay and `process.exit(0)`.
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
      closeServer: () => closeHttpServer(app.getHttpServer() as Server),
      closeResources: () => app.close(),
      exit: (code) => process.exit(code),
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

function signalListeners(signal: NodeJS.Signals): NodeJS.SignalsListener[] {
  // Node's listener union is not assignable to itself under strict function types.
  return process.listeners(signal) as unknown as NodeJS.SignalsListener[];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
