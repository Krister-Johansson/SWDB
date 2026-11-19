// Spike SP1 client. Run: node spikes/sp1-sse-webhook/client.ts http://127.0.0.1:4100 <server log file>
import { createHmac, randomUUID } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"

const base = process.argv[2] ?? "http://127.0.0.1:4100"
const logFile = process.argv[3]
const results: Record<string, unknown> = {}
const readLog = () =>
  logFile && existsSync(logFile) ? readFileSync(logFile, "utf8").split("\n").filter(Boolean) : []
// Lines already in the server log belong to earlier runs and do not count.
const logBaseline = readLog().length

async function readEvents(headers: Record<string, string>, count: number) {
  const controller = new AbortController()
  const requestId = randomUUID()
  const res = await fetch(`${base}/spike/sse`, {
    headers: { ...headers, "x-sp1-request": requestId },
    signal: controller.signal,
  })
  if (!res.body) throw new Error("The SSE response has no body")
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  const arrivals: number[] = []
  const ids: number[] = []
  // A read can end inside a frame or hold several frames, so frames are cut at the blank
  // line and each complete frame gets its own arrival time. Two frames in one read give a
  // gap of about 0 ms, which fails the unbuffered check.
  let pending = ""
  while (ids.length < count) {
    const { value, done } = await reader.read()
    if (done) break
    pending += decoder.decode(value, { stream: true })
    const frames = pending.split("\n\n")
    pending = frames.pop() ?? ""
    for (const frame of frames) {
      const id = frame.match(/^id: (\d+)$/m)
      if (!id) continue
      ids.push(Number(id[1]))
      arrivals.push(performance.now())
    }
  }
  controller.abort()
  const gaps = arrivals.slice(1).map((t, i) => Math.round(t - arrivals[i]))
  return {
    requestId,
    status: res.status,
    type: res.headers.get("content-type"),
    encoding: res.headers.get("content-encoding"),
    ids,
    gaps,
  }
}

const first = await readEvents({ accept: "text/event-stream", "accept-encoding": "gzip, br" }, 6)
results.contentType = first.type
results.contentEncoding = first.encoding
results.firstIds = first.ids
results.chunkGapsMs = first.gaps
// Unbuffered means events arrive one at a time, about 200 ms apart.
results.unbuffered = first.gaps.length >= 5 && first.gaps.every((g) => g > 100 && g < 400)
results.uncompressed = first.encoding === null

const resumed = await readEvents({ accept: "text/event-stream", "last-event-id": "41" }, 3)
results.resumedIds = resumed.ids
results.resumeOk = resumed.ids[0] === 42

await new Promise((r) => setTimeout(r, 600))
if (logFile) {
  // Each of the two requests above must have fired request.signal exactly once: a
  // stream-cancel line does not prove that. Lines are matched on the request id, so other
  // clients of the same server cannot satisfy the check.
  const log = readLog().slice(logBaseline)
  results.serverLog = log
  results.disconnectSeen = [first, resumed].every(
    (r) => log.filter((line) => line.startsWith(`abort-signal ${r.requestId} `)).length === 1,
  )
}

const body = JSON.stringify({ action: "opened", number: 218, note: "åäö   spacing  kept" })
const sig = createHmac("sha256", "sp1-secret").update(body).digest("hex")
const good = await fetch(`${base}/spike/hook`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-signature": sig },
  body,
})
const bad = await fetch(`${base}/spike/hook`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-signature": sig },
  body: `${body} `,
})
results.hookGood = [good.status, await good.json()]
results.hookTampered = bad.status
results.hmacOk = good.status === 202 && bad.status === 401

console.log(JSON.stringify(results, null, 1))
const pass =
  results.unbuffered &&
  results.uncompressed &&
  results.resumeOk &&
  results.hmacOk &&
  (logFile ? results.disconnectSeen : true)
console.log(pass ? "PASS" : "FAIL")
