// Spike SP2: can the web process and the worker write to one SQLite file at the same time?
// Run: node spikes/sp2-two-processes/run.ts
// The parent starts two child processes on the same WAL-mode file for DURATION_MS:
//   web    inserts "runs" rows as fast as it can (what a burst of triggers would do)
//   worker appends "run_events" rows, and every 500 ms holds a write transaction for 150 ms
// The parent starts both children, waits until both have the file open, and gives them the
// same start and end time, so the two workloads overlap for the whole run.
// Pass: zero SQLITE_BUSY errors, every row both processes wrote is in the file afterwards,
// both processes wrote throughout the shared window, and the worker held long transactions in it.
import { fork } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { openDb } from "../../packages/db/src/index.ts"

const DURATION_MS = 8000
const role = process.argv[2]
const path = process.argv[3]

type Result = {
  role: string
  written: number
  busy: number
  maxWaitMs: number
  firstWriteAt: number
  lastWriteAt: number
  longTx: number
}
type Window = { start: number; end: number }

function work(role: "web" | "worker", path: string, window: Window): Result {
  const { sqlite } = openDb({ path })
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS runs (id INTEGER PRIMARY KEY, status TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS run_events (run_id INTEGER NOT NULL, seq INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (run_id, seq));
  `)
  const enqueue = sqlite.prepare("INSERT INTO runs (status, created_at) VALUES ('queued', ?)")
  const append = sqlite.prepare("INSERT INTO run_events (run_id, seq, payload) VALUES (?, ?, ?)")
  const payload = "x".repeat(2000)
  let written = 0
  let firstWriteAt = 0
  let lastWriteAt = 0
  let longTx = 0
  let busy = 0
  let maxWaitMs = 0
  let seq = 0
  while (Date.now() < window.start) {}
  let lastLongTx = Date.now()

  while (Date.now() < window.end) {
    const t0 = performance.now()
    try {
      if (role === "web") {
        enqueue.run(Date.now())
        written++
      } else if (Date.now() - lastLongTx > 500) {
        // A slow step inside a write transaction, such as a large batch of events.
        sqlite.transaction(() => {
          for (let i = 0; i < 50; i++) append.run(process.pid, seq++, payload)
          const hold = Date.now() + 150
          while (Date.now() < hold) {}
        })()
        written += 50
        longTx++
        lastLongTx = Date.now()
      } else {
        append.run(process.pid, seq++, payload)
        written++
      }
    } catch (error) {
      if ((error as { code?: string }).code?.startsWith("SQLITE_BUSY")) busy++
      else throw error
    }
    lastWriteAt = Date.now()
    firstWriteAt ||= lastWriteAt
    maxWaitMs = Math.max(maxWaitMs, performance.now() - t0)
  }
  sqlite.close()
  return {
    role,
    written,
    busy,
    maxWaitMs: Math.round(maxWaitMs),
    firstWriteAt,
    lastWriteAt,
    longTx,
  }
}

if (role === "web" || role === "worker") {
  process.once("message", (window) => {
    process.send?.(work(role, path as string, window as Window))
    process.disconnect()
  })
  process.send?.("ready")
} else {
  const dir = mkdtempSync(join(tmpdir(), "swdb-sp2-"))
  const file = join(dir, "swdb.sqlite")
  openDb({ path: file }).sqlite.close()
  const self = fileURLToPath(import.meta.url)
  const children = (["web", "worker"] as const).map((r) => fork(self, [r, file]))
  await Promise.all(children.map((c) => new Promise((ready) => c.once("message", ready))))
  const start = Date.now() + 200
  const window: Window = { start, end: start + DURATION_MS }
  const results = await Promise.all(
    children.map(
      (child) =>
        new Promise<Result>((resolve, reject) => {
          child.once("message", (m) => resolve(m as Result))
          child.once("error", reject)
          child.send(window)
        }),
    ),
  )
  const { sqlite } = openDb({ path: file })
  const runs = sqlite.prepare("SELECT count(*) AS n FROM runs").get() as { n: number }
  const events = sqlite.prepare("SELECT count(*) AS n FROM run_events").get() as { n: number }
  sqlite.close()
  rmSync(dir, { recursive: true, force: true })

  const web = results.find((r) => r.role === "web") as Result
  const worker = results.find((r) => r.role === "worker") as Result
  // Both processes must have been writing during the same stretch of time. A long wait for
  // the lock can delay a first or last write, so the shared stretch only has to cover half
  // of the run.
  const overlapMs =
    Math.min(web.lastWriteAt, worker.lastWriteAt) - Math.max(web.firstWriteAt, worker.firstWriteAt)
  console.table(results)
  console.log(`rows in file: runs ${runs.n}, run_events ${events.n}, overlap ${overlapMs} ms`)
  const pass =
    web.busy === 0 &&
    worker.busy === 0 &&
    runs.n === web.written &&
    events.n === worker.written &&
    overlapMs >= DURATION_MS / 2 &&
    worker.longTx >= 5
  console.log(pass ? "PASS" : "FAIL")
  process.exit(pass ? 0 : 1)
}
