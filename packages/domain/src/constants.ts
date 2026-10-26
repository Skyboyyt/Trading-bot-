/** Network identifier used everywhere a token or pool is referenced. Solana mainnet only for now. */
export const NETWORK = "solana-mainnet" as const;
export type Network = typeof NETWORK;

/** SPL Token program (the only token program accepted by the initial screening universe). */
export const SPL_TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
/** Token-2022 program. Rejected until extension parsing and tests exist. */
export const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";

/** Native USDC on Solana mainnet. */
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDC_DECIMALS = 6;
/** Wrapped SOL mint, used for quotes and pool identification. */
export const WSOL_MINT = "So11111111111111111111111111111111111111112";
export const SOL_DECIMALS = 9;
export const LAMPORTS_PER_SOL = 1_000_000_000n;

/**
 * Largest token decimals the system accepts. SPL allows a u8, but values above 18 are
 * unusual, break common price assumptions and are rejected as unsupported.
 */
export const MAX_SUPPORTED_DECIMALS = 18;

/** Base58 alphabet used by Solana addresses. */
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;

/** Shape check for a Solana public key / mint address (32 bytes => 32–44 base58 chars). */
export function isSolanaAddress(value: string): boolean {
  return value.length >= 32 && value.length <= 44 && BASE58.test(value);
}
