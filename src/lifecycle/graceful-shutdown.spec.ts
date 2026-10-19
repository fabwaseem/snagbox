import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import http, { createServer } from "http";
import type { AddressInfo } from "net";
import path from "path";
import { beginDraining, isDraining, resetDraining } from "../health/health-probe";
import {
  HEADERS_TIMEOUT_MS,
  KEEP_ALIVE_TIMEOUT_MS,
  closeHttpServer,
  configureHttpServer,
  installGracefulShutdown,
  runGracefulShutdown,
  shutdownDrainMs,
} from "./graceful-shutdown";

const root = path.resolve(__dirname, "../..");

describe("shutdownDrainMs", () => {
  it("defaults to 9s and caps the window", () => {
    expect(shutdownDrainMs(undefined)).toBe(9_000);
    expect(shutdownDrainMs("")).toBe(9_000);
    expect(shutdownDrainMs("nope")).toBe(9_000);
    expect(shutdownDrainMs("1500")).toBe(1_500);
    expect(shutdownDrainMs("30000")).toBe(20_000);
  });
});

describe("runGracefulShutdown", () => {
  beforeEach(() => {
    resetDraining();
  });

  it("serves through the drain, then closes the server before resources", async () => {
    const order: string[] = [];
    const exit = jest.fn();
    const started = Date.now();
    await runGracefulShutdown({
      drainMs: 80,
      deadlineMs: 2_000,
      closeServer: async () => {
        order.push("server");
        expect(isDraining()).toBe(true);
        expect(Date.now() - started).toBeGreaterThanOrEqual(60);
      },
      closeResources: async () => {
        order.push("resources");
      },
      exit,
    });
    expect(order).toEqual(["server", "resources"]);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("logs the close and the exit", async () => {
    const lines: string[] = [];
    const exit = jest.fn();
    await runGracefulShutdown({
      drainMs: 0,
      deadlineMs: 2_000,
      closeServer: async () => 2,
      closeResources: async () => undefined,
      exit,
      log: (_level, message) => {
        lines.push(message);
      },
    });
    expect(lines).toEqual(["closing server", "closed, in-flight=2", "exiting 0"]);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("force-exits when close hangs past the deadline", async () => {
    const exit = jest.fn();
    await runGracefulShutdown({
      drainMs: 10,
      deadlineMs: 40,
      closeServer: () => new Promise(() => undefined),
      closeResources: async () => undefined,
      exit,
    });
    expect(exit).toHaveBeenCalledWith(1);
    expect(exit).not.toHaveBeenCalledWith(0);
  });
});

describe("installGracefulShutdown", () => {
  it("enables Nest hooks and keeps a single replacement listener", () => {
    const nestListener = () => undefined;
    const app = {
      enableShutdownHooks: (signals: string[]) => {
        for (const signal of signals) process.on(signal, nestListener);
      },
      getHttpServer: () => createServer(),
      close: async () => undefined,
    };
    const before = process.listenerCount("SIGTERM");
    const stop = installGracefulShutdown(app as never);
    expect(process.listenerCount("SIGTERM")).toBe(before + 1);
    expect(process.listeners("SIGTERM")).not.toContain(nestListener);
    expect(process.listeners("SIGINT")).not.toContain(nestListener);
    stop();
    expect(process.listenerCount("SIGTERM")).toBe(before);
  });
});

describe("HTTP server close", () => {
  afterEach(() => {
    resetDraining();
  });

  function listen(server: http.Server): Promise<number> {
    return new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        resolve((server.address() as AddressInfo).port);
      });
    });
  }

  it("sets keep-alive timeouts above a 60s proxy idle", () => {
    const server = createServer();
    configureHttpServer(server);
    expect(server.keepAliveTimeout).toBe(KEEP_ALIVE_TIMEOUT_MS);
    expect(server.headersTimeout).toBe(HEADERS_TIMEOUT_MS);
    expect(server.headersTimeout).toBeGreaterThan(server.keepAliveTimeout);
    server.close();
  });

  it("sends Connection: close on a response that finishes during the drain", async () => {
    let release: () => void = () => undefined;
    const server = createServer((_req, res) => {
      void new Promise<void>((resolve) => {
        release = resolve;
      }).then(() => {
        res.end("ok");
      });
    });
    configureHttpServer(server);
    const port = await listen(server);
    const pending = new Promise<{ status: number; connection: string | undefined }>((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${port}/`, (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode ?? 0, connection: res.headers.connection }));
      });
      req.on("error", reject);
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    beginDraining();
    release();
    const res = await pending;
    expect(res.status).toBe(200);
    expect(res.connection).toBe("close");
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it("drops idle keep-alive sockets instead of waiting out the timeout", async () => {
    const server = createServer((_req, res) => {
      res.end("ok");
    });
    configureHttpServer(server);
    server.keepAliveTimeout = 30_000;
    const port = await listen(server);
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    await new Promise<void>((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${port}/`, { agent }, (res) => {
        res.resume();
        res.on("end", () => resolve());
      });
      req.on("error", reject);
    });
    const started = Date.now();
    const inflight = await closeHttpServer(server, 5_000);
    expect(inflight).toBe(0);
    expect(Date.now() - started).toBeLessThan(1_000);
    agent.destroy();
  });

  it("closes sockets that are still in flight after the grace period", async () => {
    const server = createServer((_req, res) => {
      res.write("partial");
    });
    configureHttpServer(server);
    const port = await listen(server);
    const hung = http.get(`http://127.0.0.1:${port}/`);
    hung.on("error", () => undefined);
    await new Promise<void>((resolve) => {
      hung.on("response", () => resolve());
    });
    const started = Date.now();
    const inflight = await closeHttpServer(server, 80);
    expect(inflight).toBe(1);
    expect(Date.now() - started).toBeGreaterThanOrEqual(70);
    expect(Date.now() - started).toBeLessThan(2_000);
    hung.destroy();
  });
});

describe("SIGTERM drain", () => {
  let child: ChildProcessWithoutNullStreams | undefined;

  afterEach(() => {
    if (child && child.exitCode === null && !child.killed) child.kill("SIGKILL");
    child = undefined;
  });

  it("finishes an in-flight request, fails health, then exits 0", async () => {
    child = spawn(
      process.execPath,
      ["--require", "ts-node/register/transpile-only", "test/shutdown.harness.ts"],
      {
        cwd: root,
        env: {
          ...process.env,
          TS_NODE_COMPILER_OPTIONS: JSON.stringify({
            module: "commonjs",
            moduleResolution: "bundler",
            esModuleInterop: true,
            experimentalDecorators: true,
            emitDecoratorMetadata: true,
            target: "ES2022",
          }),
          SHUTDOWN_DRAIN_MS: "500",
          SLOW_MS: "1200",
        },
      },
    );

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const ready = await waitFor(() => {
      const line = stdout.split("\n").find((item) => item.startsWith("READY "));
      return line ? line.slice("READY ".length).trim() : undefined;
    }, 20_000).catch((error: Error) => {
      throw new Error(`${error.message}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    });
    expect(ready).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const healthy = await fetch(`${ready}/api/health`);
    expect(healthy.status).toBe(200);
    expect(healthy.headers.get("cache-control")).toContain("no-store");
    expect(await healthy.json()).toEqual({ status: "ok" });

    const agent = new http.Agent({ keepAlive: true, maxSockets: 20 });
    const socketErrors: string[] = [];
    let sawClose = false;
    let detached = false;
    // Traefik drops a backend once liveness is 503. Until that response, the
    // pooled keep-alive sockets are still in use and must not reset.
    const hammer = Promise.all(
      Array.from({ length: 20 }, async () => {
        while (!detached) {
          const result = await new Promise<{ status?: number; connection?: string; error?: string }>(
            (resolve) => {
              const req = http.get(`${ready}/api/health`, { agent }, (res) => {
                const connection = res.headers.connection;
                res.resume();
                res.on("end", () => resolve({ status: res.statusCode, connection }));
              });
              req.setTimeout(2_000, () => req.destroy(Object.assign(new Error("timeout"), { code: "timeout" })));
              req.on("error", (error: NodeJS.ErrnoException) => {
                resolve({ error: error.code ?? error.message });
              });
            },
          );
          if (result.error) {
            socketErrors.push(result.error);
            return;
          }
          if (result.status !== 200 && result.status !== 503) socketErrors.push(String(result.status));
          if (result.connection === "close") sawClose = true;
          if (result.status === 503) detached = true;
        }
      }),
    );

    let slowStatus = 0;
    let slowBody = "";
    const slow = fetch(`${ready}/slow`).then(async (res) => {
      slowStatus = res.status;
      slowBody = await res.text();
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    child.kill("SIGTERM");

    let saw503 = false;
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && !saw503) {
      const probe = await fetch(`${ready}/api/health`);
      if (probe.status === 503) {
        expect(probe.headers.get("cache-control")).toContain("no-store");
        expect(await probe.json()).toEqual({ status: "draining" });
        saw503 = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    await slow;
    const exitCode = await waitForExit(child);
    detached = true;
    await hammer;
    agent.destroy();

    expect(saw503).toBe(true);
    expect(sawClose).toBe(true);
    expect(socketErrors).toEqual([]);
    expect(slowStatus).toBe(200);
    expect(slowBody).toBe("done");
    expect(stdout).toContain("closing server");
    expect(stdout).toMatch(/closed, in-flight=\d+/);
    expect(stdout).toContain("exiting 0");
    expect(stdout.indexOf("closing server")).toBeLessThan(stdout.indexOf("exiting 0"));
    expect(stdout.indexOf("SLOW_DONE")).toBeGreaterThanOrEqual(0);
    expect(stdout.indexOf("SLOW_DONE")).toBeLessThan(stdout.indexOf("RESOURCES_CLOSED"));
    expect(exitCode).toBe(0);
    if (exitCode !== 0) {
      throw new Error(stderr);
    }
  }, 30_000);
});

function waitFor(read: () => string | undefined, timeoutMs: number): Promise<string> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const value = read();
      if (value) {
        resolve(value);
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error("timed out waiting for the harness"));
        return;
      }
      setTimeout(tick, 20);
    };
    tick();
  });
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => {
    child.once("exit", (code) => resolve(code));
  });
}
