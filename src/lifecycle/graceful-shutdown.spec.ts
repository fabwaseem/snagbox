import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { createServer } from "http";
import path from "path";
import { isDraining, resetDraining } from "../health/health-probe";
import { installGracefulShutdown, runGracefulShutdown, shutdownDrainMs } from "./graceful-shutdown";

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

    let slowStatus = 0;
    let slowBody = "";
    const slow = fetch(`${ready}/slow`).then(async (res) => {
      slowStatus = res.status;
      slowBody = await res.text();
    });

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

    expect(saw503).toBe(true);
    expect(slowStatus).toBe(200);
    expect(slowBody).toBe("done");
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
