import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { scanRepo } from "./paper-safety.ts";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");

function fakeRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "paper-safety-"));
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

describe("paper safety scanner", () => {
  it("passes on this repository", () => {
    expect(scanRepo(repoRoot)).toEqual([]);
  });

  it("detects signing, broadcasting, live imports and signing SDKs", () => {
    const root = fakeRepo({
      "apps/worker/package.json": JSON.stringify({ dependencies: { "@solana/web3.js": "1.0.0", "@tb/execution-live": "workspace:*" } }),
      "apps/worker/src/a.ts": `import { Keypair } from "@solana/web3.js";\nconst k = Keypair.fromSecretKey(x);`,
      "apps/worker/src/b.ts": `import { createLiveExecutor } from "@tb/execution-live";`,
      "packages/providers/src/c.ts": `await fetch(base + "/execute"); connection.sendRawTransaction(tx); const q = { taker: me };`,
      "packages/x/src/d.ts": `await partiallySignTransaction([kp], tx);`,
    });
    const rules = new Set(scanRepo(root).map((v) => v.rule));
    for (const r of [
      "no-signing-dependency",
      "no-live-execution-dependency",
      "no-keypair-construction",
      "no-solana-signing-sdk",
      "no-live-execution-import",
      "no-jupiter-execute",
      "no-transaction-broadcast",
      "no-taker-parameter",
      "no-transaction-signing",
    ]) {
      expect(rules, r).toContain(r);
    }
  });
});
