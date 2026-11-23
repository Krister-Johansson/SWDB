import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { eq, getTableName, is } from "drizzle-orm"
import { SQLiteTable } from "drizzle-orm/sqlite-core"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { type Db, openDb, schema } from "./index.ts"
import { migrateDb } from "./migrate.ts"

const root = resolve(import.meta.dirname, "../../..")

let dir: string
let db: Db

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "swdb-migrate-"))
  db = openDb({ path: join(dir, "swdb.sqlite") })
  migrateDb(db)
})

afterEach(() => {
  db.sqlite.close()
  rmSync(dir, { recursive: true, force: true })
})

function tableNames(): string[] {
  return db.sqlite
    .prepare("select name from sqlite_master where type = 'table' and name not like 'sqlite_%'")
    .pluck()
    .all() as string[]
}

// Every table in the "Data model" table of docs/research-report.md, read from the report so
// that a table added there without a schema change fails this test.
function reportTables(): string[] {
  const report = readFileSync(resolve(root, "docs/research-report.md"), "utf8")
  const section = report.split("### Data model")[1]?.split("\n### ")[0] ?? ""
  const rows = section
    .split("\n")
    .filter((line) => /^\| [A-Z]/.test(line) && !line.startsWith("| Area"))
  return rows.flatMap((row) =>
    [...(row.split("|")[2] ?? "").matchAll(/`([a-z_]+)`/g)].map((m) => m[1] as string),
  )
}

test("the data model section of the report names 27 tables", () => {
  expect(reportTables()).toHaveLength(27)
})

test("a fresh database gets every table in the report's data model", () => {
  const names = tableNames()
  for (const table of reportTables()) expect(names).toContain(table)
})

test("every table in the Drizzle schema exists after migrating", () => {
  const tables = Object.values(schema).filter((v) => is(v, SQLiteTable))
  const names = tableNames()
  for (const table of tables) expect(names).toContain(getTableName(table))
})

test("running the migrations again changes nothing", () => {
  const before = db.sqlite.prepare("select count(*) from __drizzle_migrations").pluck().get()
  migrateDb(db)
  expect(db.sqlite.prepare("select count(*) from __drizzle_migrations").pluck().get()).toBe(before)
})

test("pnpm db:migrate migrates an empty data folder in one command", () => {
  const dataDir = join(dir, "fresh")
  execFileSync("pnpm", ["db:migrate"], {
    cwd: root,
    env: { ...process.env, SWDB_DATA_DIR: dataDir },
    stdio: "pipe",
  })
  const fresh = openDb({ path: join(dataDir, "swdb.sqlite") })
  const names = fresh.sqlite
    .prepare("select name from sqlite_master where type = 'table'")
    .pluck()
    .all()
  fresh.sqlite.close()
  expect(names).toContain("runs")
  expect(names).toContain("run_events")
})

test("a database from M1, with only the bootstrap heartbeat table, migrates and keeps its rows", () => {
  const path = join(dir, "m1.sqlite")
  const old = openDb({ path })
  old.sqlite.exec(
    "create table process_heartbeats (process text primary key, pid integer not null, started_at integer not null, beat_at integer not null)",
  )
  old.sqlite.exec("insert into process_heartbeats values ('worker', 1, 2, 3)")
  migrateDb(old)
  expect(old.select().from(schema.processHeartbeats).all()).toEqual([
    { process: "worker", pid: 1, startedAt: 2, beatAt: 3 },
  ])
  expect(old.sqlite.prepare("select count(*) from runs").pluck().get()).toBe(0)
  old.sqlite.close()
})

describe("constraints", () => {
  function seedRun() {
    const agent = db
      .insert(schema.agents)
      .values({ name: "a", model: "openai/gpt-oss-20b" })
      .returning()
      .get()
    const version = db
      .insert(schema.agentVersions)
      .values({ agentId: agent.id, version: 1, definition: { name: "a" } })
      .returning()
      .get()
    const run = db
      .insert(schema.runs)
      .values({ agentId: agent.id, agentVersionId: version.id, source: "manual" })
      .returning()
      .get()
    return { agent, version, run }
  }

  test("a new agent starts enabled, at sandbox level 1, with empty limits", () => {
    const { agent } = seedRun()
    expect(agent).toMatchObject({ enabled: true, sandboxLevel: 1, limits: {}, pausedReason: null })
  })

  test("a value outside a fixed set fails on write", () => {
    const { agent, version } = seedRun()
    expect(() =>
      db.sqlite
        .prepare(
          "insert into runs (id, agent_id, agent_version_id, source, status, queued_at) values (?, ?, ?, ?, ?, ?)",
        )
        .run("r2", agent.id, version.id, "manual", "done", 0),
    ).toThrow(/CHECK constraint failed: runs_status_check/)
    expect(() =>
      db
        .update(schema.agents)
        .set({ sandboxLevel: 4 as 1 })
        .run(),
    ).toThrow(/agents_sandbox_level_check/)
  })

  test("run_events has one row per (run, seq)", () => {
    const { run } = seedRun()
    db.insert(schema.runEvents).values({ runId: run.id, seq: 1, type: "run_start" }).run()
    expect(() =>
      db.insert(schema.runEvents).values({ runId: run.id, seq: 1, type: "turn_start" }).run(),
    ).toThrow(/UNIQUE constraint failed/)
  })

  test("a repeated webhook delivery is rejected by (trigger_id, dedup_key)", () => {
    const { agent } = seedRun()
    const trigger = db
      .insert(schema.triggers)
      .values({ agentId: agent.id, kind: "webhook", name: "gh", pathToken: "t", authMode: "none" })
      .returning()
      .get()
    const delivery = { triggerId: trigger.id, dedupKey: "msg_1", headers: {}, body: "{}" }
    db.insert(schema.webhookDeliveries).values(delivery).run()
    expect(() => db.insert(schema.webhookDeliveries).values(delivery).run()).toThrow(
      /UNIQUE constraint failed/,
    )
  })

  test("a human request resolves once: the second compare-and-set changes no row", () => {
    const { run } = seedRun()
    const request = db
      .insert(schema.humanRequests)
      .values({
        runId: run.id,
        kind: "approval",
        title: "ok?",
        expiresAt: 1,
        defaultOnTimeout: "deny",
      })
      .returning()
      .get()
    const answer = (via: "inbox" | "slack") =>
      db.sqlite
        .prepare(
          "update human_requests set status = 'answered', answered_via = ? where id = ? and status = 'open'",
        )
        .run(via, request.id).changes
    expect(answer("slack")).toBe(1)
    expect(answer("inbox")).toBe(0)
    expect(
      db.select().from(schema.humanRequests).where(eq(schema.humanRequests.id, request.id)).get()
        ?.answeredVia,
    ).toBe("slack")
  })

  test("deleting an agent removes its selections and versions", () => {
    const agent = db.insert(schema.agents).values({ name: "b", model: "m" }).returning().get()
    db.insert(schema.agentVersions).values({ agentId: agent.id, version: 1, definition: {} }).run()
    const skill = db
      .insert(schema.skills)
      .values({ name: "s", description: "d", location: "/x", contentHash: "h" })
      .returning()
      .get()
    db.insert(schema.agentSkills).values({ agentId: agent.id, skillId: skill.id }).run()
    db.delete(schema.agents).where(eq(schema.agents.id, agent.id)).run()
    expect(db.select().from(schema.agentSkills).all()).toEqual([])
    expect(db.select().from(schema.agentVersions).all()).toEqual([])
  })

  test("an agent with runs cannot be deleted, so its run history stays", () => {
    const { agent } = seedRun()
    expect(() => db.delete(schema.agents).where(eq(schema.agents.id, agent.id)).run()).toThrow(
      /FOREIGN KEY constraint failed/,
    )
  })
})
