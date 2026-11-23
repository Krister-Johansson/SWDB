import { type Db, schema } from "@swdb/db"
import type { AgentLimits, SandboxLevel, ToolEffect } from "@swdb/db/schema"
import { and, desc, eq, ne } from "drizzle-orm"

export type AgentInput = {
  name: string
  description: string
  instructions: string
  /** OpenRouter model slug. */
  model: string
  limits: AgentLimits
  sandboxLevel: SandboxLevel
  enabled: boolean
  skillIds: string[]
  mcpTools: { toolId: string; effect: ToolEffect }[]
  commandIds: string[]
}

/** The full definition saved in agent_versions. A run uses this, not the live agent row. */
export type AgentDefinition = Omit<
  AgentInput,
  "enabled" | "skillIds" | "mcpTools" | "commandIds"
> & {
  skills: { id: string; name: string; contentHash: string }[]
  mcpTools: {
    id: string
    serverId: string
    name: string
    effect: ToolEffect
    definitionHash: string
  }[]
  commands: { id: string; name: string }[]
}

export const emptyAgentInput = (): AgentInput => ({
  name: "",
  description: "",
  instructions: "",
  model: "",
  limits: {},
  sandboxLevel: 1,
  enabled: true,
  skillIds: [],
  mcpTools: [],
  commandIds: [],
})

export class AgentValidationError extends Error {
  readonly field: string
  constructor(field: string, message: string) {
    super(message)
    this.field = field
  }
}

const LIMIT_FIELDS = [
  "maxTurns",
  "maxCostUsd",
  "timeoutMs",
  "dailyCostCapUsd",
  "maxConcurrentRuns",
] as const satisfies readonly (keyof AgentLimits)[]

/** Trims strings, drops empty limits, and rejects input the database would accept but the harness cannot use. */
export function normalizeAgentInput(input: AgentInput): AgentInput {
  const name = input.name.trim()
  const model = input.model.trim()
  if (!name) throw new AgentValidationError("name", "An agent needs a name")
  if (name.length > 80) throw new AgentValidationError("name", "Names are at most 80 characters")
  if (!/^[a-z0-9-]+(\/[a-z0-9._:-]+)+$/i.test(model)) {
    throw new AgentValidationError("model", "Pick an OpenRouter model, such as openai/gpt-oss-20b")
  }
  if (![1, 2, 3].includes(input.sandboxLevel)) {
    throw new AgentValidationError("sandboxLevel", "Sandbox level is 1, 2 or 3")
  }
  const limits: AgentLimits = {}
  for (const field of LIMIT_FIELDS) {
    const value = input.limits[field]
    if (value === undefined || value === null || Number.isNaN(value)) continue
    if (typeof value !== "number" || value <= 0) {
      throw new AgentValidationError(`limits.${field}`, `${field} must be a positive number`)
    }
    const integer = field === "maxTurns" || field === "timeoutMs" || field === "maxConcurrentRuns"
    if (integer && !Number.isInteger(value)) {
      throw new AgentValidationError(`limits.${field}`, `${field} must be a whole number`)
    }
    limits[field] = value
  }
  return {
    ...input,
    name,
    model,
    description: input.description.trim(),
    instructions: input.instructions,
    limits,
    skillIds: [...new Set(input.skillIds)],
    commandIds: [...new Set(input.commandIds)],
    mcpTools: [...new Map(input.mcpTools.map((t) => [t.toolId, t])).values()],
  }
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]

function assertNameFree(tx: Tx, name: string, exceptId?: string) {
  const clash = tx
    .select({ id: schema.agents.id })
    .from(schema.agents)
    .where(
      exceptId
        ? and(eq(schema.agents.name, name), ne(schema.agents.id, exceptId))
        : eq(schema.agents.name, name),
    )
    .get()
  if (clash) throw new AgentValidationError("name", `An agent named "${name}" already exists`)
}

function writeSelections(tx: Tx, agentId: string, input: AgentInput) {
  tx.delete(schema.agentSkills).where(eq(schema.agentSkills.agentId, agentId)).run()
  tx.delete(schema.agentMcpTools).where(eq(schema.agentMcpTools.agentId, agentId)).run()
  tx.delete(schema.agentCommands).where(eq(schema.agentCommands.agentId, agentId)).run()
  if (input.skillIds.length) {
    tx.insert(schema.agentSkills)
      .values(input.skillIds.map((skillId) => ({ agentId, skillId })))
      .run()
  }
  if (input.mcpTools.length) {
    tx.insert(schema.agentMcpTools)
      .values(input.mcpTools.map((t) => ({ agentId, toolId: t.toolId, effect: t.effect })))
      .run()
  }
  if (input.commandIds.length) {
    tx.insert(schema.agentCommands)
      .values(input.commandIds.map((commandId) => ({ agentId, commandId })))
      .run()
  }
}

/** Builds the definition snapshot from the rows as they are inside the transaction. */
function snapshot(tx: Tx, agentId: string, input: AgentInput): AgentDefinition {
  const skills = tx
    .select({
      id: schema.skills.id,
      name: schema.skills.name,
      contentHash: schema.skills.contentHash,
    })
    .from(schema.agentSkills)
    .innerJoin(schema.skills, eq(schema.skills.id, schema.agentSkills.skillId))
    .where(eq(schema.agentSkills.agentId, agentId))
    .orderBy(schema.skills.name)
    .all()
  const mcpTools = tx
    .select({
      id: schema.mcpTools.id,
      serverId: schema.mcpTools.serverId,
      name: schema.mcpTools.name,
      effect: schema.agentMcpTools.effect,
      definitionHash: schema.mcpTools.definitionHash,
    })
    .from(schema.agentMcpTools)
    .innerJoin(schema.mcpTools, eq(schema.mcpTools.id, schema.agentMcpTools.toolId))
    .where(eq(schema.agentMcpTools.agentId, agentId))
    .orderBy(schema.mcpTools.name)
    .all()
  const commands = tx
    .select({ id: schema.commands.id, name: schema.commands.name })
    .from(schema.agentCommands)
    .innerJoin(schema.commands, eq(schema.commands.id, schema.agentCommands.commandId))
    .where(eq(schema.agentCommands.agentId, agentId))
    .orderBy(schema.commands.name)
    .all()
  return {
    name: input.name,
    description: input.description,
    instructions: input.instructions,
    model: input.model,
    limits: input.limits,
    sandboxLevel: input.sandboxLevel,
    skills,
    mcpTools,
    commands,
  }
}

/** Creates an agent and its version 1. Returns the agent id. */
export function createAgent(db: Db, raw: AgentInput): string {
  const input = normalizeAgentInput(raw)
  return db.transaction((tx) => {
    assertNameFree(tx, input.name)
    const agent = tx
      .insert(schema.agents)
      .values({
        name: input.name,
        description: input.description,
        instructions: input.instructions,
        model: input.model,
        limits: input.limits,
        sandboxLevel: input.sandboxLevel,
        enabled: input.enabled,
        currentVersion: 1,
      })
      .returning({ id: schema.agents.id })
      .get()
    writeSelections(tx, agent.id, input)
    tx.insert(schema.agentVersions)
      .values({ agentId: agent.id, version: 1, definition: snapshot(tx, agent.id, input) })
      .run()
    return agent.id
  })
}

/** Saves an agent. Every save writes a new version. Returns the new version number. */
export function updateAgent(db: Db, agentId: string, raw: AgentInput): number {
  const input = normalizeAgentInput(raw)
  return db.transaction((tx) => {
    const current = tx
      .select({ currentVersion: schema.agents.currentVersion })
      .from(schema.agents)
      .where(eq(schema.agents.id, agentId))
      .get()
    if (!current) throw new Error(`Agent ${agentId} not found`)
    assertNameFree(tx, input.name, agentId)
    const version = current.currentVersion + 1
    tx.update(schema.agents)
      .set({
        name: input.name,
        description: input.description,
        instructions: input.instructions,
        model: input.model,
        limits: input.limits,
        sandboxLevel: input.sandboxLevel,
        enabled: input.enabled,
        currentVersion: version,
      })
      .where(eq(schema.agents.id, agentId))
      .run()
    writeSelections(tx, agentId, input)
    tx.insert(schema.agentVersions)
      .values({ agentId, version, definition: snapshot(tx, agentId, input) })
      .run()
    return version
  })
}

/** Turns an agent on or off without writing a version; it is not part of the definition. */
export function setAgentEnabled(db: Db, agentId: string, enabled: boolean): void {
  db.update(schema.agents)
    .set({ enabled, pausedReason: enabled ? null : undefined })
    .where(eq(schema.agents.id, agentId))
    .run()
}

export function listAgents(db: Db) {
  return db.select().from(schema.agents).orderBy(schema.agents.name).all()
}

/** The agent row plus its current selections, in the shape the editor edits. */
export function getAgent(db: Db, agentId: string) {
  const agent = db.select().from(schema.agents).where(eq(schema.agents.id, agentId)).get()
  if (!agent) return null
  const input: AgentInput = {
    name: agent.name,
    description: agent.description,
    instructions: agent.instructions,
    model: agent.model,
    limits: agent.limits,
    sandboxLevel: agent.sandboxLevel,
    enabled: agent.enabled,
    skillIds: db
      .select({ id: schema.agentSkills.skillId })
      .from(schema.agentSkills)
      .where(eq(schema.agentSkills.agentId, agentId))
      .all()
      .map((r) => r.id),
    mcpTools: db
      .select({ toolId: schema.agentMcpTools.toolId, effect: schema.agentMcpTools.effect })
      .from(schema.agentMcpTools)
      .where(eq(schema.agentMcpTools.agentId, agentId))
      .all(),
    commandIds: db
      .select({ id: schema.agentCommands.commandId })
      .from(schema.agentCommands)
      .where(eq(schema.agentCommands.agentId, agentId))
      .all()
      .map((r) => r.id),
  }
  return { agent, input }
}

export function listAgentVersions(db: Db, agentId: string) {
  return db
    .select()
    .from(schema.agentVersions)
    .where(eq(schema.agentVersions.agentId, agentId))
    .orderBy(desc(schema.agentVersions.version))
    .all()
}

/** The version row a new run should point at. */
export function currentAgentVersion(db: Db, agentId: string) {
  return db
    .select()
    .from(schema.agentVersions)
    .where(eq(schema.agentVersions.agentId, agentId))
    .orderBy(desc(schema.agentVersions.version))
    .get()
}

/** What the editor can offer: everything in the registry. Nothing is selected by default. */
export function listSelectable(db: Db) {
  return {
    skills: db
      .select({
        id: schema.skills.id,
        name: schema.skills.name,
        description: schema.skills.description,
        hasScripts: schema.skills.hasScripts,
      })
      .from(schema.skills)
      .where(eq(schema.skills.enabled, true))
      .orderBy(schema.skills.name)
      .all(),
    mcpTools: db
      .select({
        id: schema.mcpTools.id,
        name: schema.mcpTools.name,
        description: schema.mcpTools.description,
        server: schema.mcpServers.name,
      })
      .from(schema.mcpTools)
      .innerJoin(schema.mcpServers, eq(schema.mcpServers.id, schema.mcpTools.serverId))
      .where(eq(schema.mcpServers.enabled, true))
      .orderBy(schema.mcpServers.name, schema.mcpTools.name)
      .all(),
    commands: db
      .select({
        id: schema.commands.id,
        name: schema.commands.name,
        description: schema.commands.description,
      })
      .from(schema.commands)
      .orderBy(schema.commands.name)
      .all(),
  }
}
