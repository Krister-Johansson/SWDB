# Spikes

Each folder holds the code and result of one spike issue. Results are from 2026-11-19 on Node 26.11, macOS.

| Spike                                                     | Result                                | How to run                                 |
| --------------------------------------------------------- | ------------------------------------- | ------------------------------------------ |
| SP1: SSE and raw-body webhook from Start server routes    | Pass, dev server and production build | See `sp1-sse-webhook/README.md`            |
| SP2: two processes on one SQLite file                     | Pass                                  | `node spikes/sp2-two-processes/run.ts`     |
| SP3: kill the worker mid-run and resume from `run_events` | Pass                                  | `node spikes/sp3-resume-after-kill/run.ts` |
| SP4: TanStack AI as the loop layer                        | Pass, live run on OpenRouter          | See below                                  |

## SP2

Two processes wrote to one WAL-mode file for 8 seconds with `busy_timeout = 5000`. The parent gives both the same start and end time, and the run passes only if both wrote during a shared stretch of at least 4 seconds and the worker held at least five long transactions. In the last run the "web" process inserted 840,156 rows and the "worker" appended 102,702 event rows, including eight 150 ms write transactions. Neither saw `SQLITE_BUSY`, every row was in the file afterwards, and the two wrote side by side for 6,801 ms. The longest single write waited 1,620 ms in the web process and 1,616 ms in the worker, and an earlier run measured 2,026 ms. These waits happen while the other process writes in a tight loop, which real trigger traffic does not do, but they show that a 5 second busy timeout is needed and a short one would fail.

## SP3

A scripted model asked for six tool calls. The first worker was killed with SIGKILL while tool 3 was executing. The second worker loaded the log, wrote a synthetic "interrupted" result for call 3, and finished the run. Every tool call has exactly one result and no tool ran twice.

The harness never re-executes a tool call that has no recorded result, because it cannot know whether the side effect happened. A tool that was killed after its side effect but before its result was written is therefore also reported as interrupted. The model sees "interrupted" and has to check before it retries.

## SP4

Live run against OpenRouter with `@tanstack/ai` 1.5 and `@tanstack/ai-openrouter` 1.1 on `openai/gpt-oss-20b`, a reasoning model with tool support. It passed twice and cost under $0.0001 per run. Run it with `pnpm --filter sp4-tanstack-ai spike` and `OPENROUTER_API_KEY` in `.env`.

| Check                                                                            | Result                                                                                             |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Usage with the cost OpenRouter reports, once per model call (`onUsage`)          | Pass: three model calls, three usage records with cost                                             |
| Request config visible before every model call (`onConfig`, phase `beforeModel`) | Pass: messages, tools, reasoning, tool choice and a `wrapFetch` option                             |
| Reasoning chunks arrive and the tool loop still completes                        | Pass: both tools ran in order after reasoning output                                               |
| A custom `agentLoopStrategy` stops the loop on a cost budget                     | Pass: budget 0 gave one model call. The tool that call asked for still ran before the loop stopped |
| `abortController` stops a run in progress                                        | Pass                                                                                               |

The docs also confirm stop conditions, approval interrupts that survive a restart through the persistence middleware, and MCP tools through `@tanstack/ai-mcp`.

Crash recovery on TanStack AI also passes (`pnpm --filter sp4-tanstack-ai resume`). A middleware wrote each tool call to `run_events` before the tool ran. The first worker was killed with SIGKILL during the first tool. The second worker rebuilt the messages from the log, added an interrupted result for the unanswered call, and the model called the tool again and finished. The killed call never ran its side effect and no side effect ran twice.

Decision: M5 builds the loop on TanStack AI.

Not tested here:

- The exact HTTP request and response bodies. The run uses `wrapFetch` to count the HTTP requests and to check that a `beforeModel` config and one usage record belong to each, but it does not read the bodies.
- `reasoning_details` passback on a model that requires it, such as an Anthropic model with extended thinking.
