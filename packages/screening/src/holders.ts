/**
 * Holder concentration from the largest token accounts.
 *
 * Token accounts are grouped by their owner (the wallet or authority that controls them), so
 * one holder spread over several accounts is counted once ("shared owners"). Each owner is
 * classified:
 *   pool        owner is a known pool address, or a known AMM authority that is not a wallet
 *   wallet      owner account is owned by the System Program
 *   program     owner account is owned by another program (lockers, vesting, unknown PDAs)
 *   unverified  owner account does not exist (a PDA, or an unfunded wallet - indistinguishable)
 *               or could not be read
 *
 * Only `wallet` holdings count towards wallet concentration. `program` and `unverified`
 * holdings are reported separately; when they are large we cannot judge concentration and
 * the check returns UNKNOWN. Caveat: one person can control many wallets, and exchanges hold
 * pooled user funds; this data cannot see either.
 */
import { SYSTEM_PROGRAM_ID, ratioBps } from "@tb/domain";
import type { AccountProgramInfo, LargestTokenAccount, TokenAccountOwner } from "@tb/providers";

/**
 * Authorities that own pool vaults on major Solana AMMs. A match only counts when the owner is
 * not a System Program wallet, so a wallet can never be mislabelled as a pool. Verify these
 * before relying on them; an unknown authority falls back to `program`/`unverified`.
 */
export const KNOWN_AMM_AUTHORITIES: Readonly<Record<string, string>> = {
  "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1": "Raydium AMM v4 authority",
  GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL: "Raydium CPMM authority",
};

export type HolderClass = "pool" | "wallet" | "program" | "unverified";

export interface HolderGroup {
  owner: string;
  class: HolderClass;
  amountRaw: bigint;
  accounts: number;
  label: string | null;
}

export interface HolderBreakdown {
  supplyRaw: bigint;
  groups: HolderGroup[];
  walletTop10Bps: number;
  walletMaxBps: number;
  poolBps: number;
  unverifiedBps: number;
  sharedOwners: { owner: string; accounts: number }[];
  accountsExamined: number;
}

export interface ClassifyInput {
  supplyRaw: bigint;
  largest: readonly LargestTokenAccount[];
  owners: readonly TokenAccountOwner[];
  ownerPrograms: readonly AccountProgramInfo[];
  mint: string;
  poolAddresses: readonly string[];
  knownAuthorities?: Readonly<Record<string, string>>;
}

export function classifyHolders(input: ClassifyInput): HolderBreakdown {
  if (input.supplyRaw <= 0n) throw new Error("supply must be positive to measure concentration");
  const authorities = input.knownAuthorities ?? KNOWN_AMM_AUTHORITIES;
  const pools = new Set(input.poolAddresses);
  const ownerByAccount = new Map(input.owners.filter((o) => o.mint === input.mint).map((o) => [o.tokenAccount, o.owner]));
  const programByOwner = new Map(input.ownerPrograms.map((p) => [p.address, p]));

  const groups = new Map<string, HolderGroup>();
  for (const acct of input.largest) {
    if (acct.amountRaw <= 0n) continue;
    const owner = ownerByAccount.get(acct.address);
    const key = owner ?? `unknown:${acct.address}`;
    let g = groups.get(key);
    if (!g) {
      g = { owner: owner ?? acct.address, class: classify(owner, programByOwner, pools, authorities), amountRaw: 0n, accounts: 0, label: owner ? (authorities[owner] ?? (pools.has(owner) ? "pool" : null)) : null };
      groups.set(key, g);
    }
    g.amountRaw += acct.amountRaw;
    g.accounts += 1;
  }

  const all = [...groups.values()].sort((a, b) => (b.amountRaw > a.amountRaw ? 1 : b.amountRaw < a.amountRaw ? -1 : 0));
  const wallets = all.filter((g) => g.class === "wallet");
  const sum = (gs: HolderGroup[]) => gs.reduce((t, g) => t + g.amountRaw, 0n);
  const bps = (raw: bigint) => Number(ratioBps(raw, input.supplyRaw, "ceil"));

  return {
    supplyRaw: input.supplyRaw,
    groups: all,
    walletTop10Bps: bps(sum(wallets.slice(0, 10))),
    walletMaxBps: wallets[0] ? bps(wallets[0].amountRaw) : 0,
    poolBps: bps(sum(all.filter((g) => g.class === "pool"))),
    unverifiedBps: bps(sum(all.filter((g) => g.class === "program" || g.class === "unverified"))),
    sharedOwners: all.filter((g) => g.accounts > 1).map((g) => ({ owner: g.owner, accounts: g.accounts })),
    accountsExamined: input.largest.length,
  };
}

function classify(
  owner: string | undefined,
  programs: Map<string, AccountProgramInfo>,
  pools: Set<string>,
  authorities: Readonly<Record<string, string>>,
): HolderClass {
  if (!owner) return "unverified";
  const info = programs.get(owner);
  const ownerProgram = info?.ownerProgram ?? null;
  const isWallet = ownerProgram === SYSTEM_PROGRAM_ID;
  if (!isWallet && (pools.has(owner) || owner in authorities)) return "pool";
  if (!info) return "unverified";
  if (isWallet) return "wallet";
  if (ownerProgram === null) return "unverified";
  return "program";
}
