import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useServerFn } from "@tanstack/react-start"
import { AgentForm } from "@/components/agent-form"
import { getAgentEditorFn, listModelsFn, saveAgentFn } from "@/server/agents"

export const Route = createFileRoute("/agents/new")({
  loader: async () => {
    const [editor, models] = await Promise.all([getAgentEditorFn({ data: {} }), listModelsFn()])
    return { editor, models }
  },
  component: NewAgentPage,
})

function NewAgentPage() {
  const { editor, models } = Route.useLoaderData()
  const save = useServerFn(saveAgentFn)
  const navigate = useNavigate()
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold">New agent</h1>
      <AgentForm
        initial={editor.input}
        models={models.models}
        modelsError={models.error}
        selectable={editor.selectable}
        submitLabel="Create agent"
        onSubmit={async (input) => {
          const result = await save({ data: { input } })
          if (!result.ok) return result
          await navigate({ to: "/agents/$agentId", params: { agentId: result.agentId } })
          return null
        }}
      />
    </div>
  )
}
