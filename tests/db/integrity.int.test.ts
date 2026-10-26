import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { ledgerEntries, orders, positions, transitionOrder, type OrderRow } from "@tb/db";
import { newId, USDC_MINT } from "@tb/domain";
import { postJournal, LedgerImbalanceError } from "@tb/ledger";
import { createPortfolio, createReservedOrder, createToken, testDb } from "../support/db.ts";

const handle = testDb();
const { db } = handle;
afterAll(() => handle.close());

const at = new Date("2026-01-01T00:00:00Z");

async function expectDbError(fn: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  let caught: unknown;
  try {
    await fn();
  } catch (err) {
    caught = err;
  }
  expect(caught, "expected the database to reject this").toBeDefined();
  const e = caught as { message?: string; cause?: { message?: string } };
  expect(`${e.message ?? ""} ${e.cause?.message ?? ""}`).toMatch(pattern);
}

describe("append-only tables", () => {
  it("rejects updates and deletes of ledger entries", async () => {
    const p = await createPortfolio(db, { usdc: 1_000_000n });
    await expectDbError(() => db.execute(sql`update ledger_entries set amount_raw = 1 where portfolio_id = ${p.id}`), /append-only/);
    await expectDbError(() => db.execute(sql`delete from ledger_entries where portfolio_id = ${p.id}`), /append-only/);
    await expectDbError(() => db.execute(sql`truncate ledger_entries`), /append-only/);
  });

  it("rejects edits of audit events and order transitions", async () => {
    const auditId = newId();
    await db.execute(sql`insert into audit_events (id, at, actor, action, details) values (${auditId}, now(), 'test', 'test', '{}')`);
    await expectDbError(() => db.execute(sql`update audit_events set actor = 'x' where id = ${auditId}`), /append-only/);
    await expectDbError(() => db.execute(sql`delete from audit_events where id = ${auditId}`), /append-only/);

    const p = await createPortfolio(db, { usdc: 100_000_000n, sol: 1_000_000_000n });
    const token = await createToken(db);
    const order = await createReservedOrder(db, { portfolio: p, token });
    await expectDbError(() => db.execute(sql`delete from order_state_transitions where order_id = ${order.id}`), /append-only/);
    await expectDbError(() => db.execute(sql`update order_state_transitions set reason = 'x' where order_id = ${order.id}`), /append-only/);
  });
});

describe("ledger balance enforcement", () => {
  it("application code refuses unbalanced journals", async () => {
    const p = await createPortfolio(db);
    await expect(
      postJournal(db, {
        portfolioId: p.id,
        mode: p.mode,
        entryType: "ADJUSTMENT",
        lines: [
          { account: "cash", asset: USDC_MINT, amountRaw: 5n },
          { account: "adjustments", asset: USDC_MINT, amountRaw: -4n },
        ],
        at,
      }),
    ).rejects.toThrow(LedgerImbalanceError);
  });

  it("the database refuses unbalanced journals at commit even if code is bypassed", async () => {
    const p = await createPortfolio(db);
    const journalId = newId();
    await expectDbError(
      () =>
        db.transaction(async (tx) => {
          await tx.insert(ledgerEntries).values({
            id: newId(),
            journalId,
            portfolioId: p.id,
            mode: "PAPER",
            account: "cash",
            asset: USDC_MINT,
            amountRaw: "100",
            entryType: "ADJUSTMENT",
            createdAt: at,
          });
        }),
      /unbalanced/,
    );
  });

  it("refuses journals spanning two portfolios", async () => {
    const a = await createPortfolio(db);
    const b = await createPortfolio(db);
    const journalId = newId();
    await expectDbError(
      () =>
        db.transaction(async (tx) => {
          for (const [pid, amt] of [[a.id, "100"], [b.id, "-100"]] as const) {
            await tx.insert(ledgerEntries).values({
              id: newId(), journalId, portfolioId: pid, mode: "PAPER", account: "cash", asset: USDC_MINT,
              amountRaw: amt, entryType: "ADJUSTMENT", createdAt: at,
            });
          }
        }),
      /spans/,
    );
  });

  it("rejects unknown ledger accounts", async () => {
    const p = await createPortfolio(db);
    await expectDbError(
      () =>
        db.insert(ledgerEntries).values({
          id: newId(), journalId: newId(), portfolioId: p.id, mode: "PAPER", account: "profit",
          asset: USDC_MINT, amountRaw: "1", entryType: "ADJUSTMENT", createdAt: at,
        }),
      /ledger_account_chk/,
    );
  });
});

describe("PAPER and LIVE separation", () => {
  it("cannot attach a PAPER order to a LIVE portfolio", async () => {
    const live = await createPortfolio(db, { mode: "LIVE" });
    const token = await createToken(db);
    await expectDbError(
      () =>
        db.insert(orders).values({
          id: newId(), portfolioId: live.id, mode: "PAPER", tokenId: token.id, mint: token.mint, side: "BUY",
          state: "PROPOSED", idempotencyKey: newId(), notionalRaw: "1", maxSlippageBps: 1, maxPriceImpactBps: 1,
          maxNetworkFeeLamports: "1", reason: "x", purpose: "ENTRY", expiresAt: at,
        }),
      /foreign key|violates/,
    );
  });

  it("cannot change a portfolio's mode", async () => {
    const p = await createPortfolio(db);
    await expectDbError(() => db.execute(sql`update portfolios set mode = 'LIVE' where id = ${p.id}`), /immutable|violates/);
  });

  it("simulated fills are only allowed on PAPER rows", async () => {
    const res = await db.execute<{ def: string }>(sql`select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'fills_sim_mode_chk'`);
    expect(res[0]?.def).toMatch(/PAPER/);
  });
});

describe("order integrity", () => {
  it("enforces the state machine in the database", async () => {
    const p = await createPortfolio(db, { usdc: 100_000_000n, sol: 1_000_000_000n });
    const token = await createToken(db);
    const order = await createReservedOrder(db, { portfolio: p, token });
    await expectDbError(() => db.execute(sql`update orders set state = 'FINALIZED', version = version + 1 where id = ${order.id}`), /illegal order transition/);
    await expectDbError(() => db.execute(sql`update orders set state = 'PREPARED' where id = ${order.id}`), /bump version/);
    await expectDbError(() => db.execute(sql`update orders set side = 'SELL' where id = ${order.id}`), /immutable/);
    await expectDbError(() => db.execute(sql`delete from orders where id = ${order.id}`), /append-only/);
    const prepared: OrderRow = await transitionOrder(db, { orderId: order.id, to: "PREPARED", reason: "ok", actor: "test", at });
    expect(prepared.state).toBe("PREPARED");
  });

  it("rejects duplicate idempotency keys", async () => {
    const p = await createPortfolio(db, { usdc: 100_000_000n, sol: 1_000_000_000n });
    const token = await createToken(db);
    const order = await createReservedOrder(db, { portfolio: p, token });
    await expectDbError(
      () =>
        db.insert(orders).values({
          id: newId(), portfolioId: p.id, mode: "PAPER", tokenId: token.id, mint: token.mint, side: "BUY",
          state: "PROPOSED", idempotencyKey: order.idempotencyKey, notionalRaw: "1", maxSlippageBps: 1,
          maxPriceImpactBps: 1, maxNetworkFeeLamports: "1", reason: "dup", purpose: "ENTRY", expiresAt: at,
        }),
      /orders_idempotency_uq/,
    );
  });

  it("allows only one active position per token per portfolio", async () => {
    const p = await createPortfolio(db);
    const token = await createToken(db);
    const row = {
      portfolioId: p.id, mode: "PAPER", tokenId: token.id, mint: token.mint, status: "OPEN",
      quantityRaw: "1", costBasisRaw: "1", openedAt: at,
    } as const;
    await db.insert(positions).values({ id: newId(), ...row });
    await expectDbError(() => db.insert(positions).values({ id: newId(), ...row }), /positions_one_active_per_token_uq/);
    await db.insert(positions).values({ id: newId(), ...row, status: "CLOSED" });
  });

  it("refuses to let reserved funds exceed the balance", async () => {
    const p = await createPortfolio(db, { usdc: 5_000_000n, sol: 1_000_000_000n });
    await expectDbError(
      () => db.execute(sql`update portfolio_balances set reserved_raw = 6000000 where portfolio_id = ${p.id}`),
      /portfolio_balances_cover_chk/,
    );
  });
});
