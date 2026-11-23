import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type Db, openDb, schema } from "@swdb/db"
import { migrateDb } from "@swdb/db/migrate"
import { afterEach, beforeEach, expect, test } from "vitest"
import {
  type AgentInput,
  AgentValidationError,
  createAgent,
  currentAgentVersion,
  emptyAgentInput,
  getAgent,
  listAgentVersions,
  updateAgent,
} from "./agents.ts"
import { toolModels } from "./models.ts"

let dir: string
let db: Db

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "swdb-agents-"))
  db = openDb({ path: join(dir, "swdb.sqlite") })
  migrateDb(db)
})

afterEach(() => {
  db.sqlite.close()
  rmSync(dir, { recursive: true, force: true })
})

const input = (over: Partial<AgentInput> = {}): AgentInput => ({
  ...emptyAgentInput(),
  name: "Weekly report",
  model: "openai/gpt-oss-20b",
  instructions: "Summarise the week.",
  ...over,
})

function seedRegistry() {
  const server = db
    .insert(schema.mcpServers)
    .values({ slug: "gh", name: "GitHub", transport: "stdio", config: { command: "npx" } })
    .returning()
    .get()
  const tool = db
    .insert(schema.mcpTools)
    .values({
      serverId: server.id,
      name: "create_issue",
      definition: {},
      definitionHash: "h1",
      listedAt: 0,
    })
    .returning()
    .get()
  const skill = db
    .insert(schema.skills)
    .values({ name: "pdf", description: "PDFs", location: "/s/pdf", contentHash: "c1" })
    .returning()
    .get()
  const command = db
    .insert(schema.commands)
    .values({ name: "git_status", file: "git", args: ["status"] })
    .returning()
    .get()
  return { tool, skill, command }
}

test("a new agent selects no skills, MCP tools or commands by default", () => {
  seedRegistry()
  const id = createAgent(db, input())
  const loaded = getAgent(db, id)
  expect(loaded?.input).toMatchObject({ skillIds: [], mcpTools: [], commandIds: [], limits: {} })
  expect(db.select().from(schema.agentSkills).all()).toEqual([])
  expect(db.select().from(schema.agentMcpTools).all()).toEqual([])
  expect(db.select().from(schema.agentCommands).all()).toEqual([])
})

test("creating writes version 1 with the full definition", () => {
  const id = createAgent(db, input({ limits: { maxTurns: 10 } }))
  const versions = listAgentVersions(db, id)
  expect(versions).toHaveLength(1)
  expect(versions[0]?.version).toBe(1)
  expect(versions[0]?.definition).toMatchObject({
    name: "Weekly report",
    model: "openai/gpt-oss-20b",
    instructions: "Summarise the week.",
    limits: { maxTurns: 10 },
    skills: [],
    mcpTools: [],
    commands: [],
  })
})

test("each save creates a version, and old versions keep their definition", () => {
  const { tool, skill, command } = seedRegistry()
  const id = createAgent(db, input())
  const v2 = updateAgent(
    db,
    id,
    input({
      model: "anthropic/claude-sonnet-5.5",
      skillIds: [skill.id],
      mcpTools: [{ toolId: tool.id, effect: "ask" }],
      commandIds: [command.id],
    }),
  )
  const v3 = updateAgent(db, id, input({ instructions: "Changed" }))
  expect([v2, v3]).toEqual([2, 3])

  const versions = listAgentVersions(db, id)
  expect(versions.map((v) => v.version)).toEqual([3, 2, 1])
  expect(versions[1]?.definition).toMatchObject({
    model: "anthropic/claude-sonnet-5.5",
    skills: [{ id: skill.id, name: "pdf", contentHash: "c1" }],
    mcpTools: [{ id: tool.id, name: "create_issue", effect: "ask", definitionHash: "h1" }],
    commands: [{ id: command.id, name: "git_status" }],
  })
  expect(versions[2]?.definition).toMatchObject({ model: "openai/gpt-oss-20b", skills: [] })
  expect(getAgent(db, id)?.agent.currentVersion).toBe(3)
  expect(currentAgentVersion(db, id)?.version).toBe(3)
  // Version 3 dropped the selections.
  expect(getAgent(db, id)?.input).toMatchObject({ skillIds: [], mcpTools: [], commandIds: [] })
})

test("a run points at the version it ran with, which later saves do not change", () => {
  const id = createAgent(db, input())
  const version = currentAgentVersion(db, id)
  if (!version) throw new Error("no version")
  const run = db
    .insert(schema.runs)
    .values({ agentId: id, agentVersionId: version.id, source: "manual" })
    .returning()
    .get()
  updateAgent(db, id, input({ instructions: "New instructions" }))
  const row = db.sqlite
    .prepare(
      "select v.definition from runs r join agent_versions v on v.id = r.agent_version_id where r.id = ?",
    )
    .pluck()
    .get(run.id) as string
  expect(JSON.parse(row).instructions).toBe("Summarise the week.")
})

test("invalid input is refused with the field name", () => {
  const fail = (over: Partial<AgentInput>) => {
    try {
      createAgent(db, input(over))
    } catch (e) {
      return e instanceof AgentValidationError ? e.field : "other"
    }
    return "none"
  }
  expect(fail({ name: "  " })).toBe("name")
  expect(fail({ model: "gpt" })).toBe("model")
  expect(fail({ limits: { maxTurns: 0 } })).toBe("limits.maxTurns")
  expect(fail({ limits: { maxTurns: 2.5 } })).toBe("limits.maxTurns")
  expect(fail({ limits: { maxCostUsd: -1 } })).toBe("limits.maxCostUsd")
  createAgent(db, input())
  expect(fail({ name: "Weekly report" })).toBe("name")
})

test("the model list keeps only models with tools and tool_choice", () => {
  const models = toolModels([
    {
      id: "b/both",
      supported_parameters: ["tools", "tool_choice"],
      pricing: { prompt: "0.000001", completion: "0.000002" },
    },
    { id: "a/tools-only", supported_parameters: ["tools"] },
    { id: "c/none" },
    { id: "a/both", supported_parameters: ["tool_choice", "tools", "temperature"] },
  ])
  expect(models.map((m) => m.id)).toEqual(["a/both", "b/both"])
  expect(models[1]).toMatchObject({ promptPrice: 1, completionPrice: 2 })
})
