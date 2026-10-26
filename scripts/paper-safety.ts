/**
 * Static checks that prove this build cannot sign or submit transactions.
 *
 * CI runs these on every change. They fail if any deployable imports the live execution
 * package, if any source uses signing or broadcasting APIs, if any package depends on a Solana
 * signing SDK, or if the Jupiter adapter could request an executable transaction.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export interface Violation {
  file: string;
  rule: string;
  detail: string;
}

const SOURCE_DIRS = ["apps", "packages"];
const SKIP_DIRS = new Set(["node_modules", "dist", "test", "tests", "playwright-report", "test-results", ".vite"]);

const FORBIDDEN_CODE: { rule: string; pattern: RegExp }[] = [
  { rule: "no-keypair-construction", pattern: /createKeyPairSignerFromBytes|Keypair\.fromSecretKey|Keypair\.fromSeed|fromSecretKey\(/ },
  { rule: "no-transaction-signing", pattern: /\b(partiallySignTransaction|signTransaction|signAllTransactions|signMessage)\s*\(/ },
  { rule: "no-ed25519-signing", pattern: /\b(nacl\.sign|ed25519\.sign|sign\.detached)\b/ },
  { rule: "no-transaction-broadcast", pattern: /\b(sendTransaction|sendRawTransaction|sendAndConfirmTransaction|simulateTransaction)\b/ },
  { rule: "no-jupiter-execute", pattern: /\/execute["'`]|swap\/v2\/execute/ },
  { rule: "no-taker-parameter", pattern: /\btaker\s*:/ },
  { rule: "no-solana-signing-sdk", pattern: /from\s+["'](@solana\/web3\.js|@solana\/kit|@solana\/signers|tweetnacl|@noble\/ed25519)["']/ },
];

const FORBIDDEN_DEPENDENCIES = ["@solana/web3.js", "@solana/kit", "@solana/signers", "tweetnacl", "@noble/ed25519", "@noble/curves"];

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) yield* walk(full);
    else yield full;
  }
}

export function scanRepo(root: string): Violation[] {
  const violations: Violation[] = [];
  for (const top of SOURCE_DIRS) {
    let entries: string[];
    try {
      entries = readdirSync(join(root, top));
    } catch {
      continue;
    }
    for (const pkg of entries) {
      const pkgDir = join(root, top, pkg);
      if (!statSync(pkgDir).isDirectory()) continue;
      const isLivePackage = top === "packages" && pkg === "execution-live";

      try {
        const manifest = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as Record<string, Record<string, string> | undefined>;
        const deps = { ...manifest.dependencies, ...manifest.devDependencies, ...manifest.optionalDependencies };
        for (const d of FORBIDDEN_DEPENDENCIES) {
          if (d in deps) violations.push({ file: relative(root, join(pkgDir, "package.json")), rule: "no-signing-dependency", detail: d });
        }
        if (!isLivePackage && "@tb/execution-live" in deps) {
          violations.push({ file: relative(root, join(pkgDir, "package.json")), rule: "no-live-execution-dependency", detail: "@tb/execution-live" });
        }
      } catch {
        // Packages without a manifest (e.g. the deferred signer folder) are scanned as files only.
      }

      for (const file of walk(pkgDir)) {
        if (!/\.(ts|tsx|js|mjs|cjs)$/.test(file)) continue;
        const text = readFileSync(file, "utf8");
        const rel = relative(root, file);
        if (!isLivePackage && /["']@tb\/execution-live["']/.test(text)) {
          violations.push({ file: rel, rule: "no-live-execution-import", detail: "imports @tb/execution-live" });
        }
        for (const { rule, pattern } of FORBIDDEN_CODE) {
          const m = pattern.exec(text);
          if (m) violations.push({ file: rel, rule, detail: m[0] });
        }
      }
    }
  }
  return violations;
}
