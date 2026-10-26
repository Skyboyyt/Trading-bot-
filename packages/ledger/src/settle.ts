/**
 * Settlement of verified fills into the ledger, positions and cached balances.
 *
 * Callers invoke this only once a fill is verified (paper: the simulated outcome is final; live:
 * the transaction is finalized and its balance changes are parsed). Everything happens inside
 * the caller's transaction so ledger, position, fill and reservation never disagree.
 */
import { newId, priceFromRaw, decToString, USDC_DECIMALS, type TradingMode } from "@tb/domain";
import { fills, positions, reservations, type DbOrTx, type OrderRow, dbRaw } from "@tb/db";
import { and, eq, inArray } from "drizzle-orm";
import { lockBalances, writeBalances } from "./balances.ts";
import { applyAcquisition, applyDisposal } from "./cost-basis.ts";
import { ASSET_SOL, postJournal, type LedgerLine } from "./journal.ts";

export interface SettleFillInput {
  order: Pick<OrderRow, "id" | "portfolioId" | "mode" | "mint" | "side" | "tokenId" | "strategyVersionId" | "reason">;
  attemptId: string;
  baseMint: string;
  tokenDecimals: number;
  /** BUY: token units received (net of any token-denominated platform fee). SELL: token units sold. */
  tokenQtyRaw: bigint;
  /** BUY: USDC spent. SELL: USDC received (net of any USDC-denominated platform fee). */
  quoteAmountRaw: bigint;
  platformFee: { raw: bigint; mint: string } | null;
  networkFeeLamports: bigint;
  /** USD estimate of the network fee at fill time, in USDC base units (reporting only). */
  networkFeeQuoteEstimateRaw: bigint;
  isSimulated: boolean;
  fillModelVersion?: string;
  approximate: boolean;
  notes?: string;
  exitReason?: string;
  filledAt: Date;
}

export interface SettleFillResult {
  fillId: string;
  positionId: string;
  realizedPnlRaw: bigint | null;
  positionClosed: boolean;
}

export class SettlementError extends Error {
  override name = "SettlementError";
}

const ACTIVE_POSITION = ["OPEN", "CLOSING", "STRANDED"];

export async function settleFill(tx: DbOrTx, input: SettleFillInput): Promise<SettleFillResult> {
  const { order } = input;
  const mode = order.mode as TradingMode;
  if (input.tokenQtyRaw <= 0n || input.quoteAmountRaw < 0n || input.networkFeeLamports < 0n) {
    throw new SettlementError("fill amounts must be positive");
  }
  if (input.isSimulated !== (mode === "PAPER")) {
    throw new SettlementError("simulated fills are only valid for PAPER portfolios");
  }

  const balances = await lockBalances(tx, order.portfolioId);
  const reservation = (
    await tx
      .select()
      .from(reservations)
      .where(and(eq(reservations.orderId, order.id), eq(reservations.status, "ACTIVE")))
      .for("update")
  )[0];
  if (!reservation) throw new SettlementError(`order ${order.id} has no active reservation`);
  const reservedQuote = dbRaw(reservation.quoteRaw);
  const reservedFee = dbRaw(reservation.feeLamports);

  const existing = (
    await tx
      .select()
      .from(positions)
      .where(
        and(
          eq(positions.portfolioId, order.portfolioId),
          eq(positions.mint, order.mint),
          inArray(positions.status, ACTIVE_POSITION),
        ),
      )
      .for("update")
  )[0];

  const feeRaw = input.platformFee?.raw ?? 0n;
  const feeMint = input.platformFee?.mint ?? null;
  if (feeRaw < 0n) throw new SettlementError("platform fee cannot be negative");
  if (feeMint && feeMint !== order.mint && feeMint !== input.baseMint) {
    throw new SettlementError(`platform fee in unexpected mint ${feeMint}`);
  }

  const fillId = newId();
  const price = priceFromRaw(input.quoteAmountRaw, USDC_DECIMALS, input.tokenQtyRaw, input.tokenDecimals);
  let positionId: string;
  let realizedPnlRaw: bigint | null = null;
  let costRemovedRaw: bigint | null = null;
  let positionClosed = false;
  const swapLines: LedgerLine[] = [];

  if (order.side === "BUY") {
    if (input.quoteAmountRaw > reservedQuote) {
      throw new SettlementError(`spent ${input.quoteAmountRaw} exceeds reservation ${reservedQuote}`);
    }
    const tokenFee = feeMint === order.mint ? feeRaw : 0n;
    const quoteFee = feeMint === input.baseMint ? feeRaw : 0n;
    swapLines.push(
      { account: "cash", asset: input.baseMint, amountRaw: -input.quoteAmountRaw },
      { account: "trading", asset: input.baseMint, amountRaw: input.quoteAmountRaw - quoteFee },
      { account: "fees:platform", asset: input.baseMint, amountRaw: quoteFee },
      { account: "trading", asset: order.mint, amountRaw: -(input.tokenQtyRaw + tokenFee) },
      { account: "holdings", asset: order.mint, amountRaw: input.tokenQtyRaw },
      { account: "fees:platform", asset: order.mint, amountRaw: tokenFee },
    );
    if (existing) {
      const lot = applyAcquisition(
        { quantityRaw: dbRaw(existing.quantityRaw), costBasisRaw: dbRaw(existing.costBasisRaw) },
        input.tokenQtyRaw,
        input.quoteAmountRaw,
      );
      await tx
        .update(positions)
        .set({
          quantityRaw: lot.quantityRaw.toString(),
          costBasisRaw: lot.costBasisRaw.toString(),
          version: existing.version + 1,
          updatedAt: input.filledAt,
        })
        .where(eq(positions.id, existing.id));
      positionId = existing.id;
    } else {
      positionId = newId();
      await tx.insert(positions).values({
        id: positionId,
        portfolioId: order.portfolioId,
        mode,
        tokenId: order.tokenId,
        mint: order.mint,
        status: "OPEN",
        quantityRaw: input.tokenQtyRaw.toString(),
        costBasisRaw: input.quoteAmountRaw.toString(),
        entryOrderId: order.id,
        strategyVersionId: order.strategyVersionId ?? null,
        entryReason: order.reason,
        openedAt: input.filledAt,
        updatedAt: input.filledAt,
      });
    }
    balances.cashRaw -= input.quoteAmountRaw;
  } else {
    if (!existing) throw new SettlementError(`no active position for ${order.mint}`);
    const tokenFee = feeMint === order.mint ? feeRaw : 0n;
    const quoteFee = feeMint === input.baseMint ? feeRaw : 0n;
    const disposal = applyDisposal(
      { quantityRaw: dbRaw(existing.quantityRaw), costBasisRaw: dbRaw(existing.costBasisRaw) },
      input.tokenQtyRaw,
      input.quoteAmountRaw,
    );
    realizedPnlRaw = disposal.realizedPnlRaw;
    costRemovedRaw = disposal.costRemovedRaw;
    swapLines.push(
      { account: "holdings", asset: order.mint, amountRaw: -input.tokenQtyRaw },
      { account: "trading", asset: order.mint, amountRaw: input.tokenQtyRaw - tokenFee },
      { account: "fees:platform", asset: order.mint, amountRaw: tokenFee },
      { account: "trading", asset: input.baseMint, amountRaw: -(input.quoteAmountRaw + quoteFee) },
      { account: "cash", asset: input.baseMint, amountRaw: input.quoteAmountRaw },
      { account: "fees:platform", asset: input.baseMint, amountRaw: quoteFee },
    );
    positionClosed = disposal.lot.quantityRaw === 0n;
    await tx
      .update(positions)
      .set({
        quantityRaw: disposal.lot.quantityRaw.toString(),
        costBasisRaw: disposal.lot.costBasisRaw.toString(),
        realizedPnlRaw: (dbRaw(existing.realizedPnlRaw) + disposal.realizedPnlRaw).toString(),
        status: positionClosed ? "CLOSED" : "OPEN",
        closedAt: positionClosed ? input.filledAt : null,
        exitReason: input.exitReason ?? existing.exitReason,
        strandedSince: null,
        markValueRaw: positionClosed ? "0" : existing.markValueRaw,
        version: existing.version + 1,
        updatedAt: input.filledAt,
      })
      .where(eq(positions.id, existing.id));
    positionId = existing.id;
    balances.cashRaw += input.quoteAmountRaw;
  }

  await tx.insert(fills).values({
    id: fillId,
    orderId: order.id,
    attemptId: input.attemptId,
    portfolioId: order.portfolioId,
    mode,
    mint: order.mint,
    side: order.side,
    tokenQtyRaw: input.tokenQtyRaw.toString(),
    quoteAmountRaw: input.quoteAmountRaw.toString(),
    platformFeeRaw: feeRaw.toString(),
    platformFeeMint: feeMint,
    networkFeeLamports: input.networkFeeLamports.toString(),
    networkFeeQuoteEstimateRaw: input.networkFeeQuoteEstimateRaw.toString(),
    price: decToString(price),
    realizedPnlRaw: realizedPnlRaw?.toString() ?? null,
    costBasisRemovedRaw: costRemovedRaw?.toString() ?? null,
    isSimulated: input.isSimulated,
    fillModelVersion: input.fillModelVersion ?? null,
    approximate: input.approximate,
    notes: input.notes ?? null,
    filledAt: input.filledAt,
  });

  await postJournal(tx, {
    portfolioId: order.portfolioId,
    mode,
    entryType: order.side === "BUY" ? "ACQUISITION" : "DISPOSAL",
    lines: swapLines,
    orderId: order.id,
    fillId,
    memo: input.isSimulated ? "simulated paper fill" : undefined,
    at: input.filledAt,
  });
  if (input.networkFeeLamports > 0n) {
    await postJournal(tx, {
      portfolioId: order.portfolioId,
      mode,
      entryType: "FEE_NETWORK",
      lines: [
        { account: "cash", asset: ASSET_SOL, amountRaw: -input.networkFeeLamports },
        { account: "fees:network", asset: ASSET_SOL, amountRaw: input.networkFeeLamports },
      ],
      orderId: order.id,
      fillId,
      at: input.filledAt,
    });
  }

  balances.reservedRaw -= reservedQuote;
  balances.solReservedLamports -= reservedFee;
  balances.solLamports -= input.networkFeeLamports;
  await writeBalances(tx, balances, input.filledAt);
  await tx
    .update(reservations)
    .set({ status: "CONSUMED", releasedAt: input.filledAt })
    .where(eq(reservations.id, reservation.id));

  return { fillId, positionId, realizedPnlRaw, positionClosed };
}

/** Release an order's reservation without a fill (rejected, cancelled, provably failed). */
export async function releaseReservation(tx: DbOrTx, orderId: string, portfolioId: string, at: Date): Promise<boolean> {
  const balances = await lockBalances(tx, portfolioId);
  const reservation = (
    await tx
      .select()
      .from(reservations)
      .where(and(eq(reservations.orderId, orderId), eq(reservations.status, "ACTIVE")))
      .for("update")
  )[0];
  if (!reservation) return false;
  balances.reservedRaw -= dbRaw(reservation.quoteRaw);
  balances.solReservedLamports -= dbRaw(reservation.feeLamports);
  await writeBalances(tx, balances, at);
  await tx.update(reservations).set({ status: "RELEASED", releasedAt: at }).where(eq(reservations.id, reservation.id));
  return true;
}

/**
 * Charge a network fee that was paid without a fill (a transaction that landed but failed).
 * The fee comes out of the SOL balance, never out of another order's reservation.
 */
export async function chargeNetworkFee(
  tx: DbOrTx,
  input: { portfolioId: string; mode: TradingMode; orderId: string; lamports: bigint; memo: string; at: Date },
): Promise<void> {
  if (input.lamports <= 0n) return;
  const balances = await lockBalances(tx, input.portfolioId);
  await postJournal(tx, {
    portfolioId: input.portfolioId,
    mode: input.mode,
    entryType: "FEE_NETWORK",
    lines: [
      { account: "cash", asset: ASSET_SOL, amountRaw: -input.lamports },
      { account: "fees:network", asset: ASSET_SOL, amountRaw: input.lamports },
    ],
    orderId: input.orderId,
    memo: input.memo,
    at: input.at,
  });
  balances.solLamports -= input.lamports;
  await writeBalances(tx, balances, input.at);
}
