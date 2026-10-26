/**
 * Shared setup for paper-trading scenario tests. All prices here are SYNTHETIC.
 */
import { newId, ManualClock, USDC_MINT, orderIdempotencyKey, type Clock } from "@tb/domain";
import { riskPolicies, screeningAssessments, type Db, type DbOrTx } from "@tb/db";
import { takeSnapshot } from "@tb/ledger";
import { DEFAULT_FILL_MODEL, PaperExecutor, PaperReconciler, type FillModelParams } from "@tb/execution-paper";
import { PAPER_ILLUSTRATIVE_POLICY, proposeAndReserve, type RiskPolicy } from "@tb/risk";
import type { Observed, QuoteRequest, SwapProvider, SwapQuote } from "@tb/providers";
import { createPortfolio, createToken } from "./db.ts";

/** Deterministic fake swap router: price is USDC (6 dp) per whole token. */
export class FakeSwap implements SwapProvider {
  readonly name = "fake-swap";
  calls: QuoteRequest[] = [];
  failNext = 0;
  impactBps = 40;
  priorityFeeLamports: bigint | null = 20_000n;
  /** Base units of USDC per 1 whole token, scaled by 1e6 (i.e. micro-USDC per token). */
  priceMicroUsdc: bigint;
  constructor(
    private readonly clock: Clock,
    private readonly tokenDecimals: Map<string, number>,
    priceMicroUsdc = 20n,
  ) {
    this.priceMicroUsdc = priceMicroUsdc;
  }

  async getQuote(req: QuoteRequest): Promise<Observed<SwapQuote>> {
    this.calls.push(req);
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("synthetic quote failure");
    }
    const buying = req.inputMint === USDC_MINT;
    const mint = buying ? req.outputMint : req.inputMint;
    const d = this.tokenDecimals.get(mint) ?? 6;
    const scale = 10n ** BigInt(d);
    const gross = buying ? (req.amountRaw * scale) / this.priceMicroUsdc : (req.amountRaw * this.priceMicroUsdc) / scale;
    const out = (gross * BigInt(10_000 - this.impactBps)) / 10_000n;
    const slippage = BigInt(req.slippageBps ?? 50);
    const now = this.clock.now();
    return {
      data: {
        provider: this.name,
        adapterVersion: "fake@1",
        inputMint: req.inputMint,
        outputMint: req.outputMint,
        inAmountRaw: req.amountRaw,
        outAmountRaw: out,
        minOutAmountRaw: (out * (10_000n - slippage)) / 10_000n,
        slippageBps: Number(slippage),
        priceImpactBps: this.impactBps,
        feeBps: 0,
        feeMint: null,
        platformFee: null,
        signatureFeeLamports: 5_000n,
        prioritizationFeeLamports: this.priorityFeeLamports,
        rentFeeLamports: null,
        router: "synthetic",
        routeLabels: ["Synthetic"],
        requestId: newId(),
      },
      meta: { network: "solana-mainnet", provider: this.name, eventAt: now, receivedAt: now, sourceSlot: null, parserVersion: "fake@1", raw: {} },
    };
  }
}

/** A model with no randomness unless a test turns a behaviour on. */
export const DETERMINISTIC_MODEL: FillModelParams = {
  ...DEFAULT_FILL_MODEL,
  latencyMs: { min: 1_000, max: 1_000 },
  lateConfirmationProbability: 0,
  dropProbability: 0,
  landedFailureProbability: 0,
  priceDriftBpsPerSqrtSecond: 0,
  adverseDriftBps: 0,
  impactModelErrorFactor: 0,
  liquidityWithdrawalProbability: 0,
  feeSpikeProbability: 0,
  rollbackProbability: 0,
};

export interface PaperHarness {
  clock: ManualClock;
  portfolio: { id: string; mode: "PAPER" };
  token: { id: string; mint: string; decimals: number };
  policy: { id: string; params: RiskPolicy };
  swap: FakeSwap;
  executor: PaperExecutor;
  reconciler: PaperReconciler;
  model: FillModelParams;
  /** Run the entry pipeline for a BUY of `notional` at the current clock time. */
  buy(notional?: bigint, opts?: { signalAt?: Date }): ReturnType<typeof proposeAndReserve>;
  sell(quantity: bigint, opts?: { purpose?: "EXIT" | "LIQUIDATION" }): ReturnType<typeof proposeAndReserve>;
  /** Advance the clock and reconcile until nothing changes. */
  settle(ms?: number): Promise<void>;
  passScreening(mint?: string): Promise<void>;
}

export async function paperHarness(db: Db, opts: { model?: Partial<FillModelParams>; policy?: Partial<RiskPolicy>; start?: string; decimals?: number; crashAfter?: "PREPARED" | "SUBMITTING" } = {}): Promise<PaperHarness> {
  const clock = new ManualClock(opts.start ?? "2026-03-02T10:00:00Z");
  const portfolio = (await createPortfolio(db, { usdc: 1_000_000_000n, sol: 100_000_000n, at: clock.now() })) as { id: string; mode: "PAPER" };
  const token = await createToken(db, { decimals: opts.decimals ?? 6 });
  const params: RiskPolicy = { ...PAPER_ILLUSTRATIVE_POLICY, ...opts.policy };
  const policyId = newId();
  await db.insert(riskPolicies).values({ id: policyId, portfolioId: portfolio.id, mode: "PAPER", version: 1, label: params.label, params, active: true, createdBy: "test" });
  await db.transaction((tx) => takeSnapshot(tx, { portfolioId: portfolio.id, mode: "PAPER", baseMint: USDC_MINT, at: clock.now() }));
  const swap = new FakeSwap(clock, new Map([[token.mint, token.decimals]]));
  const model = { ...DETERMINISTIC_MODEL, ...opts.model };
  const executor = new PaperExecutor({ db, swap, clock, model, baseMint: USDC_MINT, maxExitFailures: 3, crashAfter: opts.crashAfter });
  const reconciler = new PaperReconciler({ db, clock, model, baseMint: USDC_MINT, maxExitFailures: 3, stalePreparedMs: 30_000, solPriceRaw: async () => 150_000_000n });
  const policy = { id: policyId, params };

  const passScreening = async (mint = token.mint) => {
    await db.insert(screeningAssessments).values({
      id: newId(), tokenId: token.id, network: "solana-mainnet", mint, verdict: "PASS", checks: [], intendedSizeRaw: "10000000",
      screenerVersion: "test", inputs: {}, assessedAt: clock.now(), expiresAt: new Date(clock.now().getTime() + 3_600_000),
    });
  };

  const propose = async (side: "BUY" | "SELL", amount: bigint, purpose: "ENTRY" | "EXIT" | "LIQUIDATION", signalAt: Date) => {
    const q = await swap.getQuote({
      inputMint: side === "BUY" ? USDC_MINT : token.mint,
      outputMint: side === "BUY" ? token.mint : USDC_MINT,
      amountRaw: amount,
      slippageBps: side === "BUY" ? params.maxSlippageBps : params.maxExitSlippageBps,
    });
    return db.transaction((tx: DbOrTx) =>
      proposeAndReserve(tx, {
        portfolioId: portfolio.id,
        tokenId: token.id,
        proposal: {
          side,
          purpose,
          mint: token.mint,
          notionalRaw: side === "BUY" ? amount : undefined,
          quantityRaw: side === "SELL" ? amount : undefined,
          quote: q.data,
          quoteReceivedAt: q.meta.receivedAt,
          networkFeeLamports: (q.data.signatureFeeLamports ?? 0n) + (q.data.prioritizationFeeLamports ?? 0n),
        },
        idempotencyKey: orderIdempotencyKey({ portfolioId: portfolio.id, strategyVersion: "test@1", mint: token.mint, signalAt, side }),
        reason: `${purpose.toLowerCase()} test`,
        policy,
        latestDataAt: clock.now(),
        actor: "test",
        now: clock.now(),
      }),
    );
  };

  return {
    clock,
    portfolio,
    token,
    policy,
    swap,
    executor,
    reconciler,
    model,
    passScreening,
    buy: (notional = 10_000_000n, o = {}) => propose("BUY", notional, "ENTRY", o.signalAt ?? clock.now()),
    sell: (quantity, o = {}) => propose("SELL", quantity, o.purpose ?? "EXIT", clock.now()),
    settle: async (ms = 20_000) => {
      clock.advance(ms);
      for (let i = 0; i < 5; i++) {
        const s = await reconciler.reconcileAll();
        if (s.transitions.length === 0) break;
      }
    },
  };
}
