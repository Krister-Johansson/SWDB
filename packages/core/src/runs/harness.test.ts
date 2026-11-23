import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type Db, openDb, schema } from "@swdb/db"
import { migrateDb } from "@swdb/db/migrate"
import { toolDefinition } from "@tanstack/ai"
import { eq } from "drizzle-orm"
import { afterEach, beforeEach, expect, test } from "vitest"
import { z } from "zod"
import { type AgentInput, createAgent, emptyAgentInput } from "../agents.ts"
import { openSecrets, type SecretStore } from "../secrets.ts"
import { appendEvent, loadEvents } from "./events.ts"
import { executeRun, OPENROUTER_SECRET, requestBodyText } from "./harness.ts"
import { claimRun, enqueueRun, requestCancel } from "./queue.ts"

let dir: string
let db: Db
let secrets: SecretStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "swdb-harness-"))
  db = openDb({ path: join(dir, "swdb.sqlite") })
  migrateDb(db)
  secrets = openSecrets(db, Buffer.alloc(32, 1)).secrets
  secrets.set(OPENROUTER_SECRET, "sk-or-test-not-a-real-key")
})

afterEach(() => {
  db.sqlite.close()
  rmSync(dir, { recursive: true, force: true })
})

// A scripted OpenRouter. Each call to fetch returns the next reply as an SSE stream in the
// chat completions chunk format, and records the request body it was sent.
type Reply = {
  text?: string
  toolCalls?: { id: string; name: string; args: object }[]
  cost?: number
}

function scripted(replies: Reply[]) {
  const requests: Record<string, unknown>[] = []
  const fetch = (async (url: unknown, init?: RequestInit) => {
    requests.push(JSON.parse((await requestBodyText(url, init)) ?? "{}"))
    const reply = replies[requests.length - 1]
    if (!reply) {
      return new Response(
        JSON.stringify({ error: { code: 400, message: "no more scripted replies" } }),
        {
          status: 400,
          headers: { "content-type": "application/json" },
        },
      )
    }
    const base = {
      id: `gen-${requests.length}`,
      object: "chat.completion.chunk",
      created: 1,
      model: String(requests.at(-1)?.model),
      provider: "Scripted",
    }
    const chunks: object[] = []
    if (reply.text) {
      chunks.push({
        ...base,
        choices: [
          { index: 0, delta: { role: "assistant", content: reply.text }, finish_reason: null },
        ],
      })
    }
    reply.toolCalls?.forEach((call, index) => {
      chunks.push({
        ...base,
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: [
                {
                  index,
                  id: call.id,
                  type: "function",
                  function: { name: call.name, arguments: JSON.stringify(call.args) },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      })
    })
    chunks.push({
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: reply.toolCalls ? "tool_calls" : "stop" }],
    })
    chunks.push({
      ...base,
      choices: [],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
        cost: reply.cost ?? 0.001,
      },
    })
    const body = `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("")}data: [DONE]\n\n`
    return new Response(body, { headers: { "content-type": "text/event-stream" } })
  }) as typeof globalThis.fetch
  return { fetch, requests }
}

function agent(over: Partial<AgentInput> = {}) {
  return createAgent(db, {
    ...emptyAgentInput(),
    name: `agent-${Math.random()}`,
    model: "openai/gpt-oss-20b",
    instructions: "You are a test agent.",
    ...over,
  })
}

function startRun(agentId: string, prompt = "Say hello") {
  const runId = enqueueRun(db, { agentId, source: "manual", input: { prompt } })
  expect(claimRun(db, "w1")?.runId).toBe(runId)
  return runId
}

const types = (runId: string) => loadEvents(db, runId).map((e) => e.type)
const runRow = (runId: string) =>
  db.select().from(schema.runs).where(eq(schema.runs.id, runId)).get()

function counterTool(
  calls: string[],
  result: (args: { n: number }) => unknown = ({ n }) => ({ doubled: n * 2 }),
) {
  return toolDefinition({
    name: "double",
    description: "Doubles a number",
    inputSchema: z.object({ n: z.number() }),
  }).server((args, context) => {
    calls.push(String(context?.toolCallId))
    return result(args)
  })
}

test("a text answer ends with one run_end carrying cost, usage, turns and reason", async () => {
  const runId = startRun(agent())
  const { fetch, requests } = scripted([{ text: "Hello there", cost: 0.002 }])
  expect(await executeRun({ db, secrets, workerId: "w1", fetch }, runId)).toBe("success")

  expect(types(runId)).toEqual([
    "run_start",
    "turn_start",
    "model_request",
    "model_response",
    "run_end",
  ])
  const end = loadEvents(db, runId).at(-1)?.payload
  expect(end).toMatchObject({
    reason: "success",
    turns: 1,
    inputTokens: 10,
    outputTokens: 5,
    costUsd: 0.002,
    output: "Hello there",
  })
  expect(runRow(runId)).toMatchObject({
    status: "succeeded",
    stopReason: "success",
    turns: 1,
    costUsd: 0.002,
  })

  // The exact request: the agent's model, its instructions as the system prompt, the user message.
  expect(requests[0]?.model).toBe("openai/gpt-oss-20b")
  expect(JSON.stringify(requests[0])).toContain("You are a test agent.")
  expect(JSON.stringify(requests[0])).toContain("Say hello")
  const call = db.select().from(schema.modelCalls).where(eq(schema.modelCalls.runId, runId)).get()
  expect(call).toMatchObject({
    turn: 1,
    costUsd: 0.002,
    servedModel: "openai/gpt-oss-20b",
    provider: "Scripted",
    generationId: "gen-1",
    finishReason: "stop",
  })
  expect(call?.requestBody).toMatchObject({ model: "openai/gpt-oss-20b" })
  expect(Array.isArray(call?.responseBody)).toBe(true)
})

test("each tool call is logged before it runs, and its result before the next model call", async () => {
  const calls: string[] = []
  const runId = startRun(agent(), "Double 21")
  const { fetch, requests } = scripted([
    { toolCalls: [{ id: "call_a", name: "double", args: { n: 21 } }] },
    { text: "It is 42" },
  ])
  const reason = await executeRun(
    { db, secrets, workerId: "w1", fetch, tools: [counterTool(calls)] },
    runId,
  )
  expect(reason).toBe("success")
  expect(calls).toEqual(["call_a"])
  expect(types(runId)).toEqual([
    "run_start",
    "turn_start",
    "model_request",
    "model_response",
    "tool_start",
    "tool_end",
    "turn_start",
    "model_request",
    "model_response",
    "run_end",
  ])
  const toolRow = db.select().from(schema.toolCalls).where(eq(schema.toolCalls.runId, runId)).get()
  expect(toolRow).toMatchObject({
    callId: "call_a",
    name: "double",
    state: "completed",
    args: { n: 21 },
  })
  expect(JSON.stringify(requests[1])).toContain("42")
})

test("a secret value in a tool result is redacted before the model and the log see it", async () => {
  secrets.set("GH_TOKEN", "ghp_supersecret123")
  const runId = startRun(agent())
  const { fetch, requests } = scripted([
    { toolCalls: [{ id: "call_s", name: "double", args: { n: 1 } }] },
    { text: "done" },
  ])
  const leaky = counterTool([], () => ({ token: "ghp_supersecret123" }))
  await executeRun({ db, secrets, workerId: "w1", fetch, tools: [leaky] }, runId)

  expect(JSON.stringify(requests[1])).not.toContain("ghp_supersecret123")
  expect(JSON.stringify(requests[1])).toContain("[secret:GH_TOKEN]")
  const everything = JSON.stringify([
    loadEvents(db, runId),
    db.select().from(schema.toolCalls).all(),
    db.select().from(schema.modelCalls).all(),
  ])
  expect(everything).not.toContain("ghp_supersecret123")
  expect(everything).not.toContain("sk-or-test-not-a-real-key")
})

test("maxTurns stops a model that keeps calling tools, with reason max_turns", async () => {
  const runId = startRun(agent({ limits: { maxTurns: 2 } }))
  const { fetch, requests } = scripted([
    { toolCalls: [{ id: "c1", name: "double", args: { n: 1 } }] },
    { toolCalls: [{ id: "c2", name: "double", args: { n: 2 } }] },
    { toolCalls: [{ id: "c3", name: "double", args: { n: 3 } }] },
  ])
  const reason = await executeRun(
    { db, secrets, workerId: "w1", fetch, tools: [counterTool([])] },
    runId,
  )
  expect(reason).toBe("max_turns")
  expect(requests).toHaveLength(2)
  expect(types(runId).filter((t) => t === "run_end")).toHaveLength(1)
  expect(runRow(runId)).toMatchObject({ status: "failed", stopReason: "max_turns", turns: 2 })
})

test("maxCostUsd stops the run once the summed cost passes it", async () => {
  const runId = startRun(agent({ limits: { maxCostUsd: 0.005 } }))
  const { fetch, requests } = scripted([
    { toolCalls: [{ id: "c1", name: "double", args: { n: 1 } }], cost: 0.01 },
    { text: "never sent" },
  ])
  expect(
    await executeRun({ db, secrets, workerId: "w1", fetch, tools: [counterTool([])] }, runId),
  ).toBe("max_budget")
  expect(requests).toHaveLength(1)
})

test("a killed worker's open tool call is closed as interrupted, never re-run, and the run resumes", async () => {
  const calls: string[] = []
  const runId = startRun(agent(), "Double 5")
  // What the first worker left behind: the model asked for a tool, the tool started, then SIGKILL.
  appendEvent(db, runId, "run_start", { model: "openai/gpt-oss-20b" })
  appendEvent(db, runId, "model_response", {
    message: {
      role: "assistant",
      content: null,
      toolCalls: [
        { id: "call_k", type: "function", function: { name: "double", arguments: '{"n":5}' } },
      ],
    },
  })
  appendEvent(db, runId, "tool_start", { callId: "call_k", name: "double", args: { n: 5 } })
  db.update(schema.runs).set({ leaseExpiresAt: 0 }).where(eq(schema.runs.id, runId)).run()

  // A second worker takes the run over once the lease lapses.
  expect(claimRun(db, "w2")).toEqual({ runId, resumed: true })
  const { fetch, requests } = scripted([{ text: "The tool was interrupted, so I stopped." }])
  expect(
    await executeRun({ db, secrets, workerId: "w2", fetch, tools: [counterTool(calls)] }, runId),
  ).toBe("success")

  expect(calls).toEqual([])
  const ends = loadEvents(db, runId).filter((e) => e.type === "tool_end")
  expect(ends).toHaveLength(1)
  expect(ends[0]?.payload).toMatchObject({ callId: "call_k", interrupted: true })
  const sent = JSON.stringify(requests[0])
  expect(sent).toContain("call_k")
  expect(sent).toContain("interrupted")
  expect(types(runId).filter((t) => t === "run_start")).toHaveLength(1)
})

test("a run without the OpenRouter secret ends with an error that says what to add", async () => {
  secrets.delete(OPENROUTER_SECRET)
  const runId = startRun(agent())
  expect(await executeRun({ db, secrets, workerId: "w1", fetch: scripted([]).fetch }, runId)).toBe(
    "error",
  )
  expect(runRow(runId)?.error).toContain("Settings > Secrets")
  expect(types(runId)).toEqual(["run_end"])
})

test("a failing model call ends the run with reason error", async () => {
  const runId = startRun(agent())
  const { fetch } = scripted([])
  expect(await executeRun({ db, secrets, workerId: "w1", fetch }, runId)).toBe("error")
  expect(runRow(runId)).toMatchObject({ status: "failed", stopReason: "error" })
  expect(types(runId).at(-1)).toBe("run_end")
})

test("cancel stops a running run at the next step boundary", async () => {
  const runId = startRun(agent())
  const { fetch, requests } = scripted([{ text: "never" }])
  expect(requestCancel(db, runId)).toBe("requested")
  expect(await executeRun({ db, secrets, workerId: "w1", fetch }, runId)).toBe("cancelled")
  expect(requests).toHaveLength(0)
  expect(runRow(runId)).toMatchObject({ status: "cancelled", stopReason: "cancelled" })
})

test("the same agent definition runs on two different models", async () => {
  const a = startRun(agent({ model: "openai/gpt-oss-20b" }))
  const first = scripted([{ text: "one" }])
  await executeRun({ db, secrets, workerId: "w1", fetch: first.fetch }, a)
  const b = startRun(agent({ model: "anthropic/claude-haiku-5.5" }))
  const second = scripted([{ text: "two" }])
  await executeRun({ db, secrets, workerId: "w1", fetch: second.fetch }, b)
  expect(first.requests[0]?.model).toBe("openai/gpt-oss-20b")
  expect(second.requests[0]?.model).toBe("anthropic/claude-haiku-5.5")
  expect(runRow(a)?.status).toBe("succeeded")
  expect(runRow(b)?.status).toBe("succeeded")
})
