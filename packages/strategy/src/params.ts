import { z } from "zod";
import { sha256Hex, stableStringify } from "@tb/domain";

export const STRATEGY_NAME = "breakout-retest-v1";

const bps = z.number().int().min(0).max(10_000);
const positiveDecimal = z.string().regex(/^\d+(\.\d+)?$/);

export const breakoutRetestParamsSchema = z
  .object({
    /** Bars used for the preceding high; the breakout candle itself is excluded. */
    breakoutLookback: z.number().int().min(5).max(500),
    /** Closed candles required before any evaluation. */
    warmupBars: z.number().int().min(10).max(2_000),
    /** Breakout close must exceed the preceding high by at least this much. */
    minBreakoutBps: bps,
    /** The retest and confirmation must happen within this many bars after the breakout. */
    retestWindowBars: z.number().int().min(1).max(100),
    /** A retest is a low within this distance of the breakout level. */
    retestToleranceBps: bps,
    /** A close further than this below the level invalidates the setup. */
    maxPenetrationBps: bps,
    /** Confirming candle must close at least this far above the level, and above its open. */
    confirmCloseAboveBps: bps,
    volumeFilter: z
      .object({
        enabled: z.boolean(),
        lookback: z.number().int().min(3).max(500),
        /** Breakout volume must be at least this multiple of the average of the lookback bars. */
        minMultiple: positiveDecimal,
      })
      .strict(),
    /** Maximum missing one-minute bars tolerated inside the evaluated window. */
    maxGapBars: z.number().int().min(0).max(100),
    /** Signals expire this long after the confirming candle closed. */
    signalTtlMs: z.number().int().min(5_000).max(10 * 60_000),
    /** The newest closed candle must be at most this old at decision time. */
    maxCandleAgeMs: z.number().int().min(60_000).max(30 * 60_000),
    exit: z
      .object({
        takeProfitBps: bps,
        stopLossBps: bps,
        maxHoldMinutes: z.number().int().min(1).max(7 * 24 * 60),
        /** Exit when value falls this far below its peak since entry (0 disables). */
        trailingStopBps: bps,
      })
      .strict(),
  })
  .strict()
  .refine((p) => p.warmupBars >= p.breakoutLookback + p.retestWindowBars + 1, {
    message: "warmupBars must cover breakoutLookback + retestWindowBars + 1",
  })
  .refine((p) => !p.volumeFilter.enabled || p.warmupBars >= p.volumeFilter.lookback + p.retestWindowBars + 1, {
    message: "warmupBars must cover the volume lookback",
  });

export type BreakoutRetestParams = z.infer<typeof breakoutRetestParamsSchema>;

/** Starting parameters for research. Not tuned, and not evidence of profitability. */
export const DEFAULT_BREAKOUT_RETEST_PARAMS: BreakoutRetestParams = {
  breakoutLookback: 30,
  warmupBars: 60,
  minBreakoutBps: 30,
  retestWindowBars: 10,
  retestToleranceBps: 60,
  maxPenetrationBps: 120,
  confirmCloseAboveBps: 15,
  volumeFilter: { enabled: true, lookback: 20, minMultiple: "1.5" },
  maxGapBars: 3,
  signalTtlMs: 90_000,
  maxCandleAgeMs: 180_000,
  exit: { takeProfitBps: 800, stopLossBps: 400, maxHoldMinutes: 120, trailingStopBps: 0 },
};

export function parseParams(input: unknown): BreakoutRetestParams {
  return breakoutRetestParamsSchema.parse(input);
}

export function paramsHash(params: BreakoutRetestParams): string {
  return sha256Hex(stableStringify(params)).slice(0, 16);
}

/** Version string recorded on every signal, order and position: name@paramsHash. */
export function strategyVersionTag(params: BreakoutRetestParams): string {
  return `${STRATEGY_NAME}@${paramsHash(params)}`;
}
