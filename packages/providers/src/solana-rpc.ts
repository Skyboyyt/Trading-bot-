/**
 * Read-only Solana JSON-RPC adapter (ChainReader). It never sends transactions.
 */
import { z } from "zod";
import { HttpClient, ProviderError, type HttpClientOptions } from "./http.ts";
import { decodeMint } from "./mint-layout.ts";
import type {
  AccountProgramInfo,
  ChainReader,
  LargestTokenAccount,
  MintAccount,
  Observed,
  SignatureStatus,
  TokenAccountOwner,
} from "./types.ts";

export const SOLANA_RPC_PARSER_VERSION = "solana-rpc@1";
const PROVIDER = "solana-rpc";
const MAX_ACCOUNTS_PER_CALL = 100;

const u64String = z.string().regex(/^\d+$/);
const contextSchema = z.object({ slot: z.number().int().nonnegative() });
const rpcEnvelope = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.number(), z.string()]),
  result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string() }).optional(),
});

const accountInfoBase64 = z.object({
  context: contextSchema,
  value: z
    .object({
      data: z.tuple([z.string(), z.literal("base64")]),
      executable: z.boolean(),
      lamports: z.number(),
      owner: z.string(),
      space: z.number().optional(),
    })
    .nullable(),
});

const largestAccounts = z.object({
  context: contextSchema,
  value: z.array(z.object({ address: z.string(), amount: u64String, decimals: z.number().int().min(0).max(255) })),
});

const parsedTokenAccount = z.object({
  data: z.object({
    program: z.string(),
    parsed: z.object({
      type: z.string(),
      info: z.object({
        mint: z.string(),
        owner: z.string(),
        tokenAmount: z.object({ amount: u64String }),
      }),
    }),
  }),
  owner: z.string(),
});

const multipleParsed = z.object({ context: contextSchema, value: z.array(z.unknown().nullable()) });
const multipleBase64 = z.object({
  context: contextSchema,
  value: z.array(z.object({ owner: z.string(), executable: z.boolean() }).passthrough().nullable()),
});

const signatureStatuses = z.object({
  context: contextSchema,
  value: z.array(
    z
      .object({
        slot: z.number().int(),
        confirmationStatus: z.enum(["processed", "confirmed", "finalized"]).nullable(),
        err: z.unknown(),
      })
      .passthrough()
      .nullable(),
  ),
});

export interface SolanaRpcOptions extends Omit<HttpClientOptions, "provider" | "baseUrl"> {
  url: string;
  commitment?: "confirmed" | "finalized";
}

export class SolanaRpcReader implements ChainReader {
  readonly http: HttpClient;
  readonly #commitment: "confirmed" | "finalized";
  #id = 0;

  constructor(options: SolanaRpcOptions) {
    this.http = new HttpClient({ ...options, provider: PROVIDER, baseUrl: options.url });
    this.#commitment = options.commitment ?? "confirmed";
  }

  async #call<T>(method: string, params: unknown[], schema: z.ZodType<T>): Promise<{ result: T; receivedAt: Date; raw: unknown }> {
    const res = await this.http.post("", { jsonrpc: "2.0", id: ++this.#id, method, params });
    const env = rpcEnvelope.safeParse(res.body);
    if (!env.success) throw new ProviderError(PROVIDER, "PARSE", `${method}: malformed JSON-RPC envelope`);
    if (env.data.error) {
      const { code, message } = env.data.error;
      const kind = code === -32005 || code === 429 ? "RATE_LIMITED" : "RPC";
      throw new ProviderError(PROVIDER, kind, `${method}: ${code} ${message.slice(0, 200)}`);
    }
    const parsed = schema.safeParse(env.data.result);
    if (!parsed.success) throw new ProviderError(PROVIDER, "PARSE", `${method}: unexpected result shape`);
    return { result: parsed.data, receivedAt: res.receivedAt, raw: res.body };
  }

  #meta(receivedAt: Date, slot: number | null, raw: unknown) {
    return {
      network: "solana-mainnet" as const,
      provider: PROVIDER,
      eventAt: receivedAt,
      receivedAt,
      sourceSlot: slot === null ? null : BigInt(slot),
      parserVersion: SOLANA_RPC_PARSER_VERSION,
      raw,
    };
  }

  async getSlot(): Promise<Observed<bigint>> {
    const { result, receivedAt, raw } = await this.#call("getSlot", [{ commitment: this.#commitment }], z.number().int().nonnegative());
    return { data: BigInt(result), meta: this.#meta(receivedAt, result, raw) };
  }

  async getMintAccount(mint: string): Promise<Observed<MintAccount | null>> {
    const { result, receivedAt, raw } = await this.#call(
      "getAccountInfo",
      [mint, { encoding: "base64", commitment: this.#commitment }],
      accountInfoBase64,
    );
    const meta = this.#meta(receivedAt, result.context.slot, raw);
    if (!result.value) return { data: null, meta };
    const bytes = Buffer.from(result.value.data[0], "base64");
    const decoded = decodeMint(bytes);
    const isError = decoded !== null && "error" in decoded;
    return {
      data: {
        mint,
        programId: result.value.owner,
        dataLength: bytes.length,
        decoded: isError ? null : decoded,
        layoutError: isError ? decoded.error : null,
      },
      meta,
    };
  }

  async getLargestTokenAccounts(mint: string): Promise<Observed<LargestTokenAccount[]>> {
    const { result, receivedAt, raw } = await this.#call(
      "getTokenLargestAccounts",
      [mint, { commitment: this.#commitment }],
      largestAccounts,
    );
    return {
      data: result.value.map((v) => ({ address: v.address, amountRaw: BigInt(v.amount), decimals: v.decimals })),
      meta: this.#meta(receivedAt, result.context.slot, raw),
    };
  }

  async getTokenAccountOwners(tokenAccounts: readonly string[]): Promise<Observed<TokenAccountOwner[]>> {
    assertBatch(tokenAccounts);
    const { result, receivedAt, raw } = await this.#call(
      "getMultipleAccounts",
      [tokenAccounts, { encoding: "jsonParsed", commitment: this.#commitment }],
      multipleParsed,
    );
    const owners: TokenAccountOwner[] = [];
    result.value.forEach((v, i) => {
      if (!v) return;
      const parsed = parsedTokenAccount.safeParse(v);
      if (!parsed.success || parsed.data.data.parsed.type !== "account") return;
      const info = parsed.data.data.parsed.info;
      owners.push({ tokenAccount: tokenAccounts[i]!, owner: info.owner, mint: info.mint, amountRaw: BigInt(info.tokenAmount.amount) });
    });
    return { data: owners, meta: this.#meta(receivedAt, result.context.slot, raw) };
  }

  async getAccountPrograms(addresses: readonly string[]): Promise<Observed<AccountProgramInfo[]>> {
    assertBatch(addresses);
    const { result, receivedAt, raw } = await this.#call(
      "getMultipleAccounts",
      [addresses, { encoding: "base64", commitment: this.#commitment, dataSlice: { offset: 0, length: 0 } }],
      multipleBase64,
    );
    return {
      data: addresses.map((address, i) => {
        const v = result.value[i];
        return { address, ownerProgram: v?.owner ?? null, executable: v?.executable ?? false };
      }),
      meta: this.#meta(receivedAt, result.context.slot, raw),
    };
  }

  async getSignatureStatuses(signatures: readonly string[]): Promise<Observed<SignatureStatus[]>> {
    assertBatch(signatures);
    const { result, receivedAt, raw } = await this.#call(
      "getSignatureStatuses",
      [signatures, { searchTransactionHistory: true }],
      signatureStatuses,
    );
    return {
      data: signatures.map((signature, i) => {
        const v = result.value[i];
        return {
          signature,
          slot: v ? BigInt(v.slot) : null,
          confirmationStatus: v?.confirmationStatus ?? null,
          err: v?.err ?? null,
        };
      }),
      meta: this.#meta(receivedAt, result.context.slot, raw),
    };
  }
}

function assertBatch(items: readonly string[]): void {
  if (items.length === 0 || items.length > MAX_ACCOUNTS_PER_CALL) {
    throw new Error(`batch must contain 1..${MAX_ACCOUNTS_PER_CALL} items`);
  }
}
