import { primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { agents } from "./agents.ts"
import { channels } from "./channels.ts"
import { json, oneOf } from "./common.ts"
import { commands, mcpTools, skills } from "./registry.ts"

// What each agent may use. Nothing is selected by default: an agent with no rows here has
// no MCP tools, skills, commands, child agents or channels besides the inbox.

export const toolEffects = ["allow", "ask", "deny"] as const
export type ToolEffect = (typeof toolEffects)[number]

/** Per (server, tool) effect for one agent. The tool row identifies the server. */
export const agentMcpTools = sqliteTable(
  "agent_mcp_tools",
  {
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    toolId: text("tool_id")
      .notNull()
      .references(() => mcpTools.id, { onDelete: "cascade" }),
    effect: text("effect", { enum: toolEffects }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.agentId, t.toolId] }),
    oneOf("agent_mcp_tools_effect_check", t.effect, toolEffects),
  ],
)

export const agentSkills = sqliteTable(
  "agent_skills",
  {
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    skillId: text("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.skillId] })],
)

export const agentCommands = sqliteTable(
  "agent_commands",
  {
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    commandId: text("command_id")
      .notNull()
      .references(() => commands.id, { onDelete: "cascade" }),
    effect: text("effect", { enum: toolEffects }).notNull().default("allow"),
  },
  (t) => [
    primaryKey({ columns: [t.agentId, t.commandId] }),
    oneOf("agent_commands_effect_check", t.effect, toolEffects),
  ],
)

/** Agents that this agent may start with spawn_agent. */
export const agentSpawnableAgents = sqliteTable(
  "agent_spawnable_agents",
  {
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    childAgentId: text("child_agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.childAgentId] })],
)

/** Events an agent can send to a channel. */
export const channelEvents = ["result", "failure", "notify", "approval"] as const
export type ChannelEvent = (typeof channelEvents)[number]

/**
 * A channel attached to an agent, with fixed recipients. The notify tool names the channel
 * only; recipients always come from this row, never from the model.
 */
export const agentChannels = sqliteTable(
  "agent_channels",
  {
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    recipients: json<string[]>("recipients").notNull().default([]),
    events: json<ChannelEvent[]>("events").notNull().default(["result", "failure"]),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.channelId] })],
)
