/**
 * CI gate: paper mode cannot instantiate a signer or call live endpoints.
 *   pnpm check:paper-safety
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadBaseConfig } from "@tb/config";
import { scanRepo } from "./paper-safety.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const failures: string[] = [];

for (const v of scanRepo(root)) failures.push(`${v.rule}: ${v.file} (${v.detail})`);

try {
  loadBaseConfig({ DATABASE_URL: "postgres://localhost/x", TRADING_MODE: "LIVE" });
  failures.push("config: TRADING_MODE=LIVE was accepted");
} catch {
  // expected
}
try {
  loadBaseConfig({ DATABASE_URL: "postgres://localhost/x", PRIVATE_KEY: "x" });
  failures.push("config: a PRIVATE_KEY variable was accepted");
} catch {
  // expected
}

const live = await import("@tb/execution-live");
try {
  live.createLiveExecutor();
  failures.push("execution-live: createLiveExecutor() did not throw");
} catch (err) {
  if (!(err instanceof live.LiveTradingDisabledError)) failures.push(`execution-live: unexpected error ${String(err)}`);
}
if (live.LIVE_TRADING_ENABLED !== false) failures.push("execution-live: LIVE_TRADING_ENABLED is not false");

if (failures.length) {
  console.error(`Paper safety check FAILED (${failures.length}):\n - ${failures.join("\n - ")}`);
  process.exit(1);
}
console.log("Paper safety check passed: no signer, no signing SDK, no broadcast or execute calls, LIVE refused.");
