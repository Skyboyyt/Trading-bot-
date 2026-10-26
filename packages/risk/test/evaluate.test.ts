import { describe, expect, it } from "vitest";
import { USDC_MINT } from "@tb/domain";
import type { SwapQuote } from "@tb/providers";
import { evaluateOrder, PAPER_ILLUSTRATIVE_POLICY as P, riskPolicySchema, type OrderProposal, type RiskContext } from "../src/index.ts";

const NOW = new Date("2026-03-02T10:00:00Z");
const MINT = "Mint111111111111111111111111111111111111";

const quote = (inAmount: bigint, over: Partial<SwapQuote> = {}): SwapQuote => ({
  provider: "t", adapterVersion: "t", inputMint: USDC_MINT, outputMint: MINT, inAmountRaw: inAmount,
  outAmountRaw: 1_000_000n, minOutAmountRaw: 990_000n, slippageBps: 100, priceImpactBps: 50, feeBps: 0, feeMint: null,
  platformFee: null, signatureFeeLamports: 5_000n, prioritizationFeeLamports: 20_000n, rentFeeLamports: null,
  router: "t", routeLabels: [], requestId: null, ...over,
});

const ctx = (over: Partial<RiskContext> = {}): RiskContext => ({
  now: NOW, mode: "PAPER", entriesPaused: false, submissionsPaused: false,
  cashRaw: 1_000_000_000n, reservedRaw: 0n, solLamports: 100_000_000n, solReservedLamports: 0n,
  positions: [], pendingOrders: [], dayStartEquityRaw: 1_000_000_000n, currentEquityRaw: 1_000_000_000n,
  peakEquityRaw: 1_000_000_000n, recentExecutionErrors: 0,
  screening: { verdict: "PASS", expiresAt: new Date(NOW.getTime() + 60_000) }, latestDataAt: new Date(NOW.getTime() - 30_000),
  ...over,
});

const buy = (over: Partial<OrderProposal> = {}): OrderProposal => ({
  side: "BUY", purpose: "ENTRY", mint: MINT, notionalRaw: 10_000_000n, quote: quote(10_000_000n),
  quoteReceivedAt: new Date(NOW.getTime() - 2_000), networkFeeLamports: 25_000n, ...over,
});

const sell = (over: Partial<OrderProposal> = {}): OrderProposal => ({
  side: "SELL", purpose: "EXIT", mint: MINT, quantityRaw: 500n,
  quote: quote(500n, { inputMint: MINT, outputMint: USDC_MINT, priceImpactBps: 1_200, minOutAmountRaw: 980_000n }),
  quoteReceivedAt: new Date(NOW.getTime() - 2_000), networkFeeLamports: 25_000n, ...over,
});

const failed = (r: ReturnType<typeof evaluateOrder>) => r.checks.filter((c) => c.verdict !== "PASS").map((c) => c.id);
const holding = { mint: MINT, status: "OPEN", quantityRaw: 500n, costBasisRaw: 10_000_000n };

describe("risk evaluation: entries", () => {
  it("approves an entry that meets every limit", () => {
    const r = evaluateOrder(buy(), ctx(), P);
    expect(failed(r)).toEqual([]);
    expect(r.approved).toBe(true);
  });

  it("enforces size, exposure, concurrency and one position per token", () => {
    expect(failed(evaluateOrder(buy({ notionalRaw: 11_000_000n, quote: quote(11_000_000n) }), ctx(), P))).toContain("limit.order_notional");
    expect(failed(evaluateOrder(buy(), ctx({ positions: [holding] }), P))).toEqual(expect.arrayContaining(["position.one_per_token", "limit.token_exposure"]));
    const others = ["A", "B", "C"].map((m) => ({ ...holding, mint: m }));
    expect(failed(evaluateOrder(buy(), ctx({ positions: others }), P))).toEqual(expect.arrayContaining(["limit.aggregate_exposure", "limit.concurrent_positions"]));
  });

  it("counts pending entries towards exposure", () => {
    const pending = [
      { mint: "A", side: "BUY" as const, state: "RESERVED", reservedQuoteRaw: 10_000_000n },
      { mint: "B", side: "BUY" as const, state: "SUBMITTED", reservedQuoteRaw: 10_000_000n },
      { mint: "C", side: "BUY" as const, state: "PREPARED", reservedQuoteRaw: 10_000_000n },
    ];
    expect(failed(evaluateOrder(buy(), ctx({ pendingOrders: pending }), P))).toEqual(expect.arrayContaining(["limit.aggregate_exposure", "orders.pending"]));
  });

  it("blocks entries while any order outcome is unknown", () => {
    const pending = [{ mint: "A", side: "BUY" as const, state: "UNKNOWN", reservedQuoteRaw: 10_000_000n }];
    expect(failed(evaluateOrder(buy(), ctx({ pendingOrders: pending }), P))).toContain("orders.unknown");
  });

  it("pauses on daily loss including unrealised losses, and on drawdown", () => {
    expect(failed(evaluateOrder(buy(), ctx({ currentEquityRaw: 980_000_000n }), P))).toContain("loss.daily");
    expect(failed(evaluateOrder(buy(), ctx({ currentEquityRaw: 985_000_000n, dayStartEquityRaw: 985_000_000n, peakEquityRaw: 1_100_000_000n }), P))).toContain("loss.drawdown");
  });

  it("fails closed on missing or stale inputs", () => {
    expect(failed(evaluateOrder(buy(), ctx({ screening: null }), P))).toContain("screening");
    expect(failed(evaluateOrder(buy(), ctx({ screening: { verdict: "UNKNOWN", expiresAt: new Date(NOW.getTime() + 1) } }), P))).toContain("screening");
    expect(failed(evaluateOrder(buy(), ctx({ screening: { verdict: "PASS", expiresAt: new Date(NOW.getTime() - 1) } }), P))).toContain("screening");
    expect(failed(evaluateOrder(buy(), ctx({ latestDataAt: null }), P))).toContain("data.freshness");
    expect(failed(evaluateOrder(buy(), ctx({ dayStartEquityRaw: null }), P))).toContain("loss.daily");
    expect(failed(evaluateOrder(buy({ quoteReceivedAt: new Date(NOW.getTime() - 60_000) }), ctx(), P))).toContain("quote.age");
    expect(failed(evaluateOrder(buy({ quote: quote(10_000_000n, { priceImpactBps: null }) }), ctx(), P))).toContain("quote.price_impact");
    expect(failed(evaluateOrder(buy({ networkFeeLamports: null }), ctx(), P))).toContain("fee.network");
    expect(failed(evaluateOrder(buy({ quote: null }), ctx(), P))).toContain("quote.present");
  });

  it("bounds slippage, fees and the SOL reserve", () => {
    expect(failed(evaluateOrder(buy({ quote: quote(10_000_000n, { minOutAmountRaw: 900_000n }) }), ctx(), P))).toContain("quote.slippage");
    expect(failed(evaluateOrder(buy({ networkFeeLamports: 300_000n }), ctx(), P))).toContain("fee.network");
    expect(failed(evaluateOrder(buy(), ctx({ solLamports: 20_010_000n }), P))).toContain("fee.sol_reserve");
  });

  it("never approves LIVE in this build", () => {
    expect(failed(evaluateOrder(buy(), ctx({ mode: "LIVE" }), P))).toContain("mode");
  });
});

describe("risk evaluation: exits", () => {
  it("exits are not blocked by entry-only rules", () => {
    const r = evaluateOrder(
      sell(),
      ctx({ positions: [holding], entriesPaused: true, screening: null, latestDataAt: null, dayStartEquityRaw: null, currentEquityRaw: 1n, solLamports: 30_000n }),
      P,
    );
    expect(failed(r)).toEqual([]);
  });

  it("exits still obey the global pause and bounded slippage and fees", () => {
    expect(failed(evaluateOrder(sell(), ctx({ positions: [holding], submissionsPaused: true }), P))).toContain("operator.submissions");
    expect(failed(evaluateOrder(sell({ quote: quote(500n, { inputMint: MINT, outputMint: USDC_MINT, minOutAmountRaw: 500_000n }) }), ctx({ positions: [holding] }), P))).toContain("quote.slippage");
    expect(failed(evaluateOrder(sell({ networkFeeLamports: 10_000_000n }), ctx({ positions: [holding] }), P))).toContain("fee.network");
  });

  it("cannot sell more than held or without a position", () => {
    expect(failed(evaluateOrder(sell({ quantityRaw: 501n, quote: quote(501n, { inputMint: MINT, outputMint: USDC_MINT, priceImpactBps: 10 }) }), ctx({ positions: [holding] }), P))).toContain("exit.quantity");
    expect(failed(evaluateOrder(sell(), ctx(), P))).toContain("exit.position");
  });
});

describe("risk policy schema", () => {
  it("has no defaults: every value must be given explicitly", () => {
    expect(() => riskPolicySchema.parse({ label: "live" })).toThrow();
    expect(riskPolicySchema.parse(P)).toEqual(P);
  });
});
