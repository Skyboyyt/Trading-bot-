/**
 * Exact decimal values for prices and ratios (never balances).
 *
 * Prices of memecoins can be extremely small (1e-12 USDC) or large, so they are kept as
 * arbitrary-precision decimals and serialized as strings. Balances stay in bigint base units.
 */
import Decimal from "decimal.js";
import { pow10 } from "./amounts.ts";

/** Isolated Decimal constructor so global configuration elsewhere can't change our precision. */
export const Dec = Decimal.clone({
  precision: 60,
  rounding: Decimal.ROUND_HALF_EVEN,
  toExpNeg: -60,
  toExpPos: 60,
});
export type Dec = InstanceType<typeof Dec>;

const DECIMAL_STRING = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/;

export class DecimalParseError extends Error {
  override name = "DecimalParseError";
}

/**
 * Parse a provider price. Accepts numbers only when they are finite and converts through
 * their shortest string form; rejects NaN, Infinity, blanks and non-numeric strings.
 */
export function parseDec(value: unknown): Dec {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new DecimalParseError(`Non-finite number: ${value}`);
    return new Dec(value.toString());
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!DECIMAL_STRING.test(trimmed)) throw new DecimalParseError(`Not a decimal: "${value}"`);
    return new Dec(trimmed);
  }
  throw new DecimalParseError(`Unsupported decimal input type: ${typeof value}`);
}

export function tryParseDec(value: unknown): Dec | null {
  try {
    return parseDec(value);
  } catch {
    return null;
  }
}

/** Fixed-point string suitable for a PostgreSQL NUMERIC column. */
export function decToString(value: Dec): string {
  return value.toFixed();
}

/**
 * Price of one whole token in quote units, from raw base-unit amounts on both sides.
 * price = (quoteRaw / 10^quoteDecimals) / (tokenRaw / 10^tokenDecimals)
 */
export function priceFromRaw(
  quoteRaw: bigint,
  quoteDecimals: number,
  tokenRaw: bigint,
  tokenDecimals: number,
): Dec {
  if (tokenRaw === 0n) throw new DecimalParseError("Cannot derive a price from zero tokens");
  const quote = new Dec(quoteRaw.toString()).div(pow10(quoteDecimals).toString());
  const token = new Dec(tokenRaw.toString()).div(pow10(tokenDecimals).toString());
  return quote.div(token);
}

/** Convert a decimal value in whole units to base units with explicit rounding. */
export function decToRaw(value: Dec, decimals: number, rounding: "floor" | "ceil" | "half-even"): bigint {
  const scaled = value.mul(pow10(decimals).toString());
  const mode =
    rounding === "floor" ? Dec.ROUND_FLOOR : rounding === "ceil" ? Dec.ROUND_CEIL : Dec.ROUND_HALF_EVEN;
  return BigInt(scaled.toDecimalPlaces(0, mode).toFixed(0));
}
