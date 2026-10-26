/**
 * Paper executor.
 *
 * Runs the same order lifecycle a live executor would, with every step persisted before the
 * next one starts: RESERVED → PREPARED (attempt + intent digest persisted) → SUBMITTING marker →
 * SUBMITTED. "Broadcasting" here means recording a deterministic simulation; no transaction is
 * ever built or signed, no private key exists and nothing is sent to a network.
 */
import { and, count, eq, inArray, sql } from "drizzle-orm";
import {
  newId,
  ratioBps,
  sha256Hex,
  stableStringify,
  type Clock,
} from "@tb/domain";
import {
  lockOrder,
  orderAttempts,
  portfolios,
  positions,
  transitionOrder,
  dbRaw,
  type Db,
  type DbOrTx,
  type OrderRow,
} from "@tb/db";
import { releaseReservation } from "@tb/ledger";
import type { SwapProvider, SwapQuote } from "@tb/providers";
import { simulateExecution, type FillModelParams } from "./fill-model.ts";

export const PAPER_PROVIDER = "paper";

export interface PaperExecutorDeps {
  db: Db;
  swap: SwapProvider;
  clock: Clock;
  model: FillModelParams;
  baseMint: string;
  /** Consecutive failed exits after which a position is marked STRANDED. */
  maxExitFailures: number;
  /** Test hook: stop right after a step to simulate a crash. */
  crashAfter?: "PREPARED" | "SUBMITTING";
}

export class SimulatedCrash extends Error {
  override name = "SimulatedCrash";
}

export type ExecuteResult =
  | { status: "SKIPPED"; reason: string }
  | { status: "CANCELLED"; reason: string }
  | { status: "SUBMITTED"; attemptId: string };

export class PaperExecutor {
  constructor(private readonly d: PaperExecutorDeps) {}

  async executeOrder(orderId: string): Promise<ExecuteResult> {
    const { db, clock } = this.d;

    // 1. Pre-checks on the reserved order.
    const pre = await db.transaction(async (tx) => {
      const order = await lockOrder(tx, orderId);
      if (order.state !== "RESERVED") return { skip: `order is ${order.state}` } as const;
      const p = (await tx.select().from(portfolios).where(eq(portfolios.id, order.portfolioId)))[0];
      if (p?.mode !== "PAPER") {
        await this.#cancel(tx, order, "paper executor only handles PAPER portfolios", null);
        return { cancelled: "not a PAPER portfolio" } as const;
      }
      if (p.submissionsPaused) {
        await this.#cancel(tx, order, "submissions paused by operator", null);
        return { cancelled: "submissions paused" } as const;
      }
      if (clock.now() > order.expiresAt) {
        await this.#cancel(tx, order, "order expired before execution", null);
        return { cancelled: "expired" } as const;
      }
      return { order } as const;
    });
    if ("skip" in pre) return { status: "SKIPPED", reason: pre.skip! };
    if ("cancelled" in pre) return { status: "CANCELLED", reason: pre.cancelled! };
    const order = pre.order;

    // 2. Fresh quote at the order's exact size (never reuse the signal's prices).
    const isBuy = order.side === "BUY";
    const amount = isBuy ? dbRaw(order.notionalRaw) : dbRaw(order.quantityRaw);
    let quote: SwapQuote;
    let quoteAt: Date;
    try {
      const q = await this.d.swap.getQuote({
        inputMint: isBuy ? this.d.baseMint : order.mint,
        outputMint: isBuy ? order.mint : this.d.baseMint,
        amountRaw: amount,
        slippageBps: order.maxSlippageBps,
      });
      quote = q.data;
      quoteAt = q.meta.receivedAt;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return this.#cancelInTx(orderId, order.version, `no fresh quote: ${msg}`, "QUOTE_UNAVAILABLE");
    }

    // 3. Re-check the quote against the order's own hard limits.
    const problem = quoteProblem(order, quote, amount);
    if (problem) return this.#cancelInTx(orderId, order.version, problem, "QUOTE_OUTSIDE_LIMITS");

    // 4. PREPARED: persist the attempt and intent before anything is "sent".
    const prepared = await db.transaction(async (tx) => {
      const o = await lockOrder(tx, orderId);
      if (o.state !== "RESERVED" || o.version !== order.version) return null;
      const n = (await tx.select({ n: count() }).from(orderAttempts).where(eq(orderAttempts.orderId, orderId)))[0]?.n ?? 0;
      const attemptId = newId();
      const now = clock.now();
      const quoteJson = quoteToJson(quote);
      const digest = sha256Hex(stableStringify({ orderId, attemptNo: n + 1, quote: quoteJson }));
      await tx.insert(orderAttempts).values({
        id: attemptId,
        orderId,
        attemptNo: n + 1,
        provider: PAPER_PROVIDER,
        providerRequestId: quote.requestId,
        txDigest: digest,
        expectedSignature: `paper-${digest.slice(0, 48)}`,
        status: "PREPARED",
        quote: quoteJson,
        quoteReceivedAt: quoteAt,
        preparedAt: now,
      });
      await transitionOrder(tx, { orderId, to: "PREPARED", reason: "fresh quote within limits; attempt prepared", actor: "paper-executor", at: now });
      return attemptId;
    });
    if (!prepared) return { status: "SKIPPED", reason: "order changed while quoting" };
    if (this.d.crashAfter === "PREPARED") throw new SimulatedCrash("crash after PREPARED");

    // 5. Mark SUBMITTING before broadcast, so a crash afterwards is treated as "may have landed".
    await db.update(orderAttempts).set({ status: "SUBMITTING" }).where(and(eq(orderAttempts.id, prepared), eq(orderAttempts.status, "PREPARED")));
    if (this.d.crashAfter === "SUBMITTING") throw new SimulatedCrash("crash after SUBMITTING");

    // 6. "Broadcast": record the deterministic simulation.
    return db.transaction(async (tx) => {
      const o = await lockOrder(tx, orderId);
      if (o.state !== "PREPARED") return { status: "SKIPPED", reason: `order is ${o.state}` } as const;
      const result = await broadcastAttempt(tx, o, prepared, clock.now(), this.d.model);
      if (result === "NOT_SUBMITTED") {
        await this.#cancel(tx, await lockOrder(tx, orderId), "network fee above the order's limit; not submitted", "FEE_ABOVE_LIMIT");
        return { status: "CANCELLED", reason: "network fee above limit" } as const;
      }
      return { status: "SUBMITTED", attemptId: prepared } as const;
    });
  }

  async #cancelInTx(orderId: string, version: number, reason: string, errorCode: string | null): Promise<ExecuteResult> {
    return this.d.db.transaction(async (tx) => {
      const o = await lockOrder(tx, orderId);
      if (o.version !== version || (o.state !== "RESERVED" && o.state !== "PREPARED")) return { status: "SKIPPED", reason: `order is ${o.state}` } as const;
      await this.#cancel(tx, o, reason, errorCode);
      return { status: "CANCELLED", reason } as const;
    });
  }

  async #cancel(tx: DbOrTx, order: OrderRow, reason: string, errorCode: string | null): Promise<void> {
    await cancelOrder(tx, order, reason, errorCode, this.d.clock.now(), this.d.maxExitFailures);
  }
}

/** Cancel an order that was never broadcast, release its reservation and restore the position. */
export async function cancelOrder(tx: DbOrTx, order: OrderRow, reason: string, errorCode: string | null, now: Date, maxExitFailures: number): Promise<void> {
  if (errorCode) {
    const n = (await tx.select({ n: count() }).from(orderAttempts).where(eq(orderAttempts.orderId, order.id)))[0]?.n ?? 0;
    const open = (await tx.select().from(orderAttempts).where(and(eq(orderAttempts.orderId, order.id), inArray(orderAttempts.status, ["PREPARED", "SUBMITTING"]))))[0];
    if (open) {
      await tx.update(orderAttempts).set({ status: "CANCELLED", errorCode, errorMessage: reason.slice(0, 500), resolvedAt: now }).where(eq(orderAttempts.id, open.id));
    } else {
      await tx.insert(orderAttempts).values({ id: newId(), orderId: order.id, attemptNo: n + 1, provider: PAPER_PROVIDER, status: "CANCELLED", errorCode, errorMessage: reason.slice(0, 500), resolvedAt: now });
    }
  }
  await transitionOrder(tx, { orderId: order.id, to: "CANCELLED", reason, actor: "paper-executor", at: now, patch: { lastError: reason.slice(0, 500) } });
  await releaseReservation(tx, order.id, order.portfolioId, now);
  if (order.side === "SELL") await afterFailedExit(tx, order, now, maxExitFailures);
}

/**
 * A failed or cancelled exit leaves the position open. After repeated failures it is marked
 * STRANDED so the dashboard shows it can't currently be sold; it is still retried.
 */
export async function afterFailedExit(tx: DbOrTx, order: OrderRow, now: Date, maxExitFailures: number): Promise<void> {
  const pos = (await tx.select().from(positions).where(and(eq(positions.portfolioId, order.portfolioId), eq(positions.mint, order.mint), inArray(positions.status, ["OPEN", "CLOSING", "STRANDED"]))).for("update"))[0];
  if (!pos) return;
  const recent = await tx.execute<{ state: string }>(
    // Count consecutive failed/cancelled exits since the last successful fill for this position.
    sqlRecentExits(order.portfolioId, order.mint, pos.openedAt),
  );
  let failures = 0;
  for (const r of recent) {
    if (r.state === "FAILED" || r.state === "CANCELLED") failures++;
    else break;
  }
  const stranded = failures >= maxExitFailures;
  await tx
    .update(positions)
    .set({ status: stranded ? "STRANDED" : "OPEN", strandedSince: stranded ? (pos.strandedSince ?? now) : null, updatedAt: now })
    .where(eq(positions.id, pos.id));
}

function sqlRecentExits(portfolioId: string, mint: string, since: Date) {
  return sql`select state from orders where portfolio_id = ${portfolioId} and mint = ${mint} and side = 'SELL'
    and created_at >= ${since.toISOString()} and state in ('FAILED','CANCELLED','RECONCILED','REJECTED') order by created_at desc limit 50`;
}

/** Simulate and persist the broadcast of a PREPARED/SUBMITTING attempt. */
export async function broadcastAttempt(tx: DbOrTx, order: OrderRow, attemptId: string, submittedAt: Date, model: FillModelParams): Promise<"SUBMITTED" | "NOT_SUBMITTED"> {
  const attempt = (await tx.select().from(orderAttempts).where(eq(orderAttempts.id, attemptId)))[0];
  if (!attempt?.quote) throw new Error(`attempt ${attemptId} has no quote`);
  const q = attempt.quote as QuoteJson;
  const sim = simulateExecution(
    {
      orderId: order.id,
      attemptNo: attempt.attemptNo,
      quoteOutRaw: BigInt(q.outAmountRaw),
      minOutRaw: BigInt(q.minOutAmountRaw),
      quoteImpactBps: q.priceImpactBps ?? 0,
      quotePriorityFeeLamports: q.prioritizationFeeLamports === null ? null : BigInt(q.prioritizationFeeLamports),
      quoteReceivedAt: attempt.quoteReceivedAt ?? submittedAt,
      submittedAt,
      maxNetworkFeeLamports: dbRaw(order.maxNetworkFeeLamports),
    },
    model,
  );
  if (sim.outcome === "NOT_SUBMITTED_FEE_LIMIT") {
    await tx.update(orderAttempts).set({ simulation: sim }).where(eq(orderAttempts.id, attemptId));
    return "NOT_SUBMITTED";
  }
  await tx
    .update(orderAttempts)
    .set({ status: "SUBMITTED", submittedAt, simulation: sim, lastValidBlockHeight: `paper-expiry:${sim.expiresAt}` })
    .where(eq(orderAttempts.id, attemptId));
  await transitionOrder(tx, { orderId: order.id, to: "SUBMITTED", reason: "simulated submission recorded", actor: "paper-executor", at: submittedAt });
  return "SUBMITTED";
}

export interface QuoteJson {
  provider: string;
  adapterVersion: string;
  inputMint: string;
  outputMint: string;
  inAmountRaw: string;
  outAmountRaw: string;
  minOutAmountRaw: string;
  slippageBps: number | null;
  priceImpactBps: number | null;
  feeBps: number | null;
  feeMint: string | null;
  platformFee: { amountRaw: string; mint: string | null } | null;
  signatureFeeLamports: string | null;
  prioritizationFeeLamports: string | null;
  rentFeeLamports: string | null;
  router: string | null;
  routeLabels: string[];
  requestId: string | null;
}

export function quoteToJson(q: SwapQuote): QuoteJson {
  return {
    provider: q.provider,
    adapterVersion: q.adapterVersion,
    inputMint: q.inputMint,
    outputMint: q.outputMint,
    inAmountRaw: q.inAmountRaw.toString(),
    outAmountRaw: q.outAmountRaw.toString(),
    minOutAmountRaw: q.minOutAmountRaw.toString(),
    slippageBps: q.slippageBps,
    priceImpactBps: q.priceImpactBps,
    feeBps: q.feeBps,
    feeMint: q.feeMint,
    platformFee: q.platformFee ? { amountRaw: q.platformFee.amountRaw.toString(), mint: q.platformFee.mint } : null,
    signatureFeeLamports: q.signatureFeeLamports?.toString() ?? null,
    prioritizationFeeLamports: q.prioritizationFeeLamports?.toString() ?? null,
    rentFeeLamports: q.rentFeeLamports?.toString() ?? null,
    router: q.router,
    routeLabels: q.routeLabels,
    requestId: q.requestId,
  };
}

function quoteProblem(order: OrderRow, q: SwapQuote, amount: bigint): string | null {
  if (q.inAmountRaw !== amount) return "quote size does not match the order";
  if (q.priceImpactBps === null) return "quote price impact unknown";
  if (q.priceImpactBps > order.maxPriceImpactBps) return `price impact ${q.priceImpactBps} bps exceeds ${order.maxPriceImpactBps}`;
  const slip = q.outAmountRaw > 0n ? Number(ratioBps(q.outAmountRaw - q.minOutAmountRaw, q.outAmountRaw, "ceil")) : Infinity;
  if (slip > order.maxSlippageBps + 1) return `slippage tolerance ${slip} bps exceeds ${order.maxSlippageBps}`;
  const fee = (q.signatureFeeLamports ?? 0n) + (q.prioritizationFeeLamports ?? 0n);
  if (fee > dbRaw(order.maxNetworkFeeLamports)) return `quoted network fee ${fee} exceeds ${order.maxNetworkFeeLamports}`;
  return null;
}
