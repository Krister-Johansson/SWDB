import { createServerFn } from "@tanstack/react-start"
import { getSecrets } from "./context"

/** Names and dates. No server function returns a secret value. */
export const listSecrets = createServerFn({ method: "GET" }).handler(() => {
  return getSecrets().secrets.list()
})

export const saveSecret = createServerFn({ method: "POST" })
  .validator((data: { name: string; value: string }) => ({
    name: String(data.name).trim(),
    value: String(data.value),
  }))
  .handler(({ data }) => {
    getSecrets().secrets.set(data.name, data.value)
    return { ok: true }
  })

export const deleteSecret = createServerFn({ method: "POST" })
  .validator((data: { name: string }) => ({ name: String(data.name) }))
  .handler(({ data }) => {
    return { deleted: getSecrets().secrets.delete(data.name) }
  })
