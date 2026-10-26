import { describe, expect, it } from "vitest";
import { Dec, MINUTE_MS } from "@tb/domain";
import {
  breakoutRetestPattern,
  DEFAULT_BREAKOUT_RETEST_PARAMS as P,
  evaluateEntry,
  evaluateExit,
  parseParams,
  strategyVersionTag,
  syntheticCandles,
  type StrategyCandle,
} from "../src/index.ts";

const START = new Date("2026-03-01T00:00:00Z");
const pattern = () => breakoutRetestPattern({ start: START, baseBars: 70, level: "0.00002" });
const decisionTime = (c: StrategyCandle[]) => new Date(c[c.length - 1]!.observedAt.getTime() + 1_000);

describe("breakout-retest-v1 entry", () => {
  it("signals on the confirming candle with evidence and an expiry", () => {
    const candles = pattern();
    const r = evaluateEntry(candles, P, decisionTime(candles));
    expect(r.kind).toBe("SIGNAL");
    if (r.kind !== "SIGNAL") return;
    const last = candles[candles.length - 1]!;
    expect(r.signal.signalAt).toEqual(last.closeTime);
    expect(r.signal.expiresAt.getTime() - last.closeTime.getTime()).toBe(P.signalTtlMs);
    expect(r.signal.strategyVersion).toBe(strategyVersionTag(P));
    expect(r.signal.evidence.breakoutLevel).toBe(new Dec("0.00002").toFixed());
    expect(r.signal.evidence.breakoutVolumeUsd).toBe("4000");
  });

  it("does not use candles that were not yet observed (no look-ahead)", () => {
    const candles = pattern();
    const last = candles[candles.length - 1]!;
    const beforeObserved = new Date(last.observedAt.getTime() - 1);
    const r = evaluateEntry(candles, P, beforeObserved);
    expect(r.kind).not.toBe("SIGNAL");
  });

  it("never treats the breakout candle as part of its own level", () => {
    // If the breakout candle's high were included, the close could never exceed the level.
    const candles = pattern();
    const r = evaluateEntry(candles, P, decisionTime(candles));
    expect(r.kind === "SIGNAL" && new Dec(r.signal.evidence.breakoutClose).gt(r.signal.evidence.breakoutLevel)).toBe(true);
  });

  it("does not repeat the signal on the next candle", () => {
    const candles = pattern();
    const last = candles[candles.length - 1]!;
    const next: StrategyCandle = {
      ...last,
      openTime: last.closeTime,
      closeTime: new Date(last.closeTime.getTime() + MINUTE_MS),
      observedAt: new Date(last.observedAt.getTime() + MINUTE_MS),
      open: last.close,
      close: last.close.mul(1.002),
      high: last.close.mul(1.003),
    };
    const r = evaluateEntry([...candles, next], P, decisionTime([...candles, next]));
    expect(r).toMatchObject({ kind: "NONE", reason: expect.stringMatching(/already confirmed/) });
  });

  it("returns UNKNOWN during warm-up, on stale data and on large gaps", () => {
    const candles = pattern();
    expect(evaluateEntry(candles.slice(0, 20), P, decisionTime(candles)).kind).toBe("UNKNOWN");
    const late = new Date(candles[candles.length - 1]!.closeTime.getTime() + P.maxCandleAgeMs + 1);
    expect(evaluateEntry(candles, { ...P, signalTtlMs: 600_000 }, late)).toMatchObject({ kind: "UNKNOWN", reason: expect.stringMatching(/old/) });
    const gappy = candles.filter((_, i) => i % 9 !== 3);
    expect(evaluateEntry(gappy, P, decisionTime(candles))).toMatchObject({ kind: "UNKNOWN", reason: expect.stringMatching(/missing minutes/) });
  });

  it("requires real volume when the volume filter is on", () => {
    const candles = pattern().map((c, i) => (i === 50 ? { ...c, volumeUsd: null } : c));
    expect(evaluateEntry(candles, P, decisionTime(candles))).toMatchObject({ kind: "UNKNOWN", reason: expect.stringMatching(/volume/) });
    const off = { ...P, volumeFilter: { ...P.volumeFilter, enabled: false } };
    expect(evaluateEntry(candles, off, decisionTime(candles)).kind).toBe("SIGNAL");
  });

  it("rejects a breakout on weak volume", () => {
    const candles = pattern();
    const weak = candles.map((c, i) => (i === 70 ? { ...c, volumeUsd: new Dec(1_100) } : c));
    expect(evaluateEntry(weak, P, decisionTime(weak))).toMatchObject({ kind: "NONE", reason: expect.stringMatching(/volume/) });
  });

  it("is invalidated when price closes well below the level", () => {
    const candles = pattern();
    const broken = candles.map((c, i) => (i === 71 ? { ...c, close: c.close.mul(0.96), low: c.low.mul(0.95) } : c));
    expect(evaluateEntry(broken, P, decisionTime(broken))).toMatchObject({ kind: "NONE", reason: expect.stringMatching(/invalidated/) });
  });

  it("expires signals", () => {
    const candles = pattern();
    const late = new Date(candles[candles.length - 1]!.closeTime.getTime() + P.signalTtlMs + 1);
    expect(evaluateEntry(candles, P, late)).toMatchObject({ kind: "NONE", reason: expect.stringMatching(/expired/) });
  });

  it("is deterministic on synthetic random walks", () => {
    const candles = syntheticCandles({ seed: 9, start: START, minutes: 400, startPrice: "0.001", volBps: 40 });
    const run = () =>
      candles.map((c, i) => evaluateEntry(candles.slice(0, i + 1), P, new Date(c.observedAt.getTime() + 1)).kind).join(",");
    expect(run()).toBe(run());
  });
});

describe("breakout-retest-v1 exits", () => {
  const base = { costBasisRaw: 10_000_000n, peakValueRaw: null, openedAt: START };
  const at = (min: number) => new Date(START.getTime() + min * MINUTE_MS);

  it("fires stop loss, take profit, trailing stop and time exit", () => {
    expect(evaluateExit({ ...base, exitValueRaw: 9_600_000n }, P, at(5))).toMatchObject({ exit: true, reason: "STOP_LOSS" });
    expect(evaluateExit({ ...base, exitValueRaw: 10_800_000n }, P, at(5))).toMatchObject({ exit: true, reason: "TAKE_PROFIT" });
    expect(evaluateExit({ ...base, exitValueRaw: 10_100_000n }, P, at(5))).toMatchObject({ exit: false });
    const trailing = { ...P, exit: { ...P.exit, trailingStopBps: 300 } };
    expect(evaluateExit({ ...base, exitValueRaw: 10_250_000n, peakValueRaw: 10_600_000n }, trailing, at(5))).toMatchObject({ reason: "TRAILING_STOP" });
    expect(evaluateExit({ ...base, exitValueRaw: 10_000_000n }, P, at(P.exit.maxHoldMinutes))).toMatchObject({ reason: "TIME_EXIT" });
  });

  it("without an exit quote only the time exit can fire", () => {
    expect(evaluateExit({ ...base, exitValueRaw: null }, P, at(5))).toMatchObject({ exit: false, detail: expect.stringMatching(/no exit quote/) });
    expect(evaluateExit({ ...base, exitValueRaw: null }, P, at(P.exit.maxHoldMinutes + 1))).toMatchObject({ reason: "TIME_EXIT" });
  });
});

describe("parameters", () => {
  it("validates and versions parameters", () => {
    expect(() => parseParams({ ...P, warmupBars: 10 })).toThrow();
    expect(() => parseParams({ ...P, extra: 1 })).toThrow();
    expect(strategyVersionTag(P)).toBe(strategyVersionTag(parseParams(JSON.parse(JSON.stringify(P)))));
    expect(strategyVersionTag({ ...P, minBreakoutBps: 31 })).not.toBe(strategyVersionTag(P));
  });
});
