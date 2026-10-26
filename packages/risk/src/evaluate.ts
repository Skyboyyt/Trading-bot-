/**
 * Pure pre-trade risk evaluation. The same function runs in live paper trading (inside the
 * reservation transaction) and in replays, so both enforce identical rules.
 *
 * Exposure is measured at cost: we assume any token can go to zero. Unrealised losses count
 * against the daily loss and drawdown limits through conservative marks. Missing inputs fail
 * closed. Exits are never blocked by entry-only rules (screening, entry pause, exposure, loss
 * limits), but they are still bounded: no unbounded slippage and no unbounded fees.
 */
import { ratioBps, type CheckResult, type TradingMode } from "@tb/domain";
import type { SwapQuote } from "@tb/providers";
import type { RiskPolicy } from "./policy.ts";

export interface RiskContext {
  now: Date;
  mode: TradingMode;
  entriesPaused: boolean;
  submissionsPaused: boolean;
  cashRaw: bigint;
  reservedRaw: bigint;
  solLamports: bigint;
  solReservedLamports: bigint;
  positions: readonly { mint: string; status: string; quantityRaw: bigint; costBasisRaw: bigint }[];
  /** Orders not yet terminal, excluding the one being evaluated. */
  pendingOrders: readonly { mint: string; side: "BUY" | "SELL"; state: string; reservedQuoteRaw: bigint }[];
  /** Equity at the start of the UTC day and now (conservative marks); null if unknown. */
  dayStartEquityRaw: bigint | null;
  currentEquityRaw: bigint | null;
  peakEquityRaw: bigint | null;
  recentExecutionErrors: number;
  screening: { verdict: string; expiresAt: Date } | null;
  latestDataAt: Date | null;
}

export interface OrderProposal {
  side: "BUY" | "SELL";
  purpose: "ENTRY" | "EXIT" | "LIQUIDATION";
  mint: string;
  /** BUY: quote spend. */
  notionalRaw?: bigint;
  /** SELL: token units. */
  quantityRaw?: bigint;
  quote: SwapQuote | null;
  quoteReceivedAt: Date | null;
  networkFeeLamports: bigint | null;
}

export interface RiskEvaluation {
  approved: boolean;
  checks: CheckResult[];
}

const ok = (id: string, reason: string, evidence?: Record<string, unknown>): CheckResult => ({ id, verdict: "PASS", reason, evidence });
const no = (id: string, reason: string, evidence?: Record<string, unknown>): CheckResult => ({ id, verdict: "REJECT", reason, evidence });
const unk = (id: string, reason: string): CheckResult => ({ id, verdict: "UNKNOWN", reason });

export const ACTIVE_POSITION_STATUSES = new Set(["OPEN", "CLOSING", "STRANDED"]);

export function evaluateOrder(p: OrderProposal, ctx: RiskContext, policy: RiskPolicy): RiskEvaluation {
  const checks: CheckResult[] = [];
  const isEntry = p.purpose === "ENTRY";

  checks.push(ctx.mode === "PAPER" ? ok("mode", "PAPER mode: simulated execution only") : no("mode", "LIVE execution is disabled in this build"));
  checks.push(ctx.submissionsPaused ? no("operator.submissions", "All submissions are paused by the operator") : ok("operator.submissions", "Submissions enabled"));
  if (isEntry) checks.push(ctx.entriesPaused ? no("operator.entries", "Entries are paused") : ok("operator.entries", "Entries enabled"));

  checks.push(...quoteChecks(p, ctx, policy));

  const fee = p.networkFeeLamports;
  const maxFee = BigInt(policy.maxNetworkFeeLamports);
  const availableSol = ctx.solLamports - ctx.solReservedLamports;
  if (fee === null) checks.push(unk("fee.network", "Network fee estimate unavailable"));
  else if (fee > maxFee) checks.push(no("fee.network", `Network fee ${fee} lamports exceeds limit ${maxFee}`));
  else checks.push(ok("fee.network", `Network fee estimate ${fee} lamports`));
  if (fee !== null) {
    const reserve = isEntry ? BigInt(policy.minSolReserveLamports) : 0n;
    checks.push(
      availableSol - fee >= reserve
        ? ok("fee.sol_reserve", `SOL available ${availableSol} lamports covers fee and reserve`)
        : no("fee.sol_reserve", `SOL available ${availableSol} lamports cannot cover fee ${fee} plus reserve ${reserve}`),
    );
  }

  const unknownOrders = ctx.pendingOrders.filter((o) => o.state === "UNKNOWN" || o.state === "MANUAL_REVIEW");
  const sameMintPending = ctx.pendingOrders.filter((o) => o.mint === p.mint);
  if (sameMintPending.length > 0) checks.push(no("orders.same_token", "Another order for this token is still pending"));
  if (isEntry) {
    if (unknownOrders.length > 0) checks.push(no("orders.unknown", `${unknownOrders.length} order(s) have an unknown outcome; entries wait for reconciliation`));
    if (ctx.pendingOrders.length >= policy.maxPendingOrders) checks.push(no("orders.pending", `${ctx.pendingOrders.length} orders pending (limit ${policy.maxPendingOrders})`));
    else checks.push(ok("orders.pending", `${ctx.pendingOrders.length} orders pending`));
    checks.push(
      ctx.recentExecutionErrors > policy.maxRecentExecutionErrors
        ? no("execution.errors", `${ctx.recentExecutionErrors} recent execution errors`)
        : ok("execution.errors", `${ctx.recentExecutionErrors} recent execution errors`),
    );
    checks.push(...entryChecks(p, ctx, policy));
  } else {
    checks.push(...exitChecks(p, ctx));
  }

  return { approved: checks.every((c) => c.verdict === "PASS"), checks };
}

function quoteChecks(p: OrderProposal, ctx: RiskContext, policy: RiskPolicy): CheckResult[] {
  const out: CheckResult[] = [];
  const q = p.quote;
  if (!q || !p.quoteReceivedAt) return [unk("quote.present", "No fresh quote for this order")];
  const age = ctx.now.getTime() - p.quoteReceivedAt.getTime();
  out.push(age >= 0 && age <= policy.maxQuoteAgeMs ? ok("quote.age", `Quote ${Math.round(age / 1000)}s old`) : no("quote.age", `Quote is ${Math.round(age / 1000)}s old (limit ${policy.maxQuoteAgeMs / 1000}s)`));

  const amount = p.side === "BUY" ? p.notionalRaw : p.quantityRaw;
  if (amount === undefined || amount <= 0n || q.inAmountRaw !== amount) out.push(no("quote.matches", "Quote does not match the order size"));
  const isEntry = p.purpose === "ENTRY";
  const maxImpact = isEntry ? policy.maxEntryPriceImpactBps : policy.maxExitPriceImpactBps;
  if (q.priceImpactBps === null) out.push(unk("quote.price_impact", "Price impact unknown"));
  else out.push(q.priceImpactBps <= maxImpact ? ok("quote.price_impact", `Impact ${q.priceImpactBps} bps`) : no("quote.price_impact", `Impact ${q.priceImpactBps} bps exceeds ${maxImpact}`));

  const maxSlip = isEntry ? policy.maxSlippageBps : policy.maxExitSlippageBps;
  const slip = q.outAmountRaw > 0n ? Number(ratioBps(q.outAmountRaw - q.minOutAmountRaw, q.outAmountRaw, "floor")) : Infinity;
  out.push(slip <= maxSlip ? ok("quote.slippage", `Minimum output within ${slip} bps`) : no("quote.slippage", `Slippage tolerance ${slip} bps exceeds ${maxSlip}`));
  return out;
}

function entryChecks(p: OrderProposal, ctx: RiskContext, policy: RiskPolicy): CheckResult[] {
  const out: CheckResult[] = [];
  const notional = p.notionalRaw ?? 0n;
  if (p.side !== "BUY") return [no("entry.side", "Entries must be buys")];

  const s = ctx.screening;
  if (!s) out.push(unk("screening", "No screening assessment"));
  else if (s.expiresAt.getTime() < ctx.now.getTime()) out.push(no("screening", "Screening assessment expired"));
  else out.push(s.verdict === "PASS" ? ok("screening", "Passed configured screening checks") : no("screening", `Screening verdict ${s.verdict}`));

  if (!ctx.latestDataAt) out.push(unk("data.freshness", "No market data timestamp"));
  else {
    const age = ctx.now.getTime() - ctx.latestDataAt.getTime();
    out.push(age <= policy.maxDataAgeMs ? ok("data.freshness", `Market data ${Math.round(age / 1000)}s old`) : no("data.freshness", `Market data is ${Math.round(age / 1000)}s old`));
  }

  const maxOrder = BigInt(policy.maxOrderNotionalRaw);
  out.push(notional > 0n && notional <= maxOrder ? ok("limit.order_notional", `Order ${notional} within ${maxOrder}`) : no("limit.order_notional", `Order ${notional} exceeds ${maxOrder}`));

  const active = ctx.positions.filter((x) => ACTIVE_POSITION_STATUSES.has(x.status));
  const held = active.find((x) => x.mint === p.mint);
  if (held) out.push(no("position.one_per_token", "Already holding this token"));

  const pendingEntries = ctx.pendingOrders.filter((o) => o.side === "BUY");
  const pendingFor = (mint?: string) => pendingEntries.filter((o) => !mint || o.mint === mint).reduce((t, o) => t + o.reservedQuoteRaw, 0n);
  const tokenExposure = (held?.costBasisRaw ?? 0n) + pendingFor(p.mint) + notional;
  const maxToken = BigInt(policy.maxTokenExposureRaw);
  out.push(tokenExposure <= maxToken ? ok("limit.token_exposure", `Token exposure ${tokenExposure}`) : no("limit.token_exposure", `Token exposure ${tokenExposure} exceeds ${maxToken}`));

  const aggregate = active.reduce((t, x) => t + x.costBasisRaw, 0n) + pendingFor() + notional;
  const maxAgg = BigInt(policy.maxAggregateExposureRaw);
  out.push(aggregate <= maxAgg ? ok("limit.aggregate_exposure", `Aggregate exposure ${aggregate}`) : no("limit.aggregate_exposure", `Aggregate exposure ${aggregate} exceeds ${maxAgg}`));

  const concurrent = active.length + pendingEntries.length;
  out.push(
    concurrent < policy.maxConcurrentPositions
      ? ok("limit.concurrent_positions", `${concurrent} positions open or pending`)
      : no("limit.concurrent_positions", `${concurrent} positions open or pending (limit ${policy.maxConcurrentPositions})`),
  );

  const available = ctx.cashRaw - ctx.reservedRaw;
  out.push(available >= notional ? ok("cash.available", `Available ${available}`) : no("cash.available", `Available ${available} < ${notional}`));

  if (ctx.dayStartEquityRaw === null || ctx.currentEquityRaw === null) out.push(unk("loss.daily", "Daily P&L unknown"));
  else {
    const loss = ctx.dayStartEquityRaw - ctx.currentEquityRaw;
    const limit = BigInt(policy.dailyLossPauseRaw);
    out.push(loss < limit ? ok("loss.daily", `Today's loss ${loss > 0n ? loss : 0n}`) : no("loss.daily", `Today's loss ${loss} reached the pause limit ${limit}`));
  }
  if (ctx.peakEquityRaw === null || ctx.currentEquityRaw === null) out.push(unk("loss.drawdown", "Drawdown unknown"));
  else {
    const dd = ctx.peakEquityRaw > 0n && ctx.currentEquityRaw < ctx.peakEquityRaw ? Number(ratioBps(ctx.peakEquityRaw - ctx.currentEquityRaw, ctx.peakEquityRaw, "ceil")) : 0;
    out.push(dd < policy.maxDrawdownBps ? ok("loss.drawdown", `Drawdown ${dd} bps`) : no("loss.drawdown", `Drawdown ${dd} bps reached the limit ${policy.maxDrawdownBps}`));
  }
  return out;
}

function exitChecks(p: OrderProposal, ctx: RiskContext): CheckResult[] {
  if (p.side !== "SELL") return [no("exit.side", "Exits must be sells")];
  const pos = ctx.positions.find((x) => x.mint === p.mint && ACTIVE_POSITION_STATUSES.has(x.status));
  if (!pos) return [no("exit.position", "No open position to exit")];
  const qty = p.quantityRaw ?? 0n;
  return [qty > 0n && qty <= pos.quantityRaw ? ok("exit.quantity", `Selling ${qty} of ${pos.quantityRaw}`) : no("exit.quantity", `Cannot sell ${qty} of ${pos.quantityRaw}`)];
}
