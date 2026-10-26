import { describe, expect, it } from "vitest";
import { assertNoSigningMaterial, ConfigError, loadApiConfig, loadBaseConfig, loadWorkerConfig, secretValues } from "../src/index.ts";

const base = { DATABASE_URL: "postgres://u:supersecretpw@localhost:5432/tb" };
const worker = { ...base, SOLANA_RPC_URL: "https://api.mainnet-beta.solana.com" };
const api = {
  ...base,
  SESSION_SECRET: "x".repeat(40),
  OWNER_USERNAME: "senku",
  OWNER_PASSWORD_HASH: "scrypt$16384$8$1$c2FsdA==$aGFzaA==",
};

describe("configuration", () => {
  it("defaults to PAPER", () => {
    expect(loadBaseConfig(base).TRADING_MODE).toBe("PAPER");
  });

  it("refuses LIVE mode in this build", () => {
    expect(() => loadBaseConfig({ ...base, TRADING_MODE: "LIVE" })).toThrow(/LIVE trading is not available/);
  });

  it("refuses to start when any signing material is present", () => {
    for (const key of ["PRIVATE_KEY", "WALLET_PRIVATE_KEY", "MY_BOT_PRIVATE_KEY", "KEYPAIR_PATH", "SIGNER_URL", "MNEMONIC", "SEED_PHRASE"]) {
      expect(() => loadWorkerConfig({ ...worker, [key]: "anything" })).toThrow(ConfigError);
      expect(() => loadApiConfig({ ...api, [key]: "anything" })).toThrow(ConfigError);
    }
    expect(() => assertNoSigningMaterial({ PRIVATE_KEY: "" })).not.toThrow();
  });

  it("derives conservative keyless rate limits", () => {
    const cfg = loadWorkerConfig(worker);
    expect(cfg.jupiterRequestsPerSecond).toBeLessThan(0.5);
    expect(cfg.marketDataCallsPerMinute).toBeLessThan(10);
    expect(cfg.marketDataApiKeyHeader).toBeNull();
  });

  it("switches to the keyed CoinGecko on-chain API only with a declared plan", () => {
    expect(() => loadWorkerConfig({ ...worker, COINGECKO_API_KEY: "k".repeat(20) })).toThrow(/COINGECKO_API_PLAN/);
    const cfg = loadWorkerConfig({ ...worker, COINGECKO_API_KEY: "k".repeat(20), COINGECKO_API_PLAN: "demo" });
    expect(cfg.marketDataBaseUrl).toBe("https://api.coingecko.com/api/v3/onchain");
    expect(cfg.marketDataApiKeyHeader?.name).toBe("x-cg-demo-api-key");
  });

  it("requires a generated password hash and a long session secret", () => {
    expect(() => loadApiConfig({ ...api, OWNER_PASSWORD_HASH: "plaintext" })).toThrow(ConfigError);
    expect(() => loadApiConfig({ ...api, SESSION_SECRET: "short" })).toThrow(ConfigError);
    expect(loadApiConfig(api).WEB_ORIGIN).toEqual(["http://localhost:5173"]);
  });

  it("requires secure cookies in production", () => {
    expect(() => loadApiConfig({ ...api, NODE_ENV: "production", COOKIE_SECURE: "false" })).toThrow(/COOKIE_SECURE/);
    expect(loadApiConfig({ ...api, NODE_ENV: "production" }).COOKIE_SECURE).toBe(true);
  });

  it("collects secrets for log redaction, including the database password", () => {
    const values = secretValues({ ...api, JUPITER_API_KEY: "jup-key-123456" });
    expect(values).toContain("supersecretpw");
    expect(values).toContain("jup-key-123456");
    expect(values).toContain(api.SESSION_SECRET);
  });
});
