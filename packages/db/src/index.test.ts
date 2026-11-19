import { isAbsolute, resolve } from "node:path"
import { afterEach, expect, test } from "vitest"
import { dataDir } from "./index.ts"

const original = process.env.SWDB_DATA_DIR

afterEach(() => {
  if (original === undefined) delete process.env.SWDB_DATA_DIR
  else process.env.SWDB_DATA_DIR = original
})

test("the default data folder is .data in the workspace root", () => {
  delete process.env.SWDB_DATA_DIR
  expect(dataDir()).toBe(resolve(import.meta.dirname, "../../..", ".data"))
})

test("a relative SWDB_DATA_DIR resolves against the workspace root, not the working directory", () => {
  process.env.SWDB_DATA_DIR = "tmp/data"
  expect(dataDir()).toBe(resolve(import.meta.dirname, "../../..", "tmp/data"))
})

test("an absolute SWDB_DATA_DIR is used as it is", () => {
  const dir = resolve("/tmp/swdb-data")
  process.env.SWDB_DATA_DIR = dir
  expect(isAbsolute(dataDir())).toBe(true)
  expect(dataDir()).toBe(dir)
})
