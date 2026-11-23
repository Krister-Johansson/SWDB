// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the strings are ${secret:NAME} references, not templates

import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type Db, openDb, schema } from "@swdb/db"
import { migrateDb } from "@swdb/db/migrate"
import { afterEach, beforeEach, expect, test } from "vitest"
import { loadMasterKey, openSecrets, Redactor, secretReferences } from "./secrets.ts"

let dir: string
let db: Db

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "swdb-secrets-"))
  db = openDb({ path: join(dir, "swdb.sqlite") })
  migrateDb(db)
})

afterEach(() => {
  db.sqlite.close()
  rmSync(dir, { recursive: true, force: true })
})

const keyFile = () => join(dir, "master.key")

test("the master key file is created with mode 600 and reused", () => {
  const first = loadMasterKey(keyFile())
  expect(statSync(keyFile()).mode & 0o777).toBe(0o600)
  expect(loadMasterKey(keyFile()).equals(first)).toBe(true)
})

test("a master key file that others can read is refused", () => {
  loadMasterKey(keyFile())
  chmodSync(keyFile(), 0o644)
  expect(() => loadMasterKey(keyFile())).toThrow(/must be 600/)
})

test("a secret round-trips, and the database holds no plaintext", () => {
  const { secrets } = openSecrets(db, loadMasterKey(keyFile()))
  secrets.set("OPENROUTER_API_KEY", "sk-or-v1-abcdef123456")
  expect(secrets.reveal("OPENROUTER_API_KEY")).toBe("sk-or-v1-abcdef123456")

  const row = db.select().from(schema.secrets).get()
  expect(row?.ciphertext.toString("utf8")).not.toContain("abcdef123456")
  expect(row?.nonce).toHaveLength(12)
  const key = db.select().from(schema.dataKeys).get()
  expect(key?.version).toBe(1)
})

test("setting a secret again replaces the value", () => {
  const { secrets } = openSecrets(db, loadMasterKey(keyFile()))
  secrets.set("TOKEN", "first-value")
  secrets.set("TOKEN", "second-value")
  expect(secrets.reveal("TOKEN")).toBe("second-value")
  expect(secrets.list().map((s) => s.name)).toEqual(["TOKEN"])
})

test("list returns names and dates, never values", () => {
  const { secrets } = openSecrets(db, loadMasterKey(keyFile()))
  secrets.set("A_KEY", "value-one")
  const listed = secrets.list()
  expect(Object.keys(listed[0] ?? {}).sort()).toEqual(["createdAt", "name", "updatedAt"])
  expect(JSON.stringify(listed)).not.toContain("value-one")
})

test("a different master key cannot decrypt", () => {
  openSecrets(db, loadMasterKey(keyFile())).secrets.set("TOKEN", "value-one")
  const other = openSecrets(db, Buffer.alloc(32, 7))
  expect(() => other.secrets.reveal("TOKEN")).toThrow()
})

test("a ciphertext copied to another name does not decrypt", () => {
  const { secrets } = openSecrets(db, loadMasterKey(keyFile()))
  secrets.set("REAL", "value-one")
  secrets.set("COPY", "value-two")
  db.sqlite.exec(
    "update secrets set ciphertext = (select ciphertext from secrets where name = 'REAL'), nonce = (select nonce from secrets where name = 'REAL') where name = 'COPY'",
  )
  expect(() => secrets.reveal("COPY")).toThrow()
})

test("a second process with the same master key reads the same secrets", () => {
  const masterKey = loadMasterKey(keyFile())
  openSecrets(db, masterKey).secrets.set("TOKEN", "shared-value")
  const other = openDb({ path: join(dir, "swdb.sqlite") })
  expect(openSecrets(other, masterKey).secrets.reveal("TOKEN")).toBe("shared-value")
  other.sqlite.close()
})

test("bad names and empty values are refused", () => {
  const { secrets } = openSecrets(db, loadMasterKey(keyFile()))
  expect(() => secrets.set("lower", "x")).toThrow(/Secret names/)
  expect(() => secrets.set("1ABC", "x")).toThrow(/Secret names/)
  expect(() => secrets.set("OK", "")).toThrow(/empty/)
})

test("substitute replaces ${secret:NAME} inside nested config, and fails on an unknown name", () => {
  const { secrets } = openSecrets(db, loadMasterKey(keyFile()))
  secrets.set("GH_TOKEN", "ghp_123456")
  const config = {
    command: "npx",
    env: { GITHUB_TOKEN: "${secret:GH_TOKEN}" },
    headers: ["Bearer ${secret:GH_TOKEN}"],
    port: 3,
  }
  expect(secrets.substitute(config)).toEqual({
    command: "npx",
    env: { GITHUB_TOKEN: "ghp_123456" },
    headers: ["Bearer ghp_123456"],
    port: 3,
  })
  expect(() => secrets.substitute("${secret:MISSING}")).toThrow(/Unknown secret MISSING/)
  expect(secretReferences(config)).toEqual(["GH_TOKEN"])
})

test("the redactor replaces values in text and nested objects", () => {
  const { secrets } = openSecrets(db, loadMasterKey(keyFile()))
  secrets.set("GH_TOKEN", "ghp_123456")
  secrets.set("PIN", "123")
  const redact = secrets.redactor()
  expect(redact.text("token ghp_123456 used")).toBe("token [secret:GH_TOKEN] used")
  expect(redact.value({ out: ["x ghp_123456"], code: 123 })).toEqual({
    out: ["x [secret:GH_TOKEN]"],
    code: 123,
  })
  // Values under 4 characters are left alone.
  expect(redact.text("pin 123")).toBe("pin 123")
})

test("a longer secret that contains a shorter one is redacted whole", () => {
  const redact = new Redactor(
    new Map([
      ["SHORT", "abcd"],
      ["LONG", "abcd-efgh"],
    ]),
  )
  expect(redact.text("abcd-efgh and abcd")).toBe("[secret:LONG] and [secret:SHORT]")
})
