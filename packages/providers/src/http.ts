/**
 * Resilient HTTP client shared by every provider adapter.
 *
 *  - Rate limiting spreads requests evenly (no bursts) below the provider's published limit.
 *  - Bounded concurrency per provider.
 *  - Timeouts via AbortController and a response size cap.
 *  - Retries with exponential backoff + jitter for network errors, timeouts, 429 and 5xx,
 *    honouring Retry-After / x-ratelimit-reset. Other 4xx responses are not retried.
 *  - A circuit breaker stops calling a provider that keeps failing, then probes it again.
 *
 * Secret headers (API keys) are passed in `headers` and never included in errors or events.
 */
export type ProviderErrorKind =
  | "RATE_LIMITED"
  | "TIMEOUT"
  | "NETWORK"
  | "HTTP"
  | "CIRCUIT_OPEN"
  | "PARSE"
  | "RPC"
  | "TOO_LARGE"
  | "NOT_FOUND";

export class ProviderError extends Error {
  override name = "ProviderError";
  constructor(
    readonly provider: string,
    readonly kind: ProviderErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(`${provider}: ${kind}${status ? ` ${status}` : ""} - ${message}`);
  }

  get retryable(): boolean {
    return this.kind === "RATE_LIMITED" || this.kind === "TIMEOUT" || this.kind === "NETWORK" || (this.kind === "HTTP" && (this.status ?? 0) >= 500);
  }
}

export interface HttpEvent {
  provider: string;
  type: "success" | "failure" | "rate_limited" | "circuit_open" | "circuit_closed";
  latencyMs?: number;
  error?: string;
  at: number;
}

/** Even spacing limiter: each caller reserves the next free slot. */
export class RateLimiter {
  #nextFreeMs = 0;
  readonly #intervalMs: number;

  constructor(
    requestsPerSecond: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = defaultSleep,
  ) {
    if (!(requestsPerSecond > 0)) throw new Error("requestsPerSecond must be positive");
    this.#intervalMs = 1000 / requestsPerSecond;
  }

  async acquire(): Promise<void> {
    const now = this.now();
    const slot = Math.max(now, this.#nextFreeMs);
    this.#nextFreeMs = slot + this.#intervalMs;
    const wait = slot - now;
    if (wait > 0) await this.sleep(wait);
  }

  /** Push the next slot out, e.g. after a 429 with a reset time. */
  deferUntil(ms: number): void {
    this.#nextFreeMs = Math.max(this.#nextFreeMs, ms);
  }
}

export class Semaphore {
  #active = 0;
  readonly #queue: (() => void)[] = [];
  constructor(private readonly max: number) {
    if (max < 1) throw new Error("semaphore size must be >= 1");
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#active >= this.max) await new Promise<void>((resolve) => this.#queue.push(resolve));
    this.#active++;
    try {
      return await fn();
    } finally {
      this.#active--;
      this.#queue.shift()?.();
    }
  }
}

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export class CircuitBreaker {
  #state: CircuitState = "CLOSED";
  #failures = 0;
  #openedAt = 0;
  #probeInFlight = false;

  constructor(
    private readonly failureThreshold: number,
    private readonly cooldownMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  get state(): CircuitState {
    if (this.#state === "OPEN" && this.now() - this.#openedAt >= this.cooldownMs) this.#state = "HALF_OPEN";
    return this.#state;
  }

  get consecutiveFailures(): number {
    return this.#failures;
  }

  /** Returns false when calls must not be made right now. */
  allow(): boolean {
    const s = this.state;
    if (s === "CLOSED") return true;
    if (s === "HALF_OPEN" && !this.#probeInFlight) {
      this.#probeInFlight = true;
      return true;
    }
    return false;
  }

  /** Returns true if this success closed a previously open circuit. */
  success(): boolean {
    const wasOpen = this.#state !== "CLOSED";
    this.#state = "CLOSED";
    this.#failures = 0;
    this.#probeInFlight = false;
    return wasOpen;
  }

  /** Returns true if this failure opened the circuit. */
  failure(): boolean {
    this.#failures++;
    this.#probeInFlight = false;
    if (this.#state === "HALF_OPEN" || (this.#state === "CLOSED" && this.#failures >= this.failureThreshold)) {
      this.#state = "OPEN";
      this.#openedAt = this.now();
      return true;
    }
    return false;
  }
}

export interface HttpClientOptions {
  provider: string;
  baseUrl: string;
  requestsPerSecond: number;
  maxConcurrency?: number;
  timeoutMs?: number;
  maxRetries?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  headers?: Record<string, string>;
  breaker?: { failureThreshold: number; cooldownMs: number };
  maxResponseBytes?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  onEvent?: (event: HttpEvent) => void;
}

export interface HttpResponse {
  status: number;
  body: unknown;
  receivedAt: Date;
  latencyMs: number;
  headers: Headers;
}

export class HttpClient {
  readonly provider: string;
  readonly limiter: RateLimiter;
  readonly breaker: CircuitBreaker;
  readonly #sem: Semaphore;
  readonly #o: Required<Omit<HttpClientOptions, "headers" | "onEvent" | "breaker">> & Pick<HttpClientOptions, "headers" | "onEvent">;

  constructor(options: HttpClientOptions) {
    this.provider = options.provider;
    const now = options.now ?? Date.now;
    const sleep = options.sleep ?? defaultSleep;
    this.#o = {
      provider: options.provider,
      baseUrl: options.baseUrl.replace(/\/+$/, ""),
      requestsPerSecond: options.requestsPerSecond,
      maxConcurrency: options.maxConcurrency ?? 2,
      timeoutMs: options.timeoutMs ?? 10_000,
      maxRetries: options.maxRetries ?? 3,
      baseBackoffMs: options.baseBackoffMs ?? 500,
      maxBackoffMs: options.maxBackoffMs ?? 30_000,
      headers: options.headers,
      maxResponseBytes: options.maxResponseBytes ?? 5_000_000,
      fetchImpl: options.fetchImpl ?? fetch,
      now,
      sleep,
      random: options.random ?? Math.random,
      onEvent: options.onEvent,
    };
    this.limiter = new RateLimiter(options.requestsPerSecond, now, sleep);
    this.breaker = new CircuitBreaker(options.breaker?.failureThreshold ?? 5, options.breaker?.cooldownMs ?? 60_000, now);
    this.#sem = new Semaphore(this.#o.maxConcurrency);
  }

  get(path: string, query?: Record<string, string | undefined>): Promise<HttpResponse> {
    return this.request("GET", path, { query });
  }

  post(path: string, body: unknown): Promise<HttpResponse> {
    return this.request("POST", path, { body });
  }

  async request(method: "GET" | "POST", path: string, opts: { query?: Record<string, string | undefined>; body?: unknown }): Promise<HttpResponse> {
    const url = this.#buildUrl(path, opts.query);
    let attempt = 0;
    for (;;) {
      if (!this.breaker.allow()) {
        this.#emit({ type: "circuit_open" });
        throw new ProviderError(this.provider, "CIRCUIT_OPEN", "circuit breaker is open; provider paused");
      }
      try {
        const res = await this.#sem.run(async () => {
          await this.limiter.acquire();
          return this.#once(method, url, opts.body);
        });
        if (this.breaker.success()) this.#emit({ type: "circuit_closed" });
        this.#emit({ type: "success", latencyMs: res.latencyMs });
        return res;
      } catch (err) {
        const e = err instanceof ProviderError ? err : new ProviderError(this.provider, "NETWORK", String(err));
        if (e.kind === "RATE_LIMITED") {
          // Rate limiting is our own pacing problem, not provider failure; don't trip the breaker.
          this.breaker.success();
          this.#emit({ type: "rate_limited", error: e.message });
        } else if (e.retryable) {
          if (this.breaker.failure()) this.#emit({ type: "circuit_open", error: e.message });
          this.#emit({ type: "failure", error: e.message });
        } else {
          // Client errors are not the provider's fault; they don't count towards the breaker.
          this.breaker.success();
          this.#emit({ type: "failure", error: e.message });
          throw e;
        }
        if (!e.retryable || attempt >= this.#o.maxRetries) throw e;
        attempt++;
        const retryAfter = (e as ProviderError & { retryAfterMs?: number }).retryAfterMs;
        const backoff = Math.min(this.#o.maxBackoffMs, this.#o.baseBackoffMs * 2 ** (attempt - 1));
        const jittered = backoff / 2 + this.#o.random() * (backoff / 2);
        await this.#o.sleep(Math.max(jittered, retryAfter ?? 0));
      }
    }
  }

  async #once(method: string, url: string, body: unknown): Promise<HttpResponse> {
    const controller = new AbortController();
    const started = this.#o.now();
    const timer = setTimeout(() => controller.abort(), this.#o.timeoutMs);
    let res: Response;
    try {
      res = await this.#o.fetchImpl(url, {
        method,
        signal: controller.signal,
        redirect: "error",
        headers: {
          accept: "application/json",
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          ...(this.#o.headers ?? {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      clearTimeout(timer);
      if (controller.signal.aborted) throw new ProviderError(this.provider, "TIMEOUT", `no response within ${this.#o.timeoutMs}ms`);
      throw new ProviderError(this.provider, "NETWORK", errorMessage(err));
    }
    try {
      const text = await readLimited(res, this.#o.maxResponseBytes, this.provider);
      const receivedAt = new Date(this.#o.now());
      const latencyMs = this.#o.now() - started;
      if (res.status === 429) {
        const err = new ProviderError(this.provider, "RATE_LIMITED", "429 Too Many Requests", 429) as ProviderError & { retryAfterMs?: number };
        err.retryAfterMs = retryAfterMs(res.headers, this.#o.now());
        if (err.retryAfterMs) this.limiter.deferUntil(this.#o.now() + err.retryAfterMs);
        throw err;
      }
      if (res.status === 404) throw new ProviderError(this.provider, "NOT_FOUND", "not found", 404);
      if (res.status >= 400) {
        throw new ProviderError(this.provider, "HTTP", truncate(text, 300), res.status);
      }
      let parsed: unknown;
      try {
        parsed = text.length ? JSON.parse(text) : null;
      } catch {
        throw new ProviderError(this.provider, "PARSE", "response was not JSON", res.status);
      }
      return { status: res.status, body: parsed, receivedAt, latencyMs, headers: res.headers };
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      if (controller.signal.aborted) throw new ProviderError(this.provider, "TIMEOUT", `body not received within ${this.#o.timeoutMs}ms`);
      throw new ProviderError(this.provider, "NETWORK", errorMessage(err));
    } finally {
      clearTimeout(timer);
    }
  }

  #buildUrl(path: string, query?: Record<string, string | undefined>): string {
    // An empty path posts to the base URL exactly (RPC URLs may carry their own query string).
    const url = new URL(path === "" ? this.#o.baseUrl : `${this.#o.baseUrl}${path.startsWith("/") ? path : `/${path}`}`);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) url.searchParams.set(k, v);
    return url.toString();
  }

  #emit(e: Omit<HttpEvent, "provider" | "at">): void {
    this.#o.onEvent?.({ provider: this.provider, at: this.#o.now(), ...e });
  }
}

async function readLimited(res: Response, maxBytes: number, provider: string): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw new ProviderError(provider, "TOO_LARGE", `declared ${declared} bytes`);
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new ProviderError(provider, "TOO_LARGE", `response exceeded ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function retryAfterMs(headers: Headers, nowMs: number): number | undefined {
  const ra = headers.get("retry-after");
  if (ra) {
    const secs = Number(ra);
    if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
    const date = Date.parse(ra);
    if (!Number.isNaN(date)) return Math.max(0, date - nowMs);
  }
  const reset = headers.get("x-ratelimit-reset");
  if (reset && Number.isFinite(Number(reset))) return Math.max(0, Number(reset) * 1000 - nowMs);
  return undefined;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
