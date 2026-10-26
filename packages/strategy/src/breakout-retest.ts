/**
 * breakout-retest-v1
 *
 * Entry logic on closed one-minute candles only:
 *   1. Warm-up: at least `warmupBars` closed candles, with few missing minutes.
 *   2. Breakout: a candle B closes above the highest high of the `breakoutLookback` candles
 *      BEFORE it (B itself is excluded, so the level is never computed with future data).
 *   3. Retest: a later candle R (B < R <= L) trades back down to within the tolerance of that
 *      level without closing too far below it.
 *   4. Confirmation: the newest closed candle L closes above the level by the configured margin
 *      and above its own open. Only the first confirmation after a retest produces a signal.
 *   5. Volume filter (optional): the breakout candle's volume must exceed a multiple of the
 *      average of earlier candles. If any needed volume is missing, there is no signal.
 *
 * The output is a signal with evidence and an expiry. It never implies a fill price: the
 * executor must fetch a fresh quote after the signal, and the signal's closes are evidence only.
 * Inputs must only contain candles observed at or before `now` (enforced here as well).
 */
import { Dec, MINUTE_MS, type Dec as DecT } from "@tb/domain";
import { strategyVersionTag, type BreakoutRetestParams } from "./params.ts";

export interface StrategyCandle {
  openTime: Date;
  closeTime: Date;
  open: DecT;
  high: DecT;
  low: DecT;
  close: DecT;
  volumeUsd: DecT | null;
  /** When the system first stored this candle. */
  observedAt: Date;
}

export interface EntrySignal {
  side: "BUY";
  /** Close time of the confirming candle; deterministic, used in the idempotency key. */
  signalAt: Date;
  expiresAt: Date;
  strategyVersion: string;
  reason: string;
  evidence: {
    breakoutLevel: string;
    breakoutCandle: string;
    retestCandle: string;
    confirmCandle: string;
    breakoutClose: string;
    retestLow: string;
    confirmClose: string;
    breakoutVolumeUsd: string | null;
    averageVolumeUsd: string | null;
    candlesUsed: number;
    newestObservedAt: string;
  };
}

export type EntryEvaluation =
  | { kind: "SIGNAL"; signal: EntrySignal }
  | { kind: "NONE"; reason: string }
  | { kind: "UNKNOWN"; reason: string };

const bpsUp = (v: DecT, bps: number) => v.mul(new Dec(10_000 + bps)).div(10_000);
const bpsDown = (v: DecT, bps: number) => v.mul(new Dec(10_000 - bps)).div(10_000);

export function evaluateEntry(input: readonly StrategyCandle[], params: BreakoutRetestParams, now: Date): EntryEvaluation {
  // No look-ahead: drop anything not yet observed or not yet closed at decision time.
  const candles = input
    .filter((c) => c.observedAt.getTime() <= now.getTime() && c.closeTime.getTime() <= now.getTime())
    .slice()
    .sort((a, b) => a.openTime.getTime() - b.openTime.getTime());

  if (candles.length < params.warmupBars) {
    return { kind: "UNKNOWN", reason: `warm-up incomplete: ${candles.length}/${params.warmupBars} closed candles` };
  }
  const window = candles.slice(-params.warmupBars);
  const newest = window[window.length - 1]!;
  const age = now.getTime() - newest.closeTime.getTime();
  if (age > params.maxCandleAgeMs) {
    return { kind: "UNKNOWN", reason: `newest closed candle is ${Math.round(age / 1000)}s old` };
  }
  const spanMinutes = (newest.openTime.getTime() - window[0]!.openTime.getTime()) / MINUTE_MS + 1;
  const gaps = spanMinutes - window.length;
  if (gaps > params.maxGapBars) {
    return { kind: "UNKNOWN", reason: `${gaps} missing minutes in the evaluation window (max ${params.maxGapBars})` };
  }

  const L = window.length - 1;
  const confirm = window[L]!;
  // Most recent breakout first; the breakout must precede the confirming candle.
  for (let B = L - 1; B >= Math.max(params.breakoutLookback, L - params.retestWindowBars); B--) {
    const bar = window[B]!;
    const prior = window.slice(B - params.breakoutLookback, B);
    const level = prior.reduce((m, c) => (c.high.gt(m) ? c.high : m), prior[0]!.high);
    if (!bar.close.gte(bpsUp(level, params.minBreakoutBps))) continue;

    const after = window.slice(B + 1, L + 1);
    const floor = bpsDown(level, params.maxPenetrationBps);
    if (after.some((c) => c.close.lt(floor))) {
      return { kind: "NONE", reason: "breakout invalidated: a later candle closed below the level" };
    }
    const retestIdx = after.findIndex((c) => c.low.lte(bpsUp(level, params.retestToleranceBps)) && c.low.gte(floor));
    if (retestIdx === -1) return { kind: "NONE", reason: "breakout without a retest yet" };
    const R = B + 1 + retestIdx;

    const confirmLevel = bpsUp(level, params.confirmCloseAboveBps);
    const confirms = (c: StrategyCandle) => c.close.gte(confirmLevel) && c.close.gt(c.open);
    // Only the first confirmation after the retest counts; later ones would be repeats.
    for (let i = R; i < L; i++) if (confirms(window[i]!)) return { kind: "NONE", reason: "setup already confirmed on an earlier candle" };
    if (!confirms(confirm)) return { kind: "NONE", reason: "retest not yet confirmed" };

    let breakoutVolume: DecT | null = null;
    let avgVolume: DecT | null = null;
    if (params.volumeFilter.enabled) {
      const vols = window.slice(B - params.volumeFilter.lookback, B).map((c) => c.volumeUsd);
      breakoutVolume = bar.volumeUsd;
      if (breakoutVolume === null || vols.some((v) => v === null) || vols.length < params.volumeFilter.lookback) {
        return { kind: "UNKNOWN", reason: "volume filter enabled but real volume is missing" };
      }
      avgVolume = (vols as DecT[]).reduce((s, v) => s.plus(v), new Dec(0)).div(vols.length);
      if (breakoutVolume.lt(avgVolume.mul(params.volumeFilter.minMultiple))) {
        return { kind: "NONE", reason: "breakout volume below the required multiple" };
      }
    }

    const signalAt = confirm.closeTime;
    const expiresAt = new Date(signalAt.getTime() + params.signalTtlMs);
    if (now.getTime() > expiresAt.getTime()) return { kind: "NONE", reason: "signal expired before evaluation" };
    const newestObserved = window.reduce((m, c) => (c.observedAt > m ? c.observedAt : m), window[0]!.observedAt);
    return {
      kind: "SIGNAL",
      signal: {
        side: "BUY",
        signalAt,
        expiresAt,
        strategyVersion: strategyVersionTag(params),
        reason: `Breakout above ${level.toSignificantDigits(8).toFixed()} retested and confirmed`,
        evidence: {
          breakoutLevel: level.toFixed(),
          breakoutCandle: bar.openTime.toISOString(),
          retestCandle: window[R]!.openTime.toISOString(),
          confirmCandle: confirm.openTime.toISOString(),
          breakoutClose: bar.close.toFixed(),
          retestLow: window[R]!.low.toFixed(),
          confirmClose: confirm.close.toFixed(),
          breakoutVolumeUsd: breakoutVolume?.toFixed() ?? null,
          averageVolumeUsd: avgVolume?.toFixed() ?? null,
          candlesUsed: window.length,
          newestObservedAt: newestObserved.toISOString(),
        },
      },
    };
  }
  return { kind: "NONE", reason: "no breakout in the retest window" };
}

export type ExitReason = "STOP_LOSS" | "TAKE_PROFIT" | "TRAILING_STOP" | "TIME_EXIT";

export interface ExitInput {
  costBasisRaw: bigint;
  /** Conservative value: fresh exit quote output for the full position, or null if none. */
  exitValueRaw: bigint | null;
  peakValueRaw: bigint | null;
  openedAt: Date;
}

export type ExitEvaluation = { exit: true; reason: ExitReason; detail: string } | { exit: false; detail: string };

/**
 * Exit rules use the value we could actually sell for now (a fresh quote at full size),
 * not a candle price. With no exit quote, only the time exit can fire.
 */
export function evaluateExit(p: ExitInput, params: BreakoutRetestParams, now: Date): ExitEvaluation {
  const heldMin = (now.getTime() - p.openedAt.getTime()) / MINUTE_MS;
  if (p.exitValueRaw !== null && p.costBasisRaw > 0n) {
    const v = p.exitValueRaw;
    const c = p.costBasisRaw;
    if (v * 10_000n <= c * BigInt(10_000 - params.exit.stopLossBps)) {
      return { exit: true, reason: "STOP_LOSS", detail: `value ${v} <= stop at ${params.exit.stopLossBps} bps below cost ${c}` };
    }
    if (v * 10_000n >= c * BigInt(10_000 + params.exit.takeProfitBps)) {
      return { exit: true, reason: "TAKE_PROFIT", detail: `value ${v} >= target ${params.exit.takeProfitBps} bps above cost ${c}` };
    }
    if (params.exit.trailingStopBps > 0 && p.peakValueRaw !== null && p.peakValueRaw > c) {
      if (v * 10_000n <= p.peakValueRaw * BigInt(10_000 - params.exit.trailingStopBps)) {
        return { exit: true, reason: "TRAILING_STOP", detail: `value ${v} fell ${params.exit.trailingStopBps} bps below peak ${p.peakValueRaw}` };
      }
    }
  }
  if (heldMin >= params.exit.maxHoldMinutes) {
    return { exit: true, reason: "TIME_EXIT", detail: `held ${Math.floor(heldMin)} minutes` };
  }
  return { exit: false, detail: p.exitValueRaw === null ? "no exit quote; waiting" : "within limits" };
}
