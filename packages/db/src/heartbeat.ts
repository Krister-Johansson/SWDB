import { eq, sql } from "drizzle-orm"
import type { Db } from "./index.ts"
import { processHeartbeats } from "./schema/system.ts"

/** A process counts as alive when its last beat is newer than this. */
export const HEARTBEAT_STALE_MS = 10_000

export function beat(
  db: Db,
  process: string,
  pid: number,
  startedAt: number,
  now = Date.now(),
): void {
  db.insert(processHeartbeats)
    .values({ process, pid, startedAt, beatAt: now })
    .onConflictDoUpdate({
      target: processHeartbeats.process,
      set: { pid, startedAt, beatAt: sql`excluded.beat_at` },
    })
    .run()
}

export function readHeartbeat(db: Db, process: string, now = Date.now()) {
  const row = db
    .select()
    .from(processHeartbeats)
    .where(eq(processHeartbeats.process, process))
    .get()
  if (!row) return null
  return {
    alive: now - row.beatAt < HEARTBEAT_STALE_MS,
    pid: row.pid,
    startedAt: row.startedAt,
    beatAt: row.beatAt,
  }
}
