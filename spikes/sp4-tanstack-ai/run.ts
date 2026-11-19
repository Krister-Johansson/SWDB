// Spike SP4: can TanStack AI carry the SWDB agent loop on OpenRouter?
// Run from the repo root, with OPENROUTER_API_KEY in .env:
//   pnpm --filter sp4-tanstack-ai spike
// Optional: SP4_MODEL=<openrouter slug> to pick the model.
//
// The docs already confirm stop conditions, abort, persisted approvals and MCP tools.
// This run checks the parts that need a live call:
//   1. usage and cost reported once per model call (needed for a cost budget between calls)
//   2. the request config of every model call is visible before it is sent
//   3. reasoning chunks arrive and the loop keeps working on a reasoning model
//   4. a custom strategy can stop the loop on an accumulated cost budget
//   5. an abort stops a run that is in progress
import { type ChatMiddleware, chat, maxIterations, toolDefinition } from "@tanstack/ai"
import { openRouterText } from "@tanstack/ai-openrouter"
import { z } from "zod"

if (!process.env.OPENROUTER_API_KEY) {
  console.error("OPENROUTER_API_KEY is not set. Add it to .env in the repo root.")
  process.exit(2)
}

type Model = { id: string; supported_parameters?: string[]; pricing?: { prompt?: string } }

async function pickModel(): Promise<string> {
  if (process.env.SP4_MODEL) return process.env.SP4_MODEL
  const res = await fetch("https://openrouter.ai/api/v1/models")
  const { data } = (await res.json()) as { data: Model[] }
  const ok = data
    .filter((m) => /^(openai|anthropic|google)\//.test(m.id))
    .filter((m) =>
      ["tools", "tool_choice", "reasoning"].every((p) => m.supported_parameters?.includes(p)),
    )
    .map((m) => ({ id: m.id, price: Number(m.pricing?.prompt ?? 0) }))
    .filter((m) => m.price > 0)
    .sort((a, b) => a.price - b.price)
  if (!ok[0]) throw new Error("No model with tools and reasoning found. Set SP4_MODEL.")
  return ok[0].id
}

const model = await pickModel()
const calls: string[] = []

const lookupOrder = toolDefinition({
  name: "lookup_order",
  description: "Look up an order by its number",
  inputSchema: z.object({ orderNumber: z.string() }),
}).server(({ orderNumber }) => {
  calls.push(`lookup_order ${orderNumber}`)
  return { orderNumber, status: "delayed", carrier: "postnord" }
})

const carrierStatus = toolDefinition({
  name: "carrier_status",
  description: "Get the delivery estimate from a carrier for an order",
  inputSchema: z.object({ carrier: z.string(), orderNumber: z.string() }),
}).server(({ carrier, orderNumber }) => {
  calls.push(`carrier_status ${carrier} ${orderNumber}`)
  return { estimate: "2026-11-24" }
})

const prompt =
  "Order 4471: first look it up, then ask its carrier for the delivery estimate, then answer in one sentence. Use the tools one at a time."

type Trace = {
  usage: { iteration: unknown; tokens: number; cost: number | undefined }[]
  configs: { iteration: unknown; phase: unknown; keys: string[]; messages: number | undefined }[]
  chunkTypes: Record<string, number>
  finish: string | undefined
  error: string | undefined
}

async function run(options: {
  budget?: number
  abortAfterFirstToolCall?: boolean
}): Promise<Trace> {
  const trace: Trace = {
    usage: [],
    configs: [],
    chunkTypes: {},
    finish: undefined,
    error: undefined,
  }
  let spent = 0
  const abortController = new AbortController()
  const observer: ChatMiddleware = {
    name: "sp4-observer",
    onConfig: (ctx, config) => {
      const c = config as { messages?: unknown[] }
      trace.configs.push({
        iteration: (ctx as { iteration?: unknown }).iteration,
        phase: (ctx as { phase?: unknown }).phase,
        keys: Object.keys(config as object),
        messages: c.messages?.length,
      })
    },
    onUsage: (ctx, usage) => {
      spent += usage.cost ?? 0
      trace.usage.push({
        iteration: (ctx as { iteration?: unknown }).iteration,
        tokens: usage.totalTokens,
        cost: usage.cost,
      })
    },
    onChunk: (_ctx, chunk) => {
      trace.chunkTypes[chunk.type] = (trace.chunkTypes[chunk.type] ?? 0) + 1
      if (options.abortAfterFirstToolCall && chunk.type === "TOOL_CALL_END") abortController.abort()
    },
  }
  try {
    for await (const chunk of chat({
      adapter: openRouterText(model as Parameters<typeof openRouterText>[0]),
      messages: [{ role: "user", content: prompt }],
      threadId: `sp4-${Date.now()}`,
      tools: [lookupOrder, carrierStatus],
      middleware: [observer],
      abortController,
      agentLoopStrategy: (state) =>
        maxIterations(8)(state) && (options.budget === undefined || spent <= options.budget),
    })) {
      if ("finishReason" in chunk) trace.finish = String(chunk.finishReason)
    }
  } catch (error) {
    trace.error = (error as Error).name
  }
  return trace
}

console.log(`model: ${model}`)

const full = await run({})
const fullCalls = [...calls]
calls.length = 0
const budget = await run({ budget: 0 })
const budgetCalls = [...calls]
calls.length = 0
const aborted = await run({ abortAfterFirstToolCall: true })

const reasoningChunks = Object.keys(full.chunkTypes).filter((t) => t.startsWith("REASONING"))
const checks = {
  "1 usage with cost once per model call":
    full.usage.length >= 3 && full.usage.every((u) => typeof u.cost === "number"),
  "2 request config visible before every model call":
    full.configs.filter((c) => c.messages !== undefined).length >= full.usage.length,
  "3 reasoning chunks seen and both tools ran in order":
    reasoningChunks.length > 0 &&
    fullCalls.length === 2 &&
    fullCalls[0]?.startsWith("lookup_order"),
  "4 cost budget stops the loop after the first model call":
    budget.usage.length === 1 && budgetCalls.length <= 1,
  "5 abort stops the run": aborted.usage.length < full.usage.length,
}

console.log(
  JSON.stringify(
    {
      full,
      fullCalls,
      budget: { usage: budget.usage, calls: budgetCalls, finish: budget.finish },
      aborted: { usage: aborted.usage, error: aborted.error, finish: aborted.finish },
      reasoningChunks,
    },
    null,
    1,
  ),
)
console.table(checks)
const spentTotal = [...full.usage, ...budget.usage, ...aborted.usage].reduce(
  (s, u) => s + (u.cost ?? 0),
  0,
)
console.log(`total cost of this spike run: $${spentTotal.toFixed(5)}`)
console.log(Object.values(checks).every(Boolean) ? "PASS" : "FAIL")
