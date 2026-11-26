import { Link } from "react-router";
import { DownloadIcon } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { Status, startedAt } from "@/components/status";
import { score } from "../../src/reports.ts";
import { getRun } from "../workspace.server";
import type { Route } from "./+types/run";

export function loader({ params }: Route.LoaderArgs) {
  const run = getRun(params.id);
  const completed = run.reports.filter(report => report.status === "completed").length;
  const grade = run.pair !== null && completed === 2 ? score(run) : null;
  return { run, completed, grade };
}

const grades: Record<string, string> = {
  "P-C": "Both correct", "P-V": "Both predicted vulnerable", "P-B": "Both predicted benign", "P-R": "Both reversed",
};

export default function RunRoute({ loaderData: { run, completed, grade } }: Route.ComponentProps) {
  const failed = run.reports.filter(report => report.status === "failed").length;
  return <>
    <header className="mb-5 flex flex-wrap items-center justify-between gap-3">
      <div><p className="hint mb-1">Run #{run.id} · {startedAt(run.reports[0].startedAt)}</p>
        <h1 className="text-2xl">{run.pair === null ? "Single function" : `Pair ${run.pair}`}</h1></div>
      {grade && <a href={`/runs/${run.id}/result.jsonl`} download className={buttonVariants({ variant: "outline", size: "sm" })}>
        <DownloadIcon />Download result.jsonl</a>}
    </header>
    <p role="status" className="mb-4">{completed}/{run.reports.length} completed{failed > 0 && ` · ${failed} failed`}</p>
    {run.pair !== null && <section className="mb-5 rounded-md border bg-muted/30 p-4">
      <h2>Course grade</h2><p className="mt-2">{grade ? `${grade} · ${grades[grade]}` : "Not scored. Both reports must complete."}</p>
    </section>}
    <h2>Reports</h2><ul className="mt-2 divide-y">{run.reports.map(report => <li key={report.id}>
      <Link to={`/reports/${report.id}`} className="flex items-center justify-between gap-3 py-3 text-sm hover:underline">
        <span>Sample {report.idx} <span className="hint">· Report #{report.id}</span></span><Status report={report} />
      </Link></li>)}</ul>
  </>;
}
