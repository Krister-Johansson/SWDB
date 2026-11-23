import { useNavigate } from "@tanstack/react-router"
import { useServerFn } from "@tanstack/react-start"
import { useId, useState } from "react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { runNowFn } from "@/server/runs"

export function RunNow({ agentId, disabled }: { agentId: string; disabled?: string | null }) {
  const run = useServerFn(runNowFn)
  const navigate = useNavigate()
  const id = useId()
  const [prompt, setPrompt] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const result = await run({ data: { agentId, prompt } })
      if (!result.ok) return setError(result.message)
      await navigate({ to: "/runs/$runId", params: { runId: result.runId } })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form method="post" onSubmit={submit} className="flex flex-col gap-2 rounded-lg border p-4">
      <Label htmlFor={`${id}-prompt`} className="font-medium">
        Run now
      </Label>
      <Textarea
        id={`${id}-prompt`}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        rows={3}
        placeholder="What should the agent do?"
      />
      {disabled && <p className="text-muted-foreground text-xs">{disabled}</p>}
      {error && <p className="text-destructive text-xs">{error}</p>}
      <Button type="submit" className="self-start" disabled={busy || Boolean(disabled)}>
        {busy ? "Queueing" : "Run now"}
      </Button>
    </form>
  )
}
