import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { fills, positions, transitionOrder } from "@tb/db";
import { USDC_MINT } from "@tb/domain";
import {
  ASSET_SOL,
  chargeNetworkFee,
  InsufficientFundsError,
  ledgerTotals,
  readBalances,
  recordWithdrawal,
  releaseReservation,
  settleFill,
  verifyAndRebuild,
} from "../src/index.ts";
import { createPortfolio, createReservedOrder, createToken, testDb } from "../../../tests/support/db.ts";
import { eq } from "drizzle-orm";

const handle = testDb();
const { db } = handle;
afterAll(() => handle.close());
const at = new Date("2026-01-01T00:00:00Z");

const USDC_1000 = 1_000_000_000n;
const SOL_HALF = 500_000_000n;

async function buyAndSell(opts: { buyQuote: bigint; qty: bigint; sellProceeds: bigint; decimals?: number }) {
  const p = await createPortfolio(db, { usdc: USDC_1000, sol: SOL_HALF });
  const token = await createToken(db, { decimals: opts.decimals ?? 6 });
  const buy = await db.transaction(async (tx) => {
    const order = await createReservedOrder(tx, { portfolio: p, token, notionalRaw: opts.buyQuote, feeLamports: 50_000n, at });
    return settleFill(tx, {
      order,
      attemptId: await insertAttempt(tx, order.id),
      baseMint: USDC_MINT,
      tokenDecimals: token.decimals,
      tokenQtyRaw: opts.qty,
      quoteAmountRaw: opts.buyQuote,
      platformFee: null,
      networkFeeLamports: 5_000n,
      networkFeeQuoteEstimateRaw: 1_000n,
      isSimulated: true,
      approximate: true,
      filledAt: at,
    });
  });
  const sell = await db.transaction(async (tx) => {
    const order = await createReservedOrder(tx, { portfolio: p, token, side: "SELL", quantityRaw: opts.qty, feeLamports: 50_000n, at });
    return settleFill(tx, {
      order,
      attemptId: await insertAttempt(tx, order.id),
      baseMint: USDC_MINT,
      tokenDecimals: token.decimals,
      tokenQtyRaw: opts.qty,
      quoteAmountRaw: opts.sellProceeds,
      platformFee: { raw: 20_000n, mint: USDC_MINT },
      networkFeeLamports: 5_000n,
      networkFeeQuoteEstimateRaw: 1_000n,
      isSimulated: true,
      approximate: true,
      exitReason: "test exit",
      filledAt: at,
    });
  });
  return { p, token, buy, sell };
}

async function insertAttempt(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], orderId: string): Promise<string> {
  const rows = await tx.execute<{ id: string }>(sql`
    insert into order_attempts (id, order_id, attempt_no, provider, status)
    values (gen_random_uuid(), ${orderId}, 1, 'paper', 'FINALIZED') returning id
  `);
  return rows[0]!.id;
}

describe("fill settlement", () => {
  it("books a round trip with exact realised P&L and balanced ledger", async () => {
    const { p, buy, sell } = await buyAndSell({ buyQuote: 10_000_000n, qty: 123_456_789n, sellProceeds: 12_500_000n });
    expect(buy.realizedPnlRaw).toBeNull();
    expect(sell.realizedPnlRaw).toBe(2_500_000n);
    expect(sell.positionClosed).toBe(true);

    const balances = await readBalances(db, p.id);
    expect(balances?.cashRaw).toBe(USDC_1000 - 10_000_000n + 12_500_000n);
    expect(balances?.reservedRaw).toBe(0n);
    expect(balances?.solLamports).toBe(SOL_HALF - 10_000n);
    expect(balances?.solReservedLamports).toBe(0n);

    const verification = await db.transaction((tx) => verifyAndRebuild(tx, p.id, USDC_MINT, { apply: false, at }));
    expect(verification.ok).toBe(true);
    expect(verification.unbalancedJournals).toBe(0);

    const totals = await ledgerTotals(db, p.id, USDC_MINT);
    expect(totals.depositsRaw).toBe(USDC_1000);
    expect(totals.platformFeesQuoteRaw).toBe(20_000n);
    expect(totals.networkFeesLamports).toBe(10_000n);
  });

  it("keeps deposits separate from profit", async () => {
    const { p } = await buyAndSell({ buyQuote: 10_000_000n, qty: 5n, sellProceeds: 9_000_000n });
    const pos = await db.select().from(positions).where(eq(positions.portfolioId, p.id));
    expect(pos[0]?.realizedPnlRaw).toBe("-1000000");
    const totals = await ledgerTotals(db, p.id, USDC_MINT);
    expect(totals.depositsRaw).toBe(USDC_1000);
  });

  it("handles 0-decimal and 18-decimal tokens exactly", async () => {
    const zero = await buyAndSell({ buyQuote: 7_000_000n, qty: 3n, sellProceeds: 7_000_001n, decimals: 0 });
    expect(zero.sell.realizedPnlRaw).toBe(1n);
    const big = await buyAndSell({ buyQuote: 1n, qty: 10n ** 30n, sellProceeds: 2n, decimals: 18 });
    expect(big.sell.realizedPnlRaw).toBe(1n);
    const f = await db.select().from(fills).where(eq(fills.portfolioId, big.p.id));
    expect(f.find((x) => x.side === "BUY")?.price).toBe("0.000000000000000001000000000000"); // 1e-6 USDC per 1e12 tokens
  });

  it("refuses to settle a fill that spends more than was reserved", async () => {
    const p = await createPortfolio(db, { usdc: USDC_1000, sol: SOL_HALF });
    const token = await createToken(db);
    await expect(
      db.transaction(async (tx) => {
        const order = await createReservedOrder(tx, { portfolio: p, token, notionalRaw: 10_000_000n, at });
        await settleFill(tx, {
          order, attemptId: await insertAttempt(tx, order.id), baseMint: USDC_MINT, tokenDecimals: 6,
          tokenQtyRaw: 1n, quoteAmountRaw: 10_000_001n, platformFee: null, networkFeeLamports: 0n,
          networkFeeQuoteEstimateRaw: 0n, isSimulated: true, approximate: true, filledAt: at,
        });
      }),
    ).rejects.toThrow(/exceeds reservation/);
  });

  it("refuses simulated fills on a LIVE portfolio", async () => {
    const p = await createPortfolio(db, { mode: "LIVE", usdc: USDC_1000, sol: SOL_HALF });
    const token = await createToken(db);
    await expect(
      db.transaction(async (tx) => {
        const order = await createReservedOrder(tx, { portfolio: p, token, at });
        await settleFill(tx, {
          order, attemptId: await insertAttempt(tx, order.id), baseMint: USDC_MINT, tokenDecimals: 6,
          tokenQtyRaw: 1n, quoteAmountRaw: 1n, platformFee: null, networkFeeLamports: 0n,
          networkFeeQuoteEstimateRaw: 0n, isSimulated: true, approximate: true, filledAt: at,
        });
      }),
    ).rejects.toThrow(/PAPER/);
  });
});

describe("reservations, fees and withdrawals", () => {
  it("releases a reservation and charges the fee of a failed transaction", async () => {
    const p = await createPortfolio(db, { usdc: USDC_1000, sol: SOL_HALF });
    const token = await createToken(db);
    await db.transaction(async (tx) => {
      const order = await createReservedOrder(tx, { portfolio: p, token, notionalRaw: 10_000_000n, feeLamports: 80_000n, at });
      await transitionOrder(tx, { orderId: order.id, to: "FAILED", reason: "landed but failed", actor: "test", at });
      expect(await releaseReservation(tx, order.id, p.id, at)).toBe(true);
      expect(await releaseReservation(tx, order.id, p.id, at)).toBe(false);
      await chargeNetworkFee(tx, { portfolioId: p.id, mode: "PAPER", orderId: order.id, lamports: 5_000n, memo: "failed tx fee", at });
    });
    const b = await readBalances(db, p.id);
    expect(b).toMatchObject({ cashRaw: USDC_1000, reservedRaw: 0n, solLamports: SOL_HALF - 5_000n, solReservedLamports: 0n });
  });

  it("blocks withdrawals of reserved funds", async () => {
    const p = await createPortfolio(db, { usdc: 20_000_000n, sol: SOL_HALF });
    const token = await createToken(db);
    await createReservedOrder(db, { portfolio: p, token, notionalRaw: 15_000_000n, at });
    await expect(
      db.transaction((tx) =>
        recordWithdrawal(tx, { portfolioId: p.id, mode: "PAPER", asset: USDC_MINT, baseMint: USDC_MINT, amountRaw: 6_000_000n, memo: "w", at }),
      ),
    ).rejects.toThrow(InsufficientFundsError);
    await db.transaction((tx) =>
      recordWithdrawal(tx, { portfolioId: p.id, mode: "PAPER", asset: USDC_MINT, baseMint: USDC_MINT, amountRaw: 5_000_000n, memo: "w", at }),
    );
    const totals = await ledgerTotals(db, p.id, USDC_MINT);
    expect(totals.withdrawalsRaw).toBe(5_000_000n);
    expect(totals.depositsRaw).toBe(20_000_000n);
  });

  it("rebuilds a corrupted balance cache from the ledger after a restart", async () => {
    const { p } = await buyAndSell({ buyQuote: 10_000_000n, qty: 77n, sellProceeds: 11_000_000n });
    await db.execute(sql`update portfolio_balances set cash_raw = cash_raw + 123, sol_lamports = sol_lamports + 7 where portfolio_id = ${p.id}`);
    const before = await db.transaction((tx) => verifyAndRebuild(tx, p.id, USDC_MINT, { apply: true, at }));
    expect(before.ok).toBe(false);
    expect(before.corrected).toBe(true);
    expect(before.cash.cached - before.cash.ledger).toBe(123n);
    const after = await db.transaction((tx) => verifyAndRebuild(tx, p.id, USDC_MINT, { apply: false, at }));
    expect(after.ok).toBe(true);
    expect((await readBalances(db, p.id))?.solLamports).toBe(SOL_HALF - 10_000n);
    expect(ASSET_SOL).toBe("SOL");
  });
});
