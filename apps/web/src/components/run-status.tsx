import { Badge } from "@/components/ui/badge"

const variants: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  queued: "outline",
  running: "default",
  waiting_human: "default",
  succeeded: "secondary",
  failed: "destructive",
  cancelled: "outline",
}

export function RunStatus({ status, reason }: { status: string; reason?: string | null }) {
  const label = status === "failed" && reason && reason !== "error" ? `failed: ${reason}` : status
  return <Badge variant={variants[status] ?? "outline"}>{label.replace("_", " ")}</Badge>
}

export function formatCost(usd: number): string {
  if (usd === 0) return "$0"
  return usd < 0.01 ? `$${usd.toFixed(5)}` : `$${usd.toFixed(2)}`
}

export function formatDuration(start: number | null, end: number | null): string {
  if (!start) return "not started"
  const ms = (end ?? Date.now()) - start
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`
}
