import { describe, expect, it } from "vitest";
import { CircuitBreaker, HttpClient, ProviderError, RateLimiter, type HttpEvent } from "../src/index.ts";

/** Virtual time: sleeping advances the clock instantly. */
function fakeTime(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
}

type Responder = (url: string, init: RequestInit) => Response | Promise<Response>;

function client(responders: Responder[], extra: Partial<ConstructorParameters<typeof HttpClient>[0]> = {}) {
  const time = fakeTime();
  const calls: string[] = [];
  const events: HttpEvent[] = [];
  let i = 0;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push(String(url));
    const r = responders[Math.min(i++, responders.length - 1)]!;
    return r(String(url), init ?? {});
  }) as typeof fetch;
  const http = new HttpClient({
    provider: "test",
    baseUrl: "https://example.test/api",
    requestsPerSecond: 2,
    fetchImpl,
    now: time.now,
    sleep: time.sleep,
    random: () => 0.5,
    onEvent: (e) => events.push(e),
    maxRetries: 3,
    ...extra,
  });
  return { http, calls, events, time };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("RateLimiter", () => {
  it("spaces requests evenly below the limit", async () => {
    const time = fakeTime(0);
    const limiter = new RateLimiter(0.5, time.now, time.sleep);
    const stamps: number[] = [];
    for (let i = 0; i < 4; i++) {
      await limiter.acquire();
      stamps.push(time.now());
    }
    expect(stamps).toEqual([0, 2000, 4000, 6000]);
  });
});

describe("CircuitBreaker", () => {
  it("opens after the threshold, probes once after cooldown, closes on success", () => {
    const time = fakeTime(0);
    const b = new CircuitBreaker(2, 1000, time.now);
    expect(b.failure()).toBe(false);
    expect(b.failure()).toBe(true);
    expect(b.allow()).toBe(false);
    time.advance(1000);
    expect(b.state).toBe("HALF_OPEN");
    expect(b.allow()).toBe(true);
    expect(b.allow()).toBe(false); // only one probe at a time
    expect(b.success()).toBe(true);
    expect(b.state).toBe("CLOSED");
  });

  it("re-opens if the probe fails", () => {
    const time = fakeTime(0);
    const b = new CircuitBreaker(1, 1000, time.now);
    b.failure();
    time.advance(1000);
    expect(b.allow()).toBe(true);
    expect(b.failure()).toBe(true);
    expect(b.state).toBe("OPEN");
  });
});

describe("HttpClient", () => {
  it("retries server errors with backoff and then succeeds", async () => {
    const { http, calls, time } = client([() => json({}, 503), () => json({}, 502), () => json({ ok: 1 })]);
    const before = time.now();
    const res = await http.get("/x", { a: "1", b: undefined });
    expect(res.body).toEqual({ ok: 1 });
    expect(calls).toHaveLength(3);
    expect(calls[0]).toBe("https://example.test/api/x?a=1");
    expect(time.now() - before).toBeGreaterThan(500);
  });

  it("does not retry client errors", async () => {
    const { http, calls } = client([() => json({ error: "bad" }, 400)]);
    await expect(http.get("/x")).rejects.toMatchObject({ kind: "HTTP", status: 400 });
    expect(calls).toHaveLength(1);
  });

  it("treats 404 as NOT_FOUND without retrying", async () => {
    const { http, calls } = client([() => json({}, 404)]);
    await expect(http.get("/x")).rejects.toMatchObject({ kind: "NOT_FOUND" });
    expect(calls).toHaveLength(1);
  });

  it("honours Retry-After on 429 and does not trip the breaker", async () => {
    const { http, time, events } = client([() => json({}, 429, { "retry-after": "7" }), () => json({ ok: true })], {
      breaker: { failureThreshold: 1, cooldownMs: 60_000 },
    });
    const before = time.now();
    await http.get("/x");
    expect(time.now() - before).toBeGreaterThanOrEqual(7000);
    expect(http.breaker.state).toBe("CLOSED");
    expect(events.some((e) => e.type === "rate_limited")).toBe(true);
  });

  it("gives up after max retries with a typed error", async () => {
    const { http, calls } = client([() => json({}, 500)], { maxRetries: 2, breaker: { failureThreshold: 10, cooldownMs: 1000 } });
    await expect(http.get("/x")).rejects.toBeInstanceOf(ProviderError);
    expect(calls).toHaveLength(3);
  });

  it("stops calling a failing provider once the circuit opens", async () => {
    const { http, calls } = client([() => json({}, 500)], { maxRetries: 0, breaker: { failureThreshold: 2, cooldownMs: 60_000 } });
    await expect(http.get("/x")).rejects.toMatchObject({ kind: "HTTP" });
    await expect(http.get("/x")).rejects.toMatchObject({ kind: "HTTP" });
    await expect(http.get("/x")).rejects.toMatchObject({ kind: "CIRCUIT_OPEN" });
    expect(calls).toHaveLength(2);
  });

  it("maps network failures and invalid JSON", async () => {
    const net = client([() => Promise.reject(new TypeError("fetch failed"))], { maxRetries: 0 });
    await expect(net.http.get("/x")).rejects.toMatchObject({ kind: "NETWORK" });
    const bad = client([() => new Response("<html>", { status: 200 })]);
    await expect(bad.http.get("/x")).rejects.toMatchObject({ kind: "PARSE" });
  });

  it("caps response size", async () => {
    const { http } = client([() => new Response("x".repeat(2048), { status: 200 })], { maxResponseBytes: 1024 });
    await expect(http.get("/x")).rejects.toMatchObject({ kind: "TOO_LARGE" });
  });

  it("times out slow responses", async () => {
    const { http } = client(
      [
        (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          }),
      ],
      { timeoutMs: 20, maxRetries: 0, now: Date.now, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) },
    );
    await expect(http.get("/x")).rejects.toMatchObject({ kind: "TIMEOUT" });
  });

  it("never puts secret headers into error messages", async () => {
    const { http } = client([() => json({ error: "nope" }, 401)], { headers: { "x-api-key": "secret-key-value" } });
    try {
      await http.get("/x");
    } catch (err) {
      expect(String(err)).not.toContain("secret-key-value");
    }
  });

  it("posts to the exact base URL when the path is empty (RPC URLs with query keys)", async () => {
    const { http, calls } = client([() => json({ ok: 1 })], { baseUrl: "https://rpc.example.test/?api-key=abc" });
    await http.post("", { x: 1 });
    expect(calls[0]).toBe("https://rpc.example.test/?api-key=abc");
  });
});
