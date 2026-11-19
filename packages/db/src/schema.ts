import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

/** One row per SWDB process. The dashboard reads it to show whether the worker is alive. */
export const processHeartbeats = sqliteTable("process_heartbeats", {
  process: text("process").primaryKey(),
  pid: integer("pid").notNull(),
  startedAt: integer("started_at").notNull(),
  beatAt: integer("beat_at").notNull(),
})
