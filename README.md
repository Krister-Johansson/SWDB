# SWDB

SWDB (switchboard) is a private, single-user portal of single-purpose AI agents. Triggers come in over webhooks, an API and cron. Results go out over SMS, email, Slack, Discord and a dashboard inbox. It runs on one Mac and binds to 127.0.0.1.

## Run it

You need Node.js 26 and pnpm 12.

```bash
pnpm install
pnpm dev
```

`pnpm dev` starts two processes:

- `apps/web`: the TanStack Start dashboard with shadcn/ui, on http://127.0.0.1:4100
- `apps/worker`: the background process for agent runs, the schedule ticker and long-lived connections

Both open the same SQLite file in WAL mode. The file lives in `.data/swdb.sqlite`. Set `SWDB_DATA_DIR` to move it.

## Layout

| Path          | Contents                                                              |
| ------------- | --------------------------------------------------------------------- |
| `apps/web`    | Dashboard, server functions, webhook and API routes                   |
| `apps/worker` | Worker process, run with `node --watch` and TypeScript type stripping |
| `packages/db` | SQLite connection, schema and queries shared by both processes        |
| `spikes`      | Short experiments that settle open risks, one folder per spike issue  |

## Checks

```bash
pnpm check      # Biome lint and format check
pnpm typecheck  # tsc in every workspace package
pnpm test       # Vitest
pnpm build      # production build of the web app
pnpm doctor:react  # react-doctor scan of apps/web
```

Worker and package code must use erasable TypeScript syntax only (no enums, parameter properties or decorators), because Node runs it without a build step.
