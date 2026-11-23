import { openSecrets } from "@swdb/core/secrets"
import { getDb } from "./db"

// Server-only singletons. Import this module only from inside server function handlers, so
// the client bundle never pulls in the database or the secret store.

type Secrets = ReturnType<typeof openSecrets>
const holder = globalThis as typeof globalThis & { __swdbSecrets?: Secrets }

export function getSecrets(): Secrets {
  holder.__swdbSecrets ??= openSecrets(getDb())
  return holder.__swdbSecrets
}
