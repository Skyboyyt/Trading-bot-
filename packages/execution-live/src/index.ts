/**
 * LIVE EXECUTION IS DISABLED.
 *
 * This package intentionally contains no signer, no key handling and no transaction submission.
 * `createLiveExecutor` always throws. Live trading requires the isolated signing service, the
 * transaction policy below, a separate security review and an explicit owner decision, as set
 * out in docs/live-integration-plan.md.
 */
export * from "./transaction-policy.ts";

export class LiveTradingDisabledError extends Error {
  override name = "LiveTradingDisabledError";
  constructor() {
    super("Live trading is disabled in this build. No signer exists and no transaction can be submitted.");
  }
}

export function createLiveExecutor(): never {
  throw new LiveTradingDisabledError();
}

export const LIVE_TRADING_ENABLED = false as const;
