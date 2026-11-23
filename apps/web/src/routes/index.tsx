import { createFileRoute, useRouter } from "@tanstack/react-router"
import { Button } from "@/components/ui/button"
import { getWorkerStatus } from "@/server/status"

export const Route = createFileRoute("/")({
  loader: () => getWorkerStatus(),
  component: Overview,
})

function Overview() {
  const worker = Route.useLoaderData()
  const router = useRouter()

  return (
    <div className="flex max-w-xl flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">Overview</h1>
        <p className="text-muted-foreground">
          The web process and the worker share one SQLite file.
        </p>
      </div>
      <section className="flex flex-col gap-2 rounded-lg border p-4">
        <div className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className={`size-2 rounded-full ${worker?.alive ? "bg-green-700" : "bg-zinc-400"}`}
          />
          <span className="font-medium">
            {worker?.alive ? "Worker running" : "Worker not running"}
          </span>
        </div>
        {worker ? (
          <dl className="grid grid-cols-[8rem_1fr] gap-1 font-mono text-xs">
            <dt className="text-muted-foreground">pid</dt>
            <dd>{worker.pid}</dd>
            <dt className="text-muted-foreground">started</dt>
            <dd>{new Date(worker.startedAt).toISOString()}</dd>
            <dt className="text-muted-foreground">last heartbeat</dt>
            <dd>{new Date(worker.beatAt).toISOString()}</dd>
          </dl>
        ) : (
          <p className="text-muted-foreground">
            No heartbeat yet. Start both processes with pnpm dev.
          </p>
        )}
        <Button variant="outline" className="self-start" onClick={() => router.invalidate()}>
          Refresh
        </Button>
      </section>
    </div>
  )
}
