import { useEffect, useRef } from "react";
import { NavLink, Outlet, useFetcher, useLocation, useParams, useRevalidator } from "react-router";
import { PlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Status, startedAt } from "@/components/status";
import { configuredModelId } from "../../src/project-api.ts";
import { listReports } from "../../src/reports.ts";
import type { action } from "./submit";
import { openWorkspace } from "../workspace.server";
import type { Route } from "./+types/home";

export const meta = () => [{ title: "Audit workspace · Function Audit" }];

export function loader() {
  openWorkspace();
  return { reports: listReports(), model: configuredModelId() };
}

function NewAudit({ model }: { model: string }) {
  const fetcher = useFetcher<typeof action>();
  return <Dialog>
    <DialogTrigger render={<Button size="sm" />}><PlusIcon />New audit</DialogTrigger>
    <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
      <DialogHeader><DialogTitle>New audit</DialogTitle><DialogDescription>
        Enter a sample ID from <code>data/test.jsonl</code> or paste one JSON sample.
      </DialogDescription></DialogHeader>
      <fetcher.Form method="post" action="/audits" className="grid gap-4">
        <div className="grid gap-2"><Label htmlFor="idx">Dataset sample ID</Label>
          <Input id="idx" name="idx" inputMode="numeric" placeholder="e.g. 194963" /></div>
        <details><summary className="cursor-pointer font-medium">Paste a JSON sample</summary>
          <Label htmlFor="sample" className="sr-only">Sample JSON</Label>
          <Textarea id="sample" name="sample" className="mt-2 min-h-24 font-mono text-xs"
            placeholder={'{"idx":1,"func":"int one() { return 1; }","target":0}'} /></details>
        {fetcher.data?.error && <p role="alert" className="text-destructive">{fetcher.data.error}</p>}
        <p className="hint break-all">Model · {model}</p>
        <Button type="submit" disabled={fetcher.state !== "idle"}>Start audit</Button>
      </fetcher.Form>
    </DialogContent>
  </Dialog>;
}

export default function Workspace({ loaderData: { reports, model } }: Route.ComponentProps) {
  const { pathname } = useLocation();
  const taskList = useRef<HTMLElement>(null);
  useEffect(() => {
    taskList.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [pathname]);
  const { id } = useParams();
  const { revalidate } = useRevalidator();
  const backgroundAudit = reports.some(report => report.live && report.id !== Number(id));
  useEffect(() => {
    if (!backgroundAudit) return;
    const timer = window.setInterval(() => { void revalidate(); }, 5000);
    return () => window.clearInterval(timer);
  }, [backgroundAudit, revalidate]);

  return <div className="workspace">
    <aside className="tasks">
      <div className="flex items-center justify-between gap-2 px-3 py-4">
        <h2 className="text-base">Tasks <span className="count">{reports.length}</span></h2>
        <NewAudit key={pathname} model={model} />
      </div>
      <nav ref={taskList} aria-label="Audit tasks" className="task-list">
        {reports.map(report => <NavLink key={report.id} to={`/reports/${report.id}`} className="task-link">
          <div className="flex items-center justify-between gap-2">
            <strong className="font-medium">Sample {report.idx}</strong><Status report={report} live={Boolean(report.live)} />
          </div>
          <span className="hint text-xs">#{report.id} · {startedAt(report.startedAt)}</span>
        </NavLink>)}
      </nav>
    </aside>
    <article key={pathname} className="report-pane min-w-0 overflow-y-auto p-4 sm:p-6"><Outlet /></article>
  </div>;
}
