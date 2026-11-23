import { createFileRoute, Link, useRouter } from "@tanstack/react-router"
import { useEffect } from "react"
import { formatCost, formatDuration, RunStatus } from "@/components/run-status"
import { listRunsFn } from "@/server/runs"

export const Route = createFileRoute("/runs/")({
  loader: () => listRunsFn(),
  component: RunsPage,
})

function RunsPage() {
  const runs = Route.useLoaderData()
  const router = useRouter()
  const live = runs.some((r) => !r.stopReason)
  // Poll while any run is in progress. The app-wide SSE stream (M21) replaces this.
  useEffect(() => {
    if (!live) return
    const timer = setInterval(() => router.invalidate(), 1500)
    return () => clearInterval(timer)
  }, [live, router])

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold">Runs</h1>
      {runs.length === 0 ? (
        <p className="text-muted-foreground">No runs yet. Open an agent and press Run now.</p>
      ) : (
        <table className="w-full text-left">
          <thead className="text-muted-foreground text-xs">
            <tr>
              <th className="py-2 font-normal">Agent</th>
              <th className="py-2 font-normal">Status</th>
              <th className="py-2 font-normal">Source</th>
              <th className="py-2 text-right font-normal">Turns</th>
              <th className="py-2 text-right font-normal">Cost</th>
              <th className="py-2 text-right font-normal">Duration</th>
              <th className="py-2 text-right font-normal">Queued</th>
            </tr>
          </thead>
          <tbody className="divide-y border-t">
            {runs.map((run) => (
              <tr key={run.id} className="hover:bg-muted">
                <td className="py-2">
                  <Link
                    to="/runs/$runId"
                    params={{ runId: run.id }}
                    className="font-medium hover:underline"
                  >
                    {run.agentName}
                  </Link>
                </td>
                <td className="py-2">
                  <RunStatus status={run.status} reason={run.stopReason} />
                </td>
                <td className="py-2">{run.source}</td>
                <td className="py-2 text-right tabular-nums">{run.turns}</td>
                <td className="py-2 text-right tabular-nums">{formatCost(run.costUsd)}</td>
                <td className="py-2 text-right tabular-nums">
                  {formatDuration(run.startedAt, run.endedAt)}
                </td>
                <td className="text-muted-foreground py-2 text-right">
                  {new Date(run.queuedAt).toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
