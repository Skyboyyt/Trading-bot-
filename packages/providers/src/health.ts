/**
 * In-memory provider health, fed by HttpClient events and flushed to the provider_health table
 * by the worker so the dashboard can show it.
 */
import type { CircuitState, HttpEvent } from "./http.ts";

export interface ProviderHealthSnapshot {
  provider: string;
  status: "HEALTHY" | "DEGRADED" | "DOWN" | "UNKNOWN";
  circuitState: CircuitState;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  lastError: string | null;
  consecutiveFailures: number;
  requestsTotal: number;
  rateLimitedTotal: number;
}

export class ProviderHealthTracker {
  readonly #state = new Map<string, ProviderHealthSnapshot>();

  record = (e: HttpEvent): void => {
    const s = this.#get(e.provider);
    const at = new Date(e.at);
    switch (e.type) {
      case "success":
        s.requestsTotal++;
        s.lastSuccessAt = at;
        s.consecutiveFailures = 0;
        break;
      case "failure":
        s.requestsTotal++;
        s.lastFailureAt = at;
        s.lastError = e.error ?? null;
        s.consecutiveFailures++;
        break;
      case "rate_limited":
        s.requestsTotal++;
        s.rateLimitedTotal++;
        s.lastError = e.error ?? "rate limited";
        break;
      case "circuit_open":
        s.circuitState = "OPEN";
        break;
      case "circuit_closed":
        s.circuitState = "CLOSED";
        break;
    }
    if (e.type === "success") s.circuitState = "CLOSED";
    s.status = statusOf(s);
  };

  snapshot(): ProviderHealthSnapshot[] {
    return [...this.#state.values()].map((s) => ({ ...s }));
  }

  #get(provider: string): ProviderHealthSnapshot {
    let s = this.#state.get(provider);
    if (!s) {
      s = {
        provider,
        status: "UNKNOWN",
        circuitState: "CLOSED",
        lastSuccessAt: null,
        lastFailureAt: null,
        lastError: null,
        consecutiveFailures: 0,
        requestsTotal: 0,
        rateLimitedTotal: 0,
      };
      this.#state.set(provider, s);
    }
    return s;
  }
}

function statusOf(s: ProviderHealthSnapshot): ProviderHealthSnapshot["status"] {
  if (s.circuitState === "OPEN") return "DOWN";
  if (s.consecutiveFailures > 0) return "DEGRADED";
  if (s.lastSuccessAt) return "HEALTHY";
  return "UNKNOWN";
}
