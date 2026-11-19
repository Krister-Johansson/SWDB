import { appendFileSync } from "node:fs"
import { createFileRoute } from "@tanstack/react-router"

// Spike SP1: Server-Sent Events from a Start server route.
export const Route = createFileRoute("/spike/sse")({
  server: {
    handlers: {
      GET: ({ request }) => {
        const last = Number(request.headers.get("last-event-id") ?? 0)
        const encoder = new TextEncoder()
        let seq = last
        let timer: ReturnType<typeof setInterval> | undefined
        const log = (line: string) => {
          if (process.env.SP1_LOG) appendFileSync(process.env.SP1_LOG, `${line}\n`)
        }
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            timer = setInterval(() => {
              seq++
              controller.enqueue(
                encoder.encode(`id: ${seq}\ndata: {"seq":${seq},"t":${Date.now()}}\n\n`),
              )
            }, 200)
            request.signal.addEventListener("abort", () => {
              clearInterval(timer)
              log(`abort-signal after seq ${seq}`)
              try {
                controller.close()
              } catch {}
            })
          },
          cancel() {
            clearInterval(timer)
            log(`stream-cancel after seq ${seq}`)
          },
        })
        return new Response(stream, {
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache, no-transform",
            connection: "keep-alive",
          },
        })
      },
    },
  },
})
