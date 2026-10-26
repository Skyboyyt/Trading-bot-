import { z } from "zod";
import { sha256Hex, stableStringify } from "@tb/domain";

const raw = z.string().regex(/^\d+$/, "must be an integer amount in base units");
const bps = z.number().int().min(0).max(10_000);

/**
 * Risk policy. There are deliberately no defaults in the schema: every value must be written
 * down explicitly, which is what a future LIVE policy will require. The PAPER illustration
 * below is a set of labelled simulation inputs, not a recommendation.
 */
export const riskPolicySchema = z
  .object({
    label: z.string().min(1),
    maxOrderNotionalRaw: raw,
    maxTokenExposureRaw: raw,
    maxAggregateExposureRaw: raw,
    maxConcurrentPositions: z.number().int().min(1).max(50),
    /** Pause entries once the UTC-day equity loss (realised + conservative unrealised) reaches this. */
    dailyLossPauseRaw: raw,
    /** Pause entries once drawdown from peak equity reaches this. */
    maxDrawdownBps: bps,
    maxQuoteAgeMs: z.number().int().min(1_000).max(120_000),
    maxDataAgeMs: z.number().int().min(10_000).max(30 * 60_000),
    maxEntryPriceImpactBps: bps,
    maxExitPriceImpactBps: bps,
    maxSlippageBps: bps,
    maxExitSlippageBps: bps,
    maxNetworkFeeLamports: raw,
    /** SOL that must remain after paying the fee of an entry, so exits can always be paid for. */
    minSolReserveLamports: raw,
    maxPendingOrders: z.number().int().min(1).max(20),
    recentErrorWindowMs: z.number().int().min(60_000),
    maxRecentExecutionErrors: z.number().int().min(0).max(100),
    /** How long an order may wait for execution before it is cancelled. */
    orderTtlMs: z.number().int().min(5_000).max(10 * 60_000),
  })
  .strict();

export type RiskPolicy = z.infer<typeof riskPolicySchema>;

export const PAPER_ILLUSTRATIVE_POLICY: RiskPolicy = {
  label: "PAPER illustrative policy: $1,000 virtual balance, simulation inputs only",
  maxOrderNotionalRaw: "10000000", // $10
  maxTokenExposureRaw: "10000000", // $10
  maxAggregateExposureRaw: "30000000", // $30
  maxConcurrentPositions: 3,
  dailyLossPauseRaw: "20000000", // $20
  maxDrawdownBps: 1_000,
  maxQuoteAgeMs: 10_000,
  maxDataAgeMs: 4 * 60_000,
  maxEntryPriceImpactBps: 200,
  maxExitPriceImpactBps: 1_500,
  maxSlippageBps: 100,
  maxExitSlippageBps: 300,
  maxNetworkFeeLamports: "200000",
  minSolReserveLamports: "20000000",
  maxPendingOrders: 3,
  recentErrorWindowMs: 15 * 60_000,
  maxRecentExecutionErrors: 3,
  orderTtlMs: 60_000,
};

export const PAPER_VIRTUAL_DEPOSIT_RAW = 1_000_000_000n; // $1,000 in USDC base units
export const PAPER_VIRTUAL_SOL_LAMPORTS = 100_000_000n; // 0.1 SOL for simulated fees

export function riskPolicyHash(p: RiskPolicy): string {
  return sha256Hex(stableStringify(p)).slice(0, 16);
}
