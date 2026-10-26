/** Conversions between NUMERIC strings from Postgres and exact bigint base units. */

const INT_RE = /^-?\d+$/;

export function dbRaw(value: string | null | undefined): bigint {
  if (value === null || value === undefined) return 0n;
  // NUMERIC(78,0) may come back as "123" or, defensively, "123.000".
  const trimmed = value.includes(".") ? value.replace(/\.0+$/, "") : value;
  if (!INT_RE.test(trimmed)) throw new Error(`expected integer NUMERIC, got ${value}`);
  return BigInt(trimmed);
}

export function dbRawOrNull(value: string | null | undefined): bigint | null {
  return value === null || value === undefined ? null : dbRaw(value);
}

export function toDbRaw(value: bigint): string {
  return value.toString();
}
