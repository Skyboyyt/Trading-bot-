/**
 * Decoder for the SPL Token mint account layout (82 bytes). We decode raw bytes ourselves
 * rather than trusting an RPC node's parsed view, and refuse anything that is not exactly the
 * classic layout (Token-2022 mints with extensions are longer and are rejected upstream).
 *
 *   0  COption<Pubkey> mint_authority   (u32 tag + 32 bytes)
 *  36  u64            supply
 *  44  u8             decimals
 *  45  bool           is_initialized
 *  46  COption<Pubkey> freeze_authority (u32 tag + 32 bytes)
 */
import bs58 from "bs58";
import type { MintAccount } from "./types.ts";

export const SPL_MINT_LEN = 82;

export function decodeMint(data: Uint8Array): MintAccount["decoded"] | { error: string } {
  if (data.length !== SPL_MINT_LEN) return { error: `unexpected mint data length ${data.length}` };
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const mintAuthority = readCOptionPubkey(data, view, 0);
  if (mintAuthority === undefined) return { error: "invalid mint_authority option tag" };
  const supplyRaw = view.getBigUint64(36, true);
  const decimals = data[44]!;
  const initByte = data[45]!;
  if (initByte > 1) return { error: "invalid is_initialized byte" };
  const freezeAuthority = readCOptionPubkey(data, view, 46);
  if (freezeAuthority === undefined) return { error: "invalid freeze_authority option tag" };
  return { mintAuthority, supplyRaw, decimals, isInitialized: initByte === 1, freezeAuthority };
}

/** Returns the base58 key, null for None, or undefined for a malformed tag. */
function readCOptionPubkey(data: Uint8Array, view: DataView, offset: number): string | null | undefined {
  const tag = view.getUint32(offset, true);
  if (tag === 0) return null;
  if (tag !== 1) return undefined;
  return bs58.encode(data.subarray(offset + 4, offset + 36));
}

/** Build an 82-byte mint account (used by tests and fixtures). */
export function encodeMint(m: {
  mintAuthority: string | null;
  supplyRaw: bigint;
  decimals: number;
  isInitialized: boolean;
  freezeAuthority: string | null;
}): Uint8Array {
  const data = new Uint8Array(SPL_MINT_LEN);
  const view = new DataView(data.buffer);
  writeOption(data, view, 0, m.mintAuthority);
  view.setBigUint64(36, m.supplyRaw, true);
  data[44] = m.decimals;
  data[45] = m.isInitialized ? 1 : 0;
  writeOption(data, view, 46, m.freezeAuthority);
  return data;
}

function writeOption(data: Uint8Array, view: DataView, offset: number, key: string | null): void {
  if (key === null) return;
  view.setUint32(offset, 1, true);
  const bytes = bs58.decode(key);
  if (bytes.length !== 32) throw new Error("pubkey must be 32 bytes");
  data.set(bytes, offset + 4);
}
