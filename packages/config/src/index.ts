/**
 * Validated configuration for every deployable.
 *
 * Config is parsed once at startup with Zod and the process exits on any problem. This build
 * only supports PAPER mode: LIVE is refused, and the presence of any private-key style variable
 * is treated as a fatal misconfiguration so a paper process can never be handed signing material.
 */
import { hostname } from "node:os";
import { z } from "zod";

export class ConfigError extends Error {
  override name = "ConfigError";
}

/** Environment variables that would carry signing material. Their presence fails startup. */
export const FORBIDDEN_SIGNING_ENV = [
  "PRIVATE_KEY",
  "WALLET_PRIVATE_KEY",
  "SOLANA_PRIVATE_KEY",
  "BS58_PRIVATE_KEY",
  "SECRET_KEY",
  "KEYPAIR",
  "KEYPAIR_PATH",
  "SOLANA_KEYPAIR",
  "SIGNER_URL",
  "SIGNER_TOKEN",
  "MNEMONIC",
  "SEED_PHRASE",
] as const;

export function assertNoSigningMaterial(env: NodeJS.ProcessEnv): void {
  const present = Object.keys(env).filter((key) => {
    const upper = key.toUpperCase();
    return (
      env[key] !== undefined &&
      env[key] !== "" &&
      FORBIDDEN_SIGNING_ENV.some((name) => upper === name || upper.endsWith(`_${name}`))
    );
  });
  if (present.length > 0) {
    throw new ConfigError(
      `Refusing to start: signing material is not allowed in this build (found ${present.join(", ")}). ` +
        "Paper mode never needs a private key, keypair or signer.",
    );
  }
}

const boolFromEnv = (fallback: boolean) =>
  z
    .enum(["true", "false", "1", "0"])
    .optional()
    .transform((v) => (v === undefined ? fallback : v === "true" || v === "1"));

const postgresUrl = z
  .string()
  .min(1, "DATABASE_URL is required")
  .refine((v) => /^postgres(ql)?:\/\//.test(v), "DATABASE_URL must be a postgres:// URL");

const tradingMode = z
  .enum(["PAPER", "LIVE"])
  .default("PAPER")
  .refine((mode) => mode === "PAPER", {
    message:
      "LIVE trading is not available in this build. It requires the separate signing service and security review described in docs/live-integration-plan.md.",
  });

const baseSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  DATABASE_URL: postgresUrl,
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),
  TRADING_MODE: tradingMode,
});

const workerSchema = baseSchema.extend({
  WORKER_ID: z.string().min(1).default(`${hostname()}-${process.pid}`),
  SOLANA_RPC_URL: z.url({ message: "SOLANA_RPC_URL must be an http(s) URL" }),
  SOLANA_RPC_REQUESTS_PER_SECOND: z.coerce.number().positive().max(100).default(4),
  JUPITER_BASE_URL: z.url().default("https://api.jup.ag/swap/v2"),
  JUPITER_API_KEY: z.string().min(1).optional(),
  /** Requests per second. Keyless Jupiter access is limited to 0.5 RPS; stay under it. */
  JUPITER_REQUESTS_PER_SECOND: z.coerce.number().positive().max(150).optional(),
  MARKET_DATA_PROVIDER: z.enum(["geckoterminal"]).default("geckoterminal"),
  GECKOTERMINAL_BASE_URL: z.url().default("https://api.geckoterminal.com/api/v2"),
  COINGECKO_API_KEY: z.string().min(1).optional(),
  COINGECKO_API_PLAN: z.enum(["demo", "pro"]).optional(),
  /** Keyless GeckoTerminal access is about 10 calls/minute and fluctuates; stay under it. */
  MARKET_DATA_CALLS_PER_MINUTE: z.coerce.number().positive().max(1000).optional(),
  INGEST_INTERVAL_MS: z.coerce.number().int().min(5_000).default(60_000),
  SCREEN_INTERVAL_MS: z.coerce.number().int().min(5_000).default(120_000),
  STRATEGY_INTERVAL_MS: z.coerce.number().int().min(5_000).default(30_000),
  EXECUTION_POLL_MS: z.coerce.number().int().min(250).default(2_000),
  RECONCILE_INTERVAL_MS: z.coerce.number().int().min(1_000).default(15_000),
  SNAPSHOT_INTERVAL_MS: z.coerce.number().int().min(5_000).default(60_000),
  HTTP_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(10_000),
  PAPER_SIM_SEED: z.coerce.number().int().default(1),
});

const apiSchema = baseSchema.extend({
  API_HOST: z.string().default("0.0.0.0"),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  /** Comma-separated list of allowed dashboard origins for CORS. */
  WEB_ORIGIN: z
    .string()
    .default("http://localhost:5173")
    .transform((v) =>
      v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.url()).min(1)),
  SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 characters"),
  OWNER_USERNAME: z.string().min(1),
  OWNER_PASSWORD_HASH: z
    .string()
    .regex(/^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/, "OWNER_PASSWORD_HASH must be generated with `pnpm hash-password`"),
  SESSION_TTL_HOURS: z.coerce.number().positive().max(168).default(12),
  COOKIE_SECURE: boolFromEnv(true),
  TRUST_PROXY: boolFromEnv(false),
  SERVE_WEB_DIST: z.string().optional(),
});

export type BaseConfig = z.infer<typeof baseSchema>;
export type WorkerConfig = z.infer<typeof workerSchema> & {
  jupiterRequestsPerSecond: number;
  marketDataCallsPerMinute: number;
  marketDataBaseUrl: string;
  marketDataApiKeyHeader: { name: string; value: string } | null;
};
export type ApiConfig = z.infer<typeof apiSchema>;

function parse<T extends z.ZodType>(schema: T, env: NodeJS.ProcessEnv): z.infer<T> {
  const result = schema.safeParse(env);
  if (!result.success) {
    throw new ConfigError(`Invalid configuration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

export function loadBaseConfig(env: NodeJS.ProcessEnv = process.env): BaseConfig {
  assertNoSigningMaterial(env);
  return parse(baseSchema, env);
}

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  assertNoSigningMaterial(env);
  const cfg = parse(workerSchema, env);
  if (cfg.COINGECKO_API_KEY && !cfg.COINGECKO_API_PLAN) {
    throw new ConfigError("COINGECKO_API_PLAN (demo|pro) is required when COINGECKO_API_KEY is set");
  }
  const keyed = Boolean(cfg.COINGECKO_API_KEY);
  const marketDataBaseUrl = keyed
    ? cfg.COINGECKO_API_PLAN === "pro"
      ? "https://pro-api.coingecko.com/api/v3/onchain"
      : "https://api.coingecko.com/api/v3/onchain"
    : cfg.GECKOTERMINAL_BASE_URL;
  const marketDataApiKeyHeader = keyed
    ? {
        name: cfg.COINGECKO_API_PLAN === "pro" ? "x-cg-pro-api-key" : "x-cg-demo-api-key",
        value: cfg.COINGECKO_API_KEY as string,
      }
    : null;
  return {
    ...cfg,
    jupiterRequestsPerSecond: cfg.JUPITER_REQUESTS_PER_SECOND ?? (cfg.JUPITER_API_KEY ? 0.9 : 0.4),
    marketDataCallsPerMinute: cfg.MARKET_DATA_CALLS_PER_MINUTE ?? (keyed ? 25 : 8),
    marketDataBaseUrl,
    marketDataApiKeyHeader,
  };
}

export function loadApiConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  assertNoSigningMaterial(env);
  const cfg = parse(apiSchema, env);
  if (cfg.NODE_ENV === "production" && !cfg.COOKIE_SECURE) {
    throw new ConfigError("COOKIE_SECURE must be true in production");
  }
  return cfg;
}

/** Values that must never appear in logs; fed to the observability redactor at startup. */
export function secretValues(env: NodeJS.ProcessEnv = process.env): string[] {
  const keys = ["SESSION_SECRET", "JUPITER_API_KEY", "COINGECKO_API_KEY", "OWNER_PASSWORD_HASH"];
  const values = keys.map((k) => env[k]).filter((v): v is string => typeof v === "string" && v.length >= 8);
  const db = env.DATABASE_URL;
  if (db) {
    try {
      const pw = new URL(db).password;
      if (pw && pw.length >= 4) values.push(decodeURIComponent(pw));
    } catch {
      // Ignore unparsable URLs here; config validation reports them.
    }
  }
  // RPC providers often embed API keys in the URL path or query string.
  const rpc = env.SOLANA_RPC_URL;
  if (rpc) {
    try {
      const u = new URL(rpc);
      for (const v of u.searchParams.values()) if (v.length >= 8) values.push(v);
      for (const segment of u.pathname.split("/")) if (segment.length >= 16) values.push(segment);
      if (u.password) values.push(decodeURIComponent(u.password));
    } catch {
      // Reported by validation.
    }
  }
  return values;
}
