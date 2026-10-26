export const TRADING_MODES = ["PAPER", "LIVE"] as const;
export type TradingMode = (typeof TRADING_MODES)[number];

export const SIDES = ["BUY", "SELL"] as const;
export type Side = (typeof SIDES)[number];

/** Outcome of any assessment. UNKNOWN always blocks an entry; it is never treated as a pass. */
export const VERDICTS = ["PASS", "REJECT", "UNKNOWN"] as const;
export type Verdict = (typeof VERDICTS)[number];

export interface CheckResult {
  /** Stable identifier, e.g. "mint.freeze_authority". */
  readonly id: string;
  readonly verdict: Verdict;
  /** Human-readable explanation shown on the dashboard. */
  readonly reason: string;
  /** Machine-readable evidence (values, thresholds, timestamps). Amounts as strings. */
  readonly evidence?: Record<string, unknown>;
}

/** Combine check results: any REJECT rejects, otherwise any UNKNOWN is UNKNOWN, otherwise PASS. */
export function combineVerdicts(checks: readonly CheckResult[]): Verdict {
  if (checks.length === 0) return "UNKNOWN";
  if (checks.some((c) => c.verdict === "REJECT")) return "REJECT";
  if (checks.some((c) => c.verdict === "UNKNOWN")) return "UNKNOWN";
  return "PASS";
}

export const PORTFOLIO_STATUSES = ["ACTIVE", "ARCHIVED"] as const;
export type PortfolioStatus = (typeof PORTFOLIO_STATUSES)[number];

export const POSITION_STATUSES = ["OPEN", "CLOSING", "STRANDED", "CLOSED"] as const;
export type PositionStatus = (typeof POSITION_STATUSES)[number];

export const OPERATOR_COMMANDS = [
  "PAUSE_ENTRIES",
  "PAUSE_ALL",
  "LIQUIDATE",
  "RESUME",
  "DISABLE_LIVE",
] as const;
export type OperatorCommand = (typeof OPERATOR_COMMANDS)[number];

export const SIGNAL_STATUSES = ["NEW", "ACCEPTED", "REJECTED", "EXPIRED", "EXECUTED"] as const;
export type SignalStatus = (typeof SIGNAL_STATUSES)[number];
