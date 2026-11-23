import { createFileRoute, Link } from "@tanstack/react-router"
import { Badge } from "@/components/ui/badge"
import { buttonVariants } from "@/components/ui/button"
import { listAgentsFn } from "@/server/agents"

export const Route = createFileRoute("/agents/")({
  loader: () => listAgentsFn(),
  component: AgentsPage,
})

function AgentsPage() {
  const agents = Route.useLoaderData()
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Agents</h1>
        <Link to="/agents/new" className={buttonVariants()}>
          New agent
        </Link>
      </div>
      {agents.length === 0 ? (
        <p className="text-muted-foreground">No agents yet.</p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {agents.map((agent) => (
            <li key={agent.id}>
              <Link
                to="/agents/$agentId"
                params={{ agentId: agent.id }}
                className="flex items-center justify-between gap-4 px-4 py-3 hover:bg-muted"
              >
                <div>
                  <div className="font-medium">{agent.name}</div>
                  <div className="text-muted-foreground text-xs">
                    <span className="font-mono">{agent.model}</span> · version{" "}
                    {agent.currentVersion}
                    {agent.description && <> · {agent.description}</>}
                  </div>
                </div>
                {agent.pausedReason ? (
                  <Badge variant="destructive">paused</Badge>
                ) : agent.enabled ? (
                  <Badge variant="secondary">on</Badge>
                ) : (
                  <Badge variant="outline">off</Badge>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
