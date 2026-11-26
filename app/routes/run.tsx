import { Link } from "react-router";
import { DownloadIcon } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Status, startedAt } from "@/components/status";
import { score, type Summary } from "../../src/reports.ts";
import { getRun } from "../workspace.server";
import type { Route } from "./+types/run";

export function loader({ params }: Route.LoaderArgs) {
  const run = getRun(params.id);
  const counts = { queued: 0, running: 0, completed: 0, failed: 0 };
  for (const report of run.reports) counts[report.status]++;
  return { run, counts, grades: run.pairs.length ? score(run) : null };
}

const labels = {
  "P-C": "Both correct", "P-V": "Both predicted vulnerable", "P-B": "Both predicted benign", "P-R": "Both reversed",
  failed: "Execution failed", pending: "Awaiting results",
};

function ReportLink({ report }: { report: Summary }) {
  return <Link to={`/reports/${report.id}`} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm hover:underline">
    <span>Sample {report.idx} · Report #{report.id}</span>
    <span className="flex items-center gap-2">Label {report.target ?? "—"} · Prediction {report.prediction ?? "—"} <Status report={report} /></span>
  </Link>;
}

export default function RunRoute({ loaderData: { run, counts, grades } }: Route.ComponentProps) {
  const reports = new Map(run.reports.map(report => [report.id, report]));
  const finished = counts.completed + counts.failed;
  return <>
    <header className="mb-5 flex flex-wrap items-center justify-between gap-3">
      <div><p className="hint mb-1">Run #{run.id} · {startedAt(run.reports[0].startedAt)}</p>
        <h1 className="text-2xl">{grades ? `Course evaluation · ${grades.total} ${grades.total === 1 ? "pair" : "pairs"}` : "Single function"}</h1></div>
      {grades?.scored === run.pairs.length && <a href={`/runs/${run.id}/result.jsonl`} download className={buttonVariants({ variant: "outline", size: "sm" })}>
        <DownloadIcon />Download result.jsonl</a>}
    </header>
    <section className="mb-5 flex flex-col gap-2">
      <h2>Execution progress</h2>
      <p role="status">{`${finished}/${run.reports.length} reports finished · ${counts.completed} completed · ${counts.failed} failed · ${counts.running} running · ${counts.queued} queued`}</p>
      <progress className="w-full" aria-label="Reports finished" max={run.reports.length} value={finished} />
    </section>
    {grades ? <>
      <section className="mb-5 rounded-md border bg-muted/30 p-4">
        <h2>Course grades</h2>
        <p className="my-2">{`${grades.scored}/${grades.total} pairs scored · ${grades.counts.failed} failed · ${grades.counts.pending} awaiting results`}</p>
        <div className="flex flex-wrap gap-2">{(["P-C", "P-R", "P-V", "P-B"] as const).map(grade =>
          <Badge key={grade} variant="outline">{grade} · {labels[grade]} · {grades.counts[grade]}</Badge>)}</div>
      </section>
      <h2>Sample pairs</h2>
      {run.pairs.map(({ number, firstReport, secondReport }, i) => {
        const grade = grades.pairs[i].grade;
        return <Collapsible key={number} defaultOpen={run.pairs.length === 1} id={`pair-${number}`} className="border-b">
          <CollapsibleTrigger className="flex w-full flex-wrap items-center justify-between gap-2 py-3 text-left hover:underline">
            <span>Pair {number}</span><Badge variant={grade === "failed" ? "destructive" : "secondary"}>
              {grade.startsWith("P-") ? `${grade} · ` : ""}{labels[grade]}</Badge>
          </CollapsibleTrigger>
          <CollapsibleContent className="pl-3"><ReportLink report={reports.get(firstReport)!} />
            <ReportLink report={reports.get(secondReport)!} /></CollapsibleContent>
        </Collapsible>;
      })}
    </> : <ReportLink report={run.reports[0]} />}
  </>;
}
