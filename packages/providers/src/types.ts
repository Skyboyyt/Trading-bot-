/**
 * Provider-neutral types and interfaces.
 *
 * Every observation carries where and when it came from: network, provider, the provider's
 * event time, our receipt time, the source slot when known, the parser version and the raw
 * payload (persisted by the caller and referenced by hash). Amounts are bigint base units,
 * prices are exact decimals. Missing values are `null`, never zero.
 */
import type { Dec } from "@tb/domain";

export interface ObservationMeta {
  network: "solana-mainnet";
  provider: string;
  /** When the observed fact happened according to the source (falls back to receipt time). */
  eventAt: Date;
  receivedAt: Date;
  sourceSlot: bigint | null;
  parserVersion: string;
  raw: unknown;
}

export interface Observed<T> {
  data: T;
  meta: ObservationMeta;
}

// --- Chain ----------------------------------------------------------------------------------

export interface MintAccount {
  mint: string;
  /** Program that owns the mint account (SPL Token or Token-2022). */
  programId: string;
  dataLength: number;
  /** Decoded only when the layout is the 82-byte SPL Token mint; otherwise null. */
  decoded: {
    mintAuthority: string | null;
    supplyRaw: bigint;
    decimals: number;
    isInitialized: boolean;
    freezeAuthority: string | null;
  } | null;
  layoutError: string | null;
}

export interface LargestTokenAccount {
  address: string;
  amountRaw: bigint;
  decimals: number;
}

export interface TokenAccountOwner {
  tokenAccount: string;
  /** The wallet/authority that controls the token account. */
  owner: string;
  mint: string;
  amountRaw: bigint;
}

export interface AccountProgramInfo {
  address: string;
  /** null when the account does not exist (typical for PDA authorities). */
  ownerProgram: string | null;
  executable: boolean;
}

export interface SignatureStatus {
  signature: string;
  slot: bigint | null;
  confirmationStatus: "processed" | "confirmed" | "finalized" | null;
  err: unknown;
}

export interface ChainReader {
  getSlot(): Promise<Observed<bigint>>;
  getMintAccount(mint: string): Promise<Observed<MintAccount | null>>;
  getLargestTokenAccounts(mint: string): Promise<Observed<LargestTokenAccount[]>>;
  getTokenAccountOwners(tokenAccounts: readonly string[]): Promise<Observed<TokenAccountOwner[]>>;
  getAccountPrograms(addresses: readonly string[]): Promise<Observed<AccountProgramInfo[]>>;
  getSignatureStatuses(signatures: readonly string[]): Promise<Observed<SignatureStatus[]>>;
}

// --- Market data ----------------------------------------------------------------------------

export interface TxCounts {
  buys: number;
  sells: number;
  buyers: number | null;
  sellers: number | null;
}

export interface PoolSnapshot {
  poolAddress: string;
  baseMint: string;
  quoteMint: string;
  dexId: string | null;
  poolCreatedAt: Date | null;
  reserveUsd: Dec | null;
  basePriceUsd: Dec | null;
  quotePriceUsd: Dec | null;
  volumeUsd: { m5: Dec | null; h1: Dec | null; h24: Dec | null };
  transactions: { m5: TxCounts | null; h1: TxCounts | null; h24: TxCounts | null };
}

export interface Candle {
  openTime: Date;
  closeTime: Date;
  open: Dec;
  high: Dec;
  low: Dec;
  close: Dec;
  /** Null when the provider gave no volume. */
  volumeUsd: Dec | null;
}

export interface CandleRequest {
  poolAddress: string;
  /** Which side of the pool the tracked token is on; prices are quoted for that token. */
  tokenSide: "base" | "quote";
  beforeTimestamp?: Date;
  limit?: number;
}

export interface MarketDataProvider {
  readonly name: string;
  getPool(poolAddress: string): Promise<Observed<PoolSnapshot>>;
  getTokenPools(mint: string): Promise<Observed<PoolSnapshot[]>>;
  /** Minute candles, oldest first. May include the still-open current minute; callers filter. */
  getMinuteCandles(req: CandleRequest): Promise<Observed<Candle[]>>;
}

// --- Discovery ------------------------------------------------------------------------------

export interface TokenCandidate {
  mint: string;
  preferredPoolAddress: string | null;
  note: string | null;
}

/** Initial implementation reads the owner-supplied allowlist; there is no launch sniping. */
export interface TokenDiscoveryProvider {
  listCandidates(): Promise<TokenCandidate[]>;
}

// --- Swaps ----------------------------------------------------------------------------------

export interface QuoteRequest {
  inputMint: string;
  outputMint: string;
  amountRaw: bigint;
  slippageBps?: number;
}

export interface SwapQuote {
  provider: string;
  adapterVersion: string;
  inputMint: string;
  outputMint: string;
  inAmountRaw: bigint;
  /** Expected output delivered to the taker (already net of the route's platform fee). */
  outAmountRaw: bigint;
  /** Minimum output after slippage. */
  minOutAmountRaw: bigint;
  slippageBps: number | null;
  /** Absolute price impact in basis points, rounded up; null when the provider did not say. */
  priceImpactBps: number | null;
  feeBps: number | null;
  feeMint: string | null;
  platformFee: { amountRaw: bigint; mint: string | null } | null;
  signatureFeeLamports: bigint | null;
  prioritizationFeeLamports: bigint | null;
  rentFeeLamports: bigint | null;
  router: string | null;
  routeLabels: string[];
  requestId: string | null;
}

export interface SwapProvider {
  readonly name: string;
  /** Quote only. Paper mode never requests or handles a transaction. */
  getQuote(req: QuoteRequest): Promise<Observed<SwapQuote>>;
}
