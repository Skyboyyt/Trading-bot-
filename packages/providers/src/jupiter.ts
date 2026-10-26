/**
 * Jupiter Swap API v2 adapter, quote-only.
 *
 * Verified against developers.jup.ag (October 2026): `GET /swap/v2/order` without `taker`
 * returns a quote and `transaction: null`. Keyless access is limited to 0.5 requests/second;
 * a free API key (x-api-key header) allows 1 request/second. `outAmount` is what the taker
 * would receive; fees are reported separately and must not be subtracted again.
 *
 * Paper mode never sends `taker`, so no transaction is ever built. If a response contains a
 * transaction anyway, the adapter refuses it.
 */
import { z } from "zod";
import { Dec, parseDec } from "@tb/domain";
import { HttpClient, ProviderError, type HttpClientOptions } from "./http.ts";
import type { Observed, QuoteRequest, SwapProvider, SwapQuote } from "./types.ts";

export const JUPITER_ADAPTER_VERSION = "jupiter-swap-v2@1";
const PROVIDER = "jupiter";

const u64 = z.string().regex(/^\d+$/);
const optNum = z.number().finite().nullable().optional();

const orderSchema = z
  .object({
    inputMint: z.string(),
    outputMint: z.string(),
    inAmount: u64,
    outAmount: u64,
    otherAmountThreshold: u64.optional(),
    swapMode: z.string().optional(),
    slippageBps: optNum,
    priceImpact: optNum,
    priceImpactPct: z.string().nullable().optional(),
    routePlan: z
      .array(z.object({ swapInfo: z.object({ ammKey: z.string(), label: z.string().optional() }).passthrough() }).passthrough())
      .optional(),
    feeBps: optNum,
    feeMint: z.string().nullable().optional(),
    platformFee: z
      .object({ amount: u64.optional(), feeBps: optNum, feeMint: z.string().nullable().optional() })
      .nullable()
      .optional(),
    signatureFeeLamports: optNum,
    prioritizationFeeLamports: optNum,
    rentFeeLamports: optNum,
    router: z.string().nullable().optional(),
    transaction: z.string().nullable().optional(),
    requestId: z.string().optional(),
    errorCode: z.number().optional(),
    errorMessage: z.string().optional(),
    error: z.string().optional(),
  })
  .passthrough();

export interface JupiterOptions extends Omit<HttpClientOptions, "provider" | "baseUrl" | "headers"> {
  baseUrl: string;
  apiKey?: string;
}

export class JupiterQuoteProvider implements SwapProvider {
  readonly name = PROVIDER;
  readonly http: HttpClient;

  constructor(options: JupiterOptions) {
    this.http = new HttpClient({
      ...options,
      provider: PROVIDER,
      headers: options.apiKey ? { "x-api-key": options.apiKey } : undefined,
    });
  }

  async getQuote(req: QuoteRequest): Promise<Observed<SwapQuote>> {
    if (req.amountRaw <= 0n) throw new Error("quote amount must be positive");
    const res = await this.http.get("/order", {
      inputMint: req.inputMint,
      outputMint: req.outputMint,
      amount: req.amountRaw.toString(),
      swapMode: "ExactIn",
      slippageBps: req.slippageBps?.toString(),
    });
    const quote = parseJupiterOrder(res.body, req);
    return {
      data: quote,
      meta: {
        network: "solana-mainnet",
        provider: PROVIDER,
        eventAt: res.receivedAt,
        receivedAt: res.receivedAt,
        sourceSlot: null,
        parserVersion: JUPITER_ADAPTER_VERSION,
        raw: res.body,
      },
    };
  }
}

/** Exported for fixture tests. Validates the response against the request it answers. */
export function parseJupiterOrder(body: unknown, req: QuoteRequest): SwapQuote {
  const parsed = orderSchema.safeParse(body);
  if (!parsed.success) throw new ProviderError(PROVIDER, "PARSE", "unexpected /order response shape");
  const o = parsed.data;
  if (o.error || o.errorMessage) throw new ProviderError(PROVIDER, "HTTP", `order error: ${(o.errorMessage ?? o.error ?? "").slice(0, 200)}`);
  if (o.transaction) {
    throw new ProviderError(PROVIDER, "PARSE", "quote response unexpectedly contained a transaction; refusing it");
  }
  if (o.inputMint !== req.inputMint || o.outputMint !== req.outputMint) {
    throw new ProviderError(PROVIDER, "PARSE", "quote mints do not match the request");
  }
  const inAmountRaw = BigInt(o.inAmount);
  if (inAmountRaw !== req.amountRaw) throw new ProviderError(PROVIDER, "PARSE", "quote input amount does not match the request");
  const outAmountRaw = BigInt(o.outAmount);
  if (outAmountRaw <= 0n) throw new ProviderError(PROVIDER, "PARSE", "quote output amount is zero");
  const minOut = o.otherAmountThreshold !== undefined ? BigInt(o.otherAmountThreshold) : outAmountRaw;
  if (minOut > outAmountRaw) throw new ProviderError(PROVIDER, "PARSE", "minimum output exceeds expected output");

  return {
    provider: PROVIDER,
    adapterVersion: JUPITER_ADAPTER_VERSION,
    inputMint: o.inputMint,
    outputMint: o.outputMint,
    inAmountRaw,
    outAmountRaw,
    minOutAmountRaw: minOut,
    slippageBps: o.slippageBps ?? null,
    priceImpactBps: impactBps(o.priceImpact, o.priceImpactPct),
    feeBps: o.feeBps ?? null,
    feeMint: o.feeMint ?? o.platformFee?.feeMint ?? null,
    platformFee: o.platformFee?.amount !== undefined ? { amountRaw: BigInt(o.platformFee.amount), mint: o.platformFee.feeMint ?? o.feeMint ?? null } : null,
    signatureFeeLamports: lamports(o.signatureFeeLamports),
    prioritizationFeeLamports: lamports(o.prioritizationFeeLamports),
    rentFeeLamports: lamports(o.rentFeeLamports),
    router: o.router ?? null,
    routeLabels: (o.routePlan ?? []).map((s) => String(s.swapInfo.label ?? s.swapInfo.ammKey)),
    requestId: o.requestId ?? null,
  };
}

/**
 * `priceImpact` is in percentage points (-0.1 = -0.1%); the deprecated `priceImpactPct` is a
 * decimal fraction. Returned as absolute basis points rounded up, or null if neither is given.
 */
function impactBps(points: number | null | undefined, pct: string | null | undefined): number | null {
  let fraction: Dec | null = null;
  if (typeof points === "number") fraction = parseDec(points).div(100);
  else if (typeof pct === "string" && pct.trim() !== "") fraction = parseDec(pct);
  if (!fraction) return null;
  return fraction.abs().mul(10_000).toDecimalPlaces(0, Dec.ROUND_CEIL).toNumber();
}

function lamports(v: number | null | undefined): bigint | null {
  if (v === null || v === undefined) return null;
  if (!Number.isSafeInteger(v) || v < 0) throw new ProviderError(PROVIDER, "PARSE", `invalid lamport value ${v}`);
  return BigInt(v);
}
