import { existsSync, mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import Database from "better-sqlite3"
import { drizzle } from "drizzle-orm/better-sqlite3"
import * as schema from "./schema.ts"

export { schema }
export type Db = ReturnType<typeof openDb>

// The workspace root is found from the working directory, not from this file, because the
// web build bundles this module into another folder.
function workspaceRoot(): string {
  let dir = process.cwd()
  while (!existsSync(resolve(dir, "pnpm-workspace.yaml"))) {
    const parent = dirname(dir)
    if (parent === dir) return process.cwd()
    dir = parent
  }
  return dir
}

/**
 * Folder for the SQLite file, artifacts and workspaces. Override with SWDB_DATA_DIR.
 * A relative override resolves against the workspace root, because the web process and the
 * worker start in different folders and must open the same file.
 */
export function dataDir(): string {
  return resolve(workspaceRoot(), process.env.SWDB_DATA_DIR || ".data")
}

export function dbPath(): string {
  return resolve(dataDir(), "swdb.sqlite")
}

/**
 * Opens the shared SQLite file. The web process and the worker both call this,
 * so the file runs in WAL mode and writers wait up to busyTimeoutMs for a lock.
 */
export function openDb(options: { path?: string; busyTimeoutMs?: number } = {}) {
  const path = options.path ?? dbPath()
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true })
  const sqlite = new Database(path)
  sqlite.pragma("journal_mode = WAL")
  sqlite.pragma("synchronous = NORMAL")
  sqlite.pragma("foreign_keys = ON")
  sqlite.pragma(`busy_timeout = ${options.busyTimeoutMs ?? 5000}`)
  sqlite.exec(bootstrapSql)
  return Object.assign(drizzle(sqlite, { schema }), { sqlite })
}

// M2 replaces this with Drizzle migrations. Until then the one table is created on open.
const bootstrapSql = `
CREATE TABLE IF NOT EXISTS process_heartbeats (
  process TEXT PRIMARY KEY,
  pid INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  beat_at INTEGER NOT NULL
);
`
