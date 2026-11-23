import { type Db, schema } from "@swdb/db"
import type { RunEventType } from "@swdb/db/schema"
import { and, asc, eq, gt, sql } from "drizzle-orm"

/**
 * Appends one event to a run's log. seq is the next number for the run, assigned inside the
 * insert, so two writers cannot take the same number (the (run_id, seq) index would refuse it).
 */
export function appendEvent(
  db: Db,
  runId: string,
  type: RunEventType,
  payload: Record<string, unknown> = {},
  span: { spanId?: string; parentSpanId?: string } = {},
): number {
  const row = db
    .insert(schema.runEvents)
    .values({
      runId,
      type,
      payload,
      spanId: span.spanId ?? null,
      parentSpanId: span.parentSpanId ?? null,
      seq: sql`(select coalesce(max(${schema.runEvents.seq}), 0) + 1 from ${schema.runEvents} where ${schema.runEvents.runId} = ${runId})`,
    })
    .returning({ seq: schema.runEvents.seq })
    .get()
  return row.seq
}

export function loadEvents(db: Db, runId: string, afterSeq = 0) {
  return db
    .select()
    .from(schema.runEvents)
    .where(and(eq(schema.runEvents.runId, runId), gt(schema.runEvents.seq, afterSeq)))
    .orderBy(asc(schema.runEvents.seq))
    .all()
}
