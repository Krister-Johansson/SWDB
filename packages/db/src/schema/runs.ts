import {
  type AnySQLiteColumn,
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core"
import { agents, agentVersions } from "./agents.ts"
import { id, json, nullOrOneOf, oneOf } from "./common.ts"
import { triggerAttempts, triggers } from "./triggers.ts"

/** What started a run. */
export const runSources = ["api", "webhook", "cron", "manual", "spawn", "fork"] as const
export type RunSource = (typeof runSources)[number]

export const runStatuses = [
  "queued",
  "running",
  "waiting_human",
  "succeeded",
  "failed",
  "cancelled",
] as const
export type RunStatus = (typeof runStatuses)[number]

/** Reason codes on the terminal event. Every run ends with exactly one. */
export const stopReasons = [
  "success",
  "max_turns",
  "max_budget",
  "timeout",
  "cancelled",
  "error",
] as const
export type StopReason = (typeof stopReasons)[number]

export const runs = sqliteTable(
  "runs",
  {
    id: id(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    /** The definition snapshot this run used. */
    agentVersionId: text("agent_version_id")
      .notNull()
      .references(() => agentVersions.id),
    source: text("source", { enum: runSources }).notNull(),
    triggerId: text("trigger_id").references(() => triggers.id, { onDelete: "set null" }),
    triggerAttemptId: text("trigger_attempt_id").references(
      (): AnySQLiteColumn => triggerAttempts.id,
      { onDelete: "set null" },
    ),
    /** Payload or prompt the run started with, stored as received. */
    input: json<unknown>("input"),
    parentRunId: text("parent_run_id").references((): AnySQLiteColumn => runs.id),
    rootRunId: text("root_run_id").references((): AnySQLiteColumn => runs.id),
    forkedFromRunId: text("forked_from_run_id").references((): AnySQLiteColumn => runs.id),
    forkedFromSeq: integer("forked_from_seq"),
    status: text("status", { enum: runStatuses }).notNull().default("queued"),
    stopReason: text("stop_reason", { enum: stopReasons }),
    error: text("error"),
    turns: integer("turns").notNull().default(0),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    reasoningTokens: integer("reasoning_tokens").notNull().default(0),
    costUsd: real("cost_usd").notNull().default(0),
    /** Unique per run request, so a repeated trigger fire cannot start a second run. */
    idempotencyKey: text("idempotency_key"),
    /** Lease: the worker that holds the run and when the hold lapses. */
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: integer("lease_expires_at"),
    attempts: integer("attempts").notNull().default(0),
    cancelRequestedAt: integer("cancel_requested_at"),
    queuedAt: integer("queued_at")
      .notNull()
      .$defaultFn(() => Date.now()),
    startedAt: integer("started_at"),
    endedAt: integer("ended_at"),
  },
  (t) => [
    uniqueIndex("runs_idempotency_key_unique").on(t.idempotencyKey),
    index("runs_status_queued_idx").on(t.status, t.queuedAt),
    index("runs_agent_status_idx").on(t.agentId, t.status),
    index("runs_parent_idx").on(t.parentRunId),
    index("runs_root_idx").on(t.rootRunId),
    oneOf("runs_source_check", t.source, runSources),
    oneOf("runs_status_check", t.status, runStatuses),
    nullOrOneOf("runs_stop_reason_check", t.stopReason, stopReasons),
  ],
)

/**
 * Event types from the research report. The column is not constrained, so a new type
 * needs no table rebuild; the harness writes only these.
 */
export const runEventTypes = [
  "run_start",
  "turn_start",
  "model_request",
  "model_response",
  "tool_start",
  "tool_end",
  "approval_requested",
  "approval_resolved",
  "child_run_started",
  "child_run_ended",
  "compaction",
  "retry",
  "limit_hit",
  "error",
  "run_end",
] as const
export type RunEventType = (typeof runEventTypes)[number]

/** Append-only log of a run. seq starts at 1 per run and is the SSE cursor. */
export const runEvents = sqliteTable(
  "run_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    type: text("type").$type<RunEventType>().notNull(),
    spanId: text("span_id"),
    parentSpanId: text("parent_span_id"),
    payload: json<Record<string, unknown>>("payload").notNull().default({}),
    createdAt: integer("created_at")
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (t) => [uniqueIndex("run_events_run_seq_unique").on(t.runId, t.seq)],
)

/** One row per request to OpenRouter, with the exact bodies sent and received. */
export const modelCalls = sqliteTable(
  "model_calls",
  {
    id: id(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    turn: integer("turn").notNull(),
    /** Model slug the request asked for. */
    model: text("model").notNull(),
    /** Model and provider that served it, from the response. */
    servedModel: text("served_model"),
    provider: text("provider"),
    generationId: text("generation_id"),
    requestBody: json<unknown>("request_body"),
    responseBody: json<unknown>("response_body"),
    finishReason: text("finish_reason"),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    reasoningTokens: integer("reasoning_tokens").notNull().default(0),
    cachedTokens: integer("cached_tokens").notNull().default(0),
    costUsd: real("cost_usd").notNull().default(0),
    error: text("error"),
    startedAt: integer("started_at").notNull(),
    endedAt: integer("ended_at"),
  },
  (t) => [
    index("model_calls_run_idx").on(t.runId, t.turn),
    index("model_calls_started_idx").on(t.startedAt),
  ],
)

export const toolCallStates = [
  "pending",
  "awaiting_approval",
  "running",
  "completed",
  "error",
  "interrupted",
  "denied",
] as const
export type ToolCallState = (typeof toolCallStates)[number]

export const toolCalls = sqliteTable(
  "tool_calls",
  {
    id: id(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    modelCallId: text("model_call_id").references(() => modelCalls.id, { onDelete: "set null" }),
    /** The id the model gave the call, echoed back with the result. */
    callId: text("call_id").notNull(),
    /** Name as the model saw it, such as "github__create_issue". */
    name: text("name").notNull(),
    args: json<unknown>("args"),
    state: text("state", { enum: toolCallStates }).notNull().default("pending"),
    /** Result as returned to the model, capped in length. */
    result: text("result"),
    /** File with the full output when the result was capped. */
    resultPath: text("result_path"),
    error: text("error"),
    startedAt: integer("started_at"),
    endedAt: integer("ended_at"),
    createdAt: integer("created_at")
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (t) => [
    index("tool_calls_run_call_idx").on(t.runId, t.callId),
    oneOf("tool_calls_state_check", t.state, toolCallStates),
  ],
)
