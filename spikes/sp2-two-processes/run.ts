// Spike SP2: can the web process and the worker write to one SQLite file at the same time?
// Run: node spikes/sp2-two-processes/run.ts
// The parent starts two child processes on the same WAL-mode file for DURATION_MS:
//   web    inserts "runs" rows as fast as it can (what a burst of triggers would do)
//   worker appends "run_events" rows, and every 500 ms holds a write transaction for 150 ms
// Pass: zero SQLITE_BUSY errors, and every row both processes wrote is in the file afterwards.
import { fork } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { openDb } from "../../packages/db/src/index.ts"

const DURATION_MS = 8000
const role = process.argv[2]
const path = process.argv[3]

type Result = { role: string; written: number; busy: number; maxWaitMs: number }

function work(role: "web" | "worker", path: string): Result {
  const { sqlite } = openDb({ path })
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS runs (id INTEGER PRIMARY KEY, status TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS run_events (run_id INTEGER NOT NULL, seq INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (run_id, seq));
  `)
  const enqueue = sqlite.prepare("INSERT INTO runs (status, created_at) VALUES ('queued', ?)")
  const append = sqlite.prepare("INSERT INTO run_events (run_id, seq, payload) VALUES (?, ?, ?)")
  const payload = "x".repeat(2000)
  const end = Date.now() + DURATION_MS
  let written = 0
  let busy = 0
  let maxWaitMs = 0
  let seq = 0
  let lastLongTx = Date.now()

  while (Date.now() < end) {
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
        lastLongTx = Date.now()
      } else {
        append.run(process.pid, seq++, payload)
        written++
      }
    } catch (error) {
      if ((error as { code?: string }).code?.startsWith("SQLITE_BUSY")) busy++
      else throw error
    }
    maxWaitMs = Math.max(maxWaitMs, performance.now() - t0)
  }
  sqlite.close()
  return { role, written, busy, maxWaitMs: Math.round(maxWaitMs) }
}

if (role === "web" || role === "worker") {
  process.send?.(work(role, path as string))
} else {
  const dir = mkdtempSync(join(tmpdir(), "swdb-sp2-"))
  const file = join(dir, "swdb.sqlite")
  openDb({ path: file }).sqlite.close()
  const self = fileURLToPath(import.meta.url)
  const results = await Promise.all(
    (["web", "worker"] as const).map(
      (r) =>
        new Promise<Result>((resolve, reject) => {
          const child = fork(self, [r, file])
          child.once("message", (m) => resolve(m as Result))
          child.once("error", reject)
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
  console.table(results)
  console.log(`rows in file: runs ${runs.n}, run_events ${events.n}`)
  const pass =
    web.busy === 0 && worker.busy === 0 && runs.n === web.written && events.n === worker.written
  console.log(pass ? "PASS" : "FAIL")
  process.exit(pass ? 0 : 1)
}
