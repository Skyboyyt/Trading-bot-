/**
 * Order lifecycle.
 *
 * Every transition is persisted and guarded against the previous state and version, so two
 * workers can never move the same order concurrently. UNKNOWN keeps its reservation until
 * reconciliation proves what happened; we never "retry" by creating a second economic trade.
 */
import { sha256Hex } from "./ids.ts";
import type { Side } from "./types.ts";

export const ORDER_STATES = [
  "PROPOSED",
  "REJECTED",
  "RESERVED",
  "PREPARED",
  "SUBMITTED",
  "UNKNOWN",
  "CONFIRMED",
  "FINALIZED",
  "RECONCILED",
  "FAILED",
  "CANCELLED",
  "MANUAL_REVIEW",
] as const;
export type OrderState = (typeof ORDER_STATES)[number];

export const TERMINAL_ORDER_STATES: ReadonlySet<OrderState> = new Set([
  "REJECTED",
  "RECONCILED",
  "FAILED",
  "CANCELLED",
]);

/**
 * Allowed transitions.
 * - PREPARED → CANCELLED covers expiry before any submission (nothing was broadcast).
 * - SUBMITTED → UNKNOWN covers timeouts and crashes after broadcast.
 * - CONFIRMED → UNKNOWN covers forks/rollback: a confirmed transaction that later disappears.
 * - UNKNOWN → FAILED is only allowed once reconciliation proves the transaction can no longer
 *   land (e.g. its blockhash expired and it is absent on chain).
 */
const TRANSITIONS: Record<OrderState, readonly OrderState[]> = {
  PROPOSED: ["REJECTED", "RESERVED", "CANCELLED"],
  RESERVED: ["PREPARED", "CANCELLED", "FAILED"],
  PREPARED: ["SUBMITTED", "CANCELLED", "FAILED"],
  SUBMITTED: ["CONFIRMED", "FAILED", "UNKNOWN"],
  UNKNOWN: ["CONFIRMED", "FAILED", "MANUAL_REVIEW"],
  CONFIRMED: ["FINALIZED", "UNKNOWN"],
  FINALIZED: ["RECONCILED", "MANUAL_REVIEW"],
  MANUAL_REVIEW: ["RECONCILED", "FAILED", "CANCELLED"],
  REJECTED: [],
  RECONCILED: [],
  FAILED: [],
  CANCELLED: [],
};

/** Exposed so tests can prove the database trigger in migration 0001 mirrors this table. */
export const ORDER_TRANSITIONS: Readonly<Record<OrderState, readonly OrderState[]>> = TRANSITIONS;

export class InvalidTransitionError extends Error {
  override name = "InvalidTransitionError";
  constructor(
    readonly from: OrderState,
    readonly to: OrderState,
  ) {
    super(`Order cannot move from ${from} to ${to}`);
  }
}

export function canTransition(from: OrderState, to: OrderState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: OrderState, to: OrderState): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

export function allowedTransitions(from: OrderState): readonly OrderState[] {
  return TRANSITIONS[from];
}

/** States in which the order still holds a budget reservation. */
export const RESERVATION_HOLDING_STATES: ReadonlySet<OrderState> = new Set([
  "RESERVED",
  "PREPARED",
  "SUBMITTED",
  "UNKNOWN",
  "CONFIRMED",
  "FINALIZED",
  "MANUAL_REVIEW",
]);

/** States that count as "pending" for risk checks (an outcome is not yet settled). */
export const PENDING_ORDER_STATES: ReadonlySet<OrderState> = new Set([
  "PROPOSED",
  "RESERVED",
  "PREPARED",
  "SUBMITTED",
  "CONFIRMED",
  "FINALIZED",
]);

export interface IdempotencyInput {
  portfolioId: string;
  strategyVersion: string;
  mint: string;
  /** Decision timestamp of the signal that produced the order. */
  signalAt: Date;
  side: Side;
}

/**
 * Deterministic idempotency key: portfolio + strategy version + mint + signal timestamp + side.
 * The database enforces uniqueness, so a duplicate signal can never create a second order.
 */
export function orderIdempotencyKey(input: IdempotencyInput): string {
  const parts = [
    input.portfolioId,
    input.strategyVersion,
    input.mint,
    input.signalAt.toISOString(),
    input.side,
  ];
  return sha256Hex(parts.join("|"));
}
