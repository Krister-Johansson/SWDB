import { resolve } from "node:path"
import { migrate } from "drizzle-orm/better-sqlite3/migrator"
import type { Db } from "./index.ts"

/** Generated SQL migrations, committed next to this package. */
export const migrationsFolder = resolve(import.meta.dirname, "../migrations")

/**
 * Applies every migration the database has not seen yet. Drizzle records applied
 * migrations in __drizzle_migrations, so running it again is a no-op.
 *
 * This module is not exported from the package root, because the web build bundles the
 * root into another folder, where import.meta.dirname no longer points here.
 */
export function migrateDb(db: Db): void {
  migrate(db, { migrationsFolder })
}
