import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import { SPL_TOKEN_PROGRAM_ID, USDC_MINT } from "@tb/domain";
import {
  decodeMint,
  encodeMint,
  GeckoTerminalProvider,
  parseJupiterOrder,
  parseOhlcv,
  ProviderError,
  SolanaRpcReader,
} from "../src/index.ts";

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../../../tests/fixtures/providers/${name}`, import.meta.url), "utf8"));

const TOKEN = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const buyReq = { inputMint: USDC_MINT, outputMint: TOKEN, amountRaw: 10_000_000n };

describe("Jupiter order parsing", () => {
  it("parses a quote-only order with exact amounts and fees", () => {
    const q = parseJupiterOrder(fixture("jupiter-order-buy.json"), buyReq);
    expect(q.inAmountRaw).toBe(10_000_000n);
    expect(q.outAmountRaw).toBe(512_345_678_901n);
    expect(q.minOutAmountRaw).toBe(509_784_000_000n);
    expect(q.priceImpactBps).toBe(8); // 0.0712% -> 7.12 bps, rounded up
    expect(q.platformFee).toEqual({ amountRaw: 512_858_537n, mint: TOKEN });
    expect(q.signatureFeeLamports).toBe(5000n);
    expect(q.prioritizationFeeLamports).toBe(46_000n);
    expect(q.routeLabels).toEqual(["Raydium CLMM"]);
  });

  it("refuses any response that carries a transaction", () => {
    const body = { ...(fixture("jupiter-order-buy.json") as object), transaction: "AQAAAA==" };
    expect(() => parseJupiterOrder(body, buyReq)).toThrow(/refusing/);
  });

  it("rejects quotes that do not answer the request", () => {
    expect(() => parseJupiterOrder(fixture("jupiter-order-buy.json"), { ...buyReq, amountRaw: 9n })).toThrow(ProviderError);
    expect(() => parseJupiterOrder(fixture("jupiter-order-buy.json"), { ...buyReq, outputMint: USDC_MINT })).toThrow(ProviderError);
  });

  it("rejects malformed amounts and impossible thresholds", () => {
    const base = fixture("jupiter-order-buy.json") as Record<string, unknown>;
    expect(() => parseJupiterOrder({ ...base, outAmount: "1.5" }, buyReq)).toThrow(ProviderError);
    expect(() => parseJupiterOrder({ ...base, outAmount: "0" }, buyReq)).toThrow(/zero/);
    expect(() => parseJupiterOrder({ ...base, otherAmountThreshold: "999999999999999" }, buyReq)).toThrow(/minimum output/);
    expect(() => parseJupiterOrder({ ...base, signatureFeeLamports: -1 }, buyReq)).toThrow(ProviderError);
  });

  it("reports unknown price impact as null, never zero", () => {
    const base = fixture("jupiter-order-buy.json") as Record<string, unknown>;
    const q = parseJupiterOrder({ ...base, priceImpact: undefined, priceImpactPct: undefined }, buyReq);
    expect(q.priceImpactBps).toBeNull();
    const legacy = parseJupiterOrder({ ...base, priceImpact: undefined, priceImpactPct: "0.0125" }, buyReq);
    expect(legacy.priceImpactBps).toBe(125);
  });
});

describe("GeckoTerminal parsing", () => {
  it("parses pool snapshots with exact decimals", async () => {
    const provider = new GeckoTerminalProvider({
      baseUrl: "https://gt.example.test/api/v2",
      requestsPerSecond: 100,
      fetchImpl: (async () => new Response(JSON.stringify(fixture("geckoterminal-pool.json")), { status: 200 })) as typeof fetch,
    });
    const { data, meta } = await provider.getPool("Pool1111111111111111111111111111111111111");
    expect(data.baseMint).toBe("Mint111111111111111111111111111111111111");
    expect(data.quoteMint).toBe(USDC_MINT);
    expect(data.reserveUsd?.toFixed()).toBe("245310.42");
    expect(data.basePriceUsd?.toFixed()).toBe("0.0000195123");
    expect(data.transactions.h1).toEqual({ buys: 160, sells: 131, buyers: 97, sellers: 88 });
    expect(data.poolCreatedAt?.toISOString()).toBe("2026-02-01T08:30:00.000Z");
    expect(meta.provider).toBe("geckoterminal");
    expect(meta.parserVersion).toMatch(/geckoterminal@/);
  });

  it("drops impossible candles, keeps missing volume as null and sorts oldest first", () => {
    const candles = parseOhlcv(fixture("geckoterminal-ohlcv.json"));
    expect(candles.map((c) => c.openTime.getTime() / 1000)).toEqual([1772360460, 1772360520, 1772360580, 1772360640]);
    expect(candles[0]!.volumeUsd).toBeNull();
    expect(candles[1]!.high.toFixed()).toBe("0.0000194");
    expect(candles[3]!.closeTime.getTime() - candles[3]!.openTime.getTime()).toBe(60_000);
  });
});

describe("SPL mint layout", () => {
  const key = () => bs58.encode(randomBytes(32));

  it("round-trips authorities, supply and decimals", () => {
    const m = { mintAuthority: key(), supplyRaw: 18_446_744_073_709_551_615n, decimals: 9, isInitialized: true, freezeAuthority: null };
    expect(decodeMint(encodeMint(m))).toEqual(m);
  });

  it("rejects wrong lengths and malformed option tags", () => {
    expect(decodeMint(new Uint8Array(165))).toEqual({ error: "unexpected mint data length 165" });
    const bytes = encodeMint({ mintAuthority: null, supplyRaw: 1n, decimals: 6, isInitialized: true, freezeAuthority: null });
    bytes[0] = 7;
    expect(decodeMint(bytes)).toEqual({ error: "invalid mint_authority option tag" });
  });
});

describe("Solana RPC reader", () => {
  function rpc(result: unknown, error?: { code: number; message: string }) {
    return new SolanaRpcReader({
      url: "https://rpc.example.test",
      requestsPerSecond: 100,
      maxRetries: 0,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, ...(error ? { error } : { result }) }), { status: 200 })) as typeof fetch,
    });
  }

  it("decodes mint accounts from raw bytes and records the slot", async () => {
    const authority = bs58.encode(randomBytes(32));
    const data = Buffer.from(encodeMint({ mintAuthority: null, supplyRaw: 1_000n, decimals: 6, isInitialized: true, freezeAuthority: authority })).toString("base64");
    const reader = rpc({ context: { slot: 321 }, value: { data: [data, "base64"], executable: false, lamports: 1, owner: SPL_TOKEN_PROGRAM_ID, space: 82 } });
    const { data: mint, meta } = await reader.getMintAccount(TOKEN);
    expect(mint?.programId).toBe(SPL_TOKEN_PROGRAM_ID);
    expect(mint?.decoded?.freezeAuthority).toBe(authority);
    expect(mint?.decoded?.mintAuthority).toBeNull();
    expect(meta.sourceSlot).toBe(321n);
  });

  it("returns null for missing accounts", async () => {
    const reader = rpc({ context: { slot: 1 }, value: null });
    expect((await reader.getMintAccount(TOKEN)).data).toBeNull();
  });

  it("maps JSON-RPC errors to typed provider errors", async () => {
    await expect(rpc(undefined, { code: -32005, message: "rate limited" }).getSlot()).rejects.toMatchObject({ kind: "RATE_LIMITED" });
    await expect(rpc(undefined, { code: -32602, message: "invalid param" }).getSlot()).rejects.toMatchObject({ kind: "RPC" });
    await expect(rpc({ unexpected: true }).getSlot()).rejects.toMatchObject({ kind: "PARSE" });
  });
});
