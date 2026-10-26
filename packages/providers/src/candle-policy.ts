/**
 * Closed-candle and late-data policy (see docs/data-policy.md).
 *
 *  1. Only closed candles are stored: a one-minute candle is closed once
 *     receivedAt >= closeTime + graceMs. The provider may still be updating the current minute.
 *  2. First observation wins. A stored candle's values never change; if a later fetch reports
 *     different values for the same minute, that revision is recorded as an observation and
 *     counted, but strategies keep using what was known at the time.
 *  3. `observedAt` is when we first stored the candle. Decisions at time T only use candles with
 *     observedAt <= T, so backfilled history can never leak into an earlier decision.
 *  4. Missing minutes are not filled in. Gaps reduce coverage and can block a signal.
 */
import type { Candle } from "./types.ts";

export const DEFAULT_CANDLE_GRACE_MS = 90_000;

export function closedCandles(candles: readonly Candle[], receivedAt: Date, graceMs = DEFAULT_CANDLE_GRACE_MS): Candle[] {
  const cutoff = receivedAt.getTime() - graceMs;
  return candles.filter((c) => c.closeTime.getTime() <= cutoff);
}

export function sameCandleValues(a: Pick<Candle, "open" | "high" | "low" | "close" | "volumeUsd">, b: Pick<Candle, "open" | "high" | "low" | "close" | "volumeUsd">): boolean {
  const vol = (a.volumeUsd === null && b.volumeUsd === null) || (a.volumeUsd !== null && b.volumeUsd !== null && a.volumeUsd.eq(b.volumeUsd));
  return a.open.eq(b.open) && a.high.eq(b.high) && a.low.eq(b.low) && a.close.eq(b.close) && vol;
}
