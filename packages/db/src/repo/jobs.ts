import { newId } from "@tb/domain";
import { sql } from "drizzle-orm";
import type { DbOrTx } from "../client.ts";
import { jobs } from "../schema.ts";

export type JobRow = typeof jobs.$inferSelect;

export interface EnqueueInput {
  kind: string;
  payload: Record<string, unknown>;
  runAt?: Date;
  dedupeKey?: string;
  maxAttempts?: number;
}

/**
 * Enqueue a durable job. With a dedupe key, a second enqueue while an identical job is queued or
 * leased is a no-op (returns null).
 */
export async function enqueueJob(tx: DbOrTx, input: EnqueueInput): Promise<string | null> {
  const id = newId();
  const rows = await tx
    .insert(jobs)
    .values({
      id,
      kind: input.kind,
      payload: input.payload,
      runAt: input.runAt ?? new Date(),
      dedupeKey: input.dedupeKey ?? null,
      maxAttempts: input.maxAttempts ?? 10,
    })
    .onConflictDoNothing()
    .returning({ id: jobs.id });
  return rows[0]?.id ?? null;
}

/**
 * Lease up to `limit` ready jobs. Uses FOR UPDATE SKIP LOCKED so several workers can share the
 * queue; expired leases are reclaimed, which is how work survives a crashed worker.
 */
export async function leaseJobs(
  tx: DbOrTx,
  opts: { kinds: readonly string[]; owner: string; leaseMs: number; limit: number; now: Date },
): Promise<JobRow[]> {
  const leaseUntil = new Date(opts.now.getTime() + opts.leaseMs);
  const kinds = sql.join(
    opts.kinds.map((k) => sql`${k}`),
    sql`, `,
  );
  const rows = await tx.execute<{ id: string }>(sql`
    with ready as (
      select id from jobs
      where kind in (${kinds})
        and run_at <= ${opts.now.toISOString()}
        and (status = 'QUEUED' or (status = 'LEASED' and lease_until < ${opts.now.toISOString()}))
      order by run_at
      limit ${opts.limit}
      for update skip locked
    )
    update jobs set status = 'LEASED', lease_owner = ${opts.owner}, lease_until = ${leaseUntil.toISOString()},
      attempts = attempts + 1, updated_at = ${opts.now.toISOString()}
    from ready where jobs.id = ready.id
    returning jobs.id
  `);
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  return tx.query.jobs.findMany({ where: (j, { inArray }) => inArray(j.id, ids) });
}

export async function completeJob(tx: DbOrTx, id: string, owner: string, now: Date): Promise<boolean> {
  const rows = await tx.execute(sql`
    update jobs set status = 'DONE', lease_owner = null, lease_until = null, updated_at = ${now.toISOString()}
    where id = ${id} and lease_owner = ${owner} and status = 'LEASED'
    returning id
  `);
  return rows.length > 0;
}

/** Exponential backoff with a cap; dead-letters after maxAttempts. */
export async function failJob(
  tx: DbOrTx,
  id: string,
  owner: string,
  error: string,
  now: Date,
  baseDelayMs = 2_000,
): Promise<"RETRY" | "DEAD" | "LOST_LEASE"> {
  const rows = await tx.execute<{ attempts: number; max_attempts: number }>(sql`
    select attempts, max_attempts from jobs where id = ${id} and lease_owner = ${owner} and status = 'LEASED' for update
  `);
  const row = rows[0];
  if (!row) return "LOST_LEASE";
  const dead = row.attempts >= row.max_attempts;
  const delay = Math.min(baseDelayMs * 2 ** Math.max(0, row.attempts - 1), 10 * 60_000);
  await tx.execute(sql`
    update jobs set status = ${dead ? "DEAD" : "QUEUED"}, lease_owner = null, lease_until = null,
      last_error = ${error.slice(0, 2000)}, run_at = ${new Date(now.getTime() + delay).toISOString()}, updated_at = ${now.toISOString()}
    where id = ${id}
  `);
  return dead ? "DEAD" : "RETRY";
}

/** Extend a lease for long-running work; returns false if the lease was lost. */
export async function heartbeatJob(tx: DbOrTx, id: string, owner: string, leaseMs: number, now: Date): Promise<boolean> {
  const rows = await tx.execute(sql`
    update jobs set lease_until = ${new Date(now.getTime() + leaseMs).toISOString()}, updated_at = ${now.toISOString()}
    where id = ${id} and lease_owner = ${owner} and status = 'LEASED'
    returning id
  `);
  return rows.length > 0;
}
