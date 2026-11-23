import { createFileRoute, useRouter } from "@tanstack/react-router"
import { useServerFn } from "@tanstack/react-start"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { deleteSecret, listSecrets, saveSecret } from "@/server/secrets"

// biome-ignore lint/suspicious/noTemplateCurlyInString: the literal reference syntax shown to the user
const SECRET_REF = "${secret:NAME}"

export const Route = createFileRoute("/settings/secrets")({
  loader: () => listSecrets(),
  component: SecretsPage,
})

function SecretsPage() {
  const secrets = Route.useLoaderData()
  const router = useRouter()
  const save = useServerFn(saveSecret)
  const remove = useServerFn(deleteSecret)
  const [name, setName] = useState("")
  const [value, setValue] = useState("")
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    try {
      await save({ data: { name, value } })
      setName("")
      setValue("")
      await router.invalidate()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">Secrets</h1>
        <p className="text-muted-foreground">
          Values are encrypted and never shown again after you save them. Refer to a secret in
          config as <code className="font-mono">{SECRET_REF}</code>.
        </p>
      </div>

      <form method="post" onSubmit={onSubmit} className="grid max-w-xl gap-3 rounded-lg border p-4">
        <div className="grid gap-1.5">
          <Label htmlFor="secret-name">Name</Label>
          <Input
            id="secret-name"
            value={name}
            onChange={(e) => setName(e.target.value.toUpperCase())}
            placeholder="OPENROUTER_API_KEY"
            autoComplete="off"
            required
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="secret-value">Value</Label>
          <Input
            id="secret-value"
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoComplete="new-password"
            required
          />
        </div>
        {error && <p className="text-destructive">{error}</p>}
        <Button type="submit" className="self-start">
          Save secret
        </Button>
      </form>

      <section className="max-w-xl">
        {secrets.length === 0 ? (
          <p className="text-muted-foreground">No secrets yet.</p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {secrets.map((s) => (
              <li key={s.name} className="flex items-center justify-between gap-4 px-4 py-2">
                <div>
                  <div className="font-mono">{s.name}</div>
                  <div className="text-xs text-muted-foreground">
                    updated {new Date(s.updatedAt).toLocaleString()}
                  </div>
                </div>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={async () => {
                    await remove({ data: { name: s.name } })
                    await router.invalidate()
                  }}
                >
                  Delete
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
