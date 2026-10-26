/**
 * Exact amount arithmetic.
 *
 * Every balance, quantity, fee and P&L figure is an integer number of base units held in a
 * `bigint` (USDC micro-units, lamports, token base units). Floating point is never used for
 * money. Amounts cross JSON boundaries as decimal strings.
 */
import { MAX_SUPPORTED_DECIMALS } from "./constants.ts";

export type Rounding = "floor" | "ceil" | "half-even" | "trunc";

export class AmountError extends Error {
  override name = "AmountError";
}

const INTEGER = /^-?\d+$/;
const DECIMAL = /^(-)?(\d+)(?:\.(\d+))?$/;

/** Parse a base-unit integer string ("12345") into a bigint. Rejects decimals, exponents and blanks. */
export function parseRaw(value: string | bigint | number): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new AmountError(`Unsafe integer for amount: ${value}`);
    return BigInt(value);
  }
  const trimmed = value.trim();
  if (!INTEGER.test(trimmed)) throw new AmountError(`Not an integer amount: "${value}"`);
  return BigInt(trimmed);
}

/** Serialize a bigint amount for JSON. */
export function rawToString(value: bigint): string {
  return value.toString(10);
}

export function assertDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new AmountError(`Invalid token decimals: ${decimals}`);
  }
}

export function isSupportedDecimals(decimals: number): boolean {
  return Number.isInteger(decimals) && decimals >= 0 && decimals <= MAX_SUPPORTED_DECIMALS;
}

export function pow10(exp: number): bigint {
  if (!Number.isInteger(exp) || exp < 0) throw new AmountError(`Invalid exponent: ${exp}`);
  return 10n ** BigInt(exp);
}

/**
 * Convert a human decimal string ("1.25") into base units for a token with `decimals`.
 * Extra fractional digits are an error unless a rounding mode is given.
 */
export function toBaseUnits(value: string, decimals: number, rounding?: Rounding): bigint {
  assertDecimals(decimals);
  const match = DECIMAL.exec(value.trim());
  if (!match) throw new AmountError(`Not a decimal amount: "${value}"`);
  const [, sign, whole = "0", frac = ""] = match;
  const scale = pow10(decimals);
  let result = BigInt(whole) * scale;
  if (frac.length <= decimals) {
    result += BigInt(frac.padEnd(decimals, "0") || "0");
  } else {
    if (!rounding) throw new AmountError(`"${value}" has more than ${decimals} fractional digits`);
    const kept = frac.slice(0, decimals);
    const dropped = frac.slice(decimals);
    const keptValue = BigInt(kept || "0");
    const numerator = BigInt(dropped);
    const denominator = pow10(dropped.length);
    result += keptValue;
    // Rounding relative to the magnitude; sign applied afterwards.
    const negative = sign === "-";
    if (numerator > 0n) result += roundIncrement(result, numerator, denominator, rounding, negative);
  }
  return sign === "-" ? -result : result;
}

function roundIncrement(
  magnitude: bigint,
  remainder: bigint,
  divisor: bigint,
  rounding: Rounding,
  negative: boolean,
): bigint {
  switch (rounding) {
    case "trunc":
      return 0n;
    case "floor":
      return negative ? 1n : 0n;
    case "ceil":
      return negative ? 0n : 1n;
    case "half-even": {
      const twice = remainder * 2n;
      if (twice > divisor) return 1n;
      if (twice < divisor) return 0n;
      return magnitude % 2n === 0n ? 0n : 1n;
    }
  }
}

/** Format base units as a human decimal string with exactly `decimals` fractional digits trimmed of trailing zeros. */
export function fromBaseUnits(raw: bigint, decimals: number, { trimZeros = true } = {}): string {
  assertDecimals(decimals);
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const scale = pow10(decimals);
  const whole = abs / scale;
  let frac = decimals === 0 ? "" : (abs % scale).toString().padStart(decimals, "0");
  if (trimZeros) frac = frac.replace(/0+$/, "");
  const body = frac ? `${whole}.${frac}` : whole.toString();
  return negative ? `-${body}` : body;
}

/** Integer division with an explicit rounding mode. */
export function divRound(numerator: bigint, denominator: bigint, rounding: Rounding): bigint {
  if (denominator === 0n) throw new AmountError("Division by zero");
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const q = n / d;
  const r = n % d;
  let magnitude = q;
  if (r !== 0n) magnitude += roundIncrement(q, r, d, rounding, negative);
  return negative ? -magnitude : magnitude;
}

/** (a * b) / c with a single rounding step, avoiding intermediate precision loss. */
export function mulDiv(a: bigint, b: bigint, c: bigint, rounding: Rounding): bigint {
  return divRound(a * b, c, rounding);
}

export const BPS_DENOMINATOR = 10_000n;

/** amount * bps / 10_000 with explicit rounding. */
export function applyBps(amount: bigint, bps: number | bigint, rounding: Rounding): bigint {
  const b = typeof bps === "bigint" ? bps : BigInt(bps);
  return mulDiv(amount, b, BPS_DENOMINATOR, rounding);
}

/** Ratio of two amounts in basis points, rounded towards the conservative side the caller chooses. */
export function ratioBps(part: bigint, whole: bigint, rounding: Rounding): bigint {
  if (whole === 0n) throw new AmountError("Ratio against zero");
  return mulDiv(part, BPS_DENOMINATOR, whole, rounding);
}

export function minBig(...values: bigint[]): bigint {
  if (values.length === 0) throw new AmountError("minBig of nothing");
  return values.reduce((m, v) => (v < m ? v : m));
}

export function maxBig(...values: bigint[]): bigint {
  if (values.length === 0) throw new AmountError("maxBig of nothing");
  return values.reduce((m, v) => (v > m ? v : m));
}

export function absBig(v: bigint): bigint {
  return v < 0n ? -v : v;
}

export function sumBig(values: Iterable<bigint>): bigint {
  let total = 0n;
  for (const v of values) total += v;
  return total;
}

/** A quantity of a specific mint, carried together so units are never mixed up. */
export interface TokenAmount {
  readonly mint: string;
  readonly decimals: number;
  readonly raw: bigint;
}

export function tokenAmount(mint: string, decimals: number, raw: bigint): TokenAmount {
  assertDecimals(decimals);
  return { mint, decimals, raw };
}

export function addAmounts(a: TokenAmount, b: TokenAmount): TokenAmount {
  if (a.mint !== b.mint || a.decimals !== b.decimals) {
    throw new AmountError(`Cannot add ${a.mint} and ${b.mint}`);
  }
  return { mint: a.mint, decimals: a.decimals, raw: a.raw + b.raw };
}

/** JSON-safe representation of a token amount. */
export interface TokenAmountJson {
  mint: string;
  decimals: number;
  raw: string;
}

export function tokenAmountToJson(a: TokenAmount): TokenAmountJson {
  return { mint: a.mint, decimals: a.decimals, raw: rawToString(a.raw) };
}
