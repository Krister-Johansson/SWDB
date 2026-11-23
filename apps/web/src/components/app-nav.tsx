import { Link } from "@tanstack/react-router"

const links = [
  { to: "/", label: "Overview" },
  { to: "/agents", label: "Agents" },
  { to: "/settings/secrets", label: "Secrets" },
] as const

export function AppNav() {
  return (
    <header className="border-b">
      <nav className="mx-auto flex max-w-5xl items-center gap-6 px-4 py-3 text-sm">
        <span className="font-semibold tracking-tight">SWDB</span>
        {links.map((link) => (
          <Link
            key={link.to}
            to={link.to}
            activeOptions={{ exact: link.to === "/" }}
            className="text-muted-foreground hover:text-foreground"
            activeProps={{ className: "text-foreground font-medium" }}
          >
            {link.label}
          </Link>
        ))}
      </nav>
    </header>
  )
}
