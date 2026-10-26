import { assertTransition, newId, type OrderState } from "@tb/domain";
import { eq, and, sql } from "drizzle-orm";
import type { DbOrTx } from "../client.ts";
import { orders, orderStateTransitions, outboxEvents } from "../schema.ts";

export type OrderRow = typeof orders.$inferSelect;
export type NewOrderRow = typeof orders.$inferInsert;

export class ConcurrencyError extends Error {
  override name = "ConcurrencyError";
}

export class NotFoundError extends Error {
  override name = "NotFoundError";
}

export interface TransitionInput {
  orderId: string;
  to: OrderState;
  reason: string;
  actor: string;
  at: Date;
  /** Optimistic guard: fail if the order changed since the caller read it. */
  expectedVersion?: number;
  patch?: Partial<Pick<NewOrderRow, "lastError" | "reservedQuoteRaw" | "reservedFeeLamports">>;
}

/** Lock an order row for the duration of the transaction. */
export async function lockOrder(tx: DbOrTx, orderId: string): Promise<OrderRow> {
  const rows = await tx.select().from(orders).where(eq(orders.id, orderId)).for("update");
  const row = rows[0];
  if (!row) throw new NotFoundError(`order ${orderId} not found`);
  return row;
}

/**
 * Persist a guarded state transition: validates it against the state machine, bumps the version,
 * records an append-only transition row and an outbox event, all in the caller's transaction.
 */
export async function transitionOrder(tx: DbOrTx, input: TransitionInput): Promise<OrderRow> {
  const current = await lockOrder(tx, input.orderId);
  if (input.expectedVersion !== undefined && current.version !== input.expectedVersion) {
    throw new ConcurrencyError(
      `order ${input.orderId} version ${current.version} != expected ${input.expectedVersion}`,
    );
  }
  assertTransition(current.state as OrderState, input.to);
  const updated = await tx
    .update(orders)
    .set({
      state: input.to,
      version: current.version + 1,
      updatedAt: input.at,
      ...(input.patch ?? {}),
    })
    .where(and(eq(orders.id, input.orderId), eq(orders.version, current.version)))
    .returning();
  const row = updated[0];
  if (!row) throw new ConcurrencyError(`order ${input.orderId} changed concurrently`);
  await tx.insert(orderStateTransitions).values({
    id: newId(),
    orderId: input.orderId,
    fromState: current.state,
    toState: input.to,
    fromVersion: current.version,
    toVersion: row.version,
    reason: input.reason,
    actor: input.actor,
    at: input.at,
  });
  await tx.insert(outboxEvents).values({
    id: newId(),
    aggregateType: "order",
    aggregateId: input.orderId,
    eventType: "order.state_changed",
    payload: { orderId: input.orderId, from: current.state, to: input.to, reason: input.reason, mode: row.mode },
    createdAt: input.at,
  });
  return row;
}

/** Insert a new order in PROPOSED state with its initial transition row. */
export async function insertProposedOrder(
  tx: DbOrTx,
  values: Omit<NewOrderRow, "state" | "version">,
  actor: string,
): Promise<OrderRow> {
  const inserted = await tx
    .insert(orders)
    .values({ ...values, state: "PROPOSED", version: 0 })
    .returning();
  const row = inserted[0];
  if (!row) throw new Error("order insert returned no row");
  await tx.insert(orderStateTransitions).values({
    id: newId(),
    orderId: row.id,
    fromState: null,
    toState: "PROPOSED",
    fromVersion: null,
    toVersion: 0,
    reason: values.reason,
    actor,
    at: row.createdAt,
  });
  return row;
}

/** Count orders that still hold or may hold funds (anything not terminal). */
export async function countPendingOrders(tx: DbOrTx, portfolioId: string): Promise<{ pending: number; unknown: number }> {
  const rows = await tx.execute<{ pending: string; unknown: string }>(sql`
    select
      count(*) filter (where state not in ('REJECTED','RECONCILED','FAILED','CANCELLED')) as pending,
      count(*) filter (where state in ('UNKNOWN','MANUAL_REVIEW')) as unknown
    from orders where portfolio_id = ${portfolioId}
  `);
  const r = rows[0];
  return { pending: Number(r?.pending ?? 0), unknown: Number(r?.unknown ?? 0) };
}
