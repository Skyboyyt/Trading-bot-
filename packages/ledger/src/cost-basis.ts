/**
 * Cost basis: weighted average, in quote (USDC) base units.
 *
 *  - Cost basis is the USDC actually spent on acquisition (including any platform fee charged in
 *    USDC; a platform fee charged in the token reduces the quantity received instead).
 *  - Network fees are paid from the separate SOL balance and are reported separately, with a USD
 *    estimate; they are not folded into the USDC cost basis.
 *  - On a partial sale the cost removed is rounded UP (ceil), so realised P&L is never overstated.
 *    A full sale removes exactly the remaining cost.
 */
import { mulDiv } from "@tb/domain";

export interface Lot {
  quantityRaw: bigint;
  costBasisRaw: bigint;
}

export function applyAcquisition(lot: Lot, qtyRaw: bigint, costRaw: bigint): Lot {
  if (qtyRaw <= 0n) throw new Error("acquisition quantity must be positive");
  if (costRaw < 0n) throw new Error("acquisition cost cannot be negative");
  return { quantityRaw: lot.quantityRaw + qtyRaw, costBasisRaw: lot.costBasisRaw + costRaw };
}

export interface DisposalResult {
  lot: Lot;
  costRemovedRaw: bigint;
  realizedPnlRaw: bigint;
}

export function applyDisposal(lot: Lot, qtyRaw: bigint, proceedsRaw: bigint): DisposalResult {
  if (qtyRaw <= 0n) throw new Error("disposal quantity must be positive");
  if (qtyRaw > lot.quantityRaw) throw new Error(`cannot dispose ${qtyRaw} of ${lot.quantityRaw}`);
  if (proceedsRaw < 0n) throw new Error("proceeds cannot be negative");
  const costRemovedRaw =
    qtyRaw === lot.quantityRaw ? lot.costBasisRaw : mulDiv(lot.costBasisRaw, qtyRaw, lot.quantityRaw, "ceil");
  return {
    lot: { quantityRaw: lot.quantityRaw - qtyRaw, costBasisRaw: lot.costBasisRaw - costRemovedRaw },
    costRemovedRaw,
    realizedPnlRaw: proceedsRaw - costRemovedRaw,
  };
}
