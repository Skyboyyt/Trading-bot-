/**
 * Portfolio snapshots: equity, P&L, fees, exposure and drawdown at a point in time.
 *
 * Equity = cash + conservative marks of open positions (exit quote at full size; zero when no
 * exit route exists). Realised P&L comes only from verified fills. Unrealised P&L is the
 * conservative mark minus remaining cost. Deposits are reported separately and never counted
 * as profit.
 */
import { desc, eq, inArray, and, sql } from "drizzle-orm";
import { newId, type TradingMode } from "@tb/domain";
import { dbRaw, portfolioSnapshots, positions, type DbOrTx } from "@tb/db";
import { readBalances } from "./balances.ts";
import { ledgerTotals } from "./rebuild.ts";
import { drawdownBps, valuePortfolio } from "./valuation.ts";

export interface SnapshotResult {
  id: string;
  equityRaw: bigint;
  peakEquityRaw: bigint;
  drawdownBps: number;
  realizedPnlRaw: bigint;
  unrealizedPnlRaw: bigint;
}

export async function takeSnapshot(
  tx: DbOrTx,
  input: { portfolioId: string; mode: TradingMode; baseMint: string; at: Date; infraCostsRaw?: bigint },
): Promise<SnapshotResult> {
  const balances = await readBalances(tx, input.portfolioId);
  if (!balances) throw new Error(`no balances for ${input.portfolioId}`);
  const open = await tx
    .select()
    .from(positions)
    .where(and(eq(positions.portfolioId, input.portfolioId), inArray(positions.status, ["OPEN", "CLOSING", "STRANDED"])));
  const valuation = valuePortfolio(
    balances.cashRaw,
    open.map((p) => ({
      mint: p.mint,
      quantityRaw: dbRaw(p.quantityRaw),
      costBasisRaw: dbRaw(p.costBasisRaw),
      exitValueRaw: p.markValueRaw === null ? null : dbRaw(p.markValueRaw),
    })),
  );
  const realized = await tx.execute<{ total: string | null }>(
    sql`select sum(realized_pnl_raw)::text as total from positions where portfolio_id = ${input.portfolioId}`,
  );
  const feeEstimate = await tx.execute<{ total: string | null }>(
    sql`select sum(network_fee_quote_estimate_raw)::text as total from fills where portfolio_id = ${input.portfolioId}`,
  );
  const totals = await ledgerTotals(tx, input.portfolioId, input.baseMint);
  const prev = (
    await tx.select().from(portfolioSnapshots).where(eq(portfolioSnapshots.portfolioId, input.portfolioId)).orderBy(desc(portfolioSnapshots.at)).limit(1)
  )[0];
  const prevPeak = prev ? dbRaw(prev.peakEquityRaw) : 0n;
  const peak = valuation.equityRaw > prevPeak ? valuation.equityRaw : prevPeak;
  const dd = drawdownBps(valuation.equityRaw, peak);
  const realizedRaw = dbRaw(realized[0]?.total ?? "0");
  const stranded = open.filter((p) => p.status === "STRANDED").length;
  const id = newId();
  await tx.insert(portfolioSnapshots).values({
    id,
    portfolioId: input.portfolioId,
    mode: input.mode,
    at: input.at,
    cashRaw: balances.cashRaw.toString(),
    reservedRaw: balances.reservedRaw.toString(),
    positionsMarkRaw: valuation.positionsMarkRaw.toString(),
    equityRaw: valuation.equityRaw.toString(),
    depositsRaw: (totals.depositsRaw - totals.withdrawalsRaw).toString(),
    realizedPnlRaw: realizedRaw.toString(),
    unrealizedPnlRaw: valuation.unrealizedPnlRaw.toString(),
    platformFeesRaw: totals.platformFeesQuoteRaw.toString(),
    networkFeesLamports: totals.networkFeesLamports.toString(),
    networkFeesQuoteEstimateRaw: dbRaw(feeEstimate[0]?.total ?? "0").toString(),
    infraCostsRaw: (input.infraCostsRaw ?? 0n).toString(),
    exposureRaw: valuation.exposureRaw.toString(),
    peakEquityRaw: peak.toString(),
    drawdownBps: dd,
    openPositions: open.length,
    strandedPositions: stranded,
    markQuality: valuation.unmarkedPositions > 0 ? "PARTIAL_ZERO_MARKED" : open.length > 0 ? "EXIT_QUOTES" : "CASH_ONLY",
  });
  return { id, equityRaw: valuation.equityRaw, peakEquityRaw: peak, drawdownBps: dd, realizedPnlRaw: realizedRaw, unrealizedPnlRaw: valuation.unrealizedPnlRaw };
}
