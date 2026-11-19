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
// A model call is counted where it leaves the process: wrapFetch records every HTTP request
// to OpenRouter, and the checks compare the middleware hooks against those requests.
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
  usage: { iteration: number; tokens: number; cost: number | undefined }[]
  configs: { iteration: number; phase: string; keys: string[]; messages: number | undefined }[]
  // Hooks and HTTP requests in the order they happened.
  order: string[]
  // Every answer of the loop strategy: whether the loop may continue, and what was spent.
  decisions: { proceed: boolean; spent: number; overBudget: boolean }[]
  chunkTypes: Record<string, number>
  abortFired: boolean
  signalAborted: boolean
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
    order: [],
    decisions: [],
    chunkTypes: {},
    abortFired: false,
    signalAborted: false,
    finish: undefined,
    error: undefined,
  }
  let spent = 0
  const abortController = new AbortController()
  const observer: ChatMiddleware = {
    name: "sp4-observer",
    onConfig: (ctx, config) => {
      const c = config as { messages?: unknown[] }
      trace.order.push(`config:${ctx.phase}:${ctx.iteration}`)
      trace.configs.push({
        iteration: ctx.iteration,
        phase: ctx.phase,
        keys: Object.keys(config as object),
        messages: c.messages?.length,
      })
    },
    onUsage: (ctx, usage) => {
      spent += usage.cost ?? 0
      trace.order.push(`usage:${ctx.iteration}`)
      trace.usage.push({
        iteration: ctx.iteration,
        tokens: usage.totalTokens,
        cost: usage.cost,
      })
    },
    onChunk: (_ctx, chunk) => {
      trace.chunkTypes[chunk.type] = (trace.chunkTypes[chunk.type] ?? 0) + 1
      if (options.abortAfterFirstToolCall && chunk.type === "TOOL_CALL_END" && !trace.abortFired) {
        trace.abortFired = true
        abortController.abort()
      }
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
      wrapFetch: (next) => (input, init) => {
        trace.order.push("request")
        return next(input, init)
      },
      agentLoopStrategy: (state) => {
        const overBudget = options.budget !== undefined && spent > options.budget
        const proceed = maxIterations(8)(state) && !overBudget
        trace.decisions.push({ proceed, spent, overBudget })
        return proceed
      },
    })) {
      if ("finishReason" in chunk) trace.finish = String(chunk.finishReason)
    }
  } catch (error) {
    // A thrown value that is not an Error gets its own name, so it cannot pass as a clean exit.
    trace.error = error instanceof Error ? error.name : "NonErrorThrown"
  }
  trace.signalAborted = abortController.signal.aborted
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
const abortedCalls = [...calls]

const reasoningChunks = Object.keys(full.chunkTypes).filter((t) => t.startsWith("REASONING"))
const requests = (t: Trace) => t.order.filter((o) => o === "request").length
// For every HTTP request: the last hook before it is a beforeModel config, and the next
// usage record after it comes before the following request.
function everyRequestHasConfigAndUsage(t: Trace): boolean {
  const at = t.order.flatMap((o, i) => (o === "request" ? [i] : []))
  return at.every((i, n) => {
    const before = t.order[i - 1] ?? ""
    const until = at[n + 1] ?? t.order.length
    const usage = t.order.slice(i + 1, until).filter((o) => o.startsWith("usage:"))
    return before.startsWith("config:beforeModel:") && usage.length === 1
  })
}
const iterations = full.usage.map((u) => u.iteration)
const lastBudgetDecision = budget.decisions.at(-1)
const checks = {
  "1 usage with cost once per model call":
    requests(full) === 3 &&
    full.usage.length === requests(full) &&
    new Set(iterations).size === iterations.length &&
    full.usage.every((u) => typeof u.cost === "number" && u.cost > 0),
  "2 request config visible before every model call":
    everyRequestHasConfigAndUsage(full) &&
    full.configs.filter((c) => c.phase === "beforeModel").every((c) => c.messages !== undefined),
  "3 reasoning chunks seen and both tools ran in order":
    reasoningChunks.length > 0 &&
    fullCalls.join("|") === "lookup_order 4471|carrier_status postnord 4471",
  // The first model call asked for a tool, so work was pending, and the strategy then
  // refused to continue because the spend was over the budget.
  "4 cost budget stops the loop after the first model call":
    requests(budget) === 1 &&
    budget.usage.length === 1 &&
    budgetCalls.join("|") === "lookup_order 4471" &&
    budget.error === undefined &&
    lastBudgetDecision?.proceed === false &&
    lastBudgetDecision.overBudget === true,
  // The abort fired on the first tool call chunk. The run then ended quietly or with an
  // AbortError and nothing else, made no further model call, ran no tool and produced no
  // tool result. The full and budget runs must end without any error.
  "5 abort stops the run":
    aborted.abortFired &&
    aborted.signalAborted &&
    (aborted.error === undefined || aborted.error === "AbortError") &&
    requests(aborted) === 1 &&
    abortedCalls.length === 0 &&
    aborted.chunkTypes.TOOL_CALL_RESULT === undefined &&
    full.error === undefined &&
    !full.signalAborted,
}

console.log(
  JSON.stringify(
    {
      full,
      fullCalls,
      budget: {
        usage: budget.usage,
        calls: budgetCalls,
        decisions: budget.decisions,
        order: budget.order,
        finish: budget.finish,
      },
      aborted: {
        abortFired: aborted.abortFired,
        signalAborted: aborted.signalAborted,
        chunkTypes: aborted.chunkTypes,
        usage: aborted.usage,
        calls: abortedCalls,
        order: aborted.order,
        error: aborted.error,
        finish: aborted.finish,
      },
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
