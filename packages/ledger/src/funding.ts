/**
 * Deposits and withdrawals. They move equity:deposits / equity:withdrawals, never P&L, so a
 * deposit can never be mistaken for profit.
 */
import type { TradingMode } from "@tb/domain";
import type { DbOrTx } from "@tb/db";
import { availableCash, availableSol, ensureBalancesRow, InsufficientFundsError, lockBalances, writeBalances } from "./balances.ts";
import { ASSET_SOL, postJournal } from "./journal.ts";

export interface FundingInput {
  portfolioId: string;
  mode: TradingMode;
  /** The portfolio's base mint (USDC) or "SOL" for the separate fee balance. */
  asset: string;
  baseMint: string;
  amountRaw: bigint;
  memo: string;
  at: Date;
}

export async function recordDeposit(tx: DbOrTx, input: FundingInput): Promise<string> {
  if (input.amountRaw <= 0n) throw new Error("deposit must be positive");
  assertFundingAsset(input);
  await ensureBalancesRow(tx, input.portfolioId, input.mode);
  const balances = await lockBalances(tx, input.portfolioId);
  const journalId = await postJournal(tx, {
    portfolioId: input.portfolioId,
    mode: input.mode,
    entryType: "DEPOSIT",
    lines: [
      { account: "cash", asset: input.asset, amountRaw: input.amountRaw },
      { account: "equity:deposits", asset: input.asset, amountRaw: -input.amountRaw },
    ],
    memo: input.memo,
    at: input.at,
  });
  if (input.asset === ASSET_SOL) balances.solLamports += input.amountRaw;
  else balances.cashRaw += input.amountRaw;
  await writeBalances(tx, balances, input.at);
  return journalId;
}

export async function recordWithdrawal(tx: DbOrTx, input: FundingInput): Promise<string> {
  if (input.amountRaw <= 0n) throw new Error("withdrawal must be positive");
  assertFundingAsset(input);
  const balances = await lockBalances(tx, input.portfolioId);
  const available = input.asset === ASSET_SOL ? availableSol(balances) : availableCash(balances);
  if (input.amountRaw > available) {
    throw new InsufficientFundsError(`withdrawal ${input.amountRaw} exceeds available ${available}`);
  }
  const journalId = await postJournal(tx, {
    portfolioId: input.portfolioId,
    mode: input.mode,
    entryType: "WITHDRAWAL",
    lines: [
      { account: "cash", asset: input.asset, amountRaw: -input.amountRaw },
      { account: "equity:withdrawals", asset: input.asset, amountRaw: input.amountRaw },
    ],
    memo: input.memo,
    at: input.at,
  });
  if (input.asset === ASSET_SOL) balances.solLamports -= input.amountRaw;
  else balances.cashRaw -= input.amountRaw;
  await writeBalances(tx, balances, input.at);
  return journalId;
}

function assertFundingAsset(input: FundingInput): void {
  if (input.asset !== ASSET_SOL && input.asset !== input.baseMint) {
    throw new Error(`funding asset must be the base mint or SOL, got ${input.asset}`);
  }
}
