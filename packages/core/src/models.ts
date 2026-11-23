/** A model the agent editor may offer: OpenRouter lists both `tools` and `tool_choice` for it. */
export type ToolModel = {
  id: string
  name: string
  contextLength: number
  /** USD per million tokens. */
  promptPrice: number
  completionPrice: number
}

type OpenRouterModel = {
  id: string
  name?: string
  context_length?: number
  pricing?: { prompt?: string; completion?: string }
  supported_parameters?: string[]
}

const MODELS_URL = "https://openrouter.ai/api/v1/models"
const TTL_MS = 60 * 60 * 1000

/** Keeps the models that support tools and tool_choice, sorted by id. */
export function toolModels(data: OpenRouterModel[]): ToolModel[] {
  return data
    .filter((m) => {
      const params = new Set(m.supported_parameters ?? [])
      return params.has("tools") && params.has("tool_choice")
    })
    .map((m) => ({
      id: m.id,
      name: m.name ?? m.id,
      contextLength: m.context_length ?? 0,
      promptPrice: Number(m.pricing?.prompt ?? 0) * 1_000_000,
      completionPrice: Number(m.pricing?.completion ?? 0) * 1_000_000,
    }))
    .sort((a, b) => a.id.localeCompare(b.id))
}

let cache: { at: number; models: ToolModel[] } | null = null

/**
 * The OpenRouter model list, filtered to tool-capable models and cached for an hour.
 * The endpoint is public and needs no API key.
 */
export async function fetchToolModels(fetchImpl: typeof fetch = fetch): Promise<ToolModel[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.models
  const response = await fetchImpl(MODELS_URL, { signal: AbortSignal.timeout(10_000) })
  if (!response.ok) throw new Error(`OpenRouter models API returned ${response.status}`)
  const body = (await response.json()) as { data: OpenRouterModel[] }
  cache = { at: Date.now(), models: toolModels(body.data) }
  return cache.models
}
