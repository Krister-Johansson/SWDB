// Spike SP1 client. Run: node spikes/sp1-sse-webhook/client.ts http://127.0.0.1:4100 <server log file>
import { createHmac } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"

const base = process.argv[2] ?? "http://127.0.0.1:4100"
const logFile = process.argv[3]
const results: Record<string, unknown> = {}

async function readEvents(headers: Record<string, string>, count: number) {
  const controller = new AbortController()
  const res = await fetch(`${base}/spike/sse`, { headers, signal: controller.signal })
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  const arrivals: number[] = []
  const ids: number[] = []
  while (ids.length < count) {
    const { value, done } = await reader.read()
    if (done) break
    arrivals.push(performance.now())
    for (const m of decoder.decode(value).matchAll(/^id: (\d+)$/gm)) ids.push(Number(m[1]))
  }
  controller.abort()
  const gaps = arrivals.slice(1).map((t, i) => Math.round(t - arrivals[i]))
  return {
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
// Unbuffered means chunks arrive one event at a time, about 200 ms apart.
results.unbuffered = first.gaps.length >= 4 && first.gaps.every((g) => g > 100 && g < 400)

const resumed = await readEvents({ accept: "text/event-stream", "last-event-id": "41" }, 3)
results.resumedIds = resumed.ids
results.resumeOk = resumed.ids[0] === 42

await new Promise((r) => setTimeout(r, 600))
if (logFile && existsSync(logFile)) {
  const log = readFileSync(logFile, "utf8").trim().split("\n")
  results.serverLog = log
  results.disconnectSeen = log.length >= 2
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
  results.resumeOk &&
  results.hmacOk &&
  (logFile ? results.disconnectSeen : true)
console.log(pass ? "PASS" : "FAIL")
