/**
 * Atomic budget reservation.
 *
 * In one PostgreSQL transaction: lock the portfolio's balance row (serialising every budget
 * decision for that portfolio), rebuild the risk context from the database, evaluate the order,
 * create the order intent, reserve spend and fees, enqueue the execution job, and commit.
 * Two concurrent signals can therefore never both spend the same budget.
 */
import { and, desc, eq, gte, inArray, isNotNull, lte, notInArray, sql } from "drizzle-orm";
import { newId, type TradingMode } from "@tb/domain";
import {
  enqueueJob,
  insertProposedOrder,
  dbRaw,
  orderAttempts,
  orders,
  portfolioSnapshots,
  portfolios,
  positions,
  reservations,
  riskDecisions,
  screeningAssessments,
  transitionOrder,
  type DbOrTx,
  type OrderRow,
} from "@tb/db";
import { lockBalances, writeBalances } from "@tb/ledger";
import { evaluateOrder, type OrderProposal, type RiskContext, type RiskEvaluation } from "./evaluate.ts";
import type { RiskPolicy } from "./policy.ts";

export const EXECUTE_ORDER_JOB = "order.execute";
const TERMINAL = ["REJECTED", "RECONCILED", "FAILED", "CANCELLED"];

export interface ReserveInput {
  portfolioId: string;
  tokenId: string;
  proposal: OrderProposal;
  idempotencyKey: string;
  reason: string;
  signalId?: string | null;
  strategyVersionId?: string | null;
  policy: { id: string; params: RiskPolicy };
  latestDataAt: Date | null;
  actor: string;
  now: Date;
}

export type ReserveOutcome =
  | { outcome: "RESERVED"; order: OrderRow; evaluation: RiskEvaluation }
  | { outcome: "REJECTED"; order: OrderRow; evaluation: RiskEvaluation }
  | { outcome: "DUPLICATE"; order: OrderRow };

export async function proposeAndReserve(tx: DbOrTx, input: ReserveInput): Promise<ReserveOutcome> {
  const { proposal: p, now } = input;
  const balances = await lockBalances(tx, input.portfolioId);

  const existing = (await tx.select().from(orders).where(eq(orders.idempotencyKey, input.idempotencyKey)))[0];
  if (existing) return { outcome: "DUPLICATE", order: existing };

  const ctx = await loadRiskContext(tx, {
    portfolioId: input.portfolioId,
    mint: p.mint,
    now,
    latestDataAt: input.latestDataAt,
    recentErrorWindowMs: input.policy.params.recentErrorWindowMs,
    balances,
  });
  const evaluation = evaluateOrder(p, ctx, input.policy.params);
  const maxFee = BigInt(input.policy.params.maxNetworkFeeLamports);
  const isEntry = p.purpose === "ENTRY";

  const order = await insertProposedOrder(
    tx,
    {
      id: newId(),
      portfolioId: input.portfolioId,
      mode: ctx.mode,
      signalId: input.signalId ?? null,
      strategyVersionId: input.strategyVersionId ?? null,
      tokenId: input.tokenId,
      mint: p.mint,
      side: p.side,
      idempotencyKey: input.idempotencyKey,
      notionalRaw: p.side === "BUY" ? (p.notionalRaw ?? 0n).toString() : null,
      quantityRaw: p.side === "SELL" ? (p.quantityRaw ?? 0n).toString() : null,
      maxSlippageBps: isEntry ? input.policy.params.maxSlippageBps : input.policy.params.maxExitSlippageBps,
      maxPriceImpactBps: isEntry ? input.policy.params.maxEntryPriceImpactBps : input.policy.params.maxExitPriceImpactBps,
      maxNetworkFeeLamports: maxFee.toString(),
      reason: input.reason,
      purpose: p.purpose,
      expiresAt: new Date(now.getTime() + input.policy.params.orderTtlMs),
      createdAt: now,
      updatedAt: now,
    },
    input.actor,
  );

  await tx.insert(riskDecisions).values({
    id: newId(),
    signalId: input.signalId ?? null,
    orderId: order.id,
    portfolioId: input.portfolioId,
    mode: ctx.mode,
    policyId: input.policy.id,
    decision: evaluation.approved ? "APPROVED" : "REJECTED",
    checks: evaluation.checks,
    decidedAt: now,
  });

  if (!evaluation.approved) {
    const failed = evaluation.checks.filter((c) => c.verdict !== "PASS").map((c) => c.reason);
    const rejected = await transitionOrder(tx, {
      orderId: order.id,
      to: "REJECTED",
      reason: `risk: ${failed.join("; ").slice(0, 900)}`,
      actor: "risk-engine",
      at: now,
    });
    return { outcome: "REJECTED", order: rejected, evaluation };
  }

  const quoteReserve = p.side === "BUY" ? (p.notionalRaw ?? 0n) : 0n;
  balances.reservedRaw += quoteReserve;
  balances.solReservedLamports += maxFee;
  await writeBalances(tx, balances, now);
  await tx.insert(reservations).values({
    id: newId(),
    orderId: order.id,
    portfolioId: input.portfolioId,
    mode: ctx.mode,
    quoteRaw: quoteReserve.toString(),
    feeLamports: maxFee.toString(),
    createdAt: now,
  });
  const reserved = await transitionOrder(tx, {
    orderId: order.id,
    to: "RESERVED",
    reason: "risk approved; budget reserved",
    actor: "risk-engine",
    at: now,
    patch: { reservedQuoteRaw: quoteReserve.toString(), reservedFeeLamports: maxFee.toString() },
  });
  if (p.side === "SELL") {
    await tx
      .update(positions)
      .set({ status: "CLOSING", updatedAt: now })
      .where(and(eq(positions.portfolioId, input.portfolioId), eq(positions.mint, p.mint), eq(positions.status, "OPEN")));
  }
  await enqueueJob(tx, { kind: EXECUTE_ORDER_JOB, payload: { orderId: order.id }, runAt: now, dedupeKey: `execute:${order.id}` });
  return { outcome: "RESERVED", order: reserved, evaluation };
}

export async function loadRiskContext(
  tx: DbOrTx,
  args: {
    portfolioId: string;
    mint: string;
    now: Date;
    latestDataAt: Date | null;
    recentErrorWindowMs: number;
    balances: { cashRaw: bigint; reservedRaw: bigint; solLamports: bigint; solReservedLamports: bigint };
  },
): Promise<RiskContext> {
  const portfolio = (await tx.select().from(portfolios).where(eq(portfolios.id, args.portfolioId)))[0];
  if (!portfolio) throw new Error(`portfolio ${args.portfolioId} not found`);

  const pos = await tx
    .select()
    .from(positions)
    .where(and(eq(positions.portfolioId, args.portfolioId), inArray(positions.status, ["OPEN", "CLOSING", "STRANDED"])));
  const pending = await tx
    .select()
    .from(orders)
    .where(and(eq(orders.portfolioId, args.portfolioId), notInArray(orders.state, TERMINAL)));

  const dayStart = new Date(Date.UTC(args.now.getUTCFullYear(), args.now.getUTCMonth(), args.now.getUTCDate()));
  const beforeDay = (
    await tx
      .select()
      .from(portfolioSnapshots)
      .where(and(eq(portfolioSnapshots.portfolioId, args.portfolioId), lte(portfolioSnapshots.at, dayStart)))
      .orderBy(desc(portfolioSnapshots.at))
      .limit(1)
  )[0];
  const firstToday = beforeDay
    ? undefined
    : (
        await tx
          .select()
          .from(portfolioSnapshots)
          .where(and(eq(portfolioSnapshots.portfolioId, args.portfolioId), gte(portfolioSnapshots.at, dayStart)))
          .orderBy(portfolioSnapshots.at)
          .limit(1)
      )[0];
  const peakRow = await tx.execute<{ peak: string | null }>(
    sql`select max(peak_equity_raw)::text as peak from portfolio_snapshots where portfolio_id = ${args.portfolioId}`,
  );

  const marks = pos.reduce((t, x) => t + (x.markValueRaw === null ? 0n : dbRaw(x.markValueRaw)), 0n);
  const currentEquity = args.balances.cashRaw + marks;
  const dayStartEquity = beforeDay ? dbRaw(beforeDay.equityRaw) : firstToday ? dbRaw(firstToday.equityRaw) : null;
  const peakStored = peakRow[0]?.peak ? dbRaw(peakRow[0].peak) : null;

  const since = new Date(args.now.getTime() - args.recentErrorWindowMs);
  const errors = await tx.execute<{ n: string }>(sql`
    select count(*)::text as n from ${orderAttempts} a join ${orders} o on o.id = a.order_id
    where o.portfolio_id = ${args.portfolioId} and a.error_code is not null and a.resolved_at >= ${since.toISOString()}
  `);

  const screening = (
    await tx
      .select()
      .from(screeningAssessments)
      .where(and(eq(screeningAssessments.mint, args.mint), isNotNull(screeningAssessments.expiresAt)))
      .orderBy(desc(screeningAssessments.assessedAt))
      .limit(1)
  )[0];

  return {
    now: args.now,
    mode: portfolio.mode as TradingMode,
    entriesPaused: portfolio.entriesPaused,
    submissionsPaused: portfolio.submissionsPaused,
    cashRaw: args.balances.cashRaw,
    reservedRaw: args.balances.reservedRaw,
    solLamports: args.balances.solLamports,
    solReservedLamports: args.balances.solReservedLamports,
    positions: pos.map((x) => ({ mint: x.mint, status: x.status, quantityRaw: dbRaw(x.quantityRaw), costBasisRaw: dbRaw(x.costBasisRaw) })),
    pendingOrders: pending.map((o) => ({ mint: o.mint, side: o.side as "BUY" | "SELL", state: o.state, reservedQuoteRaw: dbRaw(o.reservedQuoteRaw) })),
    dayStartEquityRaw: dayStartEquity,
    currentEquityRaw: currentEquity,
    peakEquityRaw: peakStored === null ? null : peakStored > currentEquity ? peakStored : currentEquity,
    recentExecutionErrors: Number(errors[0]?.n ?? 0),
    screening: screening ? { verdict: screening.verdict, expiresAt: screening.expiresAt } : null,
    latestDataAt: args.latestDataAt,
  };
}
