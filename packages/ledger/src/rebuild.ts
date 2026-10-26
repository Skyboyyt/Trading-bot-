/**
 * Rebuild and verify cached state from the ledger.
 *
 * The ledger is authoritative. After a restart (or on a schedule) the worker recomputes cash,
 * SOL and token holdings from ledger entries, reservations from active reservation rows, and
 * compares them with the cached balance row and open positions. Any difference is reported and
 * the cache is corrected from the ledger; positions are never silently rewritten.
 */
import { dbRaw, type DbOrTx } from "@tb/db";
import { sql } from "drizzle-orm";
import { ensureBalancesRow, lockBalances, writeBalances } from "./balances.ts";
import { ASSET_SOL } from "./journal.ts";

export interface LedgerVerification {
  ok: boolean;
  cash: { ledger: bigint; cached: bigint };
  sol: { ledger: bigint; cached: bigint };
  reserved: { active: bigint; cached: bigint };
  solReserved: { active: bigint; cached: bigint };
  holdingMismatches: { mint: string; ledger: bigint; positions: bigint }[];
  unbalancedJournals: number;
  corrected: boolean;
}

export async function verifyAndRebuild(
  tx: DbOrTx,
  portfolioId: string,
  baseMint: string,
  opts: { apply: boolean; at: Date },
): Promise<LedgerVerification> {
  const mode = (
    await tx.execute<{ mode: string }>(sql`select mode from portfolios where id = ${portfolioId}`)
  )[0]?.mode;
  if (!mode) throw new Error(`portfolio ${portfolioId} not found`);
  await ensureBalancesRow(tx, portfolioId, mode as "PAPER" | "LIVE");
  const cached = await lockBalances(tx, portfolioId);

  const sums = await tx.execute<{ account: string; asset: string; total: string }>(sql`
    select account, asset, sum(amount_raw)::text as total from ledger_entries
    where portfolio_id = ${portfolioId} and account in ('cash', 'holdings')
    group by account, asset
  `);
  let cashLedger = 0n;
  let solLedger = 0n;
  const holdings = new Map<string, bigint>();
  for (const r of sums) {
    const total = dbRaw(r.total);
    if (r.account === "cash" && r.asset === baseMint) cashLedger = total;
    else if (r.account === "cash" && r.asset === ASSET_SOL) solLedger = total;
    else if (r.account === "holdings") holdings.set(r.asset, total);
  }

  const res = await tx.execute<{ quote: string | null; fee: string | null }>(sql`
    select sum(quote_raw)::text as quote, sum(fee_lamports)::text as fee from reservations
    where portfolio_id = ${portfolioId} and status = 'ACTIVE'
  `);
  const reservedActive = dbRaw(res[0]?.quote ?? "0");
  const solReservedActive = dbRaw(res[0]?.fee ?? "0");

  const pos = await tx.execute<{ mint: string; qty: string }>(sql`
    select mint, sum(quantity_raw)::text as qty from positions
    where portfolio_id = ${portfolioId} and status in ('OPEN', 'CLOSING', 'STRANDED')
    group by mint
  `);
  const positionQty = new Map<string, bigint>(pos.map((p) => [p.mint, dbRaw(p.qty)]));
  const holdingMismatches: LedgerVerification["holdingMismatches"] = [];
  for (const mint of new Set([...holdings.keys(), ...positionQty.keys()])) {
    const l = holdings.get(mint) ?? 0n;
    const p = positionQty.get(mint) ?? 0n;
    if (l !== p) holdingMismatches.push({ mint, ledger: l, positions: p });
  }

  const unbalanced = await tx.execute<{ n: string }>(sql`
    select count(*)::text as n from (
      select journal_id, asset from ledger_entries where portfolio_id = ${portfolioId}
      group by journal_id, asset having sum(amount_raw) <> 0
    ) x
  `);
  const unbalancedJournals = Number(unbalanced[0]?.n ?? 0);

  const cacheOk =
    cashLedger === cached.cashRaw &&
    solLedger === cached.solLamports &&
    reservedActive === cached.reservedRaw &&
    solReservedActive === cached.solReservedLamports;
  let corrected = false;
  if (!cacheOk && opts.apply) {
    await writeBalances(
      tx,
      { ...cached, cashRaw: cashLedger, solLamports: solLedger, reservedRaw: reservedActive, solReservedLamports: solReservedActive },
      opts.at,
    );
    corrected = true;
  }

  return {
    ok: cacheOk && holdingMismatches.length === 0 && unbalancedJournals === 0,
    cash: { ledger: cashLedger, cached: cached.cashRaw },
    sol: { ledger: solLedger, cached: cached.solLamports },
    reserved: { active: reservedActive, cached: cached.reservedRaw },
    solReserved: { active: solReservedActive, cached: cached.solReservedLamports },
    holdingMismatches,
    unbalancedJournals,
    corrected,
  };
}

/** Totals used for reporting: deposits, withdrawals, fees. */
export async function ledgerTotals(tx: DbOrTx, portfolioId: string, baseMint: string) {
  const rows = await tx.execute<{ account: string; asset: string; total: string }>(sql`
    select account, asset, sum(amount_raw)::text as total from ledger_entries
    where portfolio_id = ${portfolioId}
      and account in ('equity:deposits', 'equity:withdrawals', 'fees:platform', 'fees:network')
    group by account, asset
  `);
  const get = (account: string, asset: string) =>
    dbRaw(rows.find((r) => r.account === account && r.asset === asset)?.total ?? "0");
  return {
    /** Deposits are credits, so negate for a positive figure. */
    depositsRaw: -get("equity:deposits", baseMint),
    withdrawalsRaw: get("equity:withdrawals", baseMint),
    solDepositsLamports: -get("equity:deposits", ASSET_SOL),
    platformFeesQuoteRaw: get("fees:platform", baseMint),
    platformFeesByToken: rows
      .filter((r) => r.account === "fees:platform" && r.asset !== baseMint)
      .map((r) => ({ mint: r.asset, raw: dbRaw(r.total) })),
    networkFeesLamports: get("fees:network", ASSET_SOL),
  };
}
