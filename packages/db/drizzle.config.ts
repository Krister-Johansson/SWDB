import { defineConfig } from "drizzle-kit"

// `pnpm --filter @swdb/db generate` writes a new migration into ./migrations after a schema
// change. Commit the generated folder; `pnpm db:migrate` applies it.
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/schema/index.ts",
  out: "./migrations",
  strict: true,
  verbose: true,
})
