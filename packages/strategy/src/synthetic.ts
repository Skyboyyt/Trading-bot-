/**
 * SYNTHETIC candle generator for tests, scenario fixtures and the clearly labelled simulated
 * report. Nothing produced here is market data, and results computed on it say nothing about
 * real-world performance.
 */
import { Dec, MINUTE_MS, seededRng, type Dec as DecT } from "@tb/domain";
import type { StrategyCandle } from "./breakout-retest.ts";

export interface SyntheticSeriesOptions {
  seed: number;
  start: Date;
  minutes: number;
  startPrice: string;
  /** Per-minute volatility in basis points (standard deviation of returns). */
  volBps: number;
  /** Per-minute drift in basis points (can be negative). */
  driftBps?: number;
  baseVolumeUsd?: number;
  /** Fraction of minutes with no trades (no candle at all). */
  gapProbability?: number;
  /** Optional sudden crash: at this minute the price drops by `crashBps`. */
  crashAtMinute?: number;
  crashBps?: number;
  /** Delay between candle close and when it is "observed". */
  observeDelayMs?: number;
}

export function syntheticCandles(o: SyntheticSeriesOptions): StrategyCandle[] {
  const rng = seededRng(o.seed);
  const gauss = () => {
    const u = Math.max(rng.next(), 1e-12);
    const v = rng.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  let price = new Dec(o.startPrice);
  const out: StrategyCandle[] = [];
  for (let i = 0; i < o.minutes; i++) {
    const openTime = new Date(o.start.getTime() + i * MINUTE_MS);
    const open = price;
    let ret = ((o.driftBps ?? 0) + gauss() * o.volBps) / 10_000;
    if (o.crashAtMinute === i) ret = -(o.crashBps ?? 9_000) / 10_000;
    const close = clampPositive(open.mul(1 + ret));
    const wickUp = Math.abs(gauss()) * o.volBps * 0.5 / 10_000;
    const wickDown = Math.abs(gauss()) * o.volBps * 0.5 / 10_000;
    const high = Dec.max(open, close).mul(1 + wickUp);
    const low = clampPositive(Dec.min(open, close).mul(1 - wickDown));
    price = close;
    if (rng.next() < (o.gapProbability ?? 0)) continue;
    const volume = (o.baseVolumeUsd ?? 1_000) * (0.5 + rng.next() * (1 + Math.abs(ret) * 200));
    const closeTime = new Date(openTime.getTime() + MINUTE_MS);
    out.push({
      openTime,
      closeTime,
      open: round(open),
      high: round(high),
      low: round(low),
      close: round(close),
      volumeUsd: new Dec(volume.toFixed(2)),
      observedAt: new Date(closeTime.getTime() + (o.observeDelayMs ?? 90_000)),
    });
  }
  return out;
}

/**
 * Hand-shaped breakout → retest → confirmation pattern appended after a flat base. Used to test
 * that the strategy fires exactly when it should.
 */
export function breakoutRetestPattern(opts: { start: Date; baseBars: number; level: string; observeDelayMs?: number }): StrategyCandle[] {
  const level = new Dec(opts.level);
  const bars: { o: number; h: number; l: number; c: number; v: number }[] = [];
  // Flat base just under the level: highs touch at most the level.
  for (let i = 0; i < opts.baseBars; i++) {
    const wiggle = (i % 5) / 1000;
    bars.push({ o: 0.985 + wiggle, h: i === opts.baseBars - 10 ? 1.0 : 0.995, l: 0.98, c: 0.99 + wiggle / 2, v: 1_000 });
  }
  bars.push({ o: 0.995, h: 1.03, l: 0.99, c: 1.025, v: 4_000 }); // breakout
  bars.push({ o: 1.025, h: 1.03, l: 1.012, c: 1.018, v: 1_500 }); // drift back
  bars.push({ o: 1.018, h: 1.02, l: 1.002, c: 1.006, v: 1_200 }); // retest near the level
  bars.push({ o: 1.006, h: 1.03, l: 1.004, c: 1.026, v: 2_000 }); // confirmation
  return bars.map((b, i) => {
    const openTime = new Date(opts.start.getTime() + i * MINUTE_MS);
    const closeTime = new Date(openTime.getTime() + MINUTE_MS);
    return {
      openTime,
      closeTime,
      open: level.mul(b.o),
      high: level.mul(b.h),
      low: level.mul(b.l),
      close: level.mul(b.c),
      volumeUsd: new Dec(b.v),
      observedAt: new Date(closeTime.getTime() + (opts.observeDelayMs ?? 30_000)),
    };
  });
}

function clampPositive(v: DecT): DecT {
  const min = new Dec("1e-18");
  return v.lt(min) ? min : v;
}

function round(v: DecT): DecT {
  return v.toSignificantDigits(12);
}
