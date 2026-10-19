import { VersionCache } from "./version-cache";

describe("VersionCache", () => {
  function deferred(): { promise: Promise<string | null>; resolve: (value: string | null) => void } {
    let resolve: (value: string | null) => void = () => undefined;
    const promise = new Promise<string | null>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }

  it("returns unknown until the single in-flight probe resolves", async () => {
    const gate = deferred();
    let calls = 0;
    const cache = new VersionCache(() => {
      calls += 1;
      return gate.promise;
    });

    cache.refresh();
    cache.refresh();

    expect(cache.current()).toBe("unknown");
    expect(cache.inFlight).toBe(true);
    expect(calls).toBe(1);

    gate.resolve("2026.08.19\n");
    await cache.settled();

    expect(cache.current()).toBe("2026.08.19");
    expect(calls).toBe(1);
  });

  it("serves the cached version immediately and skips a fresh probe", async () => {
    let calls = 0;
    const cache = new VersionCache(async () => {
      calls += 1;
      return "2026.08.19";
    });
    cache.remember("2026.01.01");

    cache.refresh();
    expect(cache.current()).toBe("2026.01.01");
    await cache.settled();
    expect(calls).toBe(0);
  });

  it("refreshes a stale cache in the background without hiding the old value", async () => {
    let now = 0;
    const gate = deferred();
    let calls = 0;
    const cache = new VersionCache(
      () => {
        calls += 1;
        return gate.promise;
      },
      10_000,
      () => now,
    );
    cache.remember("2026.01.01", 0);
    now = 10_000;

    cache.refresh();
    cache.refresh();
    expect(cache.current()).toBe("2026.01.01");
    expect(calls).toBe(1);

    gate.resolve("2026.08.19");
    await cache.settled();
    expect(cache.current()).toBe("2026.08.19");
  });

  it("forces one new probe after an update, still single-flight", async () => {
    let now = 0;
    const calls: string[] = [];
    let release: (value: string) => void = () => undefined;
    const cache = new VersionCache(
      () =>
        new Promise<string>((resolve) => {
          calls.push("start");
          release = resolve;
        }),
      10_000,
      () => now,
    );
    cache.remember("2026.01.01", 0);

    cache.refresh(true);
    expect(calls).toEqual(["start"]);
    expect(cache.current()).toBe("2026.01.01");

    release("2026.02.01");
    await cache.settled();
    expect(cache.current()).toBe("2026.02.01");
    expect(calls).toEqual(["start"]);
  });

  it("runs the forced probe that arrived while another probe was in flight", async () => {
    const versions = ["2026.01.01", "2026.03.01"];
    let calls = 0;
    const cache = new VersionCache(async () => {
      const version = versions[calls] ?? "nope";
      calls += 1;
      await Promise.resolve();
      return version;
    });

    cache.refresh();
    cache.refresh(true);
    expect(calls).toBe(1);

    await cache.settled();
    expect(calls).toBe(2);
    expect(cache.current()).toBe("2026.03.01");
  });
});
