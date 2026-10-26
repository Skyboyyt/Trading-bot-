/**
 * Structured logging with secret redaction.
 *
 * Three layers keep secrets out of logs:
 *  1. Known sensitive keys are removed by pino's redaction (cookies, auth headers, api keys...).
 *  2. Exact secret values registered at startup are masked wherever they appear in strings.
 *  3. Strings that look like base58 Solana secret keys (64-byte keys, ~87–88 chars) are masked.
 */
import { pino, type Logger, type LoggerOptions } from "pino";

export type { Logger } from "pino";

const REDACT_PATHS = [
  "req.headers.cookie",
  "req.headers.authorization",
  'req.headers["x-api-key"]',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  "headers.cookie",
  "headers.authorization",
  'headers["x-api-key"]',
  "*.password",
  "*.passwordHash",
  "*.secret",
  "*.apiKey",
  "*.privateKey",
  "*.secretKey",
  "*.sessionSecret",
  "*.token",
  "password",
  "apiKey",
  "privateKey",
  "secretKey",
];

const MASK = "[REDACTED]";
const BASE58_SECRET_KEY = /\b[1-9A-HJ-NP-Za-km-z]{86,90}\b/g;

const registeredSecrets = new Set<string>();

/** Register exact secret values (API keys, session secret, DB password) to mask in any log string. */
export function registerSecrets(values: Iterable<string>): void {
  for (const v of values) {
    if (v && v.length >= 4) registeredSecrets.add(v);
  }
}

/** Mask registered secrets and key-shaped strings inside an arbitrary string. */
export function redactString(input: string): string {
  let out = input;
  for (const secret of registeredSecrets) {
    if (out.includes(secret)) out = out.split(secret).join(MASK);
  }
  return out.replace(BASE58_SECRET_KEY, MASK);
}

/** Deep-redact a value for logging or audit storage. */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[TRUNCATED]";
  if (typeof value === "string") return redactString(value);
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message) };
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? MASK : redactValue(v, depth + 1);
    }
    return out;
  }
  return value;
}

const SENSITIVE_KEY =
  /^(password|passwordHash|secret|sessionSecret|privateKey|private_key|secretKey|secret_key|apiKey|api_key|x-api-key|authorization|cookie|set-cookie|mnemonic|seedPhrase|seed_phrase|csrfToken|sessionToken|accessToken|refreshToken|token)$/i;

export interface CreateLoggerOptions {
  service: string;
  level?: LoggerOptions["level"];
  pretty?: boolean;
}

export function createLogger({ service, level = "info", pretty = false }: CreateLoggerOptions): Logger {
  return pino({
    level,
    base: { service },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACT_PATHS, censor: MASK },
    formatters: {
      level: (label) => ({ level: label }),
    },
    hooks: {
      logMethod(args, method) {
        const cleaned = args.map((a) => (typeof a === "string" ? redactString(a) : redactValue(a)));
        method.apply(this, cleaned as Parameters<typeof method>);
      },
    },
    ...(pretty
      ? { transport: { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:standard" } } }
      : {}),
  });
}

/** Minimal in-process counters exposed on /system/status. */
export class Counters {
  readonly #values = new Map<string, number>();

  inc(name: string, by = 1): void {
    this.#values.set(name, (this.#values.get(name) ?? 0) + by);
  }

  snapshot(): Record<string, number> {
    return Object.fromEntries(this.#values);
  }
}
