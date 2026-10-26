/**
 * Token screening: PASS / REJECT / UNKNOWN per network + mint.
 *
 * Pure function over already-fetched inputs, so it is deterministic and testable. Any input
 * that could not be fetched, is stale, or is ambiguous yields UNKNOWN for that check, and
 * UNKNOWN blocks entries exactly like REJECT. A PASS only means the token met the configured
 * checks at that moment; it is not a statement that the token is safe, and no probability of
 * loss is ever derived from it.
 */
import {
  combineVerdicts,
  isSupportedDecimals,
  parseDec,
  ratioBps,
  SPL_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  type CheckResult,
  type Verdict,
} from "@tb/domain";
import type { MintAccount, PoolSnapshot, SwapQuote } from "@tb/providers";
import type { HolderBreakdown } from "./holders.ts";
import { policyHash, SCREENER_VERSION, type ScreeningPolicy } from "./policy.ts";

export type Fetched<T> = { ok: true; value: T; receivedAt: Date } | { ok: false; error: string };

export interface ScreeningInputs {
  network: "solana-mainnet";
  mint: string;
  /** Entry size in quote (USDC) base units the quotes were taken for. */
  intendedSizeRaw: bigint;
  quoteMint: string;
  mintAccount: Fetched<MintAccount | null>;
  holders: Fetched<HolderBreakdown>;
  pool: Fetched<PoolSnapshot | null>;
  /** Earlier stored reserve observations for the same pool (any order). */
  reserveHistory: readonly { at: Date; reserveUsd: string }[] | null;
  closedCandleCount: number | null;
  entryQuote: Fetched<SwapQuote>;
  exitQuote: Fetched<SwapQuote>;
}

export interface ScreeningResult {
  network: string;
  mint: string;
  verdict: Verdict;
  checks: CheckResult[];
  screenerVersion: string;
  policyHash: string;
  assessedAt: Date;
  expiresAt: Date;
}

const pass = (id: string, reason: string, evidence?: Record<string, unknown>): CheckResult => ({ id, verdict: "PASS", reason, evidence });
const reject = (id: string, reason: string, evidence?: Record<string, unknown>): CheckResult => ({ id, verdict: "REJECT", reason, evidence });
const unknown = (id: string, reason: string, evidence?: Record<string, unknown>): CheckResult => ({ id, verdict: "UNKNOWN", reason, evidence });

export function screenToken(inputs: ScreeningInputs, policy: ScreeningPolicy, now: Date): ScreeningResult {
  const checks: CheckResult[] = [
    ...mintChecks(inputs),
    ...marketChecks(inputs, policy, now),
    holderCheck(inputs, policy),
    activityCheck(inputs, policy),
    ...quoteChecks(inputs, policy, now),
  ];
  return {
    network: inputs.network,
    mint: inputs.mint,
    verdict: combineVerdicts(checks),
    checks,
    screenerVersion: SCREENER_VERSION,
    policyHash: policyHash(policy),
    assessedAt: now,
    expiresAt: new Date(now.getTime() + policy.assessmentTtlMs),
  };
}

function mintChecks(inputs: ScreeningInputs): CheckResult[] {
  const f = inputs.mintAccount;
  const ids = ["mint.program", "mint.layout", "mint.decimals", "mint.mint_authority", "mint.freeze_authority"];
  if (!f.ok) return ids.map((id) => unknown(id, `Mint account could not be read: ${f.error}`));
  const m = f.value;
  if (!m) return ids.map((id) => reject(id, "Mint account does not exist on chain"));

  const out: CheckResult[] = [];
  if (m.programId === SPL_TOKEN_PROGRAM_ID) out.push(pass("mint.program", "Owned by the SPL Token program"));
  else if (m.programId === TOKEN_2022_PROGRAM_ID)
    out.push(reject("mint.program", "Token-2022 mints are not supported until extension parsing (transfer fees, hooks, permanent delegate) is implemented", { programId: m.programId }));
  else out.push(reject("mint.program", "Mint is owned by an unsupported program", { programId: m.programId }));

  const d = m.decoded;
  if (!d) {
    out.push(reject("mint.layout", `Mint data does not match the SPL mint layout: ${m.layoutError ?? "unknown"}`, { dataLength: m.dataLength }));
    return [...out, ...ids.slice(2).map((id) => reject(id, "Mint layout invalid"))];
  }
  out.push(d.isInitialized ? pass("mint.layout", "82-byte initialized SPL mint") : reject("mint.layout", "Mint is not initialized"));
  out.push(
    isSupportedDecimals(d.decimals)
      ? pass("mint.decimals", `${d.decimals} decimals`, { decimals: d.decimals })
      : reject("mint.decimals", `Unsupported decimals: ${d.decimals}`, { decimals: d.decimals }),
  );
  out.push(
    d.mintAuthority === null
      ? pass("mint.mint_authority", "Mint authority is revoked; supply cannot be increased")
      : reject("mint.mint_authority", "Mint authority is active; supply can be inflated at any time", { mintAuthority: d.mintAuthority }),
  );
  out.push(
    d.freezeAuthority === null
      ? pass("mint.freeze_authority", "Freeze authority is revoked")
      : reject("mint.freeze_authority", "Freeze authority is active; holder accounts can be frozen", { freezeAuthority: d.freezeAuthority }),
  );
  return out;
}

function marketChecks(inputs: ScreeningInputs, policy: ScreeningPolicy, now: Date): CheckResult[] {
  const ids = ["market.pool", "market.age", "market.liquidity", "market.liquidity_change"];
  const f = inputs.pool;
  const history = historyCheck(inputs, policy);
  if (!f.ok) return [...ids.map((id) => unknown(id, `Pool data unavailable: ${f.error}`)), history];
  const p = f.value;
  if (!p) return [...ids.map((id) => unknown(id, "No pool found for this token")), history];
  const age = now.getTime() - f.receivedAt.getTime();
  if (age > policy.maxObservationAgeMs) {
    return [...ids.map((id) => unknown(id, `Pool data is stale (${Math.round(age / 1000)}s old)`)), history];
  }
  const out: CheckResult[] = [];
  if (p.baseMint !== inputs.mint && p.quoteMint !== inputs.mint) {
    return [reject("market.pool", "Selected pool does not contain this mint", { pool: p.poolAddress }), ...ids.slice(1).map((id) => unknown(id, "Pool mismatch")), history];
  }
  out.push(pass("market.pool", `Pool ${p.poolAddress} on ${p.dexId ?? "unknown venue"}`, { pool: p.poolAddress, dex: p.dexId }));

  if (!p.poolCreatedAt) out.push(unknown("market.age", "Pool creation time unknown"));
  else {
    const minutes = Math.floor((now.getTime() - p.poolCreatedAt.getTime()) / 60_000);
    out.push(
      minutes >= policy.minPoolAgeMinutes
        ? pass("market.age", `Pool is ${minutes} minutes old`, { minutes })
        : reject("market.age", `Pool is only ${minutes} minutes old (minimum ${policy.minPoolAgeMinutes})`, { minutes }),
    );
  }

  const min = parseDec(policy.minLiquidityUsd);
  if (!p.reserveUsd) out.push(unknown("market.liquidity", "Pool liquidity not reported"));
  else
    out.push(
      p.reserveUsd.gte(min)
        ? pass("market.liquidity", `Liquidity $${p.reserveUsd.toFixed(0)}`, { reserveUsd: p.reserveUsd.toFixed() })
        : reject("market.liquidity", `Liquidity $${p.reserveUsd.toFixed(0)} below $${policy.minLiquidityUsd}`, { reserveUsd: p.reserveUsd.toFixed() }),
    );

  out.push(liquidityChange(inputs, p, policy, f.receivedAt));
  out.push(history);
  return out;
}

function historyCheck(inputs: ScreeningInputs, policy: ScreeningPolicy): CheckResult {
  const n = inputs.closedCandleCount;
  if (n === null) return unknown("market.history", "Candle history unavailable");
  return n >= policy.minClosedCandles
    ? pass("market.history", `${n} closed one-minute candles stored`, { candles: n })
    : unknown("market.history", `Only ${n} closed candles stored (need ${policy.minClosedCandles})`, { candles: n });
}

function liquidityChange(inputs: ScreeningInputs, p: PoolSnapshot, policy: ScreeningPolicy, at: Date): CheckResult {
  const id = "market.liquidity_change";
  if (!p.reserveUsd) return unknown(id, "Current liquidity unknown");
  if (!inputs.reserveHistory || inputs.reserveHistory.length === 0) return unknown(id, "No earlier liquidity observations to compare");
  const target = at.getTime() - policy.liquidityLookbackMinutes * 60_000;
  const tolerance = policy.liquidityLookbackToleranceMinutes * 60_000;
  let best: { at: Date; reserveUsd: string } | null = null;
  for (const h of inputs.reserveHistory) {
    const d = Math.abs(h.at.getTime() - target);
    if (d <= tolerance && (!best || d < Math.abs(best.at.getTime() - target))) best = h;
  }
  if (!best) return unknown(id, `No liquidity observation near ${policy.liquidityLookbackMinutes} minutes ago`);
  const before = parseDec(best.reserveUsd);
  if (before.lte(0)) return unknown(id, "Earlier liquidity observation was zero");
  const change = p.reserveUsd.minus(before).div(before).mul(10_000).toDecimalPlaces(0).toNumber();
  const evidence = { beforeUsd: before.toFixed(), nowUsd: p.reserveUsd.toFixed(), changeBps: change, comparedAt: best.at.toISOString() };
  return -change > policy.maxLiquidityDropBps
    ? reject(id, `Liquidity fell ${(-change / 100).toFixed(2)}% in about ${policy.liquidityLookbackMinutes} minutes`, evidence)
    : pass(id, `Liquidity change ${(change / 100).toFixed(2)}%`, evidence);
}

function holderCheck(inputs: ScreeningInputs, policy: ScreeningPolicy): CheckResult {
  const id = "holders.concentration";
  const f = inputs.holders;
  if (!f.ok) return unknown(id, `Holder data unavailable: ${f.error}`);
  const h = f.value;
  const evidence = {
    walletTop10Bps: h.walletTop10Bps,
    walletMaxBps: h.walletMaxBps,
    poolBps: h.poolBps,
    unverifiedBps: h.unverifiedBps,
    sharedOwners: h.sharedOwners,
    accountsExamined: h.accountsExamined,
    caveat: "Wallets controlled by one person and exchange custody cannot be detected.",
  };
  if (h.walletMaxBps > policy.maxSingleWalletBps)
    return reject(id, `One wallet holds ${(h.walletMaxBps / 100).toFixed(2)}% of supply`, evidence);
  if (h.walletTop10Bps > policy.maxTop10WalletBps)
    return reject(id, `Top 10 wallets hold ${(h.walletTop10Bps / 100).toFixed(2)}% of supply`, evidence);
  if (h.unverifiedBps > policy.maxUnverifiedHolderBps)
    return unknown(id, `${(h.unverifiedBps / 100).toFixed(2)}% of supply sits in accounts that could not be classified`, evidence);
  return pass(id, `Top 10 wallets hold ${(h.walletTop10Bps / 100).toFixed(2)}% of supply (pools excluded)`, evidence);
}

function activityCheck(inputs: ScreeningInputs, policy: ScreeningPolicy): CheckResult {
  const id = "activity.sell_flow";
  if (!inputs.pool.ok || !inputs.pool.value) return unknown(id, "No pool activity data");
  const h1 = inputs.pool.value.transactions.h1;
  if (!h1) return unknown(id, "Hourly transaction counts not reported");
  if (h1.buys >= policy.suspiciousMinBuys && h1.sells === 0)
    return reject(id, `${h1.buys} buys and no sells in the last hour; selling may be restricted`, { ...h1 });
  return pass(id, `${h1.buys} buys / ${h1.sells} sells in the last hour`, { ...h1 });
}

function quoteChecks(inputs: ScreeningInputs, policy: ScreeningPolicy, now: Date): CheckResult[] {
  const out: CheckResult[] = [];
  const e = inputs.entryQuote;
  const x = inputs.exitQuote;

  if (!e.ok) out.push(unknown("quote.entry", `No entry quote: ${e.error}`));
  else out.push(quoteCheck("quote.entry", e.value, e.receivedAt, now, policy.maxEntryPriceImpactBps, policy, inputs.quoteMint, inputs.mint, inputs.intendedSizeRaw));

  if (!x.ok) out.push(unknown("quote.exit", `No exit quote: ${x.error}`));
  else if (!e.ok) out.push(unknown("quote.exit", "Exit quote cannot be checked without an entry quote"));
  else out.push(quoteCheck("quote.exit", x.value, x.receivedAt, now, policy.maxExitPriceImpactBps, policy, inputs.mint, inputs.quoteMint, e.value.outAmountRaw));

  const id = "quote.round_trip_cost";
  if (!e.ok || !x.ok) out.push(unknown(id, "Round-trip cost needs both quotes"));
  else if (x.value.inAmountRaw !== e.value.outAmountRaw) out.push(unknown(id, "Exit quote was not taken at the full entry size"));
  else {
    const spent = e.value.inAmountRaw;
    const back = x.value.outAmountRaw;
    const costBps = back >= spent ? 0 : Number(ratioBps(spent - back, spent, "ceil"));
    const evidence = { spentRaw: spent.toString(), returnedRaw: back.toString(), costBps };
    out.push(
      costBps <= policy.maxRoundTripCostBps
        ? pass(id, `Immediate round trip would cost ${(costBps / 100).toFixed(2)}% before network fees`, evidence)
        : reject(id, `Immediate round trip would cost ${(costBps / 100).toFixed(2)}% (limit ${(policy.maxRoundTripCostBps / 100).toFixed(2)}%)`, evidence),
    );
  }
  return out;
}

function quoteCheck(
  id: string,
  q: SwapQuote,
  receivedAt: Date,
  now: Date,
  maxImpactBps: number,
  policy: ScreeningPolicy,
  inputMint: string,
  outputMint: string,
  amountRaw: bigint,
): CheckResult {
  const ageMs = now.getTime() - receivedAt.getTime();
  const evidence = {
    inAmountRaw: q.inAmountRaw.toString(),
    outAmountRaw: q.outAmountRaw.toString(),
    priceImpactBps: q.priceImpactBps,
    router: q.router,
    routes: q.routeLabels,
    ageMs,
  };
  if (q.inputMint !== inputMint || q.outputMint !== outputMint || q.inAmountRaw !== amountRaw)
    return unknown(id, "Quote does not match the intended trade", evidence);
  if (ageMs > policy.maxQuoteAgeMs || ageMs < 0) return unknown(id, `Quote is stale (${Math.round(ageMs / 1000)}s old)`, evidence);
  if (q.priceImpactBps === null) return unknown(id, "Price impact not reported", evidence);
  if (q.priceImpactBps > maxImpactBps)
    return reject(id, `Price impact ${(q.priceImpactBps / 100).toFixed(2)}% exceeds ${(maxImpactBps / 100).toFixed(2)}%`, evidence);
  return pass(id, `Route found; price impact ${(q.priceImpactBps / 100).toFixed(2)}%`, evidence);
}
