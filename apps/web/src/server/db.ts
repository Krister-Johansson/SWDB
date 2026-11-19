import type { Db } from "@swdb/db"
import { openDb } from "@swdb/db"

// Vite reloads server modules in development. Keeping the handle on globalThis
// stops every reload from opening another connection to the SQLite file.
const holder = globalThis as typeof globalThis & { __swdbDb?: Db }

export function getDb(): Db {
  holder.__swdbDb ??= openDb()
  return holder.__swdbDb
}
