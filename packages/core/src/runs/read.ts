import { type Db, schema } from "@swdb/db"
import { asc, desc, eq } from "drizzle-orm"
import { loadEvents } from "./events.ts"

/** Plain JSON, so the dashboard can send these values over a server function. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

export function listRuns(db: Db, limit = 200) {
  return db
    .select({
      id: schema.runs.id,
      agentId: schema.runs.agentId,
      agentName: schema.agents.name,
      source: schema.runs.source,
      status: schema.runs.status,
      stopReason: schema.runs.stopReason,
      turns: schema.runs.turns,
      costUsd: schema.runs.costUsd,
      queuedAt: schema.runs.queuedAt,
      startedAt: schema.runs.startedAt,
      endedAt: schema.runs.endedAt,
    })
    .from(schema.runs)
    .innerJoin(schema.agents, eq(schema.agents.id, schema.runs.agentId))
    .orderBy(desc(schema.runs.queuedAt))
    .limit(limit)
    .all()
}

/** A run with its log and model calls, for the run page. Null when the run does not exist. */
export function getRunDetail(db: Db, runId: string) {
  const row = db
    .select({
      run: schema.runs,
      agentName: schema.agents.name,
      version: schema.agentVersions.version,
    })
    .from(schema.runs)
    .innerJoin(schema.agents, eq(schema.agents.id, schema.runs.agentId))
    .innerJoin(schema.agentVersions, eq(schema.agentVersions.id, schema.runs.agentVersionId))
    .where(eq(schema.runs.id, runId))
    .get()
  if (!row) return null
  const { input, ...run } = row.run
  const events = loadEvents(db, runId).map((e) => ({
    seq: e.seq,
    type: e.type as string,
    createdAt: e.createdAt,
    payload: e.payload as { [key: string]: Json },
  }))
  const modelCalls = db
    .select()
    .from(schema.modelCalls)
    .where(eq(schema.modelCalls.runId, runId))
    .orderBy(asc(schema.modelCalls.turn))
    .all()
    .map((c) => ({
      ...c,
      requestBody: c.requestBody as Json,
      responseBody: c.responseBody as Json,
    }))
  return {
    run: { ...run, input: input as Json },
    agentName: row.agentName,
    version: row.version,
    events,
    modelCalls,
  }
}
