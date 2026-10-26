/**
 * Historical replay and strategy evaluation.
 *
 * Replays run the SAME strategy (evaluateEntry/evaluateExit), the SAME risk evaluator and the
 * SAME fill model as live paper trading, against stored candles with an injected clock that only
 * moves forward. Each decision at time t sees only candles observed at or before t.
 *
 * Limitations (written into every report):
 *  - Historical Jupiter quotes do not exist, so quotes are approximated from the price of the
 *    minute containing the execution time, a size-dependent impact model and fees. Fills are
 *    therefore approximate.
 *  - Screening cannot be replayed point-in-time (holder lists and authorities change), so the
 *    replay assumes the token passed screening for the whole window.
 *  - Survivorship: a token universe chosen today omits tokens that died earlier.
 *  - USD prices are treated as USDC at par.
 */
import { Dec, MINUTE_MS, ratioBps, USDC_DECIMALS, USDC_MINT, newId, type Dec as DecT } from "@tb/domain";
import { applyAcquisition, applyDisposal } from "@tb/ledger";
import type { SwapQuote } from "@tb/providers";
import { evaluateOrder, type RiskContext, type RiskPolicy } from "@tb/risk";
import { evaluateEntry, evaluateExit, strategyVersionTag, type BreakoutRetestParams, type StrategyCandle } from "@tb/strategy";
import { simulateExecution, type FillModelParams } from "./fill-model.ts";

export const REPLAY_ENGINE_VERSION = "replay-v1";

export interface QuoteModel {
  /** Fixed impact applied to every trade. */
  baseImpactBps: number;
  /** Additional impact per $1,000 of notional. */
  impactBpsPer1kUsd: number;
  platformFeeBps: number;
  slippageBps: number;
}

export const DEFAULT_QUOTE_MODEL: QuoteModel = { baseImpactBps: 30, impactBpsPer1kUsd: 40, platformFeeBps: 10, slippageBps: 100 };

export interface ReplayToken {
  mint: string;
  decimals: number;
  candles: readonly StrategyCandle[];
}

export interface ReplayConfig {
  tokens: readonly ReplayToken[];
  params: BreakoutRetestParams;
  policy: RiskPolicy;
  model: FillModelParams;
  quoteModel: QuoteModel;
  initialCashRaw: bigint;
  initialSolLamports: bigint;
  /** USDC base units per SOL, for reporting network fees in dollars. */
  solPriceRaw: bigint;
  from: Date;
  to: Date;
}

export interface ReplayTrade {
  mint: string;
  openedAt: string;
  closedAt: string;
  costRaw: string;
  proceedsRaw: string;
  pnlRaw: string;
  exitReason: string;
}

export interface ReplayMetrics {
  startEquityRaw: string;
  endEquityRaw: string;
  totalPnlRaw: string;
  returnBps: number;
  trades: number;
  wins: number;
  losses: number;
  winRateBps: number | null;
  averageWinRaw: string | null;
  averageLossRaw: string | null;
  /** Gross profit / gross loss, as a decimal string; null when there were no losses. */
  profitFactor: string | null;
  expectancyRaw: string | null;
  maxDrawdownBps: number;
  networkFeesLamports: string;
  networkFeesUsdRaw: string;
  platformFeesRaw: string;
  timeInMarketBps: number;
  signals: number;
  riskRejections: Record<string, number>;
  executionFailures: number;
  openAtEndRaw: string;
  buyAndHoldReturnBps: number | null;
  cashReturnBps: 0;
}

export interface ReplayResult {
  engineVersion: string;
  strategyVersion: string;
  window: { from: string; to: string };
  metrics: ReplayMetrics;
  trades: ReplayTrade[];
  equityCurve: { at: string; equityRaw: string }[];
}

interface OpenPosition {
  qty: bigint;
  cost: bigint;
  openedAt: Date;
  peak: bigint | null;
}

export function runReplay(cfg: ReplayConfig): ReplayResult {
  const version = strategyVersionTag(cfg.params);
  let cash = cfg.initialCashRaw;
  let sol = cfg.initialSolLamports;
  const positions = new Map<string, OpenPosition>();
  const trades: ReplayTrade[] = [];
  const curve: { at: string; equityRaw: string }[] = [];
  const rejections: Record<string, number> = {};
  const seenSignals = new Set<string>();
  const failureTimes: number[] = [];
  let signals = 0;
  let networkFees = 0n;
  let platformFees = 0n;
  let minutesInMarket = 0;
  let minutes = 0;
  let peak = cfg.initialCashRaw;
  let maxDd = 0;
  let dayStart: { day: number; equity: bigint } | null = null;
  let seq = 0;
  const startEquity = cfg.initialCashRaw;

  const byMint = new Map(cfg.tokens.map((t) => [t.mint, t]));
  const sorted = new Map(cfg.tokens.map((t) => [t.mint, [...t.candles].sort((a, b) => a.openTime.getTime() - b.openTime.getTime())]));

  /** Price of the minute containing t: that candle's open if it exists, else the last known close. */
  const priceAt = (mint: string, t: Date): DecT | null => {
    const cs = sorted.get(mint) ?? [];
    // Binary search for the last candle that opened at or before t.
    let lo = 0;
    let hi = cs.length - 1;
    let idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cs[mid]!.openTime.getTime() <= t.getTime()) {
        idx = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (idx === -1) return null;
    const c = cs[idx]!;
    return c.closeTime.getTime() > t.getTime() ? c.open : c.close;
  };
  /** Candles observed by time t (pointer per token; time only moves forward). */
  const seenIdx = new Map<string, number>();
  const visibleWindow = (mint: string, t: Date): StrategyCandle[] => {
    const cs = sorted.get(mint) ?? [];
    let i = seenIdx.get(mint) ?? 0;
    while (i < cs.length && cs[i]!.observedAt.getTime() <= t.getTime()) i++;
    seenIdx.set(mint, i);
    return cs.slice(Math.max(0, i - cfg.params.warmupBars - 10), i);
  };

  const quoteFor = (side: "BUY" | "SELL", mint: string, amount: bigint, t: Date): SwapQuote | null => {
    const token = byMint.get(mint)!;
    const price = priceAt(mint, t);
    if (!price || price.lte(0)) return null;
    return approximateQuote(side, mint, token.decimals, amount, price, cfg.quoteModel);
  };

  const markValue = (mint: string, qty: bigint, t: Date): bigint | null => {
    const q = quoteFor("SELL", mint, qty, t);
    return q ? q.outAmountRaw : null;
  };

  for (let t = new Date(Math.ceil(cfg.from.getTime() / MINUTE_MS) * MINUTE_MS); t <= cfg.to; t = new Date(t.getTime() + MINUTE_MS)) {
    const decisionAt = new Date(t.getTime() + 1_000);
    minutes++;
    if (positions.size > 0) minutesInMarket++;

    // Equity with conservative marks.
    let marks = 0n;
    for (const [mint, p] of positions) marks += markValue(mint, p.qty, decisionAt) ?? 0n;
    const equity = cash + marks;
    const day = Math.floor(decisionAt.getTime() / 86_400_000);
    if (!dayStart || dayStart.day !== day) dayStart = { day, equity };
    if (equity > peak) peak = equity;
    if (peak > 0n && equity < peak) maxDd = Math.max(maxDd, Number(ratioBps(peak - equity, peak, "ceil")));
    if (minutes % 15 === 1) curve.push({ at: decisionAt.toISOString(), equityRaw: equity.toString() });

    const recentFailures = failureTimes.filter((x) => x >= decisionAt.getTime() - cfg.policy.recentErrorWindowMs).length;
    const ctxBase = (mint: string): RiskContext => {
      const visible = visibleWindow(mint, decisionAt);
      return {
        now: decisionAt,
        mode: "PAPER",
        entriesPaused: false,
        submissionsPaused: false,
        cashRaw: cash,
        reservedRaw: 0n,
        solLamports: sol,
        solReservedLamports: 0n,
        positions: [...positions].map(([m, p]) => ({ mint: m, status: "OPEN", quantityRaw: p.qty, costBasisRaw: p.cost })),
        pendingOrders: [],
        dayStartEquityRaw: dayStart!.equity,
        currentEquityRaw: equity,
        peakEquityRaw: peak,
        recentExecutionErrors: recentFailures,
        screening: { verdict: "PASS", expiresAt: new Date(decisionAt.getTime() + 60_000) },
        latestDataAt: visible.length ? visible[visible.length - 1]!.observedAt : null,
      };
    };

    // Exits first.
    for (const [mint, p] of [...positions]) {
      const value = markValue(mint, p.qty, decisionAt);
      if (value !== null && (p.peak === null || value > p.peak)) p.peak = value;
      const ev = evaluateExit({ costBasisRaw: p.cost, exitValueRaw: value, peakValueRaw: p.peak, openedAt: p.openedAt }, cfg.params, decisionAt);
      if (!ev.exit) continue;
      const quote = quoteFor("SELL", mint, p.qty, decisionAt);
      const fee = BigInt(cfg.model.signatureFeeLamports + cfg.model.defaultPriorityFeeLamports);
      const risk = evaluateOrder({ side: "SELL", purpose: "EXIT", mint, quantityRaw: p.qty, quote, quoteReceivedAt: decisionAt, networkFeeLamports: fee }, ctxBase(mint), cfg.policy);
      if (!risk.approved || !quote) {
        for (const c of risk.checks) if (c.verdict !== "PASS") rejections[`exit:${c.id}`] = (rejections[`exit:${c.id}`] ?? 0) + 1;
        continue;
      }
      const sim = simulateExecution(
        { orderId: `replay-${++seq}`, attemptNo: 1, quoteOutRaw: quote.outAmountRaw, minOutRaw: quote.minOutAmountRaw, quoteImpactBps: quote.priceImpactBps ?? 0, quotePriorityFeeLamports: null, quoteReceivedAt: decisionAt, submittedAt: decisionAt, maxNetworkFeeLamports: BigInt(cfg.policy.maxNetworkFeeLamports) },
        cfg.model,
      );
      if (sim.outcome === "LANDED_FAILED") {
        sol -= BigInt(sim.networkFeeLamports);
        networkFees += BigInt(sim.networkFeeLamports);
      }
      if (sim.outcome !== "LANDED_SUCCESS") {
        failureTimes.push(decisionAt.getTime());
        continue;
      }
      const proceeds = BigInt(sim.fillOutRaw!);
      const d = applyDisposal({ quantityRaw: p.qty, costBasisRaw: p.cost }, p.qty, proceeds);
      cash += proceeds;
      sol -= BigInt(sim.networkFeeLamports);
      networkFees += BigInt(sim.networkFeeLamports);
      platformFees += (proceeds * BigInt(cfg.quoteModel.platformFeeBps)) / BigInt(10_000 - cfg.quoteModel.platformFeeBps);
      positions.delete(mint);
      trades.push({ mint, openedAt: p.openedAt.toISOString(), closedAt: decisionAt.toISOString(), costRaw: p.cost.toString(), proceedsRaw: proceeds.toString(), pnlRaw: d.realizedPnlRaw.toString(), exitReason: ev.reason });
    }

    // Entries.
    for (const token of cfg.tokens) {
      if (positions.has(token.mint)) continue;
      const ev = evaluateEntry(visibleWindow(token.mint, decisionAt), cfg.params, decisionAt);
      if (ev.kind !== "SIGNAL") continue;
      const key = `${token.mint}:${ev.signal.signalAt.toISOString()}`;
      if (seenSignals.has(key)) continue;
      seenSignals.add(key);
      signals++;
      const notional = BigInt(cfg.policy.maxOrderNotionalRaw);
      // The quote is taken at execution time, never at the signal candle's close.
      const quote = quoteFor("BUY", token.mint, notional, decisionAt);
      const fee = BigInt(cfg.model.signatureFeeLamports + cfg.model.defaultPriorityFeeLamports);
      const risk = evaluateOrder({ side: "BUY", purpose: "ENTRY", mint: token.mint, notionalRaw: notional, quote, quoteReceivedAt: decisionAt, networkFeeLamports: fee }, ctxBase(token.mint), cfg.policy);
      if (!risk.approved || !quote) {
        for (const c of risk.checks) if (c.verdict !== "PASS") rejections[c.id] = (rejections[c.id] ?? 0) + 1;
        continue;
      }
      const sim = simulateExecution(
        { orderId: `replay-${++seq}`, attemptNo: 1, quoteOutRaw: quote.outAmountRaw, minOutRaw: quote.minOutAmountRaw, quoteImpactBps: quote.priceImpactBps ?? 0, quotePriorityFeeLamports: null, quoteReceivedAt: decisionAt, submittedAt: decisionAt, maxNetworkFeeLamports: BigInt(cfg.policy.maxNetworkFeeLamports) },
        cfg.model,
      );
      if (sim.outcome === "LANDED_FAILED") {
        sol -= BigInt(sim.networkFeeLamports);
        networkFees += BigInt(sim.networkFeeLamports);
      }
      if (sim.outcome !== "LANDED_SUCCESS") {
        failureTimes.push(decisionAt.getTime());
        continue;
      }
      const qty = BigInt(sim.fillOutRaw!);
      const lot = applyAcquisition({ quantityRaw: 0n, costBasisRaw: 0n }, qty, notional);
      cash -= notional;
      sol -= BigInt(sim.networkFeeLamports);
      networkFees += BigInt(sim.networkFeeLamports);
      platformFees += (notional * BigInt(cfg.quoteModel.platformFeeBps)) / 10_000n;
      positions.set(token.mint, { qty: lot.quantityRaw, cost: lot.costBasisRaw, openedAt: decisionAt, peak: null });
    }
  }

  // Final valuation: open positions at conservative exit value.
  let openValue = 0n;
  for (const [mint, p] of positions) openValue += markValue(mint, p.qty, cfg.to) ?? 0n;
  const endEquity = cash + openValue;
  const pnls = trades.map((t) => BigInt(t.pnlRaw));
  const wins = pnls.filter((x) => x > 0n);
  const losses = pnls.filter((x) => x <= 0n);
  const grossWin = wins.reduce((a, b) => a + b, 0n);
  const grossLoss = -losses.reduce((a, b) => a + b, 0n);
  const avg = (xs: bigint[]) => (xs.length ? (xs.reduce((a, b) => a + b, 0n) / BigInt(xs.length)).toString() : null);

  return {
    engineVersion: REPLAY_ENGINE_VERSION,
    strategyVersion: version,
    window: { from: cfg.from.toISOString(), to: cfg.to.toISOString() },
    metrics: {
      startEquityRaw: startEquity.toString(),
      endEquityRaw: endEquity.toString(),
      totalPnlRaw: (endEquity - startEquity).toString(),
      returnBps: Number(ratioBps(endEquity - startEquity, startEquity, "trunc")),
      trades: trades.length,
      wins: wins.length,
      losses: losses.length,
      winRateBps: trades.length ? Math.floor((wins.length * 10_000) / trades.length) : null,
      averageWinRaw: avg(wins),
      averageLossRaw: avg(losses),
      profitFactor: grossLoss > 0n ? new Dec(grossWin.toString()).div(grossLoss.toString()).toDecimalPlaces(4).toFixed() : null,
      expectancyRaw: avg(pnls),
      maxDrawdownBps: maxDd,
      networkFeesLamports: networkFees.toString(),
      networkFeesUsdRaw: ((networkFees * cfg.solPriceRaw) / 1_000_000_000n).toString(),
      platformFeesRaw: platformFees.toString(),
      timeInMarketBps: minutes ? Math.floor((minutesInMarket * 10_000) / minutes) : 0,
      signals,
      riskRejections: rejections,
      executionFailures: failureTimes.length,
      openAtEndRaw: openValue.toString(),
      buyAndHoldReturnBps: buyAndHold(cfg),
      cashReturnBps: 0,
    },
    trades,
    equityCurve: curve,
  };
}

/** Equal-weight buy at the first open in the window, sell at the last close, with the same costs model. */
function buyAndHold(cfg: ReplayConfig): number | null {
  const rets: number[] = [];
  for (const t of cfg.tokens) {
    const inWindow = t.candles.filter((c) => c.openTime >= cfg.from && c.closeTime <= cfg.to);
    if (inWindow.length < 2) continue;
    const first = inWindow[0]!.open;
    const last = inWindow[inWindow.length - 1]!.close;
    const notional = BigInt(cfg.policy.maxOrderNotionalRaw);
    const qty = approximateQuote("BUY", t.mint, t.decimals, notional, first, cfg.quoteModel).outAmountRaw;
    const back = approximateQuote("SELL", t.mint, t.decimals, qty, last, cfg.quoteModel).outAmountRaw;
    rets.push(Number(ratioBps(back - notional, notional, "trunc")));
  }
  return rets.length ? Math.trunc(rets.reduce((a, b) => a + b, 0) / rets.length) : null;
}

export function approximateQuote(side: "BUY" | "SELL", mint: string, decimals: number, amountRaw: bigint, priceUsd: DecT, m: QuoteModel): SwapQuote {
  const tokenScale = new Dec(10).pow(decimals);
  const usdcScale = new Dec(10).pow(USDC_DECIMALS);
  const notionalUsd = side === "BUY" ? new Dec(amountRaw.toString()).div(usdcScale) : new Dec(amountRaw.toString()).div(tokenScale).mul(priceUsd);
  const impact = m.baseImpactBps + notionalUsd.div(1_000).mul(m.impactBpsPer1kUsd).ceil().toNumber();
  const keep = new Dec(10_000 - Math.min(9_999, impact + m.platformFeeBps)).div(10_000);
  const gross = side === "BUY" ? notionalUsd.div(priceUsd).mul(tokenScale) : notionalUsd.mul(usdcScale);
  const out = BigInt(gross.mul(keep).floor().toFixed(0));
  return {
    provider: "replay-approximation",
    adapterVersion: REPLAY_ENGINE_VERSION,
    inputMint: side === "BUY" ? USDC_MINT : mint,
    outputMint: side === "BUY" ? mint : USDC_MINT,
    inAmountRaw: amountRaw,
    outAmountRaw: out,
    minOutAmountRaw: (out * BigInt(10_000 - m.slippageBps)) / 10_000n,
    slippageBps: m.slippageBps,
    priceImpactBps: impact,
    feeBps: m.platformFeeBps,
    feeMint: null,
    platformFee: null,
    signatureFeeLamports: null,
    prioritizationFeeLamports: null,
    rentFeeLamports: null,
    router: "approximation",
    routeLabels: [],
    requestId: newId(),
  };
}

// ---------------------------------------------------------------------------------------------
// Chronological evaluation
// ---------------------------------------------------------------------------------------------

export interface ExperimentConfig extends Omit<ReplayConfig, "params" | "from" | "to"> {
  /** Every candidate parameter set. All of them are recorded, not just the winner. */
  grid: readonly BreakoutRetestParams[];
  from: Date;
  to: Date;
  /** Chronological split fractions; the remainder is the untouched test window. */
  trainFraction: number;
  validationFraction: number;
  datasetTag: "real" | "synthetic";
  datasetVersion: string;
}

export interface Trial {
  params: BreakoutRetestParams;
  strategyVersion: string;
  split: "train" | "validation" | "test";
  metrics: ReplayMetrics;
}

export interface ExperimentReport {
  label: string;
  datasetTag: "real" | "synthetic";
  datasetVersion: string;
  engineVersion: string;
  splits: { train: [string, string]; validation: [string, string]; test: [string, string] };
  selection: { rule: string; selectedStrategyVersion: string | null };
  trials: Trial[];
  test: ReplayResult | null;
  limitations: string[];
  generatedAt: string;
}

export const REPORT_LIMITATIONS = [
  "Fills are approximate: historical Jupiter quotes are unavailable, so quotes are modelled from the price of the minute containing each execution, a size-dependent impact model and fees.",
  "Screening is assumed to pass for the whole window; point-in-time holder lists and authorities cannot be replayed.",
  "Survivorship bias: a token list chosen today excludes tokens that already failed.",
  "USD prices are treated as USDC at par.",
  "A high win rate can still lose money if losses are larger than wins; read profit factor, expectancy and drawdown, not win rate alone.",
  "Past or simulated results do not predict future results. No probability of profit or loss is implied.",
];

export function runExperiment(cfg: ExperimentConfig): ExperimentReport {
  const span = cfg.to.getTime() - cfg.from.getTime();
  const at = (f: number) => new Date(cfg.from.getTime() + Math.floor((span * f) / MINUTE_MS) * MINUTE_MS);
  const trainEnd = at(cfg.trainFraction);
  const valEnd = at(cfg.trainFraction + cfg.validationFraction);
  const windows = { train: [cfg.from, trainEnd], validation: [trainEnd, valEnd], test: [valEnd, cfg.to] } as const;
  // Each window replays with history before it available for warm-up but trades only inside it.
  const replay = (params: BreakoutRetestParams, [from, to]: readonly [Date, Date]) => runReplay({ ...cfg, params, from, to });

  const trials: Trial[] = [];
  let best: { params: BreakoutRetestParams; score: bigint } | null = null;
  for (const params of cfg.grid) {
    const train = replay(params, windows.train);
    const validation = replay(params, windows.validation);
    trials.push({ params, strategyVersion: train.strategyVersion, split: "train", metrics: train.metrics });
    trials.push({ params, strategyVersion: validation.strategyVersion, split: "validation", metrics: validation.metrics });
    // Selection uses validation P&L only; the test window is never looked at while choosing.
    const score = BigInt(validation.metrics.totalPnlRaw);
    if (validation.metrics.trades > 0 && (!best || score > best.score)) best = { params, score };
  }
  let test: ReplayResult | null = null;
  if (best) {
    test = replay(best.params, windows.test);
    trials.push({ params: best.params, strategyVersion: test.strategyVersion, split: "test", metrics: test.metrics });
  }
  const iso = (w: readonly [Date, Date]): [string, string] => [w[0].toISOString(), w[1].toISOString()];
  return {
    label: cfg.datasetTag === "synthetic" ? "SIMULATED ON SYNTHETIC DATA — not market results" : "SIMULATED PAPER REPLAY on stored market data — approximate fills, not real trading results",
    datasetTag: cfg.datasetTag,
    datasetVersion: cfg.datasetVersion,
    engineVersion: REPLAY_ENGINE_VERSION,
    splits: { train: iso(windows.train), validation: iso(windows.validation), test: iso(windows.test) },
    selection: { rule: "highest validation P&L among parameter sets with at least one trade; test evaluated once", selectedStrategyVersion: best ? strategyVersionTag(best.params) : null },
    trials,
    test,
    limitations: REPORT_LIMITATIONS,
    generatedAt: new Date().toISOString(),
  };
}
