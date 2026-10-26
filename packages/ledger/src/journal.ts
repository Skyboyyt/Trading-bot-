/**
 * Append-only double-entry ledger.
 *
 * Sign convention: positive amounts are debits, negative amounts are credits. Every journal must
 * net to zero for each asset; this is checked here before insert and again by a deferred
 * constraint trigger at commit (migration 0001), so an unbalanced journal can never persist.
 *
 * Accounts:
 *   cash                 USDC trading balance and the separate SOL fee balance (asset "SOL")
 *   holdings             token inventory, per mint
 *   trading              swap clearing account; one side of every exchange, per asset
 *   fees:platform        swap platform fees, in whichever asset the route charged them
 *   fees:network         Solana network and priority fees (asset "SOL")
 *   equity:deposits      owner deposits (kept apart from trading results)
 *   equity:withdrawals   owner withdrawals
 *   adjustments          manual, audited corrections only
 */
import { newId, type TradingMode } from "@tb/domain";
import { ledgerEntries, type DbOrTx } from "@tb/db";

export const ASSET_SOL = "SOL";

export const LEDGER_ACCOUNTS = [
  "cash",
  "holdings",
  "trading",
  "fees:platform",
  "fees:network",
  "equity:deposits",
  "equity:withdrawals",
  "adjustments",
] as const;
export type LedgerAccount = (typeof LEDGER_ACCOUNTS)[number];

export type EntryType =
  | "DEPOSIT"
  | "WITHDRAWAL"
  | "ACQUISITION"
  | "DISPOSAL"
  | "FEE_NETWORK"
  | "FEE_PLATFORM"
  | "TRANSFER"
  | "ADJUSTMENT";

export interface LedgerLine {
  account: LedgerAccount;
  asset: string;
  amountRaw: bigint;
}

export class LedgerImbalanceError extends Error {
  override name = "LedgerImbalanceError";
}

/** Throws unless the lines net to zero for every asset. Zero-amount lines are rejected. */
export function assertBalanced(lines: readonly LedgerLine[]): void {
  if (lines.length < 2) throw new LedgerImbalanceError("a journal needs at least two lines");
  const totals = new Map<string, bigint>();
  for (const line of lines) {
    if (line.amountRaw === 0n) throw new LedgerImbalanceError(`zero amount on ${line.account}/${line.asset}`);
    totals.set(line.asset, (totals.get(line.asset) ?? 0n) + line.amountRaw);
  }
  for (const [asset, total] of totals) {
    if (total !== 0n) throw new LedgerImbalanceError(`journal unbalanced for ${asset}: net ${total}`);
  }
}

/** Remove zero lines (e.g. a zero platform fee) before balancing. */
export function compact(lines: readonly LedgerLine[]): LedgerLine[] {
  return lines.filter((l) => l.amountRaw !== 0n);
}

export interface PostJournalInput {
  portfolioId: string;
  mode: TradingMode;
  entryType: EntryType;
  lines: readonly LedgerLine[];
  orderId?: string;
  fillId?: string;
  memo?: string;
  at: Date;
}

export async function postJournal(tx: DbOrTx, input: PostJournalInput): Promise<string> {
  const lines = compact(input.lines);
  assertBalanced(lines);
  const journalId = newId();
  await tx.insert(ledgerEntries).values(
    lines.map((line) => ({
      id: newId(),
      journalId,
      portfolioId: input.portfolioId,
      mode: input.mode,
      account: line.account,
      asset: line.asset,
      amountRaw: line.amountRaw.toString(),
      entryType: input.entryType,
      orderId: input.orderId ?? null,
      fillId: input.fillId ?? null,
      memo: input.memo ?? null,
      createdAt: input.at,
    })),
  );
  return journalId;
}
