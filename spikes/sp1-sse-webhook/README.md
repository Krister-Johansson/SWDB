# SP1: SSE and raw-body webhook from TanStack Start server routes

Result: pass, on 2026-11-19, with `@tanstack/react-start` on Vite 8 and Node 26.11.

`route-sse.ts` and `route-hook.ts` are the two server routes that were tested. To run the test again, copy them to `apps/web/src/routes/spike/sse.ts` and `apps/web/src/routes/spike/hook.ts`, start the web app with `SP1_LOG=<file>` set, and run:

```bash
node spikes/sp1-sse-webhook/client.ts http://127.0.0.1:4100 <file>
```

| Check                                                                                  | Dev server (`vite dev`) | Production build (`srvx`) |
| -------------------------------------------------------------------------------------- | ----------------------- | ------------------------- |
| Events arrive one at a time, about 200 ms apart                                        | pass                    | pass                      |
| No `content-encoding` on the stream when the client accepts gzip and br                | pass                    | pass                      |
| A request with `Last-Event-ID: 41` starts at event 42                                  | pass                    | pass                      |
| `request.signal` fires when the client disconnects                                     | pass                    | pass                      |
| HMAC-SHA256 over `request.text()` verifies, and a body with one added byte is rejected | pass                    | pass                      |

Findings that affect the build:

- The default Start build has no Nitro. It emits `dist/server/server.js`, a fetch handler, and `srvx --prod -s ../client dist/server/server.js` serves it. SWDB does not need Nitro, whose `latest` tag is still a release candidate.
- The server build bundles dependencies. `better-sqlite3` loads a native binary by path, so `vite.config.ts` lists it under `ssr.external`, and `apps/web` depends on it directly so Node can resolve it from the build output.
- The data folder must not be located from `import.meta.url`, because the bundle moves the module. `packages/db` finds the workspace root from the working directory.
