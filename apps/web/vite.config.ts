import tailwindcss from "@tailwindcss/vite"
import { devtools } from "@tanstack/devtools-vite"
import { tanstackStart } from "@tanstack/react-start/plugin/vite"
import viteReact from "@vitejs/plugin-react"
import { defineConfig } from "vite"

const config = defineConfig({
  resolve: { tsconfigPaths: true },
  // better-sqlite3 loads a native binary by path, so the server build must not bundle it.
  ssr: { external: ["better-sqlite3"] },
  plugins: [devtools(), tailwindcss(), tanstackStart(), viteReact()],
})

export default config
