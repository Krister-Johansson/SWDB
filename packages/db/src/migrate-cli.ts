import { dbPath, openDb } from "./index.ts"
import { migrateDb } from "./migrate.ts"

// `pnpm db:migrate` from the workspace root. Creates the data folder and the SQLite file
// when they do not exist yet.
const db = openDb()
try {
  migrateDb(db)
  console.log(`[db] migrated ${dbPath()}`)
} finally {
  db.sqlite.close()
}
