import { type Db, schema } from "@swdb/db"
import type { RunSource, RunStatus, StopReason } from "@swdb/db/schema"
import { and, count, eq, inArray, isNull, sql } from "drizzle-orm"
import { currentAgentVersion } from "../agents.ts"
import { appendEvent } from "./events.ts"

/** What a run starts with. The prompt is the user message; a payload is passed as untrusted data. */
export type RunInput = { prompt: string; payload?: unknown }

export class RunRefusedError extends Error {
  readonly reason: string
  constructor(reason: string, message: string) {
    super(message)
    this.reason = reason
  }
}

/**
 * Queues a run of the agent's current version and records the fire in trigger_attempts.
 * A refused fire (agent off or paused) is recorded too, then thrown.
 */
export function enqueueRun(
  db: Db,
  options: {
    agentId: string
    source: RunSource
    input: RunInput
    triggerId?: string
    idempotencyKey?: string
  },
): string {
  const agent = db.select().from(schema.agents).where(eq(schema.agents.id, options.agentId)).get()
  if (!agent) throw new Error(`Agent ${options.agentId} not found`)
  // A refusal is recorded outside any transaction, so throwing does not roll the record back.
  const refuse = (reason: "paused" | "disabled", message: string) => {
    db.insert(schema.triggerAttempts)
      .values({
        agentId: agent.id,
        triggerId: options.triggerId ?? null,
        outcome: "skipped",
        reason,
        detail: message,
      })
      .run()
    return new RunRefusedError(reason, message)
  }
  if (agent.pausedReason) throw refuse("paused", `The agent is paused: ${agent.pausedReason}`)
  if (!agent.enabled) throw refuse("disabled", "The agent is turned off")

  return db.transaction((tx) => {
    const version = currentAgentVersion(tx, agent.id)
    if (!version) throw new Error(`Agent ${agent.id} has no saved version`)
    const attempt = tx
      .insert(schema.triggerAttempts)
      .values({ agentId: agent.id, triggerId: options.triggerId ?? null, outcome: "started" })
      .returning({ id: schema.triggerAttempts.id })
      .get()
    const run = tx
      .insert(schema.runs)
      .values({
        agentId: agent.id,
        agentVersionId: version.id,
        source: options.source,
        triggerId: options.triggerId ?? null,
        triggerAttemptId: attempt.id,
        input: options.input,
        idempotencyKey: options.idempotencyKey ?? null,
      })
      .returning({ id: schema.runs.id })
      .get()
    tx.update(schema.runs).set({ rootRunId: run.id }).where(eq(schema.runs.id, run.id)).run()
    tx.update(schema.triggerAttempts)
      .set({ runId: run.id })
      .where(eq(schema.triggerAttempts.id, attempt.id))
      .run()
    return run.id
  })
}

export const DEFAULT_LEASE_MS = 30_000

/**
 * Claims the oldest runnable run for this worker: a queued run, or a running run whose lease
 * has lapsed because its worker died. A run is skipped while its agent already has
 * maxConcurrentRuns runs held by live leases. Runs in one IMMEDIATE transaction, so two
 * workers cannot claim the same run.
 */
export function claimRun(
  db: Db,
  workerId: string,
  now = Date.now(),
  leaseMs = DEFAULT_LEASE_MS,
): { runId: string; resumed: boolean } | null {
  const claim = db.sqlite.transaction(() => {
    const candidates = db.sqlite
      .prepare(
        `select r.id, r.agent_id as agentId, r.status, json_extract(a.limits, '$.maxConcurrentRuns') as maxConcurrent
         from runs r join agents a on a.id = r.agent_id
         where r.status = 'queued'
            or (r.status = 'running' and r.lease_expires_at < ?)
         order by r.queued_at
         limit 50`,
      )
      .all(now) as {
      id: string
      agentId: string
      status: RunStatus
      maxConcurrent: number | null
    }[]
    const active = db.sqlite.prepare(
      "select count(*) from runs where agent_id = ? and status = 'running' and lease_expires_at >= ?",
    )
    for (const c of candidates) {
      if (c.maxConcurrent && (active.pluck().get(c.agentId, now) as number) >= c.maxConcurrent) {
        continue
      }
      db.sqlite
        .prepare(
          `update runs set status = 'running', lease_owner = ?, lease_expires_at = ?,
             attempts = attempts + 1, started_at = coalesce(started_at, ?)
           where id = ?`,
        )
        .run(workerId, now + leaseMs, now, c.id)
      return { runId: c.id, resumed: c.status === "running" }
    }
    return null
  })
  return claim.immediate()
}

/** Extends the lease. Returns false when another worker took the run over. */
export function renewLease(
  db: Db,
  runId: string,
  workerId: string,
  leaseMs = DEFAULT_LEASE_MS,
): boolean {
  return (
    db
      .update(schema.runs)
      .set({ leaseExpiresAt: Date.now() + leaseMs })
      .where(
        and(
          eq(schema.runs.id, runId),
          eq(schema.runs.leaseOwner, workerId),
          eq(schema.runs.status, "running"),
        ),
      )
      .run().changes > 0
  )
}

export type RunTotals = {
  turns: number
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  costUsd: number
}

/** Sums the model calls of a run. Works on a database handle or inside a transaction. */
export function runTotals(db: Pick<Db, "select">, runId: string): RunTotals {
  const row = db
    .select({
      turns: count(),
      inputTokens: sql<number>`coalesce(sum(${schema.modelCalls.inputTokens}), 0)`,
      outputTokens: sql<number>`coalesce(sum(${schema.modelCalls.outputTokens}), 0)`,
      reasoningTokens: sql<number>`coalesce(sum(${schema.modelCalls.reasoningTokens}), 0)`,
      costUsd: sql<number>`coalesce(sum(${schema.modelCalls.costUsd}), 0)`,
    })
    .from(schema.modelCalls)
    .where(eq(schema.modelCalls.runId, runId))
    .get()
  return row ?? { turns: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, costUsd: 0 }
}

const statusFor: Record<StopReason, RunStatus> = {
  success: "succeeded",
  cancelled: "cancelled",
  max_turns: "failed",
  max_budget: "failed",
  timeout: "failed",
  error: "failed",
}

/**
 * Ends a run with exactly one terminal run_end event that carries cost, usage, turns and the
 * reason code. A run that already ended is left alone, so a late second call is harmless.
 */
export function finishRun(
  db: Db,
  runId: string,
  reason: StopReason,
  detail: { error?: string; output?: string } = {},
): boolean {
  return db.transaction((tx) => {
    const ended = tx
      .update(schema.runs)
      .set({
        status: statusFor[reason],
        stopReason: reason,
        error: detail.error ?? null,
        endedAt: Date.now(),
        leaseOwner: null,
        leaseExpiresAt: null,
      })
      .where(
        and(
          eq(schema.runs.id, runId),
          inArray(schema.runs.status, ["queued", "running", "waiting_human"]),
          isNull(schema.runs.stopReason),
        ),
      )
      .run().changes
    if (!ended) return false
    const totals = runTotals(tx, runId)
    tx.update(schema.runs).set(totals).where(eq(schema.runs.id, runId)).run()
    appendEvent(tx as unknown as Db, runId, "run_end", {
      reason,
      ...totals,
      ...(detail.error ? { error: detail.error } : {}),
      ...(detail.output !== undefined ? { output: detail.output } : {}),
    })
    return true
  })
}

/**
 * Asks a run to stop. A queued run ends at once. A running run ends at its next step
 * boundary, when the harness sees cancel_requested_at.
 */
export function requestCancel(db: Db, runId: string): "cancelled" | "requested" | "already_ended" {
  const run = db.select().from(schema.runs).where(eq(schema.runs.id, runId)).get()
  if (!run || run.stopReason) return "already_ended"
  db.update(schema.runs)
    .set({ cancelRequestedAt: sql`coalesce(${schema.runs.cancelRequestedAt}, ${Date.now()})` })
    .where(eq(schema.runs.id, runId))
    .run()
  if (run.status === "queued") {
    finishRun(db, runId, "cancelled")
    return "cancelled"
  }
  return "requested"
}

export function isCancelRequested(db: Db, runId: string): boolean {
  const row = db
    .select({ at: schema.runs.cancelRequestedAt })
    .from(schema.runs)
    .where(eq(schema.runs.id, runId))
    .get()
  return row?.at != null
}
