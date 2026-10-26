/**
 * Conservative valuation.
 *
 * Open positions are marked at the quote for selling the ENTIRE position now (exit quote at
 * actual size, net of fees). If no fresh exit route exists the mark is zero: a token that cannot
 * be sold is worth nothing to this portfolio. Drawdown is measured from peak equity.
 */
import { ratioBps } from "@tb/domain";

export interface PositionMark {
  mint: string;
  quantityRaw: bigint;
  costBasisRaw: bigint;
  /** null = no usable exit quote; valued at zero. */
  exitValueRaw: bigint | null;
}

export interface Valuation {
  cashRaw: bigint;
  positionsMarkRaw: bigint;
  equityRaw: bigint;
  unrealizedPnlRaw: bigint;
  exposureRaw: bigint;
  unmarkedPositions: number;
}

export function valuePortfolio(cashRaw: bigint, marks: readonly PositionMark[]): Valuation {
  let positionsMarkRaw = 0n;
  let costRaw = 0n;
  let unmarkedPositions = 0;
  for (const m of marks) {
    const v = m.exitValueRaw ?? 0n;
    if (m.exitValueRaw === null) unmarkedPositions++;
    positionsMarkRaw += v;
    costRaw += m.costBasisRaw;
  }
  return {
    cashRaw,
    positionsMarkRaw,
    equityRaw: cashRaw + positionsMarkRaw,
    unrealizedPnlRaw: positionsMarkRaw - costRaw,
    // Exposure is measured at cost, which is what can be lost if every token goes to zero.
    exposureRaw: costRaw,
    unmarkedPositions,
  };
}

/** Drawdown from peak in basis points (rounded up, i.e. conservatively). */
export function drawdownBps(equityRaw: bigint, peakEquityRaw: bigint): number {
  if (peakEquityRaw <= 0n || equityRaw >= peakEquityRaw) return 0;
  return Number(ratioBps(peakEquityRaw - equityRaw, peakEquityRaw, "ceil"));
}
