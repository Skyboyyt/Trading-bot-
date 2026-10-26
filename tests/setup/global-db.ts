/**
 * Integration test setup: recreate the test database schema from the reviewed migrations.
 * Uses TEST_DATABASE_URL (never DATABASE_URL) so tests cannot touch a real database by accident.
 */
import postgres from "postgres";
import { runMigrations } from "../../packages/db/src/migrate.ts";

export const DEFAULT_TEST_DATABASE_URL = "postgres://postgres@127.0.0.1:5432/trading_bot_test";

export default async function setup(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;
  if (!/test/i.test(new URL(url).pathname)) {
    throw new Error(`Refusing to reset ${url}: the test database name must contain "test"`);
  }
  process.env.TEST_DATABASE_URL = url;
  const sql = postgres(url, { max: 1, onnotice: () => undefined });
  try {
    await sql.unsafe("drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;");
  } finally {
    await sql.end();
  }
  await runMigrations(url);
}
