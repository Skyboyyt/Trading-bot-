/**
 * GeckoTerminal market data adapter (MarketDataProvider).
 *
 * Chosen after checking coverage and limits (see docs/providers.md): it covers Solana DEX pools
 * including memecoin venues, exposes pool reserves, transaction counts, creation time and
 * minute OHLCV, and works keyless at roughly 10 calls/minute. The same paths are served by the
 * keyed CoinGecko on-chain API (`/api/v3/onchain`) for higher limits.
 *
 * Token names, symbols and metadata from this source are untrusted and are never used for
 * identity; we only use addresses, numbers and timestamps. No metadata URLs are fetched.
 */
import { z } from "zod";
import { tryParseDec, type Dec } from "@tb/domain";
import { HttpClient, ProviderError, type HttpClientOptions } from "./http.ts";
import type { Candle, CandleRequest, MarketDataProvider, Observed, PoolSnapshot, TxCounts } from "./types.ts";

export const GECKOTERMINAL_PARSER_VERSION = "geckoterminal@1";
const NETWORK_ID = "solana";

const numLike = z.union([z.string(), z.number()]).nullable().optional();
const txCounts = z
  .object({ buys: z.number().int().nonnegative(), sells: z.number().int().nonnegative(), buyers: z.number().int().nullable().optional(), sellers: z.number().int().nullable().optional() })
  .nullable()
  .optional();
const relId = z.object({ data: z.object({ id: z.string() }).nullable().optional() }).optional();

const poolSchema = z.object({
  id: z.string(),
  type: z.literal("pool"),
  attributes: z.object({
    address: z.string(),
    base_token_price_usd: numLike,
    quote_token_price_usd: numLike,
    pool_created_at: z.string().nullable().optional(),
    reserve_in_usd: numLike,
    volume_usd: z.object({ m5: numLike, h1: numLike, h24: numLike }).partial().nullable().optional(),
    transactions: z.object({ m5: txCounts, h1: txCounts, h24: txCounts }).partial().nullable().optional(),
  }),
  relationships: z.object({ base_token: relId, quote_token: relId, dex: relId }).optional(),
});

const ohlcvSchema = z.object({
  data: z.object({
    attributes: z.object({
      ohlcv_list: z.array(z.tuple([z.number(), numLike, numLike, numLike, numLike, numLike]).rest(z.unknown())),
    }),
  }),
});

export interface GeckoTerminalOptions extends Omit<HttpClientOptions, "provider" | "baseUrl" | "headers"> {
  baseUrl: string;
  apiKeyHeader?: { name: string; value: string } | null;
}

export class GeckoTerminalProvider implements MarketDataProvider {
  readonly name = "geckoterminal";
  readonly http: HttpClient;

  constructor(options: GeckoTerminalOptions) {
    const headers: Record<string, string> = { accept: "application/json;version=20230203" };
    if (options.apiKeyHeader) headers[options.apiKeyHeader.name] = options.apiKeyHeader.value;
    this.http = new HttpClient({ ...options, provider: this.name, headers });
  }

  async getPool(poolAddress: string): Promise<Observed<PoolSnapshot>> {
    const res = await this.http.get(`/networks/${NETWORK_ID}/pools/${encodeURIComponent(poolAddress)}`);
    const body = z.object({ data: poolSchema }).safeParse(res.body);
    if (!body.success) throw new ProviderError(this.name, "PARSE", "unexpected pool response");
    return { data: toPool(body.data.data), meta: this.#meta(res.receivedAt, res.body) };
  }

  async getTokenPools(mint: string): Promise<Observed<PoolSnapshot[]>> {
    const res = await this.http.get(`/networks/${NETWORK_ID}/tokens/${encodeURIComponent(mint)}/pools`);
    const body = z.object({ data: z.array(z.unknown()) }).safeParse(res.body);
    if (!body.success) throw new ProviderError(this.name, "PARSE", "unexpected token pools response");
    const pools: PoolSnapshot[] = [];
    for (const item of body.data.data) {
      const p = poolSchema.safeParse(item);
      if (p.success) pools.push(toPool(p.data));
    }
    return { data: pools, meta: this.#meta(res.receivedAt, res.body) };
  }

  async getMinuteCandles(req: CandleRequest): Promise<Observed<Candle[]>> {
    const res = await this.http.get(`/networks/${NETWORK_ID}/pools/${encodeURIComponent(req.poolAddress)}/ohlcv/minute`, {
      aggregate: "1",
      limit: String(Math.min(req.limit ?? 100, 1000)),
      currency: "usd",
      token: req.tokenSide,
      before_timestamp: req.beforeTimestamp ? String(Math.floor(req.beforeTimestamp.getTime() / 1000)) : undefined,
    });
    return { data: parseOhlcv(res.body, this.name), meta: this.#meta(res.receivedAt, res.body) };
  }

  #meta(receivedAt: Date, raw: unknown) {
    return {
      network: "solana-mainnet" as const,
      provider: this.name,
      eventAt: receivedAt,
      receivedAt,
      sourceSlot: null,
      parserVersion: GECKOTERMINAL_PARSER_VERSION,
      raw,
    };
  }
}

/**
 * Parse an OHLCV list into validated candles, oldest first. Rows with impossible values
 * (non-positive prices, high below low, duplicates) are dropped rather than repaired.
 */
export function parseOhlcv(body: unknown, provider = "geckoterminal"): Candle[] {
  const parsed = ohlcvSchema.safeParse(body);
  if (!parsed.success) throw new ProviderError(provider, "PARSE", "unexpected OHLCV response");
  const seen = new Set<number>();
  const candles: Candle[] = [];
  for (const row of parsed.data.data.attributes.ohlcv_list) {
    const [ts, o, h, l, c, v] = row;
    if (!Number.isInteger(ts) || ts <= 0 || seen.has(ts)) continue;
    const open = dec(o);
    const high = dec(h);
    const low = dec(l);
    const close = dec(c);
    if (!open || !high || !low || !close) continue;
    if (low.lte(0) || high.lt(low) || high.lt(open) || high.lt(close) || low.gt(open) || low.gt(close)) continue;
    const volume = dec(v);
    seen.add(ts);
    candles.push({
      openTime: new Date(ts * 1000),
      closeTime: new Date((ts + 60) * 1000),
      open,
      high,
      low,
      close,
      volumeUsd: volume && volume.gte(0) ? volume : null,
    });
  }
  return candles.sort((a, b) => a.openTime.getTime() - b.openTime.getTime());
}

function toPool(p: z.infer<typeof poolSchema>): PoolSnapshot {
  const a = p.attributes;
  const created = a.pool_created_at ? new Date(a.pool_created_at) : null;
  return {
    poolAddress: a.address,
    baseMint: stripNetwork(p.relationships?.base_token?.data?.id),
    quoteMint: stripNetwork(p.relationships?.quote_token?.data?.id),
    dexId: p.relationships?.dex?.data?.id ?? null,
    poolCreatedAt: created && !Number.isNaN(created.getTime()) ? created : null,
    reserveUsd: dec(a.reserve_in_usd),
    basePriceUsd: dec(a.base_token_price_usd),
    quotePriceUsd: dec(a.quote_token_price_usd),
    volumeUsd: { m5: dec(a.volume_usd?.m5), h1: dec(a.volume_usd?.h1), h24: dec(a.volume_usd?.h24) },
    transactions: { m5: tx(a.transactions?.m5), h1: tx(a.transactions?.h1), h24: tx(a.transactions?.h24) },
  };
}

function tx(t: z.infer<typeof txCounts>): TxCounts | null {
  if (!t) return null;
  return { buys: t.buys, sells: t.sells, buyers: t.buyers ?? null, sellers: t.sellers ?? null };
}

function stripNetwork(id: string | undefined): string {
  if (!id) return "";
  return id.startsWith(`${NETWORK_ID}_`) ? id.slice(NETWORK_ID.length + 1) : id;
}

function dec(v: unknown): Dec | null {
  if (v === null || v === undefined || v === "") return null;
  return tryParseDec(v);
}
