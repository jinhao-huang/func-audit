import { Links, Meta, Outlet, Scripts, ScrollRestoration, Link, isRouteErrorResponse } from "react-router";
import type { Route } from "./+types/root";
import "./app.css";

export function Layout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><head><meta charSet="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='6' fill='%2314546a'/%3E%3Ctext x='10' y='23' font-size='22' fill='white'%3Eƒ%3C/text%3E%3C/svg%3E" /><Meta /><Links /></head><body className="grid h-dvh grid-rows-[auto_minmax(0,1fr)]">
    <header className="border-b bg-card"><div className="shell flex h-16 items-center gap-6">
      <Link className="flex items-center gap-3 font-semibold tracking-tight" to="/">
        <span aria-hidden className="grid size-8 place-items-center rounded-md bg-primary font-mono text-sm text-primary-foreground">ƒ</span>
        Function Audit
      </Link><span className="border-l pl-6 text-sm text-muted-foreground">Workspace</span>
    </div></header>
    <main className="shell py-3 sm:py-4">{children}</main><ScrollRestoration /><Scripts />
  </body></html>;
}

export default function App() { return <Outlet />; }

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const message = isRouteErrorResponse(error) ? String(error.data) : "The workspace could not load this page.";
  return <><h1>Unable to open page</h1><p>{message}</p><Link className="underline" to="/">Return to workspace</Link></>;
}
