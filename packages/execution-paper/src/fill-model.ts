/**
 * Paper fill model (approximate, deterministic).
 *
 * A quote is not a fill. Between the quote and the moment a transaction would land, the price
 * moves, the route's impact estimate can be wrong, liquidity can be pulled, fees can spike and
 * transactions can be dropped, fail on chain, land late or be rolled back. This model applies
 * those effects on top of the quote, seeded per order attempt so every run is reproducible.
 *
 * It never double counts: the quote's `outAmount` already includes the route's price impact and
 * platform fee at quote time, so only changes AFTER the quote are applied here.
 *
 * All fills produced by this model are labelled approximate. They are a simulation and say
 * nothing certain about what a real transaction would have received.
 */
import { z } from "zod";
import { seedFromString, seededRng, type Rng } from "@tb/domain";

export const FILL_MODEL_VERSION = "paper-fill-v1";

const prob = z.number().min(0).max(1);
export const fillModelSchema = z
  .object({
    seed: z.number().int(),
    latencyMs: z.object({ min: z.number().int().min(0), max: z.number().int().min(0) }).strict(),
    confirmTimeoutMs: z.number().int().min(1_000),
    blockhashExpiryMs: z.number().int().min(10_000),
    lateConfirmationProbability: prob,
    lateConfirmationExtraMs: z.object({ min: z.number().int().min(0), max: z.number().int().min(0) }).strict(),
    dropProbability: prob,
    landedFailureProbability: prob,
    priceDriftBpsPerSqrtSecond: z.number().min(0),
    adverseDriftBps: z.number().min(0),
    impactModelErrorFactor: z.number().min(0),
    liquidityWithdrawalProbability: prob,
    liquidityWithdrawalLossBps: z.number().int().min(0).max(10_000),
    signatureFeeLamports: z.number().int().min(0),
    defaultPriorityFeeLamports: z.number().int().min(0),
    feeSpikeProbability: prob,
    feeSpikeMultiplier: z.number().min(1),
    finalizationDelayMs: z.number().int().min(0),
    rollbackProbability: prob,
    rollbackDetectMs: z.number().int().min(0),
    relandProbability: prob,
    retryDelayMs: z.number().int().min(0),
  })
  .strict();

export type FillModelParams = z.infer<typeof fillModelSchema>;

/** Conservative defaults chosen to make paper results harder, not easier, to look good. */
export const DEFAULT_FILL_MODEL: FillModelParams = {
  seed: 1,
  latencyMs: { min: 600, max: 4_000 },
  confirmTimeoutMs: 30_000,
  blockhashExpiryMs: 90_000,
  lateConfirmationProbability: 0.02,
  lateConfirmationExtraMs: { min: 30_000, max: 60_000 },
  dropProbability: 0.03,
  landedFailureProbability: 0.02,
  priceDriftBpsPerSqrtSecond: 15,
  adverseDriftBps: 10,
  impactModelErrorFactor: 0.5,
  liquidityWithdrawalProbability: 0.002,
  liquidityWithdrawalLossBps: 9_000,
  signatureFeeLamports: 5_000,
  defaultPriorityFeeLamports: 50_000,
  feeSpikeProbability: 0.03,
  feeSpikeMultiplier: 6,
  finalizationDelayMs: 13_000,
  rollbackProbability: 0.001,
  rollbackDetectMs: 4_000,
  relandProbability: 0.5,
  retryDelayMs: 5_000,
};

export interface SimulationInput {
  orderId: string;
  attemptNo: number;
  quoteOutRaw: bigint;
  minOutRaw: bigint;
  quoteImpactBps: number;
  quotePriorityFeeLamports: bigint | null;
  quoteReceivedAt: Date;
  submittedAt: Date;
  maxNetworkFeeLamports: bigint;
}

export type SimulatedOutcome = "LANDED_SUCCESS" | "LANDED_FAILED" | "DROPPED" | "NOT_SUBMITTED_FEE_LIMIT";

export interface Simulation {
  modelVersion: string;
  seed: number;
  outcome: SimulatedOutcome;
  failureReason: "SLIPPAGE_EXCEEDED" | "PROGRAM_ERROR" | "LIQUIDITY_WITHDRAWN" | "FEE_ABOVE_LIMIT" | "BLOCKHASH_EXPIRED" | null;
  networkFeeLamports: string;
  feeSpiked: boolean;
  submittedAt: string;
  landedAt: string | null;
  finalizedAt: string | null;
  rolledBack: boolean;
  rollbackAt: string | null;
  relandAt: string | null;
  expiresAt: string;
  fillOutRaw: string | null;
  driftBps: number;
  extraImpactBps: number;
  liquidityWithdrawn: boolean;
}

export function simulateExecution(input: SimulationInput, m: FillModelParams): Simulation {
  const seed = (seedFromString(`${input.orderId}:${input.attemptNo}`) ^ m.seed) >>> 0;
  const rng = seededRng(seed);
  const between = (lo: number, hi: number) => lo + rng.next() * Math.max(0, hi - lo);

  // Fees first: if the fee needed to land would exceed the order's cap, we do not submit.
  const priority = input.quotePriorityFeeLamports ?? BigInt(m.defaultPriorityFeeLamports);
  const feeSpiked = rng.next() < m.feeSpikeProbability;
  const priorityFee = feeSpiked ? (priority * BigInt(Math.round(m.feeSpikeMultiplier * 100))) / 100n : priority;
  const fee = BigInt(m.signatureFeeLamports) + priorityFee;
  const submittedMs = input.submittedAt.getTime();
  const base: Omit<Simulation, "outcome" | "failureReason" | "landedAt" | "finalizedAt" | "fillOutRaw"> = {
    modelVersion: FILL_MODEL_VERSION,
    seed,
    networkFeeLamports: fee.toString(),
    feeSpiked,
    submittedAt: input.submittedAt.toISOString(),
    rolledBack: false,
    rollbackAt: null,
    relandAt: null,
    expiresAt: new Date(submittedMs + m.blockhashExpiryMs).toISOString(),
    driftBps: 0,
    extraImpactBps: 0,
    liquidityWithdrawn: false,
  };
  if (fee > input.maxNetworkFeeLamports) {
    return { ...base, outcome: "NOT_SUBMITTED_FEE_LIMIT", failureReason: "FEE_ABOVE_LIMIT", landedAt: null, finalizedAt: null, fillOutRaw: null };
  }

  let latency = between(m.latencyMs.min, m.latencyMs.max);
  if (rng.next() < m.lateConfirmationProbability) latency += between(m.lateConfirmationExtraMs.min, m.lateConfirmationExtraMs.max);
  const landedMs = submittedMs + Math.round(latency);

  if (rng.next() < m.dropProbability || landedMs >= submittedMs + m.blockhashExpiryMs) {
    return { ...base, outcome: "DROPPED", failureReason: "BLOCKHASH_EXPIRED", landedAt: null, finalizedAt: null, fillOutRaw: null };
  }

  // Price movement from quote time to landing, plus adverse selection.
  const elapsedSec = Math.max(0, (landedMs - input.quoteReceivedAt.getTime()) / 1000);
  const drift = gaussian(rng) * m.priceDriftBpsPerSqrtSecond * Math.sqrt(elapsedSec) - m.adverseDriftBps;
  // The route's impact estimate can be optimistic; never assume it is better than quoted.
  const extraImpact = input.quoteImpactBps * m.impactModelErrorFactor * rng.next();
  const withdrawn = rng.next() < m.liquidityWithdrawalProbability;
  // Positive = worse than quoted. Favourable moves are capped at 0.5% so luck cannot dominate.
  const netBps = Math.max(-50, Math.min(10_000, Math.round(-drift + extraImpact + (withdrawn ? m.liquidityWithdrawalLossBps : 0))));
  const fillOut = (input.quoteOutRaw * BigInt(10_000 - netBps)) / 10_000n;

  const rolledBack = rng.next() < m.rollbackProbability;
  const reland = rolledBack && rng.next() < m.relandProbability;
  const common = {
    ...base,
    driftBps: Math.round(drift),
    extraImpactBps: Math.round(extraImpact),
    liquidityWithdrawn: withdrawn,
    landedAt: new Date(landedMs).toISOString(),
  };

  if (fillOut < input.minOutRaw) {
    return { ...common, outcome: "LANDED_FAILED", failureReason: withdrawn ? "LIQUIDITY_WITHDRAWN" : "SLIPPAGE_EXCEEDED", finalizedAt: new Date(landedMs + m.finalizationDelayMs).toISOString(), fillOutRaw: null };
  }
  if (rng.next() < m.landedFailureProbability) {
    return { ...common, outcome: "LANDED_FAILED", failureReason: "PROGRAM_ERROR", finalizedAt: new Date(landedMs + m.finalizationDelayMs).toISOString(), fillOutRaw: null };
  }
  if (rolledBack) {
    const rollbackAt = landedMs + m.rollbackDetectMs;
    const relandMs = reland ? rollbackAt + Math.round(between(1_000, 10_000)) : null;
    if (!reland || relandMs === null || relandMs >= submittedMs + m.blockhashExpiryMs) {
      return { ...common, outcome: "DROPPED", failureReason: "BLOCKHASH_EXPIRED", rolledBack: true, rollbackAt: new Date(rollbackAt).toISOString(), finalizedAt: null, fillOutRaw: null };
    }
    return {
      ...common,
      outcome: "LANDED_SUCCESS",
      failureReason: null,
      rolledBack: true,
      rollbackAt: new Date(rollbackAt).toISOString(),
      relandAt: new Date(relandMs).toISOString(),
      finalizedAt: new Date(relandMs + m.finalizationDelayMs).toISOString(),
      fillOutRaw: fillOut.toString(),
    };
  }
  return { ...common, outcome: "LANDED_SUCCESS", failureReason: null, finalizedAt: new Date(landedMs + m.finalizationDelayMs).toISOString(), fillOutRaw: fillOut.toString() };
}

export type ChainView =
  | { status: "NOT_FOUND"; expired: boolean }
  | { status: "CONFIRMED" }
  | { status: "FINALIZED"; fillOutRaw: bigint; feeLamports: bigint }
  | { status: "FAILED"; feeLamports: bigint; reason: string };

/**
 * What a chain observer would see for this simulated transaction at time `now`. This is the
 * paper counterpart of querying signature statuses on a real network.
 */
export function chainViewAt(sim: Simulation, now: Date): ChainView {
  const t = now.getTime();
  const expired = t >= Date.parse(sim.expiresAt);
  if (sim.outcome === "NOT_SUBMITTED_FEE_LIMIT") return { status: "NOT_FOUND", expired: true };
  if (sim.outcome === "DROPPED") {
    // A rolled-back transaction is briefly visible before it disappears.
    if (sim.rolledBack && sim.landedAt && sim.rollbackAt && t >= Date.parse(sim.landedAt) && t < Date.parse(sim.rollbackAt)) return { status: "CONFIRMED" };
    return { status: "NOT_FOUND", expired };
  }
  const landed = sim.landedAt ? Date.parse(sim.landedAt) : Infinity;
  if (t < landed) return { status: "NOT_FOUND", expired };
  if (sim.rolledBack && sim.rollbackAt && sim.relandAt) {
    if (t < Date.parse(sim.rollbackAt)) return { status: "CONFIRMED" };
    if (t < Date.parse(sim.relandAt)) return { status: "NOT_FOUND", expired };
  }
  const fee = BigInt(sim.networkFeeLamports);
  const finalized = sim.finalizedAt ? t >= Date.parse(sim.finalizedAt) : false;
  // A transaction that landed with an error is visible as failed as soon as it lands; its fee is spent.
  if (sim.outcome === "LANDED_FAILED") return { status: "FAILED", feeLamports: fee, reason: sim.failureReason ?? "failed" };
  if (!finalized) return { status: "CONFIRMED" };
  return { status: "FINALIZED", fillOutRaw: BigInt(sim.fillOutRaw ?? "0"), feeLamports: fee };
}

function gaussian(rng: Rng): number {
  const u = Math.max(rng.next(), 1e-12);
  const v = rng.next();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
