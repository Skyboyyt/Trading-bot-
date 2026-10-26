/**
 * End-to-end paper trading scenarios against a real PostgreSQL database.
 * Prices and quotes are SYNTHETIC; no network is touched.
 */
import { afterAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { USDC_MINT } from "@tb/domain";
import { dbRaw, orderAttempts, orders, portfolios, positions, reservations } from "@tb/db";
import { readBalances, verifyAndRebuild, ledgerTotals } from "@tb/ledger";
import { paperHarness, type PaperHarness } from "../support/paper.ts";
import { testDb } from "../support/db.ts";

const handle = testDb();
const { db } = handle;
afterAll(() => handle.close());

async function orderRow(id: string) {
  return (await db.select().from(orders).where(eq(orders.id, id)))[0]!;
}
async function position(h: PaperHarness) {
  return (await db.select().from(positions).where(eq(positions.portfolioId, h.portfolio.id)))[0];
}
async function ledgerOk(h: PaperHarness) {
  const v = await db.transaction((tx) => verifyAndRebuild(tx, h.portfolio.id, USDC_MINT, { apply: false, at: h.clock.now() }));
  expect(v.ok, JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x))).toBe(true);
}

describe("paper round trip", () => {
  it("buys and sells through every persisted state with an exact, balanced ledger", async () => {
    const h = await paperHarness(db);
    await h.passScreening();
    const r = await h.buy();
    expect(r.outcome).toBe("RESERVED");
    const id = r.order.id;
    expect((await readBalances(db, h.portfolio.id))?.reservedRaw).toBe(10_000_000n);

    expect(await h.executor.executeOrder(id)).toMatchObject({ status: "SUBMITTED" });
    expect((await orderRow(id)).state).toBe("SUBMITTED");
    await h.settle(2_000);
    expect((await orderRow(id)).state).toBe("CONFIRMED");
    await h.settle(15_000);
    expect((await orderRow(id)).state).toBe("RECONCILED");

    const pos = await position(h);
    expect(pos?.status).toBe("OPEN");
    // 10 USDC at 20 micro-USDC per token, minus 40 bps quoted impact; fill equals quote in this model.
    expect(pos?.quantityRaw).toBe("498000000000");
    expect(pos?.costBasisRaw).toBe("10000000");
    const b1 = await readBalances(db, h.portfolio.id);
    expect(b1).toMatchObject({ cashRaw: 990_000_000n, reservedRaw: 0n, solReservedLamports: 0n });
    expect(b1?.solLamports).toBe(100_000_000n - 25_000n);
    await ledgerOk(h);

    // Price doubles (synthetic), then exit the whole position.
    h.swap.priceMicroUsdc = 40n;
    const s = await h.sell(dbRaw(pos!.quantityRaw));
    expect(s.outcome).toBe("RESERVED");
    expect((await position(h))?.status).toBe("CLOSING");
    await h.executor.executeOrder(s.order.id);
    await h.settle(20_000);
    expect((await orderRow(s.order.id)).state).toBe("RECONCILED");
    const closed = await position(h);
    expect(closed?.status).toBe("CLOSED");
    // proceeds = 498e9 * 40 / 1e6 * (1 - 0.004) = 19,840,320; cost 10,000,000
    expect(closed?.realizedPnlRaw).toBe("9840320");
    await ledgerOk(h);
    const totals = await ledgerTotals(db, h.portfolio.id, USDC_MINT);
    expect(totals.depositsRaw).toBe(1_000_000_000n);
    expect(totals.networkFeesLamports).toBe(50_000n);
  });
});

describe("idempotency and concurrency", () => {
  it("a duplicate signal never creates a second order", async () => {
    const h = await paperHarness(db);
    await h.passScreening();
    const signalAt = h.clock.now();
    const a = await h.buy(10_000_000n, { signalAt });
    const b = await h.buy(10_000_000n, { signalAt });
    expect(a.outcome).toBe("RESERVED");
    expect(b.outcome).toBe("DUPLICATE");
    expect(b.order.id).toBe(a.order.id);
    expect((await readBalances(db, h.portfolio.id))?.reservedRaw).toBe(10_000_000n);
  });

  it("concurrent reservations cannot exceed exposure limits", async () => {
    const h = await paperHarness(db, { policy: { maxPendingOrders: 20, maxConcurrentPositions: 20, maxTokenExposureRaw: "1000000000" } });
    await h.passScreening();
    // Ten simultaneous $10 entry attempts at different signal times; aggregate limit is $30,
    // and one-pending-order-per-token allows only the first to win anyway.
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => h.buy(10_000_000n, { signalAt: new Date(h.clock.now().getTime() + i * 1000) })),
    );
    const reserved = results.filter((r) => r.outcome === "RESERVED");
    expect(reserved).toHaveLength(1);
    const b = await readBalances(db, h.portfolio.id);
    expect(b?.reservedRaw).toBe(10_000_000n);
  });

  it("aggregate exposure is enforced across tokens under concurrency", async () => {
    const h = await paperHarness(db, { policy: { maxPendingOrders: 20, maxConcurrentPositions: 20 } });
    const { createToken } = await import("../support/db.ts");
    const extra = await Promise.all(Array.from({ length: 5 }, () => createToken(db)));
    const { proposeAndReserve } = await import("@tb/risk");
    const { orderIdempotencyKey } = await import("@tb/domain");
    const { screeningAssessments } = await import("@tb/db");
    for (const t of extra) {
      await db.insert(screeningAssessments).values({
        id: crypto.randomUUID(), tokenId: t.id, network: "solana-mainnet", mint: t.mint, verdict: "PASS", checks: [],
        intendedSizeRaw: "1", screenerVersion: "t", inputs: {}, assessedAt: h.clock.now(), expiresAt: new Date(h.clock.now().getTime() + 3_600_000),
      });
    }
    const results = await Promise.all(
      extra.map(async (t) => {
        const q = await h.swap.getQuote({ inputMint: USDC_MINT, outputMint: t.mint, amountRaw: 10_000_000n, slippageBps: 100 });
        return db.transaction((tx) =>
          proposeAndReserve(tx, {
            portfolioId: h.portfolio.id, tokenId: t.id,
            proposal: { side: "BUY", purpose: "ENTRY", mint: t.mint, notionalRaw: 10_000_000n, quote: q.data, quoteReceivedAt: q.meta.receivedAt, networkFeeLamports: 25_000n },
            idempotencyKey: orderIdempotencyKey({ portfolioId: h.portfolio.id, strategyVersion: "t", mint: t.mint, signalAt: h.clock.now(), side: "BUY" }),
            reason: "concurrency", policy: h.policy, latestDataAt: h.clock.now(), actor: "test", now: h.clock.now(),
          }),
        );
      }),
    );
    expect(results.filter((r) => r.outcome === "RESERVED")).toHaveLength(3); // $30 aggregate / $10 each
    expect((await readBalances(db, h.portfolio.id))?.reservedRaw).toBe(30_000_000n);
  });
});

describe("risk rejections", () => {
  it("rejects entries without a passing screening assessment (missing data blocks entry)", async () => {
    const h = await paperHarness(db);
    const r = await h.buy();
    expect(r.outcome).toBe("REJECTED");
    if (r.outcome === "REJECTED") expect(r.evaluation.checks.find((c) => c.id === "screening")?.verdict).toBe("UNKNOWN");
    expect((await readBalances(db, h.portfolio.id))?.reservedRaw).toBe(0n);
  });

  it("rejects bad quotes: excessive price impact", async () => {
    const h = await paperHarness(db);
    await h.passScreening();
    h.swap.impactBps = 900;
    const r = await h.buy();
    expect(r.outcome).toBe("REJECTED");
  });

  it("pausing entries blocks buys but not exits; pausing everything blocks exits too", async () => {
    const h = await paperHarness(db);
    await h.passScreening();
    const b = await h.buy();
    await h.executor.executeOrder(b.order.id);
    await h.settle(20_000);
    await db.update(portfolios).set({ entriesPaused: true }).where(eq(portfolios.id, h.portfolio.id));
    h.clock.advance(60_000);
    expect((await h.buy()).outcome).toBe("REJECTED");
    const qty = dbRaw((await position(h))!.quantityRaw);
    await db.update(portfolios).set({ submissionsPaused: true }).where(eq(portfolios.id, h.portfolio.id));
    expect((await h.sell(qty)).outcome).toBe("REJECTED");
    await db.update(portfolios).set({ submissionsPaused: false }).where(eq(portfolios.id, h.portfolio.id));
    h.clock.advance(1_000);
    expect((await h.sell(qty)).outcome).toBe("RESERVED");
  });
});

describe("execution failures", () => {
  it("fee spikes above the limit cancel the order before submission and release funds", async () => {
    const h = await paperHarness(db, { model: { feeSpikeProbability: 1, feeSpikeMultiplier: 100 } });
    await h.passScreening();
    const r = await h.buy();
    expect(await h.executor.executeOrder(r.order.id)).toMatchObject({ status: "CANCELLED" });
    expect((await orderRow(r.order.id)).state).toBe("CANCELLED");
    expect(await readBalances(db, h.portfolio.id)).toMatchObject({ reservedRaw: 0n, solReservedLamports: 0n, solLamports: 100_000_000n });
  });

  it("a quote failure cancels a buy and counts as an execution error", async () => {
    const h = await paperHarness(db);
    await h.passScreening();
    const r = await h.buy();
    h.swap.failNext = 1;
    expect(await h.executor.executeOrder(r.order.id)).toMatchObject({ status: "CANCELLED" });
    const attempts = await db.select().from(orderAttempts).where(eq(orderAttempts.orderId, r.order.id));
    expect(attempts[0]?.errorCode).toBe("QUOTE_UNAVAILABLE");
  });

  it("submission timeout becomes UNKNOWN, keeps the reservation, and a late confirmation settles", async () => {
    const h = await paperHarness(db, { model: { lateConfirmationProbability: 1, lateConfirmationExtraMs: { min: 45_000, max: 45_000 } } });
    await h.passScreening();
    const r = await h.buy();
    await h.executor.executeOrder(r.order.id);
    await h.settle(31_000);
    expect((await orderRow(r.order.id)).state).toBe("UNKNOWN");
    expect((await readBalances(db, h.portfolio.id))?.reservedRaw).toBe(10_000_000n);
    // While unknown, new entries are blocked and nothing is resubmitted.
    h.clock.advance(1_000);
    const blocked = await h.buy();
    expect(blocked.outcome).toBe("REJECTED");
    await h.settle(20_000);
    await h.settle(20_000);
    expect((await orderRow(r.order.id)).state).toBe("RECONCILED");
    expect(await db.select().from(orderAttempts).where(eq(orderAttempts.orderId, r.order.id))).toHaveLength(1);
    await ledgerOk(h);
  });

  it("a dropped transaction fails only after expiry, with no fee charged", async () => {
    const h = await paperHarness(db, { model: { dropProbability: 1 } });
    await h.passScreening();
    const r = await h.buy();
    await h.executor.executeOrder(r.order.id);
    await h.settle(31_000);
    expect((await orderRow(r.order.id)).state).toBe("UNKNOWN");
    await h.settle(60_000);
    expect((await orderRow(r.order.id)).state).toBe("FAILED");
    expect(await readBalances(db, h.portfolio.id)).toMatchObject({ reservedRaw: 0n, solLamports: 100_000_000n });
    await ledgerOk(h);
  });

  it("a transaction that lands and fails releases funds but still pays its fee", async () => {
    const h = await paperHarness(db, { model: { landedFailureProbability: 1 } });
    await h.passScreening();
    const r = await h.buy();
    await h.executor.executeOrder(r.order.id);
    await h.settle(2_000);
    expect((await orderRow(r.order.id)).state).toBe("FAILED");
    expect(await readBalances(db, h.portfolio.id)).toMatchObject({ cashRaw: 1_000_000_000n, reservedRaw: 0n, solLamports: 100_000_000n - 25_000n });
    await ledgerOk(h);
  });

  it("a rolled-back confirmation goes back to UNKNOWN and settles only once it re-lands and finalizes", async () => {
    const h = await paperHarness(db, { model: { rollbackProbability: 1, relandProbability: 1 } });
    await h.passScreening();
    const r = await h.buy();
    await h.executor.executeOrder(r.order.id);
    await h.settle(1_500);
    expect((await orderRow(r.order.id)).state).toBe("CONFIRMED");
    // Landed at +1s, rollback detected 4s later, re-lands at least 1s after that.
    await h.settle(4_000);
    expect((await orderRow(r.order.id)).state).toBe("UNKNOWN");
    expect((await position(h))).toBeUndefined();
    await h.settle(40_000);
    expect((await orderRow(r.order.id)).state).toBe("RECONCILED");
    await ledgerOk(h);
  });

  it("failed exits leave the position open, then mark it STRANDED", async () => {
    const h = await paperHarness(db);
    await h.passScreening();
    const b = await h.buy();
    await h.executor.executeOrder(b.order.id);
    await h.settle(20_000);
    const qty = dbRaw((await position(h))!.quantityRaw);
    for (let i = 0; i < 3; i++) {
      h.clock.advance(60_000);
      const s = await h.sell(qty);
      expect(s.outcome).toBe("RESERVED");
      h.swap.failNext = 1;
      await h.executor.executeOrder(s.order.id);
      const p = await position(h);
      expect(p?.quantityRaw).toBe(qty.toString());
      expect(p?.status).toBe(i < 2 ? "OPEN" : "STRANDED");
    }
    await ledgerOk(h);
  });
});

describe("crash recovery", () => {
  it("crash before broadcast: the prepared order is cancelled safely after restart", async () => {
    const h = await paperHarness(db, { crashAfter: "PREPARED" });
    await h.passScreening();
    const r = await h.buy();
    await expect(h.executor.executeOrder(r.order.id)).rejects.toThrow(/crash/);
    expect((await orderRow(r.order.id)).state).toBe("PREPARED");
    await h.settle(31_000);
    expect((await orderRow(r.order.id)).state).toBe("CANCELLED");
    expect((await readBalances(db, h.portfolio.id))?.reservedRaw).toBe(0n);
    const active = await db.select().from(reservations).where(and(eq(reservations.orderId, r.order.id), eq(reservations.status, "ACTIVE")));
    expect(active).toHaveLength(0);
  });

  it("crash after broadcast: the outcome is treated as unknown and reconciled, never resubmitted", async () => {
    const h = await paperHarness(db, { crashAfter: "SUBMITTING" });
    await h.passScreening();
    const r = await h.buy();
    await expect(h.executor.executeOrder(r.order.id)).rejects.toThrow(/crash/);
    await h.settle(500);
    expect((await orderRow(r.order.id)).state).toBe("UNKNOWN");
    await h.settle(30_000);
    expect((await orderRow(r.order.id)).state).toBe("RECONCILED");
    expect(await db.select().from(orderAttempts).where(eq(orderAttempts.orderId, r.order.id))).toHaveLength(1);
    // A second execution request for the same order does nothing.
    expect(await h.executor.executeOrder(r.order.id)).toMatchObject({ status: "SKIPPED" });
    await ledgerOk(h);
  });
});
