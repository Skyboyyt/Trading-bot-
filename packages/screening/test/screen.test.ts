import { describe, expect, it } from "vitest";
import { parseDec, SPL_TOKEN_PROGRAM_ID, SYSTEM_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, USDC_MINT } from "@tb/domain";
import type { MintAccount, PoolSnapshot, SwapQuote } from "@tb/providers";
import {
  classifyHolders,
  DEFAULT_SCREENING_POLICY,
  screenToken,
  type HolderBreakdown,
  type ScreeningInputs,
} from "../src/index.ts";

const NOW = new Date("2026-03-01T12:00:00Z");
const MINT = "Mint111111111111111111111111111111111111";
const POOL = "Pool1111111111111111111111111111111111111";
const ok = <T>(value: T, receivedAt = new Date(NOW.getTime() - 2_000)) => ({ ok: true as const, value, receivedAt });

const mintAccount: MintAccount = {
  mint: MINT,
  programId: SPL_TOKEN_PROGRAM_ID,
  dataLength: 82,
  decoded: { mintAuthority: null, supplyRaw: 1_000_000_000_000n, decimals: 6, isInitialized: true, freezeAuthority: null },
  layoutError: null,
};

const pool: PoolSnapshot = {
  poolAddress: POOL,
  baseMint: MINT,
  quoteMint: USDC_MINT,
  dexId: "raydium",
  poolCreatedAt: new Date("2026-02-01T00:00:00Z"),
  reserveUsd: parseDec("250000"),
  basePriceUsd: parseDec("0.00002"),
  quotePriceUsd: parseDec("1"),
  volumeUsd: { m5: null, h1: parseDec("20000"), h24: null },
  transactions: { m5: null, h1: { buys: 120, sells: 110, buyers: 80, sellers: 70 }, h24: null },
};

const holders: HolderBreakdown = {
  supplyRaw: 1_000_000_000_000n,
  groups: [],
  walletTop10Bps: 1_800,
  walletMaxBps: 400,
  poolBps: 2_500,
  unverifiedBps: 300,
  sharedOwners: [],
  accountsExamined: 20,
};

function quote(input: string, output: string, inAmount: bigint, outAmount: bigint, impact: number | null = 30): SwapQuote {
  return {
    provider: "jupiter", adapterVersion: "test", inputMint: input, outputMint: output, inAmountRaw: inAmount,
    outAmountRaw: outAmount, minOutAmountRaw: outAmount, slippageBps: 50, priceImpactBps: impact, feeBps: 10,
    feeMint: null, platformFee: null, signatureFeeLamports: 5000n, prioritizationFeeLamports: 10_000n,
    rentFeeLamports: null, router: "metis", routeLabels: ["Raydium"], requestId: "r",
  };
}

function inputs(overrides: Partial<ScreeningInputs> = {}): ScreeningInputs {
  return {
    network: "solana-mainnet",
    mint: MINT,
    intendedSizeRaw: 10_000_000n,
    quoteMint: USDC_MINT,
    mintAccount: ok(mintAccount),
    holders: ok(holders),
    pool: ok(pool),
    reserveHistory: [{ at: new Date(NOW.getTime() - 60 * 60_000), reserveUsd: "240000" }],
    closedCandleCount: 500,
    entryQuote: ok(quote(USDC_MINT, MINT, 10_000_000n, 500_000_000_000n)),
    exitQuote: ok(quote(MINT, USDC_MINT, 500_000_000_000n, 9_850_000n)),
    ...overrides,
  };
}

const run = (o: Partial<ScreeningInputs> = {}, policy = DEFAULT_SCREENING_POLICY) => screenToken(inputs(o), policy, NOW);
const check = (r: ReturnType<typeof run>, id: string) => r.checks.find((c) => c.id === id);

describe("screening", () => {
  it("passes a token that meets every configured check, with an expiry", () => {
    const r = run();
    expect(r.checks.filter((c) => c.verdict !== "PASS")).toEqual([]);
    expect(r.verdict).toBe("PASS");
    expect(r.expiresAt.getTime() - NOW.getTime()).toBe(DEFAULT_SCREENING_POLICY.assessmentTtlMs);
    expect(r.policyHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("rejects active mint and freeze authorities", () => {
    const withAuth = { ...mintAccount, decoded: { ...mintAccount.decoded!, mintAuthority: POOL, freezeAuthority: POOL } };
    const r = run({ mintAccount: ok(withAuth) });
    expect(r.verdict).toBe("REJECT");
    expect(check(r, "mint.mint_authority")?.verdict).toBe("REJECT");
    expect(check(r, "mint.freeze_authority")?.verdict).toBe("REJECT");
  });

  it("rejects Token-2022 and unknown programs until extensions are parsed", () => {
    expect(check(run({ mintAccount: ok({ ...mintAccount, programId: TOKEN_2022_PROGRAM_ID }) }), "mint.program")?.reason).toMatch(/Token-2022/);
    expect(run({ mintAccount: ok({ ...mintAccount, programId: SYSTEM_PROGRAM_ID }) }).verdict).toBe("REJECT");
  });

  it("rejects malformed layouts and unsupported decimals", () => {
    expect(run({ mintAccount: ok({ ...mintAccount, decoded: null, layoutError: "bad", dataLength: 90 }) }).verdict).toBe("REJECT");
    expect(check(run({ mintAccount: ok({ ...mintAccount, decoded: { ...mintAccount.decoded!, decimals: 19 } }) }), "mint.decimals")?.verdict).toBe("REJECT");
  });

  it("returns UNKNOWN, never PASS, when data is missing", () => {
    expect(run({ mintAccount: { ok: false, error: "timeout" } }).verdict).toBe("UNKNOWN");
    expect(run({ holders: { ok: false, error: "rpc down" } }).verdict).toBe("UNKNOWN");
    expect(run({ pool: ok(null) }).verdict).toBe("UNKNOWN");
    expect(run({ closedCandleCount: null }).verdict).toBe("UNKNOWN");
    expect(run({ reserveHistory: [] }).verdict).toBe("UNKNOWN");
    expect(run({ pool: ok({ ...pool, reserveUsd: null }) }).verdict).toBe("UNKNOWN");
    expect(run({ pool: ok({ ...pool, poolCreatedAt: null }) }).verdict).toBe("UNKNOWN");
    expect(run({ pool: ok({ ...pool, transactions: { m5: null, h1: null, h24: null } }) }).verdict).toBe("UNKNOWN");
  });

  it("treats stale observations as UNKNOWN", () => {
    expect(run({ pool: ok(pool, new Date(NOW.getTime() - 10 * 60_000)) }).verdict).toBe("UNKNOWN");
    const staleQuote = ok(quote(USDC_MINT, MINT, 10_000_000n, 500_000_000_000n), new Date(NOW.getTime() - 60_000));
    expect(check(run({ entryQuote: staleQuote }), "quote.entry")?.verdict).toBe("UNKNOWN");
  });

  it("rejects young pools, thin liquidity and sudden liquidity drops", () => {
    expect(check(run({ pool: ok({ ...pool, poolCreatedAt: new Date(NOW.getTime() - 30 * 60_000) }) }), "market.age")?.verdict).toBe("REJECT");
    expect(check(run({ pool: ok({ ...pool, reserveUsd: parseDec("9000") }) }), "market.liquidity")?.verdict).toBe("REJECT");
    const drop = run({ reserveHistory: [{ at: new Date(NOW.getTime() - 61 * 60_000), reserveUsd: "600000" }] });
    expect(check(drop, "market.liquidity_change")?.verdict).toBe("REJECT");
  });

  it("rejects a pool that does not contain the mint", () => {
    expect(check(run({ pool: ok({ ...pool, baseMint: USDC_MINT, quoteMint: POOL }) }), "market.pool")?.verdict).toBe("REJECT");
  });

  it("flags one-sided order flow", () => {
    const r = run({ pool: ok({ ...pool, transactions: { m5: null, h1: { buys: 45, sells: 0, buyers: 30, sellers: 0 }, h24: null } }) });
    expect(check(r, "activity.sell_flow")?.verdict).toBe("REJECT");
  });

  it("checks quotes at the position size in both directions", () => {
    expect(check(run({ entryQuote: ok(quote(USDC_MINT, MINT, 10_000_000n, 1n, 900)) }), "quote.entry")?.verdict).toBe("REJECT");
    expect(check(run({ entryQuote: ok(quote(USDC_MINT, MINT, 10_000_000n, 1n, null)) }), "quote.entry")?.verdict).toBe("UNKNOWN");
    expect(check(run({ entryQuote: ok(quote(USDC_MINT, MINT, 5_000_000n, 1n)) }), "quote.entry")?.verdict).toBe("UNKNOWN");
    const costly = run({ exitQuote: ok(quote(MINT, USDC_MINT, 500_000_000_000n, 9_000_000n)) });
    expect(check(costly, "quote.round_trip_cost")?.verdict).toBe("REJECT");
    const partialExit = run({ exitQuote: ok(quote(MINT, USDC_MINT, 1_000n, 9_900_000n)) });
    expect(check(partialExit, "quote.exit")?.verdict).toBe("UNKNOWN");
    expect(run({ exitQuote: { ok: false, error: "no route" } }).verdict).toBe("UNKNOWN");
  });

  it("never states a probability of loss", () => {
    const text = JSON.stringify(run().checks);
    expect(text).not.toMatch(/chance|probability|safe to/i);
  });
});

describe("holder classification", () => {
  const wallet = (n: number) => `Wallet${String(n).padStart(36, "1")}`;
  const supplyRaw = 1_000_000n;

  it("groups accounts by owner, excludes pools and measures wallets", () => {
    const largest = [
      { address: "acctPool", amountRaw: 400_000n, decimals: 6 },
      { address: "acctA1", amountRaw: 60_000n, decimals: 6 },
      { address: "acctA2", amountRaw: 50_000n, decimals: 6 },
      { address: "acctB", amountRaw: 30_000n, decimals: 6 },
      { address: "acctPda", amountRaw: 20_000n, decimals: 6 },
    ];
    const owners = [
      { tokenAccount: "acctPool", owner: "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1", mint: MINT, amountRaw: 400_000n },
      { tokenAccount: "acctA1", owner: wallet(1), mint: MINT, amountRaw: 60_000n },
      { tokenAccount: "acctA2", owner: wallet(1), mint: MINT, amountRaw: 50_000n },
      { tokenAccount: "acctB", owner: wallet(2), mint: MINT, amountRaw: 30_000n },
      { tokenAccount: "acctPda", owner: "SomePda", mint: MINT, amountRaw: 20_000n },
    ];
    const ownerPrograms = [
      { address: "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1", ownerProgram: null, executable: false },
      { address: wallet(1), ownerProgram: SYSTEM_PROGRAM_ID, executable: false },
      { address: wallet(2), ownerProgram: SYSTEM_PROGRAM_ID, executable: false },
      { address: "SomePda", ownerProgram: null, executable: false },
    ];
    const h = classifyHolders({ supplyRaw, largest, owners, ownerPrograms, mint: MINT, poolAddresses: [POOL] });
    expect(h.poolBps).toBe(4000);
    expect(h.walletMaxBps).toBe(1100); // shared owner aggregated: 60k + 50k
    expect(h.walletTop10Bps).toBe(1400);
    expect(h.unverifiedBps).toBe(200);
    expect(h.sharedOwners).toEqual([{ owner: wallet(1), accounts: 2 }]);
  });

  it("never treats a System Program wallet as a pool, even at a known authority address", () => {
    const authority = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1";
    const h = classifyHolders({
      supplyRaw,
      largest: [{ address: "a", amountRaw: 500_000n, decimals: 6 }],
      owners: [{ tokenAccount: "a", owner: authority, mint: MINT, amountRaw: 500_000n }],
      ownerPrograms: [{ address: authority, ownerProgram: SYSTEM_PROGRAM_ID, executable: false }],
      mint: MINT,
      poolAddresses: [],
    });
    expect(h.groups[0]?.class).toBe("wallet");
    expect(h.walletMaxBps).toBe(5000);
  });

  it("ignores owner records for a different mint", () => {
    const h = classifyHolders({
      supplyRaw,
      largest: [{ address: "a", amountRaw: 500_000n, decimals: 6 }],
      owners: [{ tokenAccount: "a", owner: wallet(3), mint: USDC_MINT, amountRaw: 500_000n }],
      ownerPrograms: [{ address: wallet(3), ownerProgram: SYSTEM_PROGRAM_ID, executable: false }],
      mint: MINT,
      poolAddresses: [],
    });
    expect(h.groups[0]?.class).toBe("unverified");
  });
});
