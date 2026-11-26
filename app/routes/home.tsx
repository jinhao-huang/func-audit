import { useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useFetcher, useLocation, useRevalidator, useRouteLoaderData } from "react-router";
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
import { selectPairs } from "../../src/selection.ts";
import type { loader as catalogLoader } from "./course-pairs";
import type { loader as runLoader } from "./run";
import type { loader as reportLoader } from "./report";
import type { action } from "./submit";
import { openWorkspace } from "../workspace.server";
import type { Route } from "./+types/home";

export const meta = () => [{ title: "Audit workspace · Function Audit" }];

export function loader() {
  const capacity = openWorkspace();
  return { capacity, runs: listRuns(), model: configuredModelId() };
}

function NewAudit({ model, capacity }: { model: string; capacity: number }) {
  const fetcher = useFetcher<typeof action>();
  const catalog = useFetcher<typeof catalogLoader>();
  const [selection, setSelection] = useState("1");
  let preview = catalog.data?.error ?? "";
  if (catalog.data && !preview) {
    try {
      const numbers = selectPairs(selection, catalog.data.ids.length);
      const reports = new Set(numbers.flatMap(n => catalog.data!.ids[n - 1])).size;
      preview = `${numbers.length} ${numbers.length === 1 ? "pair" : "pairs"} · ${reports} reports`;
    } catch (error) { preview = (error as Error).message; }
  }
  return <Dialog onOpenChange={open => { if (open) void catalog.load("/course-pairs"); }}>
    <DialogTrigger render={<Button size="sm" />}><PlusIcon />New audit</DialogTrigger>
    <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
      <DialogHeader><DialogTitle>New audit</DialogTitle><DialogDescription>
        Review prepared course pairs or submit a single function.
      </DialogDescription></DialogHeader>
      <Tabs defaultValue="pair">
        <TabsList aria-label="Audit input"><TabsTrigger value="pair">Course pairs</TabsTrigger>
          <TabsTrigger value="sample">Single function</TabsTrigger></TabsList>
        {(["pair", "sample"] as const).map(mode => <TabsContent key={mode} value={mode}>
          <fetcher.Form method="post" action="/runs" className="grid gap-3 pt-2">
            {mode === "pair" ? <><Label htmlFor="pair">Pair numbers or ranges</Label>
              <Input id="pair" name="pair" placeholder="1-10,15 or all" aria-describedby="pair-help" value={selection}
                onChange={event => setSelection(event.target.value)} required />
              <p id="pair-help" className="hint">Enter a number, a range such as 1-10,15, or all.</p>
              <p role="status" className="text-sm">{preview}</p></> :
              <><Label htmlFor="sample">Sample JSON</Label>
                <Textarea id="sample" name="sample" required className="min-h-24 font-mono text-xs"
                  placeholder={'{"idx":1,"func":"int one() { return 1; }"}'} /></>}
            {fetcher.data?.mode === mode && <p role="alert" className="text-destructive">{fetcher.data.error}</p>}
            <p className="hint break-all">Model · {model} · Project concurrency {capacity}</p>
            <Button type="submit" disabled={fetcher.state !== "idle"}>Start audit</Button>
          </fetcher.Form>
        </TabsContent>)}
      </Tabs>
    </DialogContent>
  </Dialog>;
}

type SidebarRun = ReturnType<typeof listRuns>[number];

function RunItem({ run, current, currentReport }: {
  run: SidebarRun; current?: ReturnType<typeof runLoader>; currentReport?: number;
}) {
  const details = useFetcher<typeof runLoader>();
  const [open, setOpen] = useState(Boolean(current || currentReport));
  const data = current ?? details.data;
  const { load } = details;
  useEffect(() => {
    if (run.pairs && open && !data) void load(`/runs/${run.id}`);
  }, [open, data, load, run.id, run.pairs]);
  if (!run.pairs) return <NavLink className="task-link" to={`/reports/${run.firstReport}`}>
    <span>Sample {run.idx} · Run #{run.id}</span><Status report={run} />
  </NavLink>;
  const reports = new Map(data?.run.reports.map(report => [report.id, report]));
  return <Collapsible open={open} onOpenChange={setOpen} className="shrink-0">
    <div className="flex items-center">
      <NavLink to={`/runs/${run.id}`} className="task-link flex-1">
        <strong>Run #{run.id} · {run.pairs} {run.pairs === 1 ? "pair" : "pairs"}</strong>
        <span className="hint text-xs">{run.finished}/{run.total} finished{run.failed > 0 && ` · ${run.failed} failed`}{run.canceled > 0 && ` · ${run.canceled} canceled`}</span>
      </NavLink>
      <CollapsibleTrigger render={<Button variant="ghost" size="icon-sm" />} aria-label={`Pairs for run ${run.id}`}><ChevronDownIcon /></CollapsibleTrigger>
    </div>
    <CollapsibleContent className="ml-3 border-l pl-2">
      {data ? data.run.pairs.map(pair => <Collapsible key={pair.number} defaultOpen={run.pairs === 1 || [pair.firstReport, pair.secondReport].includes(currentReport ?? -1)}>
        <CollapsibleTrigger className="task-link w-full text-left">Pair {pair.number}</CollapsibleTrigger>
        <CollapsibleContent>{[pair.firstReport, pair.secondReport].map(id => {
          const report = reports.get(id)!;
          return <NavLink className="task-link" to={`/reports/${id}`} key={id}><span>Sample {report.idx}</span><Status report={report} /></NavLink>;
        })}</CollapsibleContent>
      </Collapsible>) : <p className="hint">Loading pairs…</p>}
    </CollapsibleContent>
  </Collapsible>;
}

export default function Workspace({ loaderData: { runs, model, capacity } }: Route.ComponentProps) {
  const { pathname } = useLocation();
  const selectedRun = useRouteLoaderData<typeof runLoader>("routes/run");
  const selectedReport = useRouteLoaderData<typeof reportLoader>("routes/report")?.report;
  const taskList = useRef<HTMLElement>(null);
  useEffect(() => {
    taskList.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [pathname]);
  const { revalidate } = useRevalidator();
  useEffect(() => {
    const timer = window.setInterval(() => { if (!document.hidden) void revalidate(); }, 5000);
    return () => window.clearInterval(timer);
  }, [revalidate]);

  return <div className="workspace">
    <aside className="tasks">
      <div className="flex items-center justify-between gap-2 px-3 py-4">
        <h2 className="text-base">Runs <span className="count">{runs.length}</span></h2>
        <NewAudit key={pathname} model={model} capacity={capacity} />
      </div>
      <nav ref={taskList} aria-label="Audit tasks" className="task-list">
        {runs.map(run => <RunItem key={`${run.id}-${selectedRun?.run.id === run.id || selectedReport?.runId === run.id}`}
          run={run} current={selectedRun?.run.id === run.id ? selectedRun : undefined}
          currentReport={selectedReport?.runId === run.id ? selectedReport.id : undefined} />)}
      </nav>
    </aside>
    <article key={pathname} className="report-pane min-w-0 overflow-y-auto p-4 sm:p-6"><Outlet /></article>
  </div>;
}
