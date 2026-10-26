import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb } from "./client.ts";

export const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));

/** Apply all reviewed migrations in order. Safe to run repeatedly. */
export async function runMigrations(url: string): Promise<void> {
  const handle = createDb({ url, max: 1, applicationName: "trading-bot-migrate", statementTimeoutMs: 120_000 });
  try {
    await migrate(handle.db, { migrationsFolder: MIGRATIONS_DIR });
  } finally {
    await handle.close();
  }
}
