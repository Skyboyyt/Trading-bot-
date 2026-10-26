/**
 * Reconciliation: decide what actually happened to submitted orders, from the "chain" view.
 *
 * Rules (shared with the future live reconciler):
 *  - No answer within the confirmation timeout → UNKNOWN. The reservation is kept and nothing is
 *    resubmitted; a second economic trade is never created to "retry".
 *  - Absence is only proof of failure once the transaction can no longer land (expired).
 *  - CONFIRMED can roll back to UNKNOWN; only FINALIZED results are settled into the ledger.
 *  - Late confirmations are accepted: UNKNOWN → CONFIRMED → FINALIZED.
 *  - A transaction that landed but failed still costs its network fee.
 *  - A prepared attempt that never reached SUBMITTING was never sent and is safe to cancel.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import { type Clock, type OrderState } from "@tb/domain";
import {
  dbRaw,
  lockOrder,
  openIncident,
  orderAttempts,
  orders,
  signals,
  tokens,
  transitionOrder,
  type Db,
  type DbOrTx,
  type OrderRow,
} from "@tb/db";
import { chargeNetworkFee, releaseReservation, settleFill } from "@tb/ledger";
import { afterFailedExit, broadcastAttempt, cancelOrder, type QuoteJson } from "./executor.ts";
import { chainViewAt, FILL_MODEL_VERSION, type FillModelParams, type Simulation } from "./fill-model.ts";

export interface ReconcilerDeps {
  db: Db;
  clock: Clock;
  model: FillModelParams;
  baseMint: string;
  maxExitFailures: number;
  /** Prepared attempts older than this that never reached SUBMITTING are cancelled. */
  stalePreparedMs: number;
  /** USD value of one SOL in base-mint units, for fee reporting; null if unknown. */
  solPriceRaw: () => Promise<bigint | null>;
}

export interface ReconcileSummary {
  examined: number;
  transitions: { orderId: string; from: OrderState; to: OrderState; reason: string }[];
  settled: string[];
  manualReview: string[];
}

const ACTIVE: OrderState[] = ["PREPARED", "SUBMITTED", "UNKNOWN", "CONFIRMED", "FINALIZED"];

export class PaperReconciler {
  constructor(private readonly d: ReconcilerDeps) {}

  async reconcileAll(limit = 100): Promise<ReconcileSummary> {
    const rows = await this.d.db
      .select({ id: orders.id })
      .from(orders)
      .where(and(eq(orders.mode, "PAPER"), inArray(orders.state, ACTIVE)))
      .orderBy(orders.createdAt)
      .limit(limit);
    const summary: ReconcileSummary = { examined: rows.length, transitions: [], settled: [], manualReview: [] };
    const solPrice = rows.length > 0 ? await this.d.solPriceRaw().catch(() => null) : null;
    for (const r of rows) {
      try {
        await this.d.db.transaction((tx) => this.#reconcileOne(tx, r.id, summary, solPrice));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await this.d.db.transaction(async (tx) => {
          const o = await lockOrder(tx, r.id);
          if (o.state === "FINALIZED") {
            await transitionOrder(tx, { orderId: o.id, to: "MANUAL_REVIEW", reason: `settlement failed: ${msg}`.slice(0, 900), actor: "reconciler", at: this.d.clock.now() });
            summary.manualReview.push(o.id);
          }
          await openIncident(tx, {
            severity: "CRITICAL",
            kind: "RECONCILIATION_ERROR",
            message: `Order ${o.id} could not be reconciled: ${msg}`.slice(0, 500),
            details: { orderId: o.id, state: o.state },
            portfolioId: o.portfolioId,
            dedupeKey: `reconcile:${o.id}`,
            at: this.d.clock.now(),
          });
        });
      }
    }
    return summary;
  }

  async #reconcileOne(tx: DbOrTx, orderId: string, summary: ReconcileSummary, solPrice: bigint | null): Promise<void> {
    const now = this.d.clock.now();
    let order = await lockOrder(tx, orderId);
    const attempt = (await tx.select().from(orderAttempts).where(eq(orderAttempts.orderId, orderId)).orderBy(desc(orderAttempts.attemptNo)).limit(1))[0];
    const move = async (to: OrderState, reason: string) => {
      const from = order.state as OrderState;
      order = await transitionOrder(tx, { orderId, to, reason, actor: "reconciler", at: now });
      summary.transitions.push({ orderId, from, to, reason });
    };
    if (!attempt) return;

    if (order.state === "PREPARED") {
      if (attempt.status === "PREPARED") {
        const age = now.getTime() - (attempt.preparedAt ?? order.updatedAt).getTime();
        if (age >= this.d.stalePreparedMs) {
          await cancelOrder(tx, order, "recovered after restart: prepared but never submitted, safe to cancel", null, now, this.d.maxExitFailures);
          summary.transitions.push({ orderId, from: "PREPARED", to: "CANCELLED", reason: "never submitted" });
        }
        return;
      }
      if (attempt.status === "SUBMITTING") {
        // We may have crashed after broadcasting. Treat it as submitted with an unknown outcome.
        const submittedAt = attempt.preparedAt ?? now;
        const result = await broadcastAttempt(tx, order, attempt.id, submittedAt, this.d.model);
        if (result === "NOT_SUBMITTED") {
          await cancelOrder(tx, order, "recovered: fee above limit, never submitted", "FEE_ABOVE_LIMIT", now, this.d.maxExitFailures);
          return;
        }
        order = await lockOrder(tx, orderId);
        await tx.update(orderAttempts).set({ status: "UNKNOWN" }).where(eq(orderAttempts.id, attempt.id));
        await move("UNKNOWN", "recovered after restart: submission outcome unknown until reconciled");
      }
      return;
    }

    const sim = attempt.simulation as Simulation | null;
    if (!sim || sim.modelVersion !== FILL_MODEL_VERSION) {
      if (order.state === "SUBMITTED") await move("UNKNOWN", "no readable simulation for this attempt");
      return;
    }
    const view = chainViewAt(sim, now);
    const submittedAt = attempt.submittedAt ?? now;

    switch (view.status) {
      case "NOT_FOUND": {
        if (order.state === "CONFIRMED") await move("UNKNOWN", "previously confirmed transaction no longer visible (rollback)");
        if (view.expired && (order.state === "SUBMITTED" || order.state === "UNKNOWN")) {
          await move("FAILED", "transaction expired without landing");
          await this.#afterFailure(tx, order, attempt.id, null, "BLOCKHASH_EXPIRED", now);
        } else if (order.state === "SUBMITTED" && now.getTime() - submittedAt.getTime() > this.d.model.confirmTimeoutMs) {
          await tx.update(orderAttempts).set({ status: "UNKNOWN" }).where(eq(orderAttempts.id, attempt.id));
          await move("UNKNOWN", "no confirmation within timeout; reservation kept, not resubmitted");
        }
        return;
      }
      case "CONFIRMED": {
        if (order.state === "SUBMITTED" || order.state === "UNKNOWN") {
          await tx.update(orderAttempts).set({ status: "CONFIRMED" }).where(eq(orderAttempts.id, attempt.id));
          await move("CONFIRMED", order.state === "UNKNOWN" ? "late confirmation observed" : "confirmed");
        }
        return;
      }
      case "FAILED": {
        if (order.state === "CONFIRMED") await move("UNKNOWN", "confirmed transaction reported failed; re-checking");
        if (order.state === "SUBMITTED" || order.state === "UNKNOWN") {
          await move("FAILED", `transaction landed and failed: ${view.reason}`);
          await this.#afterFailure(tx, order, attempt.id, view.feeLamports, view.reason, now);
        }
        return;
      }
      case "FINALIZED": {
        if (order.state === "SUBMITTED" || order.state === "UNKNOWN") await move("CONFIRMED", "confirmed");
        if (order.state === "CONFIRMED") await move("FINALIZED", "finalized");
        if (order.state !== "FINALIZED") return;
        await this.#settle(tx, order, attempt.id, attempt.quote as QuoteJson, view.fillOutRaw, view.feeLamports, solPrice, now);
        await tx.update(orderAttempts).set({ status: "FINALIZED", resolvedAt: now }).where(eq(orderAttempts.id, attempt.id));
        await move("RECONCILED", "simulated fill settled into the ledger");
        if (order.signalId) await tx.update(signals).set({ status: "EXECUTED", updatedAt: now }).where(eq(signals.id, order.signalId));
        summary.settled.push(orderId);
        return;
      }
    }
  }

  async #afterFailure(tx: DbOrTx, order: OrderRow, attemptId: string, feeLamports: bigint | null, reason: string, now: Date): Promise<void> {
    await tx
      .update(orderAttempts)
      .set({ status: reason === "BLOCKHASH_EXPIRED" ? "EXPIRED" : "FAILED", errorCode: reason, errorMessage: reason, resolvedAt: now })
      .where(eq(orderAttempts.id, attemptId));
    await releaseReservation(tx, order.id, order.portfolioId, now);
    if (feeLamports && feeLamports > 0n) {
      await chargeNetworkFee(tx, { portfolioId: order.portfolioId, mode: "PAPER", orderId: order.id, lamports: feeLamports, memo: `simulated fee of failed transaction (${reason})`, at: now });
    }
    if (order.side === "SELL") await afterFailedExit(tx, order, now, this.d.maxExitFailures);
  }

  async #settle(tx: DbOrTx, order: OrderRow, attemptId: string, quote: QuoteJson, fillOutRaw: bigint, feeLamports: bigint, solPrice: bigint | null, now: Date): Promise<void> {
    const token = (await tx.select().from(tokens).where(eq(tokens.id, order.tokenId)))[0];
    if (!token || token.decimals === null) throw new Error(`token decimals unknown for ${order.mint}`);
    const isBuy = order.side === "BUY";
    // Scale the quoted platform fee to the simulated fill so fees are not double counted.
    let platformFee: { raw: bigint; mint: string } | null = null;
    if (quote.platformFee && quote.platformFee.mint && BigInt(quote.outAmountRaw) > 0n) {
      const quotedFee = BigInt(quote.platformFee.amountRaw);
      const outMint = isBuy ? order.mint : this.d.baseMint;
      const raw = quote.platformFee.mint === outMint ? (quotedFee * fillOutRaw) / BigInt(quote.outAmountRaw) : quotedFee;
      if (raw > 0n) platformFee = { raw, mint: quote.platformFee.mint };
    }
    const feeUsd = solPrice === null ? 0n : (feeLamports * solPrice) / 1_000_000_000n;
    await settleFill(tx, {
      order,
      attemptId,
      baseMint: this.d.baseMint,
      tokenDecimals: token.decimals,
      tokenQtyRaw: isBuy ? fillOutRaw : dbRaw(order.quantityRaw),
      quoteAmountRaw: isBuy ? dbRaw(order.notionalRaw) : fillOutRaw,
      platformFee,
      networkFeeLamports: feeLamports,
      networkFeeQuoteEstimateRaw: feeUsd,
      isSimulated: true,
      fillModelVersion: FILL_MODEL_VERSION,
      approximate: true,
      notes: `approximate simulated fill from a ${quote.provider} quote (${quote.router ?? "router unknown"})${solPrice === null ? "; network fee USD estimate unavailable" : ""}`,
      exitReason: isBuy ? undefined : order.reason,
      filledAt: now,
    });
  }
}
