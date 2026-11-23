import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { bool, createdAt, id, json, oneOf, updatedAt } from "./common.ts"

/**
 * Sandbox levels from the research report:
 * 1 none (no shell), 2 restricted host commands under srt, 3 container.
 */
export const sandboxLevels = [1, 2, 3] as const
export type SandboxLevel = (typeof sandboxLevels)[number]

/** Per-agent limits. A missing field means the global default applies. */
export type AgentLimits = {
  maxTurns?: number
  maxCostUsd?: number
  timeoutMs?: number
  dailyCostCapUsd?: number
  maxConcurrentRuns?: number
}

export const agents = sqliteTable(
  "agents",
  {
    id: id(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    instructions: text("instructions").notNull().default(""),
    /** OpenRouter model slug, such as "openai/gpt-oss-20b". */
    model: text("model").notNull(),
    limits: json<AgentLimits>("limits").notNull().default({}),
    sandboxLevel: integer("sandbox_level").$type<SandboxLevel>().notNull().default(1),
    /** Working directory for command tools. Null means the default under the data folder. */
    workingDir: text("working_dir"),
    enabled: bool("enabled").notNull().default(true),
    /** Why the agent was paused, for example after repeated failures. Null when not paused. */
    pausedReason: text("paused_reason"),
    /** The version number of the latest agent_versions row. */
    currentVersion: integer("current_version").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("agents_name_unique").on(t.name),
    oneOf("agents_sandbox_level_check", t.sandboxLevel, sandboxLevels),
  ],
)

/** Full definition of an agent as saved, one row per save. Runs point at the row they ran with. */
export const agentVersions = sqliteTable(
  "agent_versions",
  {
    id: id(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    definition: json<Record<string, unknown>>("definition").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("agent_versions_agent_version_unique").on(t.agentId, t.version)],
)
