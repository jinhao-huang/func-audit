import { useEffect, useState } from "react";
import { useRevalidator } from "react-router";
import { DownloadIcon } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Activity } from "@/components/activity";
import { startedAt, Status } from "@/components/status";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { buttonVariants } from "@/components/ui/button";
import { CodeBlock, CodeBlockContent, CodeBlockHeader, CodeBlockTitle } from "@/components/ui/code-block";
import type { Entry } from "../../src/reports.ts";
import { getReport } from "../workspace.server";
import type { Route } from "./+types/report";

export const meta = ({ params }: Route.MetaArgs) => [{ title: `Report #${params.id} · Function Audit` }];
export function loader({ params }: Route.LoaderArgs) { return getReport(params.id); }

export default function ReportRoute({ loaderData: { report, entries, legacy } }: Route.ComponentProps) {
  const { revalidate } = useRevalidator();
  const [updates, setUpdates] = useState<Entry[]>([]);
  const [reconnecting, setReconnecting] = useState(false);
  const cursor = entries.at(-1)?.seq ?? 0;
  const live = report.status === "started" && cursor > 0;
  useEffect(() => {
    if (!live) return;
    const source = new EventSource(`/reports/${report.id}/events?after=${cursor}`);
    source.onopen = () => setReconnecting(false);
    source.onerror = () => setReconnecting(true);
    source.onmessage = message => {
      const entry: Entry = JSON.parse(message.data);
      setUpdates(previous => (previous.at(-1)?.seq ?? cursor) >= entry.seq ? previous : [...previous, entry]);
    };
    source.addEventListener("finished", () => { source.close(); void revalidate(); });
    return () => source.close();
  }, [report.id, cursor, live, revalidate]);
  const history = live ? entries.concat(updates.filter(entry => entry.seq > cursor)) : entries;
  const review = history.findLast(({ event }) => event.kind === "review")?.event;
  const prepare = history.findLast(({ event }) => event.kind === "prepare")?.event;
  const snapshot = review?.kind === "review" ? review.snapshot : legacy?.snapshot;
  const stage = review ? "Reviewing the function" : prepare?.kind === "prepare" && prepare.snapshot
    ? "Preparing the source snapshot" : "Starting the audit";
  return <>
    <header className="mb-5 flex flex-wrap items-center justify-between gap-3">
      <div>
        <p className="hint mb-1">Sample {report.idx} · {startedAt(report.startedAt)}</p>
        <h1 className="text-2xl">Report #{report.id}</h1>
      </div>
      {report.status === "completed" && <a href={`/reports/${report.id}/result.jsonl`} download
        className={buttonVariants({ variant: "outline", size: "sm" })}><DownloadIcon />Download result.jsonl</a>}
    </header>
    <Tabs defaultValue="verdict" className="report-tabs min-w-0 gap-5">
      <div className="shrink-0 overflow-x-auto border-b pb-1">
        <TabsList variant="line" aria-label="Report sections">
          <TabsTrigger value="verdict">Verdict</TabsTrigger>
          <TabsTrigger value="evidence">Evidence</TabsTrigger>
          <TabsTrigger value="tools">Tools</TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="verdict" className="min-w-0 space-y-5">
        <div className="flex items-center gap-3"><h2>Audit result</h2><Status report={report} live={live} /></div>
        {live && <p role="status" className="flex items-center gap-3"><progress className="w-16" aria-label="Audit in progress" />
          {reconnecting ? "Reconnecting to the audit…" : stage}</p>}
        {report.status === "started" && !live && <p className="hint">This earlier audit has no recorded outcome.</p>}
        <dl className="grid gap-x-8 gap-y-3 rounded-md border bg-muted/30 p-4 sm:grid-cols-3">
          <div><dt className="hint">Execution</dt><dd>{report.status === "completed" ? "Completed" : report.status === "failed" ? "Failed" : live ? "Running" : "Unfinished"}</dd></div>
          <div><dt className="hint">Model prediction</dt><dd>{report.prediction == null ? "No prediction" : report.prediction === 1 ? "Potential vulnerability" : "No finding"}</dd></div>
          <div><dt className="hint">Reference label</dt><dd>{report.target == null ? "Unlabeled" : report.target === 1 ? "Vulnerable" : "Benign"}</dd></div>
        </dl>
        {report.reason && <section><h3 className="font-semibold">Reasoning</h3><p className="mt-2 max-w-[80ch] whitespace-pre-line leading-relaxed wrap-anywhere">{report.reason}</p></section>}
        {report.error && <p className="wrap-anywhere text-destructive">{report.error}</p>}
        <p className="hint break-all">Model · {report.model}</p>
      </TabsContent>
      <TabsContent value="evidence" className="min-w-0 space-y-6">
        <section><h2>Cited evidence <span className="count">{report.evidence?.length ?? 0}</span></h2>
          {report.evidence?.length ? <div className="mt-4 space-y-3">{report.evidence.map((item, i) =>
            <CodeBlock key={i}><CodeBlockHeader><CodeBlockTitle className="whitespace-normal wrap-anywhere">
              {item.path ?? "Submitted function"} · L{item.startLine}–{item.endLine}</CodeBlockTitle></CodeBlockHeader>
              <CodeBlockContent lineNumbers startLine={item.startLine}>{item.source}</CodeBlockContent></CodeBlock>)}</div>
            : <p className="hint mt-2">No citations recorded.</p>}
        </section>
        {snapshot && <section><h2>Source snapshot</h2><p className="mt-2 break-all">{snapshot.repository} · {snapshot.revision.slice(0, 10)}</p>
          <p className="hint break-all">{snapshot.path} · L{snapshot.startLine}–{snapshot.endLine}</p></section>}
        <Collapsible><CollapsibleTrigger className={buttonVariants({ variant: "outline" })}>Submitted function</CollapsibleTrigger>
          <CollapsibleContent><CodeBlock className="mt-3"><CodeBlockContent lineNumbers className="max-h-96">{report.source}</CodeBlockContent></CodeBlock></CollapsibleContent>
        </Collapsible>
      </TabsContent>
      <TabsContent value="tools" className="min-w-0"><Activity entries={history} legacy={legacy} active={live} /></TabsContent>
    </Tabs>
  </>;
}
