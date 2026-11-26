import { useEffect, useState } from "react";
import { Link, useRevalidator } from "react-router";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Activity, snapshotStages } from "@/components/activity";
import { startedAt, Status } from "@/components/status";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Button, buttonVariants } from "@/components/ui/button";
import { CodeBlock, CodeBlockHeader, CodeBlockTitle } from "@/components/ui/code-block";
import { SourceLines } from "@/components/source-lines";
import type { Entry } from "../../src/reports.ts";
import { getReport } from "../workspace.server";
import type { Route } from "./+types/report";

export const meta = ({ params }: Route.MetaArgs) => [{ title: `Report #${params.id} · Function Audit` }];
export function loader({ params }: Route.LoaderArgs) { return getReport(params.id); }

export default function ReportRoute({ loaderData: { report, entries } }: Route.ComponentProps) {
  const { revalidate } = useRevalidator();
  const [updates, setUpdates] = useState<Entry[]>([]);
  const [reconnecting, setReconnecting] = useState(false);
  const cursor = entries.at(-1)?.seq ?? 0;
  const live = report.status === "running" || report.status === "queued";
  type Citation = NonNullable<typeof report.evidence>[number];
  const [section, setSection] = useState(live ? "timeline" : "verdict");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [submittedOpen, setSubmittedOpen] = useState(false);
  const [citation, setCitation] = useState<Citation>();
  function setCallOpen(id: string, open: boolean) {
    setExpanded(previous => {
      const next = new Set(previous);
      if (open) next.add(id);
      else next.delete(id);
      return next;
    });
    if (!open && citation?.callId === id) setCitation(undefined);
  }
  function showSource(item: Citation) {
    setCitation({ ...item });
    if (item.callId !== undefined) {
      setCallOpen(item.callId, true);
      setSection("timeline");
    } else {
      setSubmittedOpen(true);
      setSection("evidence");
    }
  }
  useEffect(() => {
    if (!live) return;
    const source = new EventSource(`/reports/${report.id}/events?after=${cursor}`);
    source.onopen = () => setReconnecting(false);
    source.onerror = () => setReconnecting(true);
    source.onmessage = message => {
      const entry: Entry = JSON.parse(message.data);
      setUpdates(previous => {
        if ((previous.at(-1)?.seq ?? cursor) >= entry.seq) return previous;
        return [...previous.filter(item => item.seq > cursor && !(entry.event.kind === "download" && item.event.kind === "download")), entry];
      });
      if (entry.event.kind === "prepare" && report.status === "queued") void revalidate();
    };
    source.addEventListener("finished", () => { source.close(); void revalidate(); });
    return () => source.close();
  }, [report.id, report.status, cursor, live, revalidate]);
  const history = live ? entries.concat(updates.filter(entry => entry.seq > cursor)) : entries;
  const review = history.findLast(({ event }) => event.kind === "review")?.event;
  const prepare = history.findLast(({ event }) => event.kind === "prepare")?.event;
  const status = report.status === "queued" && prepare ? "running" : report.status;
  const badge = <Status report={{ ...report, status }} />;
  const snapshot = review?.kind === "review" ? review.snapshot : undefined;
  const latest = history.at(-1)?.event.kind;
  const stage = latest === "download" || latest === "extract" || latest === "locate" ? snapshotStages[latest]
    : review ? "Reviewing the function" : prepare?.kind === "prepare"
    ? (prepare.snapshot ? "Preparing the source snapshot" : "Preparing the submitted function")
    : report.status === "queued" ? "Waiting for an audit slot" : "Starting the audit";
  const prediction = report.prediction == null ? "No prediction" : report.prediction === 1 ? "Potential vulnerability" : "No finding";
  const explanation = report.reason && <p className="max-w-[80ch] whitespace-pre-line leading-relaxed wrap-anywhere">{report.reason}</p>;
  function sourceLink(item: Citation) {
    const label = `${item.path ?? "Submitted function"} · L${item.startLine}–${item.endLine}`;
    if (item.path !== undefined && item.callId === undefined) return label;
    return <Button variant="link" size="sm" className="h-auto max-w-full justify-start p-0 text-left whitespace-normal wrap-anywhere"
      onClick={() => showSource(item)} aria-label={`View source: ${label}`}>{label}</Button>;
  }
  const references = report.evidence?.length ? <ul aria-label="Cited source lines" className="flex flex-col items-start gap-1">
    {report.evidence.map((item, i) => <li className="max-w-full" key={i}>{sourceLink(item)}</li>)}
  </ul> : null;
  return <>
    <header className="mb-5 flex flex-wrap items-center justify-between gap-3">
      <div>
        <p className="hint mb-1">Sample {report.idx} · {startedAt(report.startedAt)}</p>
        <h1 className="text-2xl">Report #{report.id}</h1>
      </div>
      <Link to={`/runs/${report.runId}`} className={buttonVariants({ variant: "outline", size: "sm" })}>Run #{report.runId}</Link>
    </header>
    <Tabs value={section} onValueChange={value => { setSection(value); setCitation(undefined); }} className="report-tabs min-w-0 gap-5">
      <div className="shrink-0 overflow-x-auto border-b pb-1">
        <TabsList variant="line" aria-label="Report sections">
          <TabsTrigger value="timeline">Timeline</TabsTrigger>
          <TabsTrigger value="verdict">Verdict</TabsTrigger>
          <TabsTrigger value="evidence">Evidence</TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="timeline" className="min-w-0">
        <section className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-3"><h2>Audit timeline</h2>{badge}</div>
          {live && <p role="status" className="hint">{reconnecting ? "Reconnecting to the audit…" : stage}</p>}
          <Activity entries={history} active={live} expanded={expanded} setOpen={setCallOpen} citation={citation} />
          {!live && <section className="flex flex-col gap-2 border-t pt-3">
            {!history.some(({ event }) => "callId" in event) && <p className="hint">No tool calls recorded.</p>}
            <h3 className="font-semibold">{report.status === "failed" ? "Audit failed" : `Audit completed · ${prediction}`}</h3>
            {report.error && <p className="wrap-anywhere text-destructive">{report.error}</p>}
            {explanation}{references}
          </section>}
        </section>
      </TabsContent>
      <TabsContent value="verdict" className="min-w-0 space-y-5">
        <div className="flex items-center gap-3"><h2>Audit result</h2>{badge}</div>
        {live && <p role="status" className="flex items-center gap-3"><progress className="w-16" aria-label="Audit in progress" />
          {reconnecting ? "Reconnecting to the audit…" : stage}</p>}
        <dl className="grid gap-x-8 gap-y-3 rounded-md border bg-muted/30 p-4 sm:grid-cols-3">
          <div><dt className="hint">Execution</dt><dd className="capitalize">{status}</dd></div>
          <div><dt className="hint">Model prediction</dt><dd>{prediction}</dd></div>
          <div><dt className="hint">Reference label</dt><dd>{report.target == null ? "Unlabeled" : report.target === 1 ? "Vulnerable" : "Benign"}</dd></div>
        </dl>
        {explanation && <section className="flex flex-col gap-2"><h3 className="font-semibold">Decision rationale</h3>{explanation}{references}</section>}
        {report.error && <p className="wrap-anywhere text-destructive">{report.error}</p>}
        <p className="hint break-all">Model · {report.model}</p>
      </TabsContent>
      <TabsContent value="evidence" className="min-w-0 space-y-6">
        <section><h2>Cited evidence <span className="count">{report.evidence?.length ?? 0}</span></h2>
          {report.evidence?.length ? <div className="mt-4 space-y-3">{report.evidence.map((item, i) =>
            <CodeBlock key={i}><CodeBlockHeader><CodeBlockTitle className="whitespace-normal wrap-anywhere">
              {sourceLink(item)}</CodeBlockTitle></CodeBlockHeader>
              <SourceLines startLine={item.startLine} text={item.source} /></CodeBlock>)}</div>
            : <p className="hint mt-2">No citations recorded.</p>}
        </section>
        {snapshot && <section><h2>Source snapshot</h2><p className="mt-2 break-all">{snapshot.repository} · {snapshot.revision.slice(0, 10)}</p>
          <p className="hint break-all">{snapshot.path} · L{snapshot.startLine}–{snapshot.endLine}</p></section>}
        <Collapsible open={submittedOpen} onOpenChange={open => { setSubmittedOpen(open); if (!open) setCitation(undefined); }}><CollapsibleTrigger className={buttonVariants({ variant: "outline" })}>Submitted function</CollapsibleTrigger>
          <CollapsibleContent><CodeBlock className="mt-3"><SourceLines text={report.source} citation={citation?.path === undefined ? citation : undefined} /></CodeBlock></CollapsibleContent>
        </Collapsible>
      </TabsContent>
    </Tabs>
  </>;
}
