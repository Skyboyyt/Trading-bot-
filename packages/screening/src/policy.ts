import { z } from "zod";
import { sha256Hex, stableStringify } from "@tb/domain";

export const SCREENER_VERSION = "screen-v1";

const decimalString = z.string().regex(/^\d+(\.\d+)?$/, "must be a non-negative decimal string");
const bps = z.number().int().min(0).max(10_000);

export const screeningPolicySchema = z
  .object({
    minPoolAgeMinutes: z.number().int().min(0),
    minClosedCandles: z.number().int().min(0),
    minLiquidityUsd: decimalString,
    liquidityLookbackMinutes: z.number().int().min(1),
    liquidityLookbackToleranceMinutes: z.number().int().min(1),
    maxLiquidityDropBps: bps,
    maxTop10WalletBps: bps,
    maxSingleWalletBps: bps,
    maxUnverifiedHolderBps: bps,
    maxEntryPriceImpactBps: bps,
    maxExitPriceImpactBps: bps,
    maxRoundTripCostBps: bps,
    maxQuoteAgeMs: z.number().int().min(1_000),
    maxObservationAgeMs: z.number().int().min(1_000),
    suspiciousMinBuys: z.number().int().min(1),
    assessmentTtlMs: z.number().int().min(10_000),
  })
  .strict();

export type ScreeningPolicy = z.infer<typeof screeningPolicySchema>;

/**
 * Default thresholds. These are starting points for research, not evidence that a token that
 * passes them is safe. Every assessment stores the exact policy it used.
 */
export const DEFAULT_SCREENING_POLICY: ScreeningPolicy = {
  minPoolAgeMinutes: 720,
  minClosedCandles: 120,
  minLiquidityUsd: "50000",
  liquidityLookbackMinutes: 60,
  liquidityLookbackToleranceMinutes: 20,
  maxLiquidityDropBps: 3_000,
  maxTop10WalletBps: 3_000,
  maxSingleWalletBps: 1_000,
  maxUnverifiedHolderBps: 2_000,
  maxEntryPriceImpactBps: 200,
  maxExitPriceImpactBps: 300,
  maxRoundTripCostBps: 500,
  maxQuoteAgeMs: 15_000,
  maxObservationAgeMs: 5 * 60_000,
  suspiciousMinBuys: 20,
  assessmentTtlMs: 10 * 60_000,
};

export function policyHash(policy: ScreeningPolicy): string {
  return sha256Hex(stableStringify(policy)).slice(0, 16);
}
