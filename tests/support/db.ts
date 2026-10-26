/** Helpers shared by integration tests. */
import { createDb, insertProposedOrder, portfolios, reservations, tokens, transitionOrder, type DbHandle, type DbOrTx, type OrderRow } from "@tb/db";
import { newId, USDC_MINT, type TradingMode } from "@tb/domain";
import { ASSET_SOL, lockBalances, recordDeposit, writeBalances } from "@tb/ledger";
import bs58 from "bs58";
import { randomBytes } from "node:crypto";

export function testDb(): DbHandle {
  const url = process.env.TEST_DATABASE_URL ?? "postgres://postgres@127.0.0.1:5432/trading_bot_test";
  return createDb({ url, max: 8, applicationName: "trading-bot-tests" });
}

/** A random, valid-looking Solana address for test mints and pools. */
export function randomAddress(): string {
  return bs58.encode(randomBytes(32));
}

export async function createPortfolio(
  db: DbOrTx,
  opts: { mode?: TradingMode; usdc?: bigint; sol?: bigint; at?: Date } = {},
): Promise<{ id: string; mode: TradingMode }> {
  const id = newId();
  const mode = opts.mode ?? "PAPER";
  const at = opts.at ?? new Date("2026-01-01T00:00:00Z");
  await db.insert(portfolios).values({ id, name: `test-${id}`, mode, baseMint: USDC_MINT });
  if (opts.usdc && opts.usdc > 0n) {
    await recordDeposit(db, { portfolioId: id, mode, asset: USDC_MINT, baseMint: USDC_MINT, amountRaw: opts.usdc, memo: "test deposit", at });
  }
  if (opts.sol && opts.sol > 0n) {
    await recordDeposit(db, { portfolioId: id, mode, asset: ASSET_SOL, baseMint: USDC_MINT, amountRaw: opts.sol, memo: "test SOL", at });
  }
  return { id, mode };
}

export async function createToken(db: DbOrTx, opts: { decimals?: number; mint?: string } = {}): Promise<{ id: string; mint: string; decimals: number }> {
  const id = newId();
  const mint = opts.mint ?? randomAddress();
  const decimals = opts.decimals ?? 6;
  await db.insert(tokens).values({ id, network: "solana-mainnet", mint, decimals, symbol: "TEST", allowlisted: true });
  return { id, mint, decimals };
}

export interface TestOrderInput {
  portfolio: { id: string; mode: TradingMode };
  token: { id: string; mint: string };
  side?: "BUY" | "SELL";
  notionalRaw?: bigint;
  quantityRaw?: bigint;
  feeLamports?: bigint;
  at?: Date;
}

/** Create an order and move it to RESERVED with a matching reservation (test shortcut for the risk engine). */
export async function createReservedOrder(db: DbOrTx, input: TestOrderInput): Promise<OrderRow> {
  const at = input.at ?? new Date("2026-01-01T00:00:00Z");
  const side = input.side ?? "BUY";
  const notional = side === "BUY" ? (input.notionalRaw ?? 10_000_000n) : null;
  const fee = input.feeLamports ?? 100_000n;
  const order = await insertProposedOrder(
    db,
    {
      id: newId(),
      portfolioId: input.portfolio.id,
      mode: input.portfolio.mode,
      tokenId: input.token.id,
      mint: input.token.mint,
      side,
      idempotencyKey: newId(),
      notionalRaw: notional?.toString() ?? null,
      quantityRaw: side === "SELL" ? (input.quantityRaw ?? 1n).toString() : null,
      maxSlippageBps: 100,
      maxPriceImpactBps: 300,
      maxNetworkFeeLamports: fee.toString(),
      reason: "test",
      purpose: side === "BUY" ? "ENTRY" : "EXIT",
      expiresAt: new Date(at.getTime() + 60_000),
      createdAt: at,
    },
    "test",
  );
  const balances = await lockBalances(db, input.portfolio.id);
  balances.reservedRaw += notional ?? 0n;
  balances.solReservedLamports += fee;
  await writeBalances(db, balances, at);
  await db.insert(reservations).values({
    id: newId(),
    orderId: order.id,
    portfolioId: input.portfolio.id,
    mode: input.portfolio.mode,
    quoteRaw: (notional ?? 0n).toString(),
    feeLamports: fee.toString(),
  });
  return transitionOrder(db, { orderId: order.id, to: "RESERVED", reason: "test reserve", actor: "test", at });
}
