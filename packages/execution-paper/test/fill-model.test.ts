import { describe, expect, it } from "vitest";
import { chainViewAt, DEFAULT_FILL_MODEL, simulateExecution, type FillModelParams } from "../src/fill-model.ts";

const T0 = new Date("2026-03-02T10:00:00Z");
const input = {
  orderId: "0190f2c4-0000-7000-8000-000000000001",
  attemptNo: 1,
  quoteOutRaw: 1_000_000_000n,
  minOutRaw: 990_000_000n,
  quoteImpactBps: 40,
  quotePriorityFeeLamports: 20_000n,
  quoteReceivedAt: new Date(T0.getTime() - 1_000),
  submittedAt: T0,
  maxNetworkFeeLamports: 200_000n,
};
const quiet: FillModelParams = {
  ...DEFAULT_FILL_MODEL,
  latencyMs: { min: 1_000, max: 1_000 },
  lateConfirmationProbability: 0,
  dropProbability: 0,
  landedFailureProbability: 0,
  priceDriftBpsPerSqrtSecond: 0,
  adverseDriftBps: 0,
  impactModelErrorFactor: 0,
  liquidityWithdrawalProbability: 0,
  feeSpikeProbability: 0,
  rollbackProbability: 0,
};

describe("paper fill model", () => {
  it("is deterministic per order attempt", () => {
    expect(simulateExecution(input, DEFAULT_FILL_MODEL)).toEqual(simulateExecution(input, DEFAULT_FILL_MODEL));
    expect(simulateExecution({ ...input, attemptNo: 2 }, DEFAULT_FILL_MODEL).seed).not.toBe(simulateExecution(input, DEFAULT_FILL_MODEL).seed);
  });

  it("does not double count costs already in the quote", () => {
    const s = simulateExecution(input, quiet);
    expect(s.outcome).toBe("LANDED_SUCCESS");
    expect(s.fillOutRaw).toBe("1000000000");
    expect(s.networkFeeLamports).toBe("25000");
  });

  it("refuses to submit when the fee would exceed the cap", () => {
    const s = simulateExecution(input, { ...quiet, feeSpikeProbability: 1, feeSpikeMultiplier: 20 });
    expect(s.outcome).toBe("NOT_SUBMITTED_FEE_LIMIT");
  });

  it("fails on chain when liquidity is pulled before landing, and the fee is still spent", () => {
    const s = simulateExecution(input, { ...quiet, liquidityWithdrawalProbability: 1 });
    expect(s).toMatchObject({ outcome: "LANDED_FAILED", failureReason: "LIQUIDITY_WITHDRAWN" });
    expect(chainViewAt(s, new Date(T0.getTime() + 2_000))).toEqual({ status: "FAILED", feeLamports: 25_000n, reason: "LIQUIDITY_WITHDRAWN" });
  });

  it("caps favourable price moves", () => {
    for (let i = 0; i < 200; i++) {
      const s = simulateExecution({ ...input, orderId: `o-${i}` }, { ...quiet, priceDriftBpsPerSqrtSecond: 500, adverseDriftBps: 0 });
      if (s.fillOutRaw) expect(BigInt(s.fillOutRaw)).toBeLessThanOrEqual(1_005_000_000n);
    }
  });

  it("is conservative on average under the default model", () => {
    let total = 0n;
    let n = 0n;
    for (let i = 0; i < 1_000; i++) {
      const s = simulateExecution({ ...input, orderId: `avg-${i}`, minOutRaw: 0n }, DEFAULT_FILL_MODEL);
      if (s.fillOutRaw) {
        total += BigInt(s.fillOutRaw);
        n++;
      }
    }
    expect(n).toBeGreaterThan(800n);
    expect(total / n).toBeLessThan(input.quoteOutRaw);
  });

  it("exposes the lifecycle over time: pending, confirmed, finalized", () => {
    const s = simulateExecution(input, quiet);
    expect(chainViewAt(s, new Date(T0.getTime() + 500))).toEqual({ status: "NOT_FOUND", expired: false });
    expect(chainViewAt(s, new Date(T0.getTime() + 2_000))).toEqual({ status: "CONFIRMED" });
    expect(chainViewAt(s, new Date(T0.getTime() + 20_000))).toEqual({ status: "FINALIZED", fillOutRaw: 1_000_000_000n, feeLamports: 25_000n });
  });

  it("dropped transactions are only provably failed after expiry", () => {
    const s = simulateExecution(input, { ...quiet, dropProbability: 1 });
    expect(chainViewAt(s, new Date(T0.getTime() + 60_000))).toEqual({ status: "NOT_FOUND", expired: false });
    expect(chainViewAt(s, new Date(T0.getTime() + 90_000))).toEqual({ status: "NOT_FOUND", expired: true });
  });
});
