import { blob, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { bool, createdAt, id, json, oneOf, updatedAt } from "./common.ts"
import { runs, toolCalls } from "./runs.ts"

/** The inbox is always attached to every agent and needs no channels row. */
export const channelKinds = ["sms", "email", "slack", "discord"] as const
export type ChannelKind = (typeof channelKinds)[number]

/**
 * A configured outbound channel. The config (webhook URLs, tokens, sender) is encrypted
 * with the secret store's data key, because a Slack or Discord webhook URL is a credential.
 */
export const channels = sqliteTable(
  "channels",
  {
    id: id(),
    /** Name the notify tool uses, such as "ops-slack". */
    name: text("name").notNull(),
    kind: text("kind", { enum: channelKinds }).notNull(),
    configCiphertext: blob("config_ciphertext", { mode: "buffer" }).notNull(),
    configNonce: blob("config_nonce", { mode: "buffer" }).notNull(),
    keyVersion: integer("key_version").notNull(),
    enabled: bool("enabled").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("channels_name_unique").on(t.name),
    oneOf("channels_kind_check", t.kind, channelKinds),
  ],
)

export const humanRequestKinds = ["info", "question", "approval", "choice"] as const
export type HumanRequestKind = (typeof humanRequestKinds)[number]

export const humanRequestStatuses = ["open", "answered", "expired", "cancelled"] as const
export type HumanRequestStatus = (typeof humanRequestStatuses)[number]

/** Where an answer came from. The column is not constrained. */
export const answerSources = ["inbox", "slack", "discord", "email", "sms", "timeout"] as const
export type AnswerSource = (typeof answerSources)[number]

/**
 * Notices, questions, approvals and choices for the user. A request resolves through one
 * compare-and-set update on status = 'open', so the first answer wins.
 */
export const humanRequests = sqliteTable(
  "human_requests",
  {
    id: id(),
    runId: text("run_id").references(() => runs.id, { onDelete: "cascade" }),
    /** For approvals: the tool call waiting on this request. */
    toolCallId: text("tool_call_id").references(() => toolCalls.id, { onDelete: "set null" }),
    kind: text("kind", { enum: humanRequestKinds }).notNull(),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    /** Options for choice requests. */
    options: json<string[]>("options"),
    status: text("status", { enum: humanRequestStatuses }).notNull().default("open"),
    answer: json<unknown>("answer"),
    answeredVia: text("answered_via").$type<AnswerSource>(),
    answeredAt: integer("answered_at"),
    expiresAt: integer("expires_at").notNull(),
    /** Answer applied when the request expires. Deny for approvals. */
    defaultOnTimeout: json<unknown>("default_on_timeout").notNull(),
    /** Set when the harness has acted on the answer, so a resume never acts twice. */
    executedAt: integer("executed_at"),
    readAt: integer("read_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("human_requests_status_idx").on(t.status, t.createdAt),
    index("human_requests_run_idx").on(t.runId),
    index("human_requests_expires_idx").on(t.status, t.expiresAt),
    oneOf("human_requests_kind_check", t.kind, humanRequestKinds),
    oneOf("human_requests_status_check", t.status, humanRequestStatuses),
  ],
)

/** One copy of a human request sent to a channel, so it can be edited after the answer. */
export const humanRequestDeliveries = sqliteTable(
  "human_request_deliveries",
  {
    id: id(),
    humanRequestId: text("human_request_id")
      .notNull()
      .references(() => humanRequests.id, { onDelete: "cascade" }),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    /** Provider reference for the sent message, such as Slack channel and ts. */
    providerMessageRef: json<Record<string, string>>("provider_message_ref"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("human_request_deliveries_request_channel_unique").on(
      t.humanRequestId,
      t.channelId,
    ),
  ],
)

export const deliveryStatuses = ["pending", "sent", "failed"] as const
export type DeliveryStatus = (typeof deliveryStatuses)[number]

/** One outbound message on a channel: a run result, a notify call or a system alert. */
export const deliveries = sqliteTable(
  "deliveries",
  {
    id: id(),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    runId: text("run_id").references(() => runs.id, { onDelete: "set null" }),
    /** Unique per message, so a retry after a crash does not send twice. */
    idempotencyKey: text("idempotency_key").notNull(),
    payload: json<Record<string, unknown>>("payload").notNull(),
    status: text("status", { enum: deliveryStatuses }).notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    nextAttemptAt: integer("next_attempt_at"),
    providerMessageRef: json<Record<string, string>>("provider_message_ref"),
    sentAt: integer("sent_at"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("deliveries_idempotency_key_unique").on(t.idempotencyKey),
    index("deliveries_pending_idx").on(t.status, t.nextAttemptAt),
    oneOf("deliveries_status_check", t.status, deliveryStatuses),
  ],
)
