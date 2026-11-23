import type { AgentInput } from "@swdb/core/agents"
import type { ToolModel } from "@swdb/core/models"
import { useId, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"

type Selectable = {
  skills: { id: string; name: string; description: string; hasScripts: boolean }[]
  mcpTools: { id: string; name: string; description: string; server: string }[]
  commands: { id: string; name: string; description: string }[]
}

type Props = {
  initial: AgentInput
  models: ToolModel[]
  modelsError: string | null
  selectable: Selectable
  submitLabel: string
  onSubmit: (input: AgentInput) => Promise<{ field: string; message: string } | null>
}

const limitFields = [
  { key: "maxTurns", label: "Max turns", step: "1" },
  { key: "maxCostUsd", label: "Max cost per run (USD)", step: "0.01" },
  { key: "timeoutMs", label: "Timeout (ms)", step: "1000" },
  { key: "dailyCostCapUsd", label: "Daily cost cap (USD)", step: "0.01" },
  { key: "maxConcurrentRuns", label: "Concurrent runs", step: "1" },
] as const

export function AgentForm({
  initial,
  models,
  modelsError,
  selectable,
  submitLabel,
  onSubmit,
}: Props) {
  const [input, setInput] = useState<AgentInput>(initial)
  const [error, setError] = useState<{ field: string; message: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const id = useId()
  const set = <K extends keyof AgentInput>(key: K, value: AgentInput[K]) =>
    setInput((prev) => ({ ...prev, [key]: value }))
  const model = models.find((m) => m.id === input.model)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setSaving(true)
    setError(null)
    try {
      setError(await onSubmit(input))
    } catch (e) {
      setError({ field: "form", message: e instanceof Error ? e.message : String(e) })
    } finally {
      setSaving(false)
    }
  }

  const fieldError = (field: string) =>
    error?.field === field ? <p className="text-destructive text-xs">{error.message}</p> : null

  return (
    <form method="post" onSubmit={submit} className="grid max-w-2xl gap-5">
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-name`}>Name</Label>
        <Input
          id={`${id}-name`}
          value={input.name}
          onChange={(e) => set("name", e.target.value)}
          required
        />
        {fieldError("name")}
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-description`}>Description</Label>
        <Input
          id={`${id}-description`}
          value={input.description}
          onChange={(e) => set("description", e.target.value)}
        />
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-model`}>Model</Label>
        <Input
          id={`${id}-model`}
          list={`${id}-models`}
          value={input.model}
          onChange={(e) => set("model", e.target.value)}
          placeholder="Type to search, such as openai/gpt-oss-20b"
          autoComplete="off"
          required
        />
        <datalist id={`${id}-models`}>
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </datalist>
        <p className="text-muted-foreground text-xs">
          {modelsError
            ? `Could not load the OpenRouter model list (${modelsError}). Enter a model slug.`
            : model
              ? `${model.name}. $${model.promptPrice.toFixed(2)} in, $${model.completionPrice.toFixed(2)} out per million tokens. ${model.contextLength.toLocaleString()} token context.`
              : `${models.length} OpenRouter models support tools and tool_choice.`}
        </p>
        {fieldError("model")}
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-instructions`}>Instructions</Label>
        <Textarea
          id={`${id}-instructions`}
          value={input.instructions}
          onChange={(e) => set("instructions", e.target.value)}
          rows={8}
          className="font-mono text-xs"
        />
      </div>

      <fieldset className="grid gap-3 rounded-lg border p-4">
        <legend className="px-1 font-medium">Limits</legend>
        <p className="text-muted-foreground text-xs">Leave a field empty to use no limit.</p>
        <div className="grid grid-cols-2 gap-3">
          {limitFields.map((f) => (
            <div key={f.key} className="grid gap-1.5">
              <Label htmlFor={`${id}-${f.key}`}>{f.label}</Label>
              <Input
                id={`${id}-${f.key}`}
                type="number"
                min="0"
                step={f.step}
                value={input.limits[f.key] ?? ""}
                onChange={(e) =>
                  set("limits", {
                    ...input.limits,
                    [f.key]: e.target.value === "" ? undefined : Number(e.target.value),
                  })
                }
              />
              {fieldError(`limits.${f.key}`)}
            </div>
          ))}
        </div>
      </fieldset>

      <fieldset className="grid gap-2 rounded-lg border p-4">
        <legend className="px-1 font-medium">MCP tools</legend>
        {selectable.mcpTools.length === 0 ? (
          <p className="text-muted-foreground text-xs">No MCP servers are connected yet.</p>
        ) : (
          selectable.mcpTools.map((tool) => {
            const selected = input.mcpTools.find((t) => t.toolId === tool.id)
            return (
              <div key={tool.id} className="flex items-center justify-between gap-3">
                <span>
                  <span className="font-mono">{tool.server}</span> / {tool.name}
                </span>
                <select
                  aria-label={`${tool.server} ${tool.name}`}
                  className="rounded border bg-background px-2 py-1 text-xs"
                  value={selected?.effect ?? "off"}
                  onChange={(e) => {
                    const rest = input.mcpTools.filter((t) => t.toolId !== tool.id)
                    const effect = e.target.value
                    set(
                      "mcpTools",
                      effect === "off"
                        ? rest
                        : [
                            ...rest,
                            { toolId: tool.id, effect: effect as "allow" | "ask" | "deny" },
                          ],
                    )
                  }}
                >
                  <option value="off">Off</option>
                  <option value="allow">Allow</option>
                  <option value="ask">Ask first</option>
                </select>
              </div>
            )
          })
        )}
      </fieldset>

      <CheckList
        legend="Skills"
        empty="No skills are installed yet."
        items={selectable.skills.map((s) => ({
          id: s.id,
          label: s.name,
          note: s.hasScripts ? "has scripts, needs shell access" : s.description,
        }))}
        selected={input.skillIds}
        onChange={(ids) => set("skillIds", ids)}
      />

      <CheckList
        legend="Commands"
        empty="No commands are defined yet."
        items={selectable.commands.map((c) => ({ id: c.id, label: c.name, note: c.description }))}
        selected={input.commandIds}
        onChange={(ids) => set("commandIds", ids)}
      />

      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={input.enabled}
          onChange={(e) => set("enabled", e.target.checked)}
        />
        Enabled
      </label>

      {error && !error.field.startsWith("limits.") && !["name", "model"].includes(error.field) && (
        <p className="text-destructive">{error.message}</p>
      )}
      <Button type="submit" className="self-start" disabled={saving}>
        {saving ? "Saving" : submitLabel}
      </Button>
    </form>
  )
}

function CheckList(props: {
  legend: string
  empty: string
  items: { id: string; label: string; note: string }[]
  selected: string[]
  onChange: (ids: string[]) => void
}) {
  return (
    <fieldset className="grid gap-2 rounded-lg border p-4">
      <legend className="px-1 font-medium">{props.legend}</legend>
      {props.items.length === 0 ? (
        <p className="text-muted-foreground text-xs">{props.empty}</p>
      ) : (
        props.items.map((item) => (
          <label key={item.id} className="flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-1"
              checked={props.selected.includes(item.id)}
              onChange={(e) =>
                props.onChange(
                  e.target.checked
                    ? [...props.selected, item.id]
                    : props.selected.filter((id) => id !== item.id),
                )
              }
            />
            <span>
              <span className="font-mono">{item.label}</span>
              {item.note && (
                <span className="text-muted-foreground block text-xs">{item.note}</span>
              )}
            </span>
          </label>
        ))
      )}
    </fieldset>
  )
}
