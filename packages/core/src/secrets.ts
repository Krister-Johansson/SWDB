import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { type Db, dataDir, schema } from "@swdb/db"
import { desc, eq } from "drizzle-orm"

// Envelope encryption. The master key is 32 random bytes in a 0600 file outside the
// database. It wraps data keys, which are stored in data_keys. Secret values and channel
// configs are encrypted with AES-256-GCM under the newest data key. The additional
// authenticated data binds each ciphertext to its row, so a ciphertext copied to another
// secret name fails to decrypt.

const KEY_BYTES = 32
const NONCE_BYTES = 12
const TAG_BYTES = 16

/** Secret names are upper case, digits and underscores, starting with a letter. */
export const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/

/** Matches ${secret:NAME} references in config values and tool arguments. */
const REFERENCE = /\$\{secret:([A-Z][A-Z0-9_]{0,63})\}/g

export function masterKeyPath(): string {
  return process.env.SWDB_MASTER_KEY_FILE || resolve(dataDir(), "master.key")
}

/**
 * Reads the master key, creating it on first use. Refuses a key file that group or others
 * can read, because anyone who can read it can decrypt every secret.
 */
export function loadMasterKey(path = masterKeyPath()): Buffer {
  if (!existsSync(path)) {
    writeFileSync(path, randomBytes(KEY_BYTES), { mode: 0o600, flag: "wx" })
    chmodSync(path, 0o600)
  }
  const mode = statSync(path).mode & 0o777
  if (mode & 0o077) {
    throw new Error(
      `${path} has mode ${mode.toString(8)}; it must be 600. Run: chmod 600 "${path}"`,
    )
  }
  const key = readFileSync(path)
  if (key.length !== KEY_BYTES) throw new Error(`${path} must hold exactly ${KEY_BYTES} bytes`)
  return key
}

function seal(key: Buffer, plaintext: Buffer, aad: string) {
  const nonce = randomBytes(NONCE_BYTES)
  const cipher = createCipheriv("aes-256-gcm", key, nonce)
  cipher.setAAD(Buffer.from(aad))
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()])
  return { ciphertext, nonce }
}

function open(key: Buffer, ciphertext: Buffer, nonce: Buffer, aad: string): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", key, nonce)
  decipher.setAAD(Buffer.from(aad))
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - TAG_BYTES))
  return Buffer.concat([
    decipher.update(ciphertext.subarray(0, ciphertext.length - TAG_BYTES)),
    decipher.final(),
  ])
}

export type Sealed = { ciphertext: Buffer; nonce: Buffer; keyVersion: number }

/** Encrypts and decrypts with the data keys. One instance per process is enough. */
export class Vault {
  readonly #db: Db
  readonly #masterKey: Buffer
  readonly #keys = new Map<number, Buffer>()

  constructor(db: Db, masterKey: Buffer) {
    this.#db = db
    this.#masterKey = masterKey
  }

  /** The newest data key, created on first use. */
  #current(): { version: number; key: Buffer } {
    const row = this.#db.select().from(schema.dataKeys).orderBy(desc(schema.dataKeys.version)).get()
    if (row) return { version: row.version, key: this.#key(row.version) }
    const key = randomBytes(KEY_BYTES)
    const wrapped = seal(this.#masterKey, key, "data_key:1")
    // Two processes may race to create the first key. The primary key keeps one; the
    // loser reads the winner's key.
    this.#db
      .insert(schema.dataKeys)
      .values({ version: 1, wrappedKey: wrapped.ciphertext, nonce: wrapped.nonce })
      .onConflictDoNothing()
      .run()
    return { version: 1, key: this.#key(1) }
  }

  #key(version: number): Buffer {
    const cached = this.#keys.get(version)
    if (cached) return cached
    const row = this.#db
      .select()
      .from(schema.dataKeys)
      .where(eq(schema.dataKeys.version, version))
      .get()
    if (!row) throw new Error(`data key ${version} is missing`)
    const key = open(this.#masterKey, row.wrappedKey, row.nonce, `data_key:${version}`)
    this.#keys.set(version, key)
    return key
  }

  encrypt(plaintext: string, aad: string): Sealed {
    const { version, key } = this.#current()
    return { ...seal(key, Buffer.from(plaintext, "utf8"), aad), keyVersion: version }
  }

  decrypt(sealed: Sealed, aad: string): string {
    return open(this.#key(sealed.keyVersion), sealed.ciphertext, sealed.nonce, aad).toString("utf8")
  }
}

export type SecretInfo = { name: string; createdAt: number; updatedAt: number }

/** The secret store. Values go in through set() and come out only inside the harness. */
export class SecretStore {
  readonly #db: Db
  readonly #vault: Vault

  constructor(db: Db, vault: Vault) {
    this.#db = db
    this.#vault = vault
  }

  /** Creates or replaces a secret. */
  set(name: string, value: string): void {
    if (!SECRET_NAME.test(name)) {
      throw new Error("Secret names use A-Z, 0-9 and _, start with a letter, max 64 characters")
    }
    if (value.length === 0) throw new Error("A secret value cannot be empty")
    const sealed = this.#vault.encrypt(value, `secret:${name}`)
    this.#db
      .insert(schema.secrets)
      .values({ name, ...sealed })
      .onConflictDoUpdate({
        target: schema.secrets.name,
        set: { ...sealed, updatedAt: Date.now() },
      })
      .run()
  }

  delete(name: string): boolean {
    return this.#db.delete(schema.secrets).where(eq(schema.secrets.name, name)).run().changes > 0
  }

  /** Names and dates only. There is no way to list values. */
  list(): SecretInfo[] {
    return this.#db
      .select({
        name: schema.secrets.name,
        createdAt: schema.secrets.createdAt,
        updatedAt: schema.secrets.updatedAt,
      })
      .from(schema.secrets)
      .orderBy(schema.secrets.name)
      .all()
  }

  has(name: string): boolean {
    return (
      this.#db
        .select({ name: schema.secrets.name })
        .from(schema.secrets)
        .where(eq(schema.secrets.name, name))
        .get() !== undefined
    )
  }

  /** The plain value. Only the harness calls this, at the moment it needs the value. */
  reveal(name: string): string {
    const row = this.#db.select().from(schema.secrets).where(eq(schema.secrets.name, name)).get()
    if (!row) throw new Error(`Unknown secret ${name}`)
    return this.#vault.decrypt(row, `secret:${name}`)
  }

  /** Every stored value with its name, for building a redactor. */
  revealAll(): Map<string, string> {
    const rows = this.#db.select().from(schema.secrets).all()
    return new Map(rows.map((row) => [row.name, this.#vault.decrypt(row, `secret:${row.name}`)]))
  }

  /**
   * Replaces ${secret:NAME} in every string inside value. Throws on an unknown name, so a
   * typo fails the call instead of sending the literal reference.
   */
  substitute<T>(value: T): T {
    return mapStrings(value, (s) => s.replace(REFERENCE, (_, name: string) => this.reveal(name)))
  }

  /** A redactor for the values stored right now. Build a new one after a secret changes. */
  redactor(): Redactor {
    return new Redactor(this.revealAll())
  }
}

/** Names referenced as ${secret:NAME} anywhere inside value. */
export function secretReferences(value: unknown): string[] {
  const names = new Set<string>()
  mapStrings(value, (s) => {
    for (const match of s.matchAll(REFERENCE)) names.add(match[1] as string)
    return s
  })
  return [...names]
}

/**
 * Replaces secret values with [secret:NAME] in text and in every string inside objects.
 * Values shorter than 4 characters are not redacted, because they would match ordinary
 * text everywhere.
 */
export class Redactor {
  readonly #entries: [string, string][]

  constructor(values: Map<string, string>) {
    // Longest first, so a secret that contains another is replaced whole.
    this.#entries = [...values]
      .filter(([, v]) => v.length >= 4)
      .sort((a, b) => b[1].length - a[1].length)
  }

  text(input: string): string {
    let out = input
    for (const [name, value] of this.#entries) out = out.replaceAll(value, `[secret:${name}]`)
    return out
  }

  value<T>(input: T): T {
    return mapStrings(input, (s) => this.text(s))
  }
}

function mapStrings<T>(value: T, fn: (s: string) => string): T {
  if (typeof value === "string") return fn(value) as T
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn)) as T
  if (value && typeof value === "object" && !Buffer.isBuffer(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, fn)])) as T
  }
  return value
}

/** Opens the vault and secret store for this process. */
export function openSecrets(db: Db, masterKey = loadMasterKey()) {
  const vault = new Vault(db, masterKey)
  return { vault, secrets: new SecretStore(db, vault) }
}
