import { type SQL, sql } from "drizzle-orm"
import { type AnySQLiteColumn, check, integer, text } from "drizzle-orm/sqlite-core"

// Conventions for every table:
// - ids are random UUID strings, generated in the application
// - times are Unix epoch milliseconds in INTEGER columns ending in _at
// - JSON goes in TEXT columns, typed with $type
// - fixed value sets are TEXT columns with a CHECK constraint, so a bad value fails on write

export const id = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID())

export const createdAt = () =>
  integer("created_at")
    .notNull()
    .$defaultFn(() => Date.now())

export const updatedAt = () =>
  integer("updated_at")
    .notNull()
    .$defaultFn(() => Date.now())
    .$onUpdateFn(() => Date.now())

export const bool = (name: string) => integer(name, { mode: "boolean" })

export const json = <T>(name: string) => text(name, { mode: "json" }).$type<T>()

/** CHECK constraint that limits a TEXT column to a fixed list of values. */
export function oneOf(
  name: string,
  column: AnySQLiteColumn,
  values: readonly (string | number)[],
): ReturnType<typeof check> {
  return check(name, sql`${column} in (${literals(values)})`)
}

/** CHECK constraint for a nullable column: null or one of the values. */
export function nullOrOneOf(
  name: string,
  column: AnySQLiteColumn,
  values: readonly (string | number)[],
): ReturnType<typeof check> {
  const condition: SQL = sql`${column} is null or ${column} in (${literals(values)})`
  return check(name, condition)
}

// CHECK constraints are DDL, so the values are written into the SQL as literals, not parameters.
function literals(values: readonly (string | number)[]): SQL {
  const list = values.map((v) =>
    typeof v === "number" ? String(v) : `'${v.replaceAll("'", "''")}'`,
  )
  return sql.raw(list.join(", "))
}
