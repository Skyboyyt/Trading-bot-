import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import bs58 from "bs58";
import { SPL_TOKEN_PROGRAM_ID, SYSTEM_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@tb/domain";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  COMPUTE_BUDGET_PROGRAM_ID,
  createLiveExecutor,
  ixData,
  JUPITER_V6_PROGRAM_ID,
  LIVE_TRADING_ENABLED,
  LiveTradingDisabledError,
  validateTransaction,
  type DecodedInstruction,
  type DecodedTransaction,
  type TransactionPolicy,
} from "../src/index.ts";

const addr = () => bs58.encode(randomBytes(32));
const OWNER = addr();
const ATTACKER = addr();
const MINT = addr();
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const policy: TransactionPolicy = {
  ownerWallet: OWNER,
  allowedSwapPrograms: [JUPITER_V6_PROGRAM_ID],
  allowedLookupTables: "any-from-allowed-router",
  maxComputeUnitPriceMicroLamports: 1_000_000n,
  maxComputeUnits: 1_400_000,
  expectedMints: [MINT, USDC],
};

const u32 = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return [...b]; };
const u64 = (n: bigint) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, n, true); return [...b]; };

const computeLimit = (units: number): DecodedInstruction => ({ programId: COMPUTE_BUDGET_PROGRAM_ID, accounts: [], data: ixData(2, ...u32(units)) });
const computePrice = (price: bigint): DecodedInstruction => ({ programId: COMPUTE_BUDGET_PROGRAM_ID, accounts: [], data: ixData(3, ...u64(price)) });
const createAta = (owner = OWNER, mint = MINT): DecodedInstruction => ({ programId: ASSOCIATED_TOKEN_PROGRAM_ID, accounts: [OWNER, addr(), owner, mint, SYSTEM_PROGRAM_ID, SPL_TOKEN_PROGRAM_ID], data: ixData(1) });
const swap: DecodedInstruction = { programId: JUPITER_V6_PROGRAM_ID, accounts: [OWNER], data: ixData(1, 2, 3) };

const tx = (...instructions: DecodedInstruction[]): DecodedTransaction => ({ feePayer: OWNER, instructions, addressTableLookups: [] });
const reasons = (t: DecodedTransaction) => validateTransaction(t, policy).map((v) => v.reason).join(" | ");

describe("live execution is disabled", () => {
  it("cannot create a live executor", () => {
    expect(LIVE_TRADING_ENABLED).toBe(false);
    expect(() => createLiveExecutor()).toThrow(LiveTradingDisabledError);
  });
});

describe("transaction policy", () => {
  it("accepts a plain swap with bounded compute fees", () => {
    expect(validateTransaction(tx(computeLimit(400_000), computePrice(50_000n), createAta(), swap), policy)).toEqual([]);
  });

  it("rejects token transfers, delegates, authority changes and foreign closures", () => {
    const tokenIx = (kind: number, accounts: string[] = [addr(), ATTACKER, OWNER]): DecodedInstruction => ({ programId: SPL_TOKEN_PROGRAM_ID, accounts, data: ixData(kind, ...u64(1n)) });
    expect(reasons(tx(swap, tokenIx(3)))).toMatch(/Transfer not allowed/);
    expect(reasons(tx(swap, tokenIx(12)))).toMatch(/TransferChecked/);
    expect(reasons(tx(swap, tokenIx(4)))).toMatch(/delegate/);
    expect(reasons(tx(swap, tokenIx(13)))).toMatch(/delegate/);
    expect(reasons(tx(swap, tokenIx(6)))).toMatch(/SetAuthority/);
    expect(reasons(tx(swap, tokenIx(9, [addr(), ATTACKER, OWNER])))).toMatch(/closure must return funds to the owner/);
    expect(validateTransaction(tx(swap, tokenIx(9, [addr(), OWNER, OWNER])), policy)).toEqual([]);
  });

  it("rejects SOL transfers and other system instructions", () => {
    expect(reasons(tx(swap, { programId: SYSTEM_PROGRAM_ID, accounts: [OWNER, ATTACKER], data: ixData(...u32(2), ...u64(1_000_000n)) }))).toMatch(/SOL transfers/);
    expect(reasons(tx(swap, { programId: SYSTEM_PROGRAM_ID, accounts: [OWNER], data: ixData(...u32(1)) }))).toMatch(/system instruction 1/);
  });

  it("rejects unknown programs, Token-2022 and extra swaps", () => {
    expect(reasons(tx(swap, { programId: addr(), accounts: [], data: ixData(0) }))).toMatch(/allowlist/);
    expect(reasons(tx(swap, { programId: TOKEN_2022_PROGRAM_ID, accounts: [], data: ixData(3) }))).toMatch(/Token-2022/);
    expect(reasons(tx(swap, swap))).toMatch(/exactly one swap/);
    expect(reasons(tx(computeLimit(1)))).toMatch(/exactly one swap/);
  });

  it("rejects excessive fees and a foreign fee payer", () => {
    expect(reasons(tx(computePrice(5_000_000n), swap))).toMatch(/compute unit price/);
    expect(reasons(tx(computeLimit(2_000_000), swap))).toMatch(/compute unit limit/);
    expect(reasons({ ...tx(swap), feePayer: ATTACKER })).toMatch(/fee payer/);
  });

  it("rejects account creation for someone else or for unexpected mints", () => {
    expect(reasons(tx(createAta(ATTACKER), swap))).toMatch(/created for and paid by the owner/);
    expect(reasons(tx(createAta(OWNER, addr()), swap))).toMatch(/unexpected mint/);
  });

  it("can restrict address lookup tables", () => {
    const strict = { ...policy, allowedLookupTables: [] as string[] };
    expect(validateTransaction({ ...tx(swap), addressTableLookups: [addr()] }, strict).map((v) => v.reason).join()).toMatch(/lookup table/);
  });
});
