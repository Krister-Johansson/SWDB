// First task of M5: the SP3 crash rule on top of TanStack AI, with a real model.
// Run from the repo root, with OPENROUTER_API_KEY in .env:
//   pnpm --filter sp4-tanstack-ai resume
//
// The worker runs chat() with two tools. A middleware writes every tool call to run_events
// before the tool runs, and each tool writes its result to run_events when it finishes.
// The parent kills the first worker with SIGKILL while the first tool is executing, then
// starts a second worker. The second worker rebuilds the messages from run_events, adds a
// synthetic "interrupted" result for the call that has none, and continues the run.
// Pass: the run finishes with an answer, every tool call has exactly one result, the killed
// call is marked interrupted and its side effect never ran, no call's side effect ran twice,
// and after the restart the model called lookup_order again and then carrier_status, and
// both of those ran their side effect.
import { fork } from "node:child_process"
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  type ChatMiddleware,
  chat,
  type ModelMessage,
  maxIterations,
  toolDefinition,
} from "@tanstack/ai"
import { openRouterText } from "@tanstack/ai-openrouter"
import { z } from "zod"
import { openDb } from "../../packages/db/src/index.ts"

const MODEL = process.env.SP4_MODEL ?? "openai/gpt-oss-20b"
const PROMPT =
  "Order 4471: first look it up, then ask its carrier for the delivery estimate, then answer in one sentence. Use the tools one at a time. If a tool result says it was interrupted, call that tool again."
const [role, file, effects] = process.argv.slice(2)

type Event = { seq: number; type: string; payload: string }

async function worker(file: string, effects: string): Promise<void> {
  const { sqlite } = openDb({ path: file })
  sqlite.exec(
    "CREATE TABLE IF NOT EXISTS run_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, payload TEXT NOT NULL)",
  )
  const insert = sqlite.prepare("INSERT INTO run_events (type, payload) VALUES (?, ?)")
  const append = (type: string, payload: object) => insert.run(type, JSON.stringify(payload))
  const load = () =>
    sqlite.prepare("SELECT seq, type, payload FROM run_events ORDER BY seq").all() as Event[]

  // Recovery: a recorded tool call with no result gets an "interrupted" result. It is never re-executed here.
  const answered = new Set(
    load()
      .filter((e) => e.type === "tool_result")
      .map((e) => JSON.parse(e.payload).id),
  )
  for (const e of load().filter((e) => e.type === "tool_call")) {
    const { id } = JSON.parse(e.payload)
    if (!answered.has(id)) {
      append("tool_result", {
        id,
        interrupted: true,
        content: { error: "interrupted: the worker stopped before this tool call finished" },
      })
    }
  }

  // Rebuild the transcript from the log.
  const messages: ModelMessage[] = [{ role: "user", content: PROMPT }]
  for (const e of load()) {
    const p = JSON.parse(e.payload)
    if (e.type === "tool_call") {
      messages.push({
        role: "assistant",
        content: null,
        toolCalls: [
          {
            id: p.id,
            type: "function",
            function: { name: p.name, arguments: JSON.stringify(p.args) },
          },
        ],
      })
    } else if (e.type === "tool_result") {
      messages.push({ role: "tool", toolCallId: p.id, content: JSON.stringify(p.content) })
    }
  }

  // A tool runs its slow side effect, then records its own result before returning it.
  // The call id comes from the tool's own execution context, so two calls can never share one.
  const effect = <T extends object>(id: string | undefined, result: T): T => {
    if (!id) throw new Error("The tool ran without a tool call id")
    const until = Date.now() + 300
    while (Date.now() < until) {}
    appendFileSync(effects, `${id}\n`)
    append("tool_result", { id, content: result })
    return result
  }
  const lookupOrder = toolDefinition({
    name: "lookup_order",
    description: "Look up an order by its number",
    inputSchema: z.object({ orderNumber: z.string() }),
  }).server(({ orderNumber }, context) =>
    effect(context?.toolCallId, { orderNumber, status: "delayed", carrier: "postnord" }),
  )
  const carrierStatus = toolDefinition({
    name: "carrier_status",
    description: "Get the delivery estimate from a carrier for an order",
    inputSchema: z.object({ carrier: z.string(), orderNumber: z.string() }),
  }).server((_args, context) => effect(context?.toolCallId, { estimate: "2026-11-24" }))

  const log: ChatMiddleware = {
    name: "run-events",
    onBeforeToolCall: (_ctx, hook) => {
      append("tool_call", { id: hook.toolCall.id, name: hook.toolName, args: hook.args })
      if (!existsSync(`${effects}.killed`)) process.send?.("kill-me")
    },
  }

  let text = ""
  for await (const chunk of chat({
    adapter: openRouterText(MODEL as Parameters<typeof openRouterText>[0]),
    messages,
    threadId: "sp4-resume",
    tools: [lookupOrder, carrierStatus],
    middleware: [log],
    // One tool at a time, so each call is logged right before it runs.
    toolExecution: "sequential",
    agentLoopStrategy: maxIterations(8),
  })) {
    if (chunk.type === "TEXT_MESSAGE_CONTENT") text += chunk.delta
  }
  append("run_end", { reason: "success", text })
  sqlite.close()
  process.exit(0)
}

if (role === "worker") {
  await worker(file as string, effects as string)
} else {
  if (!process.env.OPENROUTER_API_KEY) {
    console.error("OPENROUTER_API_KEY is not set. Add it to .env in the repo root.")
    process.exit(2)
  }
  const dir = mkdtempSync(join(tmpdir(), "swdb-sp4-resume-"))
  const db = join(dir, "swdb.sqlite")
  const fx = join(dir, "effects.log")
  const self = fileURLToPath(import.meta.url)
  const run = (kill: boolean) =>
    new Promise<string>((resolve) => {
      const child = fork(self, ["worker", db, fx])
      child.on("message", () => {
        if (!kill) return
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
  const events = (
    sqlite.prepare("SELECT seq, type, payload FROM run_events ORDER BY seq").all() as Event[]
  ).map((e) => ({ type: e.type, ...JSON.parse(e.payload) }))
  sqlite.close()
  const effectsRun = existsSync(fx) ? readFileSync(fx, "utf8").trim().split("\n") : []
  const calls = events.filter((e) => e.type === "tool_call")
  const results = events.filter((e) => e.type === "tool_result")
  const interrupted = results.filter((r) => r.interrupted).map((r) => r.id)
  const end = events.filter((e) => e.type === "run_end")
  // The work the resumed run must have done: every call after the interrupted one, in order,
  // with the side effect of each.
  const killedAt = calls.findIndex((c) => c.id === interrupted[0])
  const afterRestart = calls.slice(killedAt + 1)
  const recovered =
    killedAt === 0 &&
    calls[0]?.name === "lookup_order" &&
    afterRestart.map((c) => c.name).join(",") === "lookup_order,carrier_status" &&
    // The recovered calls must be about the same order and the carrier the lookup returned.
    [calls[0], ...afterRestart].every((c) => String(c?.args?.orderNumber) === "4471") &&
    String(afterRestart[1]?.args?.carrier).toLowerCase() === "postnord" &&
    effectsRun.join(",") === afterRestart.map((c) => c.id).join(",")

  console.log({
    model: MODEL,
    firstWorker: first,
    secondWorker: second,
    toolCalls: calls.map((c) => `${c.id.slice(-6)} ${c.name}`),
    interrupted: interrupted.map((i: string) => i.slice(-6)),
    effectsRun: effectsRun.map((e) => e.slice(-6)),
    answer: end[0]?.text,
  })
  const pass =
    first === "SIGKILL" &&
    second === "exit 0" &&
    end.length === 1 &&
    calls.every((c) => results.filter((r) => r.id === c.id).length === 1) &&
    interrupted.length === 1 &&
    !effectsRun.includes(interrupted[0]) &&
    new Set(effectsRun).size === effectsRun.length &&
    recovered &&
    typeof end[0]?.text === "string" &&
    end[0].text.trim().length > 0
  console.log(pass ? "PASS" : "FAIL")
  rmSync(dir, { recursive: true, force: true })
  process.exit(pass ? 0 : 1)
}
