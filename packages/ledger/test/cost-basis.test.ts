import { describe, expect, it } from "vitest";
import {
  applyAcquisition,
  applyDisposal,
  assertBalanced,
  drawdownBps,
  LedgerImbalanceError,
  valuePortfolio,
} from "../src/index.ts";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TOKEN = "TokenMint1111111111111111111111111111111111";

describe("journal balancing", () => {
  it("accepts journals that net to zero per asset", () => {
    expect(() =>
      assertBalanced([
        { account: "cash", asset: USDC, amountRaw: -10_000_000n },
        { account: "trading", asset: USDC, amountRaw: 10_000_000n },
        { account: "trading", asset: TOKEN, amountRaw: -5n },
        { account: "holdings", asset: TOKEN, amountRaw: 5n },
      ]),
    ).not.toThrow();
  });

  it("rejects imbalance even when totals across assets cancel", () => {
    expect(() =>
      assertBalanced([
        { account: "cash", asset: USDC, amountRaw: -10n },
        { account: "holdings", asset: TOKEN, amountRaw: 10n },
      ]),
    ).toThrow(LedgerImbalanceError);
  });

  it("rejects zero lines and single-line journals", () => {
    expect(() => assertBalanced([{ account: "cash", asset: USDC, amountRaw: 0n }])).toThrow(LedgerImbalanceError);
  });
});

describe("weighted-average cost basis", () => {
  it("accumulates acquisitions", () => {
    const lot = applyAcquisition(applyAcquisition({ quantityRaw: 0n, costBasisRaw: 0n }, 100n, 1_000n), 300n, 6_000n);
    expect(lot).toEqual({ quantityRaw: 400n, costBasisRaw: 7_000n });
  });

  it("rounds removed cost up on partial disposals so realised P&L is never overstated", () => {
    const r = applyDisposal({ quantityRaw: 3n, costBasisRaw: 10n }, 1n, 4n);
    expect(r.costRemovedRaw).toBe(4n); // ceil(10/3)
    expect(r.realizedPnlRaw).toBe(0n);
    expect(r.lot).toEqual({ quantityRaw: 2n, costBasisRaw: 6n });
  });

  it("removes exactly the remaining cost on a full disposal", () => {
    let lot = { quantityRaw: 3n, costBasisRaw: 10n };
    const a = applyDisposal(lot, 1n, 3n);
    lot = a.lot;
    const b = applyDisposal(lot, 2n, 9n);
    expect(a.costRemovedRaw + b.costRemovedRaw).toBe(10n);
    expect(b.lot).toEqual({ quantityRaw: 0n, costBasisRaw: 0n });
    expect(a.realizedPnlRaw + b.realizedPnlRaw).toBe(12n - 10n);
  });

  it("refuses to sell more than held", () => {
    expect(() => applyDisposal({ quantityRaw: 1n, costBasisRaw: 1n }, 2n, 1n)).toThrow();
  });
});

describe("conservative valuation", () => {
  it("values positions without an exit route at zero", () => {
    const v = valuePortfolio(990_000_000n, [
      { mint: TOKEN, quantityRaw: 5n, costBasisRaw: 10_000_000n, exitValueRaw: null },
    ]);
    expect(v.positionsMarkRaw).toBe(0n);
    expect(v.unrealizedPnlRaw).toBe(-10_000_000n);
    expect(v.equityRaw).toBe(990_000_000n);
    expect(v.unmarkedPositions).toBe(1);
  });

  it("measures drawdown from peak", () => {
    expect(drawdownBps(900n, 1_000n)).toBe(1000);
    expect(drawdownBps(1_100n, 1_000n)).toBe(0);
    expect(drawdownBps(999n, 1_000n)).toBe(10);
  });
});
