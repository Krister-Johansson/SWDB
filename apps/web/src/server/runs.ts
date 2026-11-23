import { createServerFn } from "@tanstack/react-start"

// Handlers import server-only modules lazily, so none of them reach the client bundle.

export const runNowFn = createServerFn({ method: "POST" })
  .validator((data: { agentId: string; prompt: string }) => ({
    agentId: String(data.agentId),
    prompt: String(data.prompt),
  }))
  .handler(async ({ data }) => {
    const { enqueueRun, RunRefusedError } = await import("@swdb/core/runs/queue")
    const { getDb } = await import("./db")
    if (!data.prompt.trim()) return { ok: false as const, message: "Write a prompt for the run" }
    try {
      const runId = enqueueRun(getDb(), {
        agentId: data.agentId,
        source: "manual",
        input: { prompt: data.prompt },
      })
      return { ok: true as const, runId }
    } catch (e) {
      if (e instanceof RunRefusedError) return { ok: false as const, message: e.message }
      throw e
    }
  })

export const cancelRunFn = createServerFn({ method: "POST" })
  .validator((data: { runId: string }) => ({ runId: String(data.runId) }))
  .handler(async ({ data }) => {
    const { requestCancel } = await import("@swdb/core/runs/queue")
    const { getDb } = await import("./db")
    return { result: requestCancel(getDb(), data.runId) }
  })

export const listRunsFn = createServerFn({ method: "GET" }).handler(async () => {
  const { listRuns } = await import("@swdb/core/runs/read")
  const { getDb } = await import("./db")
  return listRuns(getDb())
})

export const getRunFn = createServerFn({ method: "GET" })
  .validator((data: { runId: string }) => ({ runId: String(data.runId) }))
  .handler(async ({ data }) => {
    const { getRunDetail } = await import("@swdb/core/runs/read")
    const { getDb } = await import("./db")
    const detail = getRunDetail(getDb(), data.runId)
    if (!detail) throw new Error("Run not found")
    return detail
  })
