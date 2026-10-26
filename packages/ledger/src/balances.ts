import type { TradingMode } from "@tb/domain";
import { dbRaw, portfolioBalances, type DbOrTx } from "@tb/db";
import { eq } from "drizzle-orm";

export interface Balances {
  portfolioId: string;
  mode: TradingMode;
  cashRaw: bigint;
  reservedRaw: bigint;
  solLamports: bigint;
  solReservedLamports: bigint;
  version: number;
}

export class InsufficientFundsError extends Error {
  override name = "InsufficientFundsError";
}

export async function ensureBalancesRow(tx: DbOrTx, portfolioId: string, mode: TradingMode): Promise<void> {
  await tx.insert(portfolioBalances).values({ portfolioId, mode }).onConflictDoNothing();
}

/** Lock the balance row for the rest of the transaction (serialises budget changes per portfolio). */
export async function lockBalances(tx: DbOrTx, portfolioId: string): Promise<Balances> {
  const rows = await tx.select().from(portfolioBalances).where(eq(portfolioBalances.portfolioId, portfolioId)).for("update");
  const row = rows[0];
  if (!row) throw new Error(`no balance row for portfolio ${portfolioId}`);
  return toBalances(row);
}

export async function readBalances(tx: DbOrTx, portfolioId: string): Promise<Balances | null> {
  const rows = await tx.select().from(portfolioBalances).where(eq(portfolioBalances.portfolioId, portfolioId));
  return rows[0] ? toBalances(rows[0]) : null;
}

function toBalances(row: typeof portfolioBalances.$inferSelect): Balances {
  return {
    portfolioId: row.portfolioId,
    mode: row.mode as TradingMode,
    cashRaw: dbRaw(row.cashRaw),
    reservedRaw: dbRaw(row.reservedRaw),
    solLamports: dbRaw(row.solLamports),
    solReservedLamports: dbRaw(row.solReservedLamports),
    version: row.version,
  };
}

/** Write new balance values for a row already locked by this transaction. */
export async function writeBalances(tx: DbOrTx, b: Balances, at: Date): Promise<void> {
  if (b.cashRaw < b.reservedRaw || b.solLamports < b.solReservedLamports || b.reservedRaw < 0n || b.solReservedLamports < 0n) {
    throw new InsufficientFundsError(
      `balance invariant violated: cash ${b.cashRaw} reserved ${b.reservedRaw} sol ${b.solLamports} solReserved ${b.solReservedLamports}`,
    );
  }
  await tx
    .update(portfolioBalances)
    .set({
      cashRaw: b.cashRaw.toString(),
      reservedRaw: b.reservedRaw.toString(),
      solLamports: b.solLamports.toString(),
      solReservedLamports: b.solReservedLamports.toString(),
      version: b.version + 1,
      updatedAt: at,
    })
    .where(eq(portfolioBalances.portfolioId, b.portfolioId));
}

export function availableCash(b: Balances): bigint {
  return b.cashRaw - b.reservedRaw;
}

export function availableSol(b: Balances): bigint {
  return b.solLamports - b.solReservedLamports;
}
