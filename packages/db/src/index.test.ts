import { execFileSync } from "node:child_process"
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

// The web process and the worker start in different folders. Each must resolve the same
// data folder, so this runs dataDir() in a child process started in each of them.
const root = resolve(import.meta.dirname, "../../..")
function dataDirFrom(cwd: string, override?: string): string {
  const env = { ...process.env }
  delete env.SWDB_DATA_DIR
  if (override !== undefined) env.SWDB_DATA_DIR = override
  const script = `import(${JSON.stringify(resolve(import.meta.dirname, "index.ts"))}).then((m) => console.log(m.dataDir()))`
  return execFileSync(process.execPath, ["-e", script], { cwd, env, encoding: "utf8" }).trim()
}

test.each(["apps/web", "apps/worker"])("%s resolves the shared data folder", (app) => {
  const cwd = resolve(root, app)
  expect(dataDirFrom(cwd)).toBe(resolve(root, ".data"))
  expect(dataDirFrom(cwd, "tmp/data")).toBe(resolve(root, "tmp/data"))
})
