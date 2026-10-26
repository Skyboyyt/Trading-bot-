# Test fixtures

Everything in this folder is **synthetic**. The payloads follow the response shapes documented by
each provider (Jupiter Swap API v2, GeckoTerminal API v2, Solana JSON-RPC) but the numbers,
addresses and timestamps are made up for tests. They are never used as market evidence and never
appear in reports labelled as real data.

- `providers/` — raw provider responses used by adapter tests.
- `candles/` — generated candle series used by strategy and replay scenario tests.
