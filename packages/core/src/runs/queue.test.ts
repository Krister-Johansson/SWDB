import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type Db, openDb, schema } from "@swdb/db"
import { migrateDb } from "@swdb/db/migrate"
import { eq } from "drizzle-orm"
import { afterEach, beforeEach, expect, test } from "vitest"
import { createAgent, emptyAgentInput, setAgentEnabled, updateAgent } from "../agents.ts"
import { loadEvents } from "./events.ts"
import {
  claimRun,
  enqueueRun,
  finishRun,
  RunRefusedError,
  renewLease,
  requestCancel,
} from "./queue.ts"

let dir: string
let db: Db

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "swdb-queue-"))
  db = openDb({ path: join(dir, "swdb.sqlite") })
  migrateDb(db)
})

afterEach(() => {
  db.sqlite.close()
  rmSync(dir, { recursive: true, force: true })
})

const base = () => ({
  ...emptyAgentInput(),
  name: `a-${Math.random()}`,
  model: "openai/gpt-oss-20b",
})

test("enqueueing records a started trigger attempt and points the run at the current version", () => {
  const agentId = createAgent(db, base())
  updateAgent(db, agentId, { ...base(), instructions: "v2" })
  const runId = enqueueRun(db, { agentId, source: "manual", input: { prompt: "hi" } })
  const run = db.select().from(schema.runs).where(eq(schema.runs.id, runId)).get()
  const version = db
    .select()
    .from(schema.agentVersions)
    .where(eq(schema.agentVersions.id, run?.agentVersionId ?? ""))
    .get()
  expect(version?.version).toBe(2)
  expect(run).toMatchObject({ status: "queued", rootRunId: runId, source: "manual" })
  expect(db.select().from(schema.triggerAttempts).all()).toMatchObject([
    { outcome: "started", runId },
  ])
})

test("a turned-off agent refuses new runs and records the skip", () => {
  const agentId = createAgent(db, base())
  setAgentEnabled(db, agentId, false)
  expect(() => enqueueRun(db, { agentId, source: "manual", input: { prompt: "hi" } })).toThrow(
    RunRefusedError,
  )
  expect(db.select().from(schema.triggerAttempts).all()).toMatchObject([
    { outcome: "skipped", reason: "disabled" },
  ])
  expect(db.select().from(schema.runs).all()).toEqual([])
})

test("two workers never claim the same run", () => {
  const agentId = createAgent(db, base())
  const runId = enqueueRun(db, { agentId, source: "manual", input: { prompt: "hi" } })
  const other = openDb({ path: join(dir, "swdb.sqlite") })
  expect(claimRun(db, "w1")?.runId).toBe(runId)
  expect(claimRun(other, "w2")).toBeNull()
  other.sqlite.close()
})

test("a per-agent concurrency limit holds", () => {
  const agentId = createAgent(db, { ...base(), limits: { maxConcurrentRuns: 1 } })
  const first = enqueueRun(db, { agentId, source: "manual", input: { prompt: "1" } })
  const second = enqueueRun(db, { agentId, source: "manual", input: { prompt: "2" } })
  expect(claimRun(db, "w1")?.runId).toBe(first)
  expect(claimRun(db, "w1")).toBeNull()
  finishRun(db, first, "success")
  expect(claimRun(db, "w1")?.runId).toBe(second)
})

test("a lapsed lease lets another worker resume the run; the old worker cannot renew", () => {
  const agentId = createAgent(db, base())
  const runId = enqueueRun(db, { agentId, source: "manual", input: { prompt: "hi" } })
  const now = 1_000_000
  claimRun(db, "w1", now, 1000)
  expect(claimRun(db, "w2", now + 500, 1000)).toBeNull()
  expect(claimRun(db, "w2", now + 2000, 1000)).toEqual({ runId, resumed: true })
  expect(renewLease(db, runId, "w1")).toBe(false)
  expect(renewLease(db, runId, "w2")).toBe(true)
})

test("cancelling a queued run ends it at once with one terminal event", () => {
  const agentId = createAgent(db, base())
  const runId = enqueueRun(db, { agentId, source: "manual", input: { prompt: "hi" } })
  expect(requestCancel(db, runId)).toBe("cancelled")
  expect(requestCancel(db, runId)).toBe("already_ended")
  expect(loadEvents(db, runId).map((e) => [e.type, e.payload.reason])).toEqual([
    ["run_end", "cancelled"],
  ])
  expect(claimRun(db, "w1")).toBeNull()
})

test("finishRun writes exactly one terminal event even when called twice", () => {
  const agentId = createAgent(db, base())
  const runId = enqueueRun(db, { agentId, source: "manual", input: { prompt: "hi" } })
  expect(finishRun(db, runId, "error", { error: "boom" })).toBe(true)
  expect(finishRun(db, runId, "success")).toBe(false)
  const ends = loadEvents(db, runId).filter((e) => e.type === "run_end")
  expect(ends).toHaveLength(1)
  expect(ends[0]?.payload).toMatchObject({ reason: "error", error: "boom", turns: 0, costUsd: 0 })
})
