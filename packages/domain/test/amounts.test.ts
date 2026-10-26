import { describe, expect, it } from "vitest";
import {
  AmountError,
  applyBps,
  divRound,
  fromBaseUnits,
  MAX_SUPPORTED_DECIMALS,
  mulDiv,
  parseRaw,
  ratioBps,
  toBaseUnits,
  isSupportedDecimals,
  seededRng,
} from "../src/index.ts";
import { decToRaw, parseDec, priceFromRaw, Dec } from "../src/decimal.ts";

describe("base-unit arithmetic", () => {
  it("converts decimal strings to base units exactly", () => {
    expect(toBaseUnits("1.25", 6)).toBe(1_250_000n);
    expect(toBaseUnits("0.000001", 6)).toBe(1n);
    expect(toBaseUnits("1000", 0)).toBe(1000n);
    expect(toBaseUnits("-2.5", 9)).toBe(-2_500_000_000n);
  });

  it("refuses silent precision loss", () => {
    expect(() => toBaseUnits("0.0000001", 6)).toThrow(AmountError);
    expect(toBaseUnits("0.0000001", 6, "floor")).toBe(0n);
    expect(toBaseUnits("0.0000001", 6, "ceil")).toBe(1n);
    expect(toBaseUnits("0.0000005", 6, "half-even")).toBe(0n);
    expect(toBaseUnits("0.0000015", 6, "half-even")).toBe(2n);
  });

  it("rejects malformed input", () => {
    for (const bad of ["", "1e6", "abc", "1.2.3", " ", "NaN", "Infinity"]) {
      expect(() => toBaseUnits(bad, 6)).toThrow(AmountError);
    }
    expect(() => parseRaw("1.5")).toThrow(AmountError);
    expect(() => parseRaw("1e3")).toThrow(AmountError);
    expect(() => parseRaw(2 ** 60)).toThrow(AmountError);
    expect(parseRaw("123456789012345678901234567890")).toBe(123456789012345678901234567890n);
  });

  it("round-trips across every supported decimal count, including extremes", () => {
    const rng = seededRng(42);
    for (let decimals = 0; decimals <= MAX_SUPPORTED_DECIMALS; decimals++) {
      for (let i = 0; i < 50; i++) {
        const raw = BigInt(Math.floor(rng.next() * 1e15)) * BigInt(Math.floor(rng.next() * 1e6) + 1);
        expect(toBaseUnits(fromBaseUnits(raw, decimals), decimals)).toBe(raw);
      }
    }
    // u64::MAX supply with 18 decimals stays exact.
    const u64max = 18_446_744_073_709_551_615n;
    expect(fromBaseUnits(u64max, 18)).toBe("18.446744073709551615");
    expect(fromBaseUnits(u64max, 0)).toBe("18446744073709551615");
  });

  it("flags unsupported decimal counts", () => {
    expect(isSupportedDecimals(18)).toBe(true);
    expect(isSupportedDecimals(19)).toBe(false);
    expect(isSupportedDecimals(-1)).toBe(false);
    expect(isSupportedDecimals(6.5)).toBe(false);
  });

  it("rounds division explicitly", () => {
    expect(divRound(10n, 3n, "floor")).toBe(3n);
    expect(divRound(10n, 3n, "ceil")).toBe(4n);
    expect(divRound(-10n, 3n, "floor")).toBe(-4n);
    expect(divRound(-10n, 3n, "ceil")).toBe(-3n);
    expect(divRound(-10n, 3n, "trunc")).toBe(-3n);
    expect(divRound(5n, 2n, "half-even")).toBe(2n);
    expect(divRound(7n, 2n, "half-even")).toBe(4n);
    expect(() => divRound(1n, 0n, "floor")).toThrow(AmountError);
  });

  it("computes basis points without floats", () => {
    expect(applyBps(10_000_000n, 50, "ceil")).toBe(50_000n);
    expect(applyBps(3n, 1, "ceil")).toBe(1n);
    expect(applyBps(3n, 1, "floor")).toBe(0n);
    expect(ratioBps(1n, 3n, "ceil")).toBe(3334n);
    expect(mulDiv(2n ** 200n, 3n, 2n ** 199n, "floor")).toBe(6n);
  });
});

describe("decimal prices", () => {
  it("derives tiny memecoin prices exactly", () => {
    // 1 USDC buys 1e12 whole tokens of a 9-decimal token.
    const price = priceFromRaw(1_000_000n, 6, 10n ** 21n, 9);
    expect(price.toFixed()).toBe("0.000000000001");
  });

  it("handles 0 and 18 decimal tokens", () => {
    expect(priceFromRaw(2_500_000n, 6, 2n, 0).toFixed()).toBe("1.25");
    expect(priceFromRaw(1n, 6, 10n ** 18n, 18).toFixed()).toBe("0.000001");
  });

  it("parses provider strings but rejects non-finite values", () => {
    expect(parseDec("0.00000000123").toFixed()).toBe("0.00000000123");
    expect(parseDec("1e-12").toFixed()).toBe("0.000000000001");
    expect(() => parseDec(Number.NaN)).toThrow();
    expect(() => parseDec("Infinity")).toThrow();
    expect(() => parseDec("")).toThrow();
    expect(() => parseDec(null)).toThrow();
  });

  it("converts decimals back to base units with explicit rounding", () => {
    expect(decToRaw(new Dec("1.0000005"), 6, "floor")).toBe(1_000_000n);
    expect(decToRaw(new Dec("1.0000005"), 6, "ceil")).toBe(1_000_001n);
  });
});
