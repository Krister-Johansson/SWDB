// Spike SP3: kill the worker mid-run and resume from run_events.
// Run: node spikes/sp3-resume-after-kill/run.ts
//
// A scripted "model" asks for six tool calls, one per turn. Each tool appends a line to a
// side-effect file, so a tool that ran twice is visible. The loop writes every model response
// and every tool result to run_events before it acts on it.
// The parent starts a worker, kills it with SIGKILL while tool 3 is executing, then starts a
// second worker on the same database.
// Pass: the run finishes, the killed tool call has a synthetic "interrupted" result, the
// transcript is valid (every tool call has exactly one result), and no tool ran twice.
import { fork } from "node:child_process"
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { openDb } from "../../packages/db/src/index.ts"

const TOOLS = 6
const KILL_DURING = 3
const [role, file, effects] = process.argv.slice(2)

type Event = { seq: number; type: string; payload: string }

function worker(file: string, effects: string): void {
  const { sqlite } = openDb({ path: file })
  sqlite.exec(
    "CREATE TABLE IF NOT EXISTS run_events (run_id TEXT NOT NULL, seq INTEGER NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (run_id, seq))",
  )
  const insert = sqlite.prepare(
    "INSERT INTO run_events (run_id, seq, type, payload) VALUES ('r1', ?, ?, ?)",
  )
  const load = () =>
    sqlite
      .prepare("SELECT seq, type, payload FROM run_events WHERE run_id = 'r1' ORDER BY seq")
      .all() as Event[]
  const append = (type: string, payload: object) => {
    const seq = (load().at(-1)?.seq ?? 0) + 1
    insert.run(seq, type, JSON.stringify(payload))
  }

  // Recovery: a tool call that was requested but has no result did not finish. The harness
  // cannot know whether its side effect happened, so it never re-executes it. It records an
  // "interrupted" result and lets the model decide what to do next.
  let events = load()
  if (events.length === 0) append("run_start", {})
  const results = new Set(
    events.filter((e) => e.type === "tool_result").map((e) => JSON.parse(e.payload).callId),
  )
  for (const e of events.filter((e) => e.type === "model_response")) {
    const { callId } = JSON.parse(e.payload)
    if (callId && !results.has(callId)) {
      append("tool_result", {
        callId,
        interrupted: true,
        output: "interrupted: the worker stopped before this tool call finished",
      })
    }
  }

  for (;;) {
    events = load()
    if (events.some((e) => e.type === "run_end")) break
    const done = events.filter((e) => e.type === "tool_result").length
    // The scripted model: asks for the next tool until all are done, then finishes.
    if (done >= TOOLS) {
      append("model_response", { final: "all tools done" })
      append("run_end", { reason: "success" })
      break
    }
    const callId = `call_${done + 1}`
    append("model_response", { callId, tool: "side_effect", n: done + 1 })
    if (done + 1 === KILL_DURING && !existsSync(`${effects}.killed`)) process.send?.("kill-me")
    // The tool: a slow external side effect.
    const until = Date.now() + 300
    while (Date.now() < until) {}
    appendFileSync(effects, `${callId}\n`)
    append("tool_result", { callId, output: `effect ${done + 1} written` })
  }
  sqlite.close()
  process.exit(0)
}

if (role === "worker") {
  worker(file as string, effects as string)
} else {
  const dir = mkdtempSync(join(tmpdir(), "swdb-sp3-"))
  const db = join(dir, "swdb.sqlite")
  const fx = join(dir, "effects.log")
  const self = fileURLToPath(import.meta.url)
  const run = (killOnRequest: boolean) =>
    new Promise<string>((resolve) => {
      const child = fork(self, ["worker", db, fx])
      child.on("message", () => {
        if (!killOnRequest) return
        // Kill 100 ms into the 300 ms tool, before its side effect and its result are written.
        setTimeout(() => {
          appendFileSync(`${fx}.killed`, "1")
          child.kill("SIGKILL")
        }, 100)
      })
      child.on("exit", (code, signal) => resolve(signal ?? `exit ${code}`))
    })

  const first = await run(true)
  const second = await run(false)

  const { sqlite } = openDb({ path: db })
  const events = sqlite
    .prepare("SELECT seq, type, payload FROM run_events ORDER BY seq")
    .all() as Event[]
  sqlite.close()
  const effectsRun = existsSync(fx) ? readFileSync(fx, "utf8").trim().split("\n") : []
  const calls = events
    .filter((e) => e.type === "model_response")
    .map((e) => JSON.parse(e.payload).callId)
    .filter(Boolean)
  const results = events.filter((e) => e.type === "tool_result").map((e) => JSON.parse(e.payload))
  const interrupted = results.filter((r) => r.interrupted).map((r) => r.callId)
  const oneResultPerCall = calls.every(
    (c: string) => results.filter((r) => r.callId === c).length === 1,
  )
  const noDoubleEffects = new Set(effectsRun).size === effectsRun.length
  const ended = events.filter((e) => e.type === "run_end").length === 1

  console.log({
    firstWorker: first,
    secondWorker: second,
    events: events.length,
    toolCalls: calls.length,
    interrupted,
    effectsRun,
  })
  const pass =
    first === "SIGKILL" &&
    second === "exit 0" &&
    ended &&
    oneResultPerCall &&
    noDoubleEffects &&
    interrupted.length === 1 &&
    !effectsRun.includes(interrupted[0])
  console.log(pass ? "PASS" : "FAIL")
  rmSync(dir, { recursive: true, force: true })
  process.exit(pass ? 0 : 1)
}
