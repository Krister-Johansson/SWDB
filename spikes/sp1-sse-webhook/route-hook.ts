import { createHmac, timingSafeEqual } from "node:crypto"
import { createFileRoute } from "@tanstack/react-router"

// Spike SP1: verify an HMAC over the raw request body in a Start server route.
export const Route = createFileRoute("/spike/hook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const raw = await request.text()
        const given = request.headers.get("x-signature") ?? ""
        const expected = createHmac("sha256", "sp1-secret").update(raw).digest("hex")
        const ok =
          given.length === expected.length &&
          timingSafeEqual(Buffer.from(given), Buffer.from(expected))
        return Response.json({ ok, bytes: Buffer.byteLength(raw) }, { status: ok ? 202 : 401 })
      },
    },
  },
})
