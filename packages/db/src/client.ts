import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.ts";

export type Schema = typeof schema;
export type Db = PostgresJsDatabase<Schema>;
/** A transaction handle; same query surface as Db. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type DbOrTx = Db | Tx;

export interface DbHandle {
  db: Db;
  sql: postgres.Sql;
  close: () => Promise<void>;
}

export interface CreateDbOptions {
  url: string;
  max?: number;
  applicationName?: string;
  /** Statement timeout guards against runaway queries holding locks. */
  statementTimeoutMs?: number;
}

export function createDb({ url, max = 10, applicationName = "trading-bot", statementTimeoutMs = 30_000 }: CreateDbOptions): DbHandle {
  const sql = postgres(url, {
    max,
    idle_timeout: 30,
    connect_timeout: 10,
    prepare: true,
    onnotice: () => undefined,
    connection: {
      application_name: applicationName,
      statement_timeout: statementTimeoutMs,
      TimeZone: "UTC",
    },
    types: {
      // Return NUMERIC as strings (default) and bigint as JS bigint.
      bigint: postgres.BigInt,
    },
  });
  const db = drizzle(sql, { schema });
  return { db, sql, close: () => sql.end({ timeout: 5 }) };
}
