import { randomBytes } from "node:crypto";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import { redactString, redactValue, registerSecrets } from "../src/index.ts";

describe("secret redaction", () => {
  it("masks registered secret values anywhere in a string", () => {
    registerSecrets(["jup-secret-abcdef"]);
    expect(redactString("calling with key=jup-secret-abcdef ok")).toBe("calling with key=[REDACTED] ok");
  });

  it("masks strings shaped like base58 64-byte secret keys", () => {
    const fakeKey = bs58.encode(randomBytes(64));
    expect(redactString(`oops ${fakeKey}`)).toBe("oops [REDACTED]");
    // Ordinary 32-byte addresses (mints, signatures are 64 bytes but labelled) are left alone.
    const mint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    expect(redactString(mint)).toBe(mint);
  });

  it("masks sensitive keys by exact name but keeps similarly named fields", () => {
    const out = redactValue({
      password: "x",
      apiKey: "y",
      privateKey: "z",
      nested: { secretKey: [1, 2, 3], token: "t" },
      baseToken: "So11111111111111111111111111111111111111112",
      tokenAmount: "10",
    }) as Record<string, unknown>;
    expect(out.password).toBe("[REDACTED]");
    expect(out.apiKey).toBe("[REDACTED]");
    expect(out.privateKey).toBe("[REDACTED]");
    expect((out.nested as Record<string, unknown>).secretKey).toBe("[REDACTED]");
    expect((out.nested as Record<string, unknown>).token).toBe("[REDACTED]");
    expect(out.baseToken).toBe("So11111111111111111111111111111111111111112");
    expect(out.tokenAmount).toBe("10");
  });

  it("serialises bigint and errors safely", () => {
    expect(redactValue(5n)).toBe("5");
    expect(redactValue(new Error("boom"))).toEqual({ name: "Error", message: "boom" });
  });
});
