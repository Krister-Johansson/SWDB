import { readHeartbeat } from "@swdb/db/heartbeat"
import { createServerFn } from "@tanstack/react-start"
import { getDb } from "./db"

/** Reads the worker's heartbeat row from the shared SQLite file. */
export const getWorkerStatus = createServerFn({ method: "GET" }).handler(() => {
  return readHeartbeat(getDb(), "worker")
})
