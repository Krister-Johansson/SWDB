import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { bool, createdAt, id, json, oneOf, updatedAt } from "./common.ts"

export const mcpTransports = ["stdio", "http"] as const
export type McpTransport = (typeof mcpTransports)[number]

/** Whether one server process is shared by all agents, started per agent, or started per run. */
export const mcpSharingModes = ["shared", "per-agent", "per-run"] as const
export type McpSharing = (typeof mcpSharingModes)[number]

/**
 * Transport settings. Values may hold ${secret:NAME} references, which the harness
 * substitutes at call time. Stdio: command, args, env. HTTP: url, headers.
 */
export type McpServerConfig = {
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
}

export const mcpServers = sqliteTable(
  "mcp_servers",
  {
    id: id(),
    /** Short name used as the tool name prefix, such as "github". */
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    transport: text("transport", { enum: mcpTransports }).notNull(),
    config: json<McpServerConfig>("config").notNull(),
    sharing: text("sharing", { enum: mcpSharingModes }).notNull().default("shared"),
    enabled: bool("enabled").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("mcp_servers_slug_unique").on(t.slug),
    oneOf("mcp_servers_transport_check", t.transport, mcpTransports),
    oneOf("mcp_servers_sharing_check", t.sharing, mcpSharingModes),
  ],
)

/**
 * One row per tool a server lists. definition_hash is the hash of the full tool definition
 * as last listed. approved_hash is the hash the user reviewed. When they differ, the tool is
 * disabled for every agent until the user reviews the change.
 */
export const mcpTools = sqliteTable(
  "mcp_tools",
  {
    id: id(),
    serverId: text("server_id")
      .notNull()
      .references(() => mcpServers.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    definition: json<Record<string, unknown>>("definition").notNull(),
    definitionHash: text("definition_hash").notNull(),
    approvedHash: text("approved_hash"),
    listedAt: integer("listed_at").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("mcp_tools_server_name_unique").on(t.serverId, t.name)],
)

export const skillScanStatuses = ["pending", "clean", "flagged", "failed"] as const
export type SkillScanStatus = (typeof skillScanStatuses)[number]

/** An installed Agent Skills directory. SWDB never updates a skill on its own. */
export const skills = sqliteTable(
  "skills",
  {
    id: id(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    /** Directory of the skill under the SWDB skills folder. */
    location: text("location").notNull(),
    /** Git repository, tarball or skills.sh URL it was installed from. Null for local skills. */
    sourceUrl: text("source_url"),
    /** Hash of the directory tree at install or last review. */
    contentHash: text("content_hash").notNull(),
    scanStatus: text("scan_status", { enum: skillScanStatuses }).notNull().default("pending"),
    /** True when the skill has a scripts/ folder and so needs shell access. */
    hasScripts: bool("has_scripts").notNull().default(false),
    enabled: bool("enabled").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("skills_name_unique").on(t.name),
    oneOf("skills_scan_status_check", t.scanStatus, skillScanStatuses),
  ],
)

/**
 * A named, parameterised command tool. The harness runs it with spawn(file, args) and no
 * shell. args is a template list in which {param} placeholders take values from the tool
 * call, validated against parameters (a JSON Schema).
 */
export const commands = sqliteTable(
  "commands",
  {
    id: id(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    file: text("file").notNull(),
    args: json<string[]>("args").notNull().default([]),
    parameters: json<Record<string, unknown>>("parameters").notNull().default({}),
    /** Read-only commands may run concurrently; others run one at a time. */
    readOnly: bool("read_only").notNull().default(false),
    timeoutMs: integer("timeout_ms"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("commands_name_unique").on(t.name)],
)

export const sandboxProviders = ["srt", "container"] as const
export type SandboxProvider = (typeof sandboxProviders)[number]

/** A reusable sandbox profile: srt settings for level 2, image and limits for level 3. */
export const sandboxTemplates = sqliteTable(
  "sandbox_templates",
  {
    id: id(),
    name: text("name").notNull(),
    provider: text("provider", { enum: sandboxProviders }).notNull(),
    config: json<Record<string, unknown>>("config").notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("sandbox_templates_name_unique").on(t.name),
    oneOf("sandbox_templates_provider_check", t.provider, sandboxProviders),
  ],
)
