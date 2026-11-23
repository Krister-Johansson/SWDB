import { createFileRoute, useRouter } from "@tanstack/react-router"
import { useServerFn } from "@tanstack/react-start"
import { useState } from "react"
import { AgentForm } from "@/components/agent-form"
import { RunNow } from "@/components/run-now"
import { getAgentEditorFn, listModelsFn, saveAgentFn } from "@/server/agents"

export const Route = createFileRoute("/agents/$agentId")({
  loader: async ({ params }) => {
    const [editor, models] = await Promise.all([
      getAgentEditorFn({ data: { agentId: params.agentId } }),
      listModelsFn(),
    ])
    return { editor, models }
  },
  component: AgentPage,
})

function AgentPage() {
  const { editor, models } = Route.useLoaderData()
  const { agentId } = Route.useParams()
  const save = useServerFn(saveAgentFn)
  const router = useRouter()
  const [saved, setSaved] = useState<number | null>(null)
  if (!editor.agent) return null

  return (
    <div className="grid gap-8 md:grid-cols-[1fr_18rem]">
      <div className="flex flex-col gap-6">
        <div>
          <h1 className="text-xl font-semibold">{editor.agent.name}</h1>
          {editor.agent.pausedReason && (
            <p className="text-destructive">Paused: {editor.agent.pausedReason}</p>
          )}
        </div>
        <AgentForm
          key={editor.agent.currentVersion}
          initial={editor.input}
          models={models.models}
          modelsError={models.error}
          selectable={editor.selectable}
          submitLabel="Save new version"
          onSubmit={async (input) => {
            const result = await save({ data: { agentId, input } })
            if (!result.ok) return result
            setSaved(result.version)
            await router.invalidate()
            return null
          }}
        />
        {saved && <p className="text-muted-foreground">Saved as version {saved}.</p>}
      </div>
      <aside className="flex flex-col gap-4">
        <RunNow
          agentId={agentId}
          disabled={
            editor.agent.pausedReason
              ? `Paused: ${editor.agent.pausedReason}`
              : editor.agent.enabled
                ? null
                : "The agent is turned off."
          }
        />
        <h2 className="font-medium">Versions</h2>
        <ol className="divide-y rounded-lg border text-xs">
          {editor.versions.map((v) => (
            <li key={v.id} className="px-3 py-2">
              <div className="font-medium">Version {v.version}</div>
              <div className="text-muted-foreground font-mono">{v.model}</div>
              <div className="text-muted-foreground">{new Date(v.createdAt).toLocaleString()}</div>
            </li>
          ))}
        </ol>
      </aside>
    </div>
  )
}
