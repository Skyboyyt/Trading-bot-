import { createHash } from "node:crypto";
import { v7 as uuidv7, validate as uuidValidate } from "uuid";

/** Time-ordered UUID (v7) for primary keys. */
export function newId(): string {
  return uuidv7();
}

export function isUuid(value: string): boolean {
  return uuidValidate(value);
}

export function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Stable JSON serialization (sorted keys) so the same parameters always hash identically.
 * bigint values are written as strings; undefined properties are dropped.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(normalize);
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = normalize(v);
    }
    return out;
  }
  return value;
}
