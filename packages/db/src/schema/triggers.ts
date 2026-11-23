import {
  type AnySQLiteColumn,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core"
import { agents } from "./agents.ts"
import { bool, createdAt, id, json, nullOrOneOf, oneOf, updatedAt } from "./common.ts"
import { runs } from "./runs.ts"

export const triggerKinds = ["api", "webhook", "cron"] as const
export type TriggerKind = (typeof triggerKinds)[number]

/** Webhook authentication: none, a shared header secret, a configurable HMAC, or Standard Webhooks. */
export const webhookAuthModes = ["none", "header", "hmac", "standard_webhooks"] as const
export type WebhookAuthMode = (typeof webhookAuthModes)[number]

/** Auth settings. Secrets are ${secret:NAME} references, never values. */
export type WebhookAuthConfig = {
  header?: string
  secret?: string
  algorithm?: "sha1" | "sha256" | "sha512"
  signaturePrefix?: string
}

export const triggers = sqliteTable(
  "triggers",
  {
    id: id(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: triggerKinds }).notNull(),
    name: text("name").notNull(),
    /** Unguessable token in /hooks/<token>. Webhook triggers only. */
    pathToken: text("path_token"),
    authMode: text("auth_mode", { enum: webhookAuthModes }),
    authConfig: json<WebhookAuthConfig>("auth_config"),
    /** Optional filter on the payload; a fire that does not match starts no run. */
    filter: json<Record<string, unknown>>("filter"),
    /** Template that turns the payload into the run prompt. */
    promptTemplate: text("prompt_template"),
    enabled: bool("enabled").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("triggers_path_token_unique").on(t.pathToken),
    index("triggers_agent_idx").on(t.agentId),
    oneOf("triggers_kind_check", t.kind, triggerKinds),
    nullOrOneOf("triggers_auth_mode_check", t.authMode, webhookAuthModes),
  ],
)

export const missedRunPolicies = ["skip", "run_once"] as const
export type MissedRunPolicy = (typeof missedRunPolicies)[number]

/** What happens when a fire is due while a run from the same schedule is still active. */
export const overlapPolicies = ["skip", "queue"] as const
export type OverlapPolicy = (typeof overlapPolicies)[number]

export const schedules = sqliteTable(
  "schedules",
  {
    id: id(),
    triggerId: text("trigger_id")
      .notNull()
      .references(() => triggers.id, { onDelete: "cascade" }),
    cron: text("cron").notNull(),
    /** IANA time zone, such as "Europe/Stockholm". */
    timezone: text("timezone").notNull(),
    nextRunAt: integer("next_run_at").notNull(),
    lastRunAt: integer("last_run_at"),
    missedRunPolicy: text("missed_run_policy", { enum: missedRunPolicies })
      .notNull()
      .default("skip"),
    overlapPolicy: text("overlap_policy", { enum: overlapPolicies }).notNull().default("skip"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("schedules_trigger_unique").on(t.triggerId),
    index("schedules_next_run_idx").on(t.nextRunAt),
    oneOf("schedules_missed_run_policy_check", t.missedRunPolicy, missedRunPolicies),
    oneOf("schedules_overlap_policy_check", t.overlapPolicy, overlapPolicies),
  ],
)

/** API keys are stored as a short display prefix and a SHA-256 hash of the full key. */
export const apiKeys = sqliteTable(
  "api_keys",
  {
    id: id(),
    name: text("name").notNull(),
    prefix: text("prefix").notNull(),
    hash: text("hash").notNull(),
    /** Limits the key to one agent. Null means the key may start any agent. */
    agentId: text("agent_id").references(() => agents.id, { onDelete: "cascade" }),
    lastUsedAt: integer("last_used_at"),
    revokedAt: integer("revoked_at"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("api_keys_hash_unique").on(t.hash)],
)

/** Every webhook request as received, kept for replay and inspection. */
export const webhookDeliveries = sqliteTable(
  "webhook_deliveries",
  {
    id: id(),
    triggerId: text("trigger_id")
      .notNull()
      .references(() => triggers.id, { onDelete: "cascade" }),
    /** From the webhook-id header or a hash of the body. A repeat is rejected by the unique index. */
    dedupKey: text("dedup_key").notNull(),
    headers: json<Record<string, string>>("headers").notNull(),
    body: text("body").notNull(),
    signatureValid: bool("signature_valid"),
    receivedAt: integer("received_at")
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (t) => [uniqueIndex("webhook_deliveries_trigger_dedup_unique").on(t.triggerId, t.dedupKey)],
)

export const triggerAttemptOutcomes = ["started", "skipped", "rejected"] as const
export type TriggerAttemptOutcome = (typeof triggerAttemptOutcomes)[number]

/** Reason codes for a fire that started no run. The column is not constrained. */
export const triggerSkipReasons = [
  "paused",
  "disabled",
  "global_stop",
  "rate_limited",
  "agent_daily_cap",
  "global_daily_cap",
  "invalid_payload",
  "invalid_signature",
  "filtered",
  "duplicate",
  "overlap",
  "missed",
] as const
export type TriggerSkipReason = (typeof triggerSkipReasons)[number]

/** One row per fire of any trigger, including Run now, whether or not a run started. */
export const triggerAttempts = sqliteTable(
  "trigger_attempts",
  {
    id: id(),
    /** Null for Run now from the dashboard, which has no trigger row. */
    triggerId: text("trigger_id").references(() => triggers.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    webhookDeliveryId: text("webhook_delivery_id").references(() => webhookDeliveries.id, {
      onDelete: "set null",
    }),
    /** For cron fires: the scheduled time this fire is for. */
    scheduledFor: integer("scheduled_for"),
    outcome: text("outcome", { enum: triggerAttemptOutcomes }).notNull(),
    reason: text("reason").$type<TriggerSkipReason>(),
    detail: text("detail"),
    runId: text("run_id").references((): AnySQLiteColumn => runs.id, { onDelete: "set null" }),
    firedAt: integer("fired_at")
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (t) => [
    index("trigger_attempts_trigger_idx").on(t.triggerId, t.firedAt),
    index("trigger_attempts_agent_idx").on(t.agentId, t.firedAt),
    oneOf("trigger_attempts_outcome_check", t.outcome, triggerAttemptOutcomes),
  ],
)
