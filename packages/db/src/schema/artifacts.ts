import { blob, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { agents } from "./agents.ts"
import { createdAt, id, updatedAt } from "./common.ts"
import { runs } from "./runs.ts"

/**
 * A file an agent saved with save_artifact. The file lives at
 * <data dir>/artifacts/<run_id>/<id>/<filename>. Runs of the same agent that save under the
 * same key make new versions of one artifact.
 */
export const artifacts = sqliteTable(
  "artifacts",
  {
    id: id(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    /** Stable key per agent, such as "weekly-report". Defaults to the filename. */
    key: text("key").notNull(),
    version: integer("version").notNull(),
    filename: text("filename").notNull(),
    mediaType: text("media_type").notNull(),
    size: integer("size").notNull(),
    sha256: text("sha256").notNull(),
    title: text("title"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("artifacts_agent_key_version_unique").on(t.agentId, t.key, t.version),
    index("artifacts_run_idx").on(t.runId),
  ],
)

/**
 * A secret value, encrypted with AES-256-GCM under a data key. key_version names the data
 * key, so keys can be rotated. Config rows refer to secrets by name as ${secret:NAME}.
 */
export const secrets = sqliteTable(
  "secrets",
  {
    id: id(),
    name: text("name").notNull(),
    ciphertext: blob("ciphertext", { mode: "buffer" }).notNull(),
    nonce: blob("nonce", { mode: "buffer" }).notNull(),
    keyVersion: integer("key_version").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("secrets_name_unique").on(t.name)],
)
