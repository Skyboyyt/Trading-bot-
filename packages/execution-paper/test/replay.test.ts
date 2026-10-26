import { describe, expect, it } from "vitest";
import { MINUTE_MS } from "@tb/domain";
import { PAPER_ILLUSTRATIVE_POLICY } from "@tb/risk";
import { breakoutRetestPattern, DEFAULT_BREAKOUT_RETEST_PARAMS as P, syntheticCandles, type StrategyCandle } from "@tb/strategy";
import { DEFAULT_FILL_MODEL, DEFAULT_QUOTE_MODEL, runExperiment, runReplay, type ReplayConfig } from "../src/index.ts";

const START = new Date("2026-03-01T00:00:00Z");
const quietModel = { ...DEFAULT_FILL_MODEL, dropProbability: 0, landedFailureProbability: 0, feeSpikeProbability: 0, rollbackProbability: 0, liquidityWithdrawalProbability: 0 };

function patternThenTrend(level = "0.00002"): StrategyCandle[] {
  const base = breakoutRetestPattern({ start: START, baseBars: 70, level });
  const last = base[base.length - 1]!;
  const tail = syntheticCandles({ seed: 4, start: last.closeTime, minutes: 180, startPrice: last.close.toFixed(), volBps: 25, driftBps: 6 });
  return [...base, ...tail];
}

const config = (candles: StrategyCandle[], over: Partial<ReplayConfig> = {}): ReplayConfig => ({
  tokens: [{ mint: "Synth1111111111111111111111111111111111111", decimals: 6, candles }],
  params: P,
  policy: PAPER_ILLUSTRATIVE_POLICY,
  model: quietModel,
  quoteModel: DEFAULT_QUOTE_MODEL,
  initialCashRaw: 1_000_000_000n,
  initialSolLamports: 100_000_000n,
  solPriceRaw: 150_000_000n,
  from: START,
  to: new Date(START.getTime() + 250 * MINUTE_MS),
  ...over,
});

describe("replay", () => {
  it("trades the synthetic setup and reports complete metrics", () => {
    const r = runReplay(config(patternThenTrend()));
    expect(r.metrics.signals).toBeGreaterThanOrEqual(1);
    expect(r.metrics.trades).toBeGreaterThanOrEqual(1);
    expect(r.trades[0]!.openedAt > new Date(START.getTime() + 73 * MINUTE_MS).toISOString()).toBe(true);
    expect(r.metrics.cashReturnBps).toBe(0);
    expect(r.metrics.buyAndHoldReturnBps).not.toBeNull();
    expect(BigInt(r.metrics.endEquityRaw) - BigInt(r.metrics.startEquityRaw)).toBe(BigInt(r.metrics.totalPnlRaw));
  });

  it("is deterministic", () => {
    const candles = patternThenTrend();
    expect(runReplay(config(candles, { model: DEFAULT_FILL_MODEL }))).toEqual(runReplay(config(candles, { model: DEFAULT_FILL_MODEL })));
  });

  it("has no look-ahead: removing future candles never changes earlier decisions", () => {
    const candles = syntheticCandles({ seed: 21, start: START, minutes: 900, startPrice: "0.0004", volBps: 60, driftBps: 2 });
    const cut = new Date(START.getTime() + 500 * MINUTE_MS);
    const full = runReplay(config(candles, { to: new Date(START.getTime() + 900 * MINUTE_MS) }));
    const truncated = runReplay(config(candles.filter((c) => c.openTime < cut), { to: new Date(START.getTime() + 900 * MINUTE_MS) }));
    const closedBefore = (r: typeof full) => r.trades.filter((t) => t.closedAt < cut.toISOString());
    expect(closedBefore(truncated)).toEqual(closedBefore(full));
    const curveBefore = (r: typeof full) => r.equityCurve.filter((p) => p.at < cut.toISOString());
    expect(curveBefore(truncated)).toEqual(curveBefore(full));
  });

  it("values a rugged position at what it can actually be sold for", () => {
    const base = patternThenTrend();
    const crash = base.map((c, i) => (i > 80 ? { ...c, open: c.open.mul("0.01"), high: c.high.mul("0.01"), low: c.low.mul("0.01"), close: c.close.mul("0.01") } : c));
    const r = runReplay(config(crash));
    expect(BigInt(r.metrics.totalPnlRaw)).toBeLessThan(0n);
    expect(r.metrics.maxDrawdownBps).toBeGreaterThan(0);
  });
});

describe("chronological experiment", () => {
  it("records every parameter set, selects on validation only and runs the test once", () => {
    const tokens = [1, 2, 3].map((seed) => ({
      mint: `Synth${seed}`.padEnd(40, "1"),
      decimals: 6,
      candles: syntheticCandles({ seed, start: START, minutes: 1_500, startPrice: "0.0003", volBps: 55, driftBps: seed - 2 }),
    }));
    const grid = [P, { ...P, minBreakoutBps: 60 }, { ...P, volumeFilter: { ...P.volumeFilter, enabled: false } }];
    const report = runExperiment({
      tokens, grid, policy: PAPER_ILLUSTRATIVE_POLICY, model: DEFAULT_FILL_MODEL, quoteModel: DEFAULT_QUOTE_MODEL,
      initialCashRaw: 1_000_000_000n, initialSolLamports: 100_000_000n, solPriceRaw: 150_000_000n,
      from: START, to: new Date(START.getTime() + 1_500 * MINUTE_MS), trainFraction: 0.6, validationFraction: 0.2,
      datasetTag: "synthetic", datasetVersion: "synthetic-test",
    });
    expect(report.label).toMatch(/SYNTHETIC/);
    expect(report.trials.filter((t) => t.split === "train")).toHaveLength(3);
    expect(report.trials.filter((t) => t.split === "validation")).toHaveLength(3);
    expect(report.trials.filter((t) => t.split === "test").length).toBeLessThanOrEqual(1);
    expect(report.splits.train[1]).toBe(report.splits.validation[0]);
    expect(report.splits.validation[1]).toBe(report.splits.test[0]);
    expect(report.limitations.join(" ")).toMatch(/win rate can still lose/);
  });
});
