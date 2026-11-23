import { hostname } from "node:os"
import { executeRun } from "@swdb/core/runs/harness"
import { claimRun, finishRun } from "@swdb/core/runs/queue"
import { openSecrets } from "@swdb/core/secrets"
import { dbPath, openDb } from "@swdb/db"
import { beat } from "@swdb/db/heartbeat"

// The worker owns everything that must outlive a web request: agent runs, the schedule
// ticker, MCP child processes and chat connections. Today it claims queued runs and runs them.
const db = openDb()
const { secrets } = openSecrets(db)
const startedAt = Date.now()
const workerId = `${hostname()}:${process.pid}`
const MAX_PARALLEL_RUNS = Number(process.env.SWDB_MAX_PARALLEL_RUNS ?? 4)
const POLL_MS = 500

const active = new Set<string>()
let stopping = false

function tick(): void {
  beat(db, "worker", process.pid, startedAt)
}

function poll(): void {
  while (!stopping && active.size < MAX_PARALLEL_RUNS) {
    const claimed = claimRun(db, workerId)
    if (!claimed) return
    const { runId, resumed } = claimed
    active.add(runId)
    console.log(`[worker] ${resumed ? "resuming" : "starting"} run ${runId}`)
    executeRun({ db, secrets, workerId }, runId)
      .then((reason) => console.log(`[worker] run ${runId} ended: ${reason ?? "lease lost"}`))
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`[worker] run ${runId} crashed: ${message}`)
        finishRun(db, runId, "error", { error: message })
      })
      .finally(() => active.delete(runId))
  }
}

tick()
const heartbeat = setInterval(tick, 2000)
const poller = setInterval(poll, POLL_MS)
console.log(`[worker] ${workerId} started, database ${dbPath()}`)

function shutdown(signal: string): void {
  // Runs in progress keep their rows. Their leases lapse and the next worker resumes them.
  stopping = true
  clearInterval(heartbeat)
  clearInterval(poller)
  db.sqlite.close()
  console.log(`[worker] stopped on ${signal} with ${active.size} run(s) in progress`)
  process.exit(0)
}

process.on("SIGINT", () => shutdown("SIGINT"))
process.on("SIGTERM", () => shutdown("SIGTERM"))
