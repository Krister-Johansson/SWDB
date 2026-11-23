import type { AgentInput } from "@swdb/core/agents"
import { createServerFn } from "@tanstack/react-start"

// Handlers import their server-only modules lazily, so none of them reach the client bundle.

export const listAgentsFn = createServerFn({ method: "GET" }).handler(async () => {
  const { listAgents } = await import("@swdb/core/agents")
  const { getDb } = await import("./db")
  return listAgents(getDb())
})

export const getAgentEditorFn = createServerFn({ method: "GET" })
  .validator((data: { agentId?: string }) => ({ agentId: data.agentId }))
  .handler(async ({ data }) => {
    const core = await import("@swdb/core/agents")
    const { getDb } = await import("./db")
    const db = getDb()
    const selectable = core.listSelectable(db)
    if (!data.agentId)
      return { agent: null, input: core.emptyAgentInput(), versions: [], selectable }
    const loaded = core.getAgent(db, data.agentId)
    if (!loaded) throw new Error("Agent not found")
    const versions = core.listAgentVersions(db, data.agentId).map((v) => ({
      id: v.id,
      version: v.version,
      createdAt: v.createdAt,
      model: String(v.definition.model),
    }))
    return { agent: loaded.agent, input: loaded.input, versions, selectable }
  })

/** Tool-capable OpenRouter models. Empty when the API cannot be reached. */
export const listModelsFn = createServerFn({ method: "GET" }).handler(async () => {
  const { fetchToolModels } = await import("@swdb/core/models")
  try {
    return { models: await fetchToolModels(), error: null }
  } catch (e) {
    return { models: [], error: e instanceof Error ? e.message : String(e) }
  }
})

export type SaveAgentResult =
  | { ok: true; agentId: string; version: number }
  | { ok: false; field: string; message: string }

export const saveAgentFn = createServerFn({ method: "POST" })
  .validator((data: { agentId?: string; input: AgentInput }) => data)
  .handler(async ({ data }): Promise<SaveAgentResult> => {
    const core = await import("@swdb/core/agents")
    const { fetchToolModels } = await import("@swdb/core/models")
    const { getDb } = await import("./db")
    const db = getDb()
    // Refuse a model without tool support. If OpenRouter cannot be reached, the slug check
    // in normalizeAgentInput still applies and the run fails later with a clear error.
    const models = await fetchToolModels().catch(() => null)
    if (models && !models.some((m) => m.id === data.input.model.trim())) {
      return {
        ok: false,
        field: "model",
        message: "Pick a model from the list: it must support tools and tool_choice",
      }
    }
    try {
      if (data.agentId) {
        const version = core.updateAgent(db, data.agentId, data.input)
        return { ok: true, agentId: data.agentId, version }
      }
      return { ok: true, agentId: core.createAgent(db, data.input), version: 1 }
    } catch (e) {
      if (e instanceof core.AgentValidationError)
        return { ok: false, field: e.field, message: e.message }
      throw e
    }
  })

export const setAgentEnabledFn = createServerFn({ method: "POST" })
  .validator((data: { agentId: string; enabled: boolean }) => data)
  .handler(async ({ data }) => {
    const { setAgentEnabled } = await import("@swdb/core/agents")
    const { getDb } = await import("./db")
    setAgentEnabled(getDb(), data.agentId, data.enabled)
    return { ok: true }
  })
