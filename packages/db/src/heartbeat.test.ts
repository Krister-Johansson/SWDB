import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, test } from "vitest"
import { beat, HEARTBEAT_STALE_MS, readHeartbeat } from "./heartbeat.ts"
import { openDb } from "./index.ts"

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "swdb-db-"))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

test("the database file opens in WAL mode", () => {
  const db = openDb({ path: join(dir, "swdb.sqlite") })
  expect(db.sqlite.pragma("journal_mode", { simple: true })).toBe("wal")
  db.sqlite.close()
})

test("a second connection reads the heartbeat the first one wrote", () => {
  const path = join(dir, "swdb.sqlite")
  const worker = openDb({ path })
  const web = openDb({ path })

  expect(readHeartbeat(web, "worker")).toBeNull()

  beat(worker, "worker", 4242, 1000, 5000)
  expect(readHeartbeat(web, "worker", 5001)).toEqual({
    alive: true,
    pid: 4242,
    startedAt: 1000,
    beatAt: 5000,
  })

  worker.sqlite.close()
  web.sqlite.close()
})

test("a heartbeat older than the stale limit counts as not alive", () => {
  const db = openDb({ path: join(dir, "swdb.sqlite") })
  beat(db, "worker", 1, 0, 0)
  expect(readHeartbeat(db, "worker", HEARTBEAT_STALE_MS + 1)?.alive).toBe(false)
  db.sqlite.close()
})
