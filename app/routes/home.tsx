import { useEffect, useRef } from "react";
import { NavLink, Outlet, useFetcher, useLocation, useRevalidator } from "react-router";
import { ChevronDownIcon, PlusIcon } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Status } from "@/components/status";
import { configuredModelId } from "../../src/project-api.ts";
import { listRuns } from "../../src/reports.ts";
import type { action } from "./submit";
import { openWorkspace } from "../workspace.server";
import type { Route } from "./+types/home";

export const meta = () => [{ title: "Audit workspace · Function Audit" }];

export function loader() {
  openWorkspace();
  return { runs: listRuns(), model: configuredModelId() };
}

function NewAudit({ model }: { model: string }) {
  const fetcher = useFetcher<typeof action>();
  return <Dialog>
    <DialogTrigger render={<Button size="sm" />}><PlusIcon />New audit</DialogTrigger>
    <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
      <DialogHeader><DialogTitle>New audit</DialogTitle><DialogDescription>
        Review a prepared course pair or submit a single function.
      </DialogDescription></DialogHeader>
      <Tabs defaultValue="pair">
        <TabsList aria-label="Audit input"><TabsTrigger value="pair">Course pair</TabsTrigger>
          <TabsTrigger value="sample">Single function</TabsTrigger></TabsList>
        {(["pair", "sample"] as const).map(mode => <TabsContent key={mode} value={mode}>
          <fetcher.Form method="post" action="/runs" className="grid gap-3 pt-2">
            {mode === "pair" ? <><Label htmlFor="pair">Course pair number</Label>
              <Input id="pair" name="pair" type="number" min="1" defaultValue="1" required /></> :
              <><Label htmlFor="sample">Sample JSON</Label>
                <Textarea id="sample" name="sample" required className="min-h-24 font-mono text-xs"
                  placeholder={'{"idx":1,"func":"int one() { return 1; }"}'} /></>}
            {fetcher.data?.mode === mode && <p role="alert" className="text-destructive">{fetcher.data.error}</p>}
            <p className="hint break-all">Model · {model}</p>
            <Button type="submit" disabled={fetcher.state !== "idle"}>Start audit</Button>
          </fetcher.Form>
        </TabsContent>)}
      </Tabs>
    </DialogContent>
  </Dialog>;
}

export default function Workspace({ loaderData: { runs, model } }: Route.ComponentProps) {
  const { pathname } = useLocation();
  const taskList = useRef<HTMLElement>(null);
  useEffect(() => {
    taskList.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [pathname]);
  const { revalidate } = useRevalidator();
  const backgroundAudit = runs.some(run => run.reports.some(report => report.status === "started"));
  useEffect(() => {
    if (!backgroundAudit) return;
    const timer = window.setInterval(() => { void revalidate(); }, 5000);
    return () => window.clearInterval(timer);
  }, [backgroundAudit, revalidate]);

  return <div className="workspace">
    <aside className="tasks">
      <div className="flex items-center justify-between gap-2 px-3 py-4">
        <h2 className="text-base">Runs <span className="count">{runs.length}</span></h2>
        <NewAudit key={pathname} model={model} />
      </div>
      <nav ref={taskList} aria-label="Audit tasks" className="task-list">
        {runs.map(run => {
          const [first] = run.reports;
          if (run.pair === null) return <NavLink key={run.id} className="task-link" to={`/reports/${first.id}`}>
            <span>Sample {first.idx} · Run #{run.id}</span><Status report={first} /></NavLink>;
          const selected = pathname === `/runs/${run.id}` || run.reports.some(report => pathname === `/reports/${report.id}`);
          return <Collapsible key={`${run.id}-${selected}`} defaultOpen={selected} className="shrink-0">
            <div className="flex items-center">
              <NavLink to={`/runs/${run.id}`} className="task-link flex-1">
                <strong>Pair {run.pair} · Run #{run.id}</strong>
                <span className="hint text-xs">{run.reports.filter(report => report.status === "completed").length}/2 completed
                  {run.reports.some(report => report.status === "failed") && " · Failed"}</span>
              </NavLink>
              <CollapsibleTrigger render={<Button variant="ghost" size="icon-sm" />} aria-label={`Reports for run ${run.id}`}>
                <ChevronDownIcon /></CollapsibleTrigger>
            </div>
            <CollapsibleContent className="ml-3 border-l pl-1">
              {run.reports.map(report => <NavLink className="task-link" to={`/reports/${report.id}`} key={report.id}>
                <span>Sample {report.idx}</span><Status report={report} /></NavLink>)}
            </CollapsibleContent>
          </Collapsible>;
        })}
      </nav>
    </aside>
    <article key={pathname} className="report-pane min-w-0 overflow-y-auto p-4 sm:p-6"><Outlet /></article>
  </div>;
}
