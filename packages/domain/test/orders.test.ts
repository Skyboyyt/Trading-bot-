import { describe, expect, it } from "vitest";
import {
  allowedTransitions,
  assertTransition,
  canTransition,
  combineVerdicts,
  InvalidTransitionError,
  ManualClock,
  ORDER_STATES,
  orderIdempotencyKey,
  seededRng,
  seedFromString,
  TERMINAL_ORDER_STATES,
} from "../src/index.ts";

describe("order state machine", () => {
  it("allows the happy path", () => {
    const path = ["PROPOSED", "RESERVED", "PREPARED", "SUBMITTED", "CONFIRMED", "FINALIZED", "RECONCILED"] as const;
    for (let i = 0; i < path.length - 1; i++) {
      expect(canTransition(path[i]!, path[i + 1]!)).toBe(true);
    }
  });

  it("routes timeouts through UNKNOWN instead of failing blindly", () => {
    expect(canTransition("SUBMITTED", "UNKNOWN")).toBe(true);
    expect(canTransition("UNKNOWN", "CONFIRMED")).toBe(true);
    expect(canTransition("UNKNOWN", "PREPARED")).toBe(false);
    expect(canTransition("UNKNOWN", "SUBMITTED")).toBe(false);
    expect(canTransition("UNKNOWN", "CANCELLED")).toBe(false);
  });

  it("supports rollback of a confirmed transaction", () => {
    expect(canTransition("CONFIRMED", "UNKNOWN")).toBe(true);
    expect(canTransition("FINALIZED", "UNKNOWN")).toBe(false);
  });

  it("never leaves terminal states", () => {
    for (const s of TERMINAL_ORDER_STATES) {
      expect(allowedTransitions(s)).toHaveLength(0);
      for (const to of ORDER_STATES) expect(canTransition(s, to)).toBe(false);
    }
  });

  it("throws a typed error on illegal transitions", () => {
    expect(() => assertTransition("PROPOSED", "SUBMITTED")).toThrow(InvalidTransitionError);
  });
});

describe("idempotency keys", () => {
  const base = {
    portfolioId: "0190f2c4-0000-7000-8000-000000000001",
    strategyVersion: "breakout-retest-v1@abc",
    mint: "So11111111111111111111111111111111111111112",
    signalAt: new Date("2026-03-01T12:05:00Z"),
    side: "BUY" as const,
  };

  it("is deterministic for the same signal", () => {
    expect(orderIdempotencyKey(base)).toBe(orderIdempotencyKey({ ...base, signalAt: new Date(base.signalAt) }));
  });

  it("differs by side, time, mint, portfolio and strategy version", () => {
    const k = orderIdempotencyKey(base);
    expect(orderIdempotencyKey({ ...base, side: "SELL" })).not.toBe(k);
    expect(orderIdempotencyKey({ ...base, signalAt: new Date("2026-03-01T12:06:00Z") })).not.toBe(k);
    expect(orderIdempotencyKey({ ...base, mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" })).not.toBe(k);
    expect(orderIdempotencyKey({ ...base, portfolioId: "0190f2c4-0000-7000-8000-000000000002" })).not.toBe(k);
    expect(orderIdempotencyKey({ ...base, strategyVersion: "breakout-retest-v1@def" })).not.toBe(k);
  });
});

describe("verdicts", () => {
  it("treats missing evidence as UNKNOWN, never PASS", () => {
    expect(combineVerdicts([])).toBe("UNKNOWN");
    expect(combineVerdicts([{ id: "a", verdict: "PASS", reason: "" }, { id: "b", verdict: "UNKNOWN", reason: "" }])).toBe("UNKNOWN");
    expect(combineVerdicts([{ id: "a", verdict: "UNKNOWN", reason: "" }, { id: "b", verdict: "REJECT", reason: "" }])).toBe("REJECT");
    expect(combineVerdicts([{ id: "a", verdict: "PASS", reason: "" }])).toBe("PASS");
  });
});

describe("deterministic helpers", () => {
  it("seeded RNG is reproducible", () => {
    const a = seededRng(7);
    const b = seededRng(7);
    for (let i = 0; i < 100; i++) expect(a.next()).toBe(b.next());
    expect(seedFromString("order-1")).toBe(seedFromString("order-1"));
    expect(seedFromString("order-1")).not.toBe(seedFromString("order-2"));
  });

  it("manual clock never moves backwards", () => {
    const c = new ManualClock("2026-01-01T00:00:00Z");
    c.advance(60_000);
    expect(c.now().toISOString()).toBe("2026-01-01T00:01:00.000Z");
    expect(() => c.set("2025-12-31T00:00:00Z")).toThrow();
    expect(() => c.advance(-1)).toThrow();
  });
});
