import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ORDER_STATES, ORDER_TRANSITIONS } from "@tb/domain";

describe("migration 0001", () => {
  it("encodes exactly the same order transitions as the domain state machine", () => {
    const sqlText = readFileSync(new URL("../migrations/0001_integrity.sql", import.meta.url), "utf8");
    const block = sqlText.slice(sqlText.indexOf("IF NOT ((OLD.state, NEW.state) IN ("), sqlText.indexOf(")) THEN"));
    const pairs = new Set([...block.matchAll(/\('([A-Z_]+)', '([A-Z_]+)'\)/g)].map((m) => `${m[1]}->${m[2]}`));
    const expected = new Set<string>();
    for (const from of ORDER_STATES) for (const to of ORDER_TRANSITIONS[from]) expected.add(`${from}->${to}`);
    expect([...pairs].sort()).toEqual([...expected].sort());
  });
});
