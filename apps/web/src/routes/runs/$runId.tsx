import { createFileRoute, Link, useRouter } from "@tanstack/react-router"
import { useServerFn } from "@tanstack/react-start"
import { useEffect } from "react"
import { formatCost, formatDuration, RunStatus } from "@/components/run-status"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { cancelRunFn, getRunFn } from "@/server/runs"

export const Route = createFileRoute("/runs/$runId")({
  loader: ({ params }) => getRunFn({ data: { runId: params.runId } }),
  component: RunPage,
})

type Event = { seq: number; type: string; payload: Record<string, unknown>; createdAt: number }
type ToolCall = { id: string; function: { name: string; arguments: string } }
type Message = {
  content?: string | null
  toolCalls?: ToolCall[]
  thinking?: { content: string }[]
}

function RunPage() {
  const data = Route.useLoaderData()
  const router = useRouter()
  const cancel = useServerFn(cancelRunFn)
  const { run } = data
  const live = !run.stopReason

  // Poll while the run is in progress. The per-run SSE stream (S6) replaces this.
  useEffect(() => {
    if (!live) return
    const timer = setInterval(() => router.invalidate(), 1000)
    return () => clearInterval(timer)
  }, [live, router])

  const end = data.events.find((e) => e.type === "run_end")?.payload

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <div className="text-muted-foreground text-xs">
            <Link to="/runs" className="hover:underline">
              Runs
            </Link>{" "}
            / {run.id}
          </div>
          <h1 className="flex items-center gap-3 text-xl font-semibold">
            <Link
              to="/agents/$agentId"
              params={{ agentId: run.agentId }}
              className="hover:underline"
            >
              {data.agentName}
            </Link>
            <RunStatus status={run.status} reason={run.stopReason} />
          </h1>
          <div className="text-muted-foreground text-xs">
            version {data.version} · {run.source} · {run.turns} turns · {formatCost(run.costUsd)} ·{" "}
            {run.inputTokens + run.outputTokens} tokens ·{" "}
            {formatDuration(run.startedAt, run.endedAt)}
          </div>
        </div>
        {live && (
          <Button
            variant="destructive"
            onClick={async () => {
              await cancel({ data: { runId: run.id } })
              await router.invalidate()
            }}
            disabled={run.cancelRequestedAt != null}
          >
            {run.cancelRequestedAt ? "Cancelling" : "Cancel run"}
          </Button>
        )}
      </div>

      {run.error && (
        <p className="text-destructive rounded-lg border border-destructive/40 p-3">{run.error}</p>
      )}

      <section className="flex flex-col gap-3">
        <h2 className="font-medium">Transcript</h2>
        <ol className="flex flex-col gap-3">
          {data.events.map((event) => (
            <TranscriptItem key={event.seq} event={event} />
          ))}
          {live && <li className="text-muted-foreground text-xs">Waiting for the worker…</li>}
        </ol>
        {end?.output !== undefined && (
          <div className="rounded-lg border p-4">
            <div className="text-muted-foreground mb-1 text-xs">Final answer</div>
            <div className="whitespace-pre-wrap">{String(end.output)}</div>
          </div>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="font-medium">Model calls</h2>
        {data.modelCalls.length === 0 ? (
          <p className="text-muted-foreground text-xs">None yet.</p>
        ) : (
          data.modelCalls.map((call) => (
            <div key={call.id} className="rounded-lg border p-3 text-xs">
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                <span className="font-medium">Turn {call.turn}</span>
                <span className="font-mono">{call.servedModel ?? call.model}</span>
                {call.provider && <span>via {call.provider}</span>}
                <span>
                  {call.inputTokens} in / {call.outputTokens} out
                  {call.reasoningTokens ? ` / ${call.reasoningTokens} reasoning` : ""}
                </span>
                <span>{formatCost(call.costUsd)}</span>
                {call.finishReason && <span>finish: {call.finishReason}</span>}
                {call.generationId && <span className="font-mono">{call.generationId}</span>}
              </div>
              {call.error && <p className="text-destructive mt-2">{call.error}</p>}
              <Raw label="Request body" value={call.requestBody} />
              <Raw label="Response chunks" value={call.responseBody} />
            </div>
          ))
        )}
      </section>
    </div>
  )
}

function Raw({ label, value }: { label: string; value: unknown }) {
  if (value == null) return null
  return (
    <details className="mt-2">
      <summary className="cursor-pointer select-none">{label}</summary>
      <pre className="bg-muted mt-1 max-h-96 overflow-auto rounded p-2 text-[11px]">
        {JSON.stringify(value, null, 2)}
      </pre>
    </details>
  )
}

function TranscriptItem({ event }: { event: Event }) {
  const p = event.payload
  switch (event.type) {
    case "run_start": {
      const input = p.input as { prompt?: string; payload?: unknown } | undefined
      return (
        <li className="rounded-lg border p-3">
          <div className="text-muted-foreground mb-1 text-xs">
            Prompt{Number(p.attempt) > 1 ? ` · resumed, attempt ${p.attempt}` : ""}
          </div>
          <div className="whitespace-pre-wrap">{input?.prompt}</div>
        </li>
      )
    }
    case "model_response": {
      const message = p.message as Message
      return (
        <li className="bg-muted/40 rounded-lg border p-3">
          <div className="text-muted-foreground mb-1 text-xs">Model</div>
          {message.thinking?.length ? (
            <details className="mb-2 text-xs">
              <summary className="cursor-pointer select-none">Reasoning</summary>
              <div className="text-muted-foreground mt-1 whitespace-pre-wrap">
                {message.thinking.map((t) => t.content).join("\n")}
              </div>
            </details>
          ) : null}
          {message.content && <div className="whitespace-pre-wrap">{message.content}</div>}
          {message.toolCalls?.map((call) => (
            <div key={call.id} className="mt-1 font-mono text-xs">
              → {call.function.name}({call.function.arguments})
            </div>
          ))}
        </li>
      )
    }
    case "tool_end":
      return (
        <li className="rounded-lg border p-3 text-xs">
          <div className="mb-1 flex items-center gap-2">
            <span className="font-mono">{String(p.name)}</span>
            {p.interrupted ? (
              <Badge variant="destructive">interrupted</Badge>
            ) : p.ok ? (
              <Badge variant="secondary">ok</Badge>
            ) : (
              <Badge variant="destructive">error</Badge>
            )}
            {p.durationMs !== undefined && (
              <span className="text-muted-foreground">{String(p.durationMs)} ms</span>
            )}
          </div>
          <pre className="bg-muted max-h-64 overflow-auto rounded p-2 whitespace-pre-wrap">
            {String(p.result)}
          </pre>
        </li>
      )
    case "run_end":
      return (
        <li className="text-muted-foreground text-xs">
          Ended: {String(p.reason)}
          {p.error ? ` · ${String(p.error)}` : ""}
        </li>
      )
    default:
      return null
  }
}
