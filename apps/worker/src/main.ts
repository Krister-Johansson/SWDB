import { dbPath, openDb } from "@swdb/db"
import { beat } from "@swdb/db/heartbeat"

// The worker owns everything that must outlive a web request: agent runs, the schedule
// ticker, MCP child processes and chat connections. For now it only reports that it is alive.
const db = openDb()
const startedAt = Date.now()

function tick(): void {
  beat(db, "worker", process.pid, startedAt)
}

tick()
const timer = setInterval(tick, 2000)
console.log(`[worker] pid ${process.pid} started, database ${dbPath()}`)

function shutdown(signal: string): void {
  clearInterval(timer)
  db.sqlite.close()
  console.log(`[worker] stopped on ${signal}`)
  process.exit(0)
}

process.on("SIGINT", () => shutdown("SIGINT"))
process.on("SIGTERM", () => shutdown("SIGTERM"))
