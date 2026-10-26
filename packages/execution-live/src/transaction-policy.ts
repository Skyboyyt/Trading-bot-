/**
 * Transaction policy for a FUTURE live signer. Nothing in this build signs anything.
 *
 * The signer must never sign arbitrary bytes returned by an API. Before signing, it will decode
 * the transaction and pass the decoded form through this validator, which only allows a swap
 * for the owner's own wallet through an allowlisted router, bounded compute fees, and the
 * minimal token-account housekeeping a swap needs. It rejects transfers, approvals/delegates,
 * authority changes, account closures to anyone else, unknown programs, and fee payers other
 * than the owner's wallet.
 *
 * The program allowlist below must be re-verified against current router documentation before
 * any live use (see docs/live-integration-plan.md).
 */
import bs58 from "bs58";
import { SPL_TOKEN_PROGRAM_ID, SYSTEM_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@tb/domain";

export const COMPUTE_BUDGET_PROGRAM_ID = "ComputeBudget111111111111111111111111111111";
export const ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
/** Jupiter v6 aggregator program used by the Metis router. Re-verify before live use. */
export const JUPITER_V6_PROGRAM_ID = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUJoi5ZqtqZn9z";

export interface DecodedInstruction {
  programId: string;
  /** Account addresses in instruction order. */
  accounts: string[];
  data: Uint8Array;
}

export interface DecodedTransaction {
  feePayer: string;
  instructions: DecodedInstruction[];
  /** Address lookup tables referenced by a v0 message. */
  addressTableLookups: string[];
}

export interface TransactionPolicy {
  ownerWallet: string;
  allowedSwapPrograms: readonly string[];
  allowedLookupTables: readonly string[] | "any-from-allowed-router";
  maxComputeUnitPriceMicroLamports: bigint;
  maxComputeUnits: number;
  /** Mints the order expects to touch; token instructions on other mints are rejected. */
  expectedMints: readonly string[];
}

export interface PolicyViolation {
  index: number;
  programId: string;
  reason: string;
}

export function validateTransaction(tx: DecodedTransaction, policy: TransactionPolicy): PolicyViolation[] {
  const v: PolicyViolation[] = [];
  if (tx.feePayer !== policy.ownerWallet) v.push({ index: -1, programId: "-", reason: `fee payer ${tx.feePayer} is not the owner wallet` });
  if (policy.allowedLookupTables !== "any-from-allowed-router") {
    for (const t of tx.addressTableLookups) if (!policy.allowedLookupTables.includes(t)) v.push({ index: -1, programId: "-", reason: `unknown address lookup table ${t}` });
  }
  let swaps = 0;
  tx.instructions.forEach((ix, i) => {
    const bad = (reason: string) => v.push({ index: i, programId: ix.programId, reason });
    switch (ix.programId) {
      case COMPUTE_BUDGET_PROGRAM_ID: {
        const kind = ix.data[0];
        if (kind === 2) {
          if (ix.data.length < 5) return bad("malformed compute unit limit");
          const units = new DataView(ix.data.buffer, ix.data.byteOffset).getUint32(1, true);
          if (units > policy.maxComputeUnits) bad(`compute unit limit ${units} exceeds ${policy.maxComputeUnits}`);
        } else if (kind === 3) {
          if (ix.data.length < 9) return bad("malformed compute unit price");
          const price = new DataView(ix.data.buffer, ix.data.byteOffset).getBigUint64(1, true);
          if (price > policy.maxComputeUnitPriceMicroLamports) bad(`compute unit price ${price} exceeds ${policy.maxComputeUnitPriceMicroLamports}`);
        } else bad(`compute budget instruction ${kind} not allowed`);
        return;
      }
      case ASSOCIATED_TOKEN_PROGRAM_ID: {
        // Only "create idempotent" (1) or "create" (0) of the owner's own ATA for an expected mint.
        const kind = ix.data.length === 0 ? 0 : ix.data[0];
        if (kind !== 0 && kind !== 1) return bad(`associated token instruction ${kind} not allowed`);
        const [payer, , owner, mint] = ix.accounts;
        if (payer !== policy.ownerWallet || owner !== policy.ownerWallet) bad("associated token account must be created for and paid by the owner");
        if (mint && !policy.expectedMints.includes(mint)) bad(`unexpected mint ${mint}`);
        return;
      }
      case SPL_TOKEN_PROGRAM_ID: {
        const kind = ix.data[0];
        if (kind === 17) return; // SyncNative (wrapped SOL bookkeeping)
        if (kind === 9) {
          // CloseAccount: only back to the owner, with the owner as authority.
          const [, destination, authority] = ix.accounts;
          if (destination !== policy.ownerWallet || authority !== policy.ownerWallet) bad("token account closure must return funds to the owner");
          return;
        }
        return bad(TOKEN_INSTRUCTION_NAMES[kind ?? -1] ? `token ${TOKEN_INSTRUCTION_NAMES[kind ?? -1]} not allowed` : `token instruction ${kind} not allowed`);
      }
      case TOKEN_2022_PROGRAM_ID:
        return bad("Token-2022 instructions are not supported");
      case SYSTEM_PROGRAM_ID: {
        const kind = ix.data.length >= 4 ? new DataView(ix.data.buffer, ix.data.byteOffset).getUint32(0, true) : -1;
        return bad(kind === 2 ? "SOL transfers are not allowed" : `system instruction ${kind} not allowed`);
      }
      default:
        if (policy.allowedSwapPrograms.includes(ix.programId)) {
          swaps++;
          return;
        }
        return bad("program is not on the allowlist");
    }
  });
  if (swaps !== 1) v.push({ index: -1, programId: "-", reason: `expected exactly one swap instruction, found ${swaps}` });
  return v;
}

const TOKEN_INSTRUCTION_NAMES: Record<number, string> = {
  3: "Transfer",
  4: "Approve (delegate)",
  5: "Revoke",
  6: "SetAuthority",
  7: "MintTo",
  8: "Burn",
  10: "FreezeAccount",
  11: "ThawAccount",
  12: "TransferChecked",
  13: "ApproveChecked (delegate)",
  14: "MintToChecked",
  15: "BurnChecked",
};

/** Helper for tests and the future signer: build instruction data bytes. */
export function ixData(...bytes: number[]): Uint8Array {
  return Uint8Array.from(bytes);
}

export function isValidAddress(address: string): boolean {
  try {
    return bs58.decode(address).length === 32;
  } catch {
    return false;
  }
}
