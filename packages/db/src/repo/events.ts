import { newId } from "@tb/domain";
import { and, asc, isNull, sql } from "drizzle-orm";
import type { DbOrTx } from "../client.ts";
import { auditEvents, outboxEvents, systemIncidents } from "../schema.ts";

export interface AuditInput {
  actor: string;
  action: string;
  subjectType?: string;
  subjectId?: string;
  /** Must already be redacted by the caller (see @tb/observability redactValue). */
  details: Record<string, unknown>;
  ip?: string;
  requestId?: string;
  at: Date;
}

export async function appendAudit(tx: DbOrTx, input: AuditInput): Promise<string> {
  const id = newId();
  await tx.insert(auditEvents).values({
    id,
    at: input.at,
    actor: input.actor,
    action: input.action,
    subjectType: input.subjectType ?? null,
    subjectId: input.subjectId ?? null,
    details: input.details,
    ip: input.ip ?? null,
    requestId: input.requestId ?? null,
  });
  return id;
}

export async function appendOutbox(
  tx: DbOrTx,
  input: { aggregateType: string; aggregateId: string; eventType: string; payload: Record<string, unknown>; at: Date },
): Promise<void> {
  await tx.insert(outboxEvents).values({
    id: newId(),
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    eventType: input.eventType,
    payload: input.payload,
    createdAt: input.at,
  });
}

/** Claim a batch of unpublished outbox events (FOR UPDATE SKIP LOCKED). */
export async function claimOutbox(tx: DbOrTx, limit: number) {
  return tx
    .select()
    .from(outboxEvents)
    .where(isNull(outboxEvents.publishedAt))
    .orderBy(asc(outboxEvents.createdAt))
    .limit(limit)
    .for("update", { skipLocked: true });
}

export async function markOutboxPublished(tx: DbOrTx, ids: readonly string[], at: Date): Promise<void> {
  if (ids.length === 0) return;
  await tx.execute(sql`update outbox_events set published_at = ${at.toISOString()} where id in (${sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )})`);
}

/** Open an incident unless an identical one (same dedupe key) is already open. */
export async function openIncident(
  tx: DbOrTx,
  input: {
    severity: "INFO" | "WARNING" | "CRITICAL";
    kind: string;
    message: string;
    details: Record<string, unknown>;
    portfolioId?: string;
    dedupeKey?: string;
    at: Date;
  },
): Promise<void> {
  await tx
    .insert(systemIncidents)
    .values({
      id: newId(),
      severity: input.severity,
      kind: input.kind,
      message: input.message,
      details: input.details,
      portfolioId: input.portfolioId ?? null,
      dedupeKey: input.dedupeKey ?? null,
      openedAt: input.at,
    })
    .onConflictDoNothing();
}

export async function resolveIncident(tx: DbOrTx, dedupeKey: string, at: Date): Promise<void> {
  await tx
    .update(systemIncidents)
    .set({ resolvedAt: at })
    .where(and(sql`${systemIncidents.dedupeKey} = ${dedupeKey}`, isNull(systemIncidents.resolvedAt)));
}
