import { ArchiveIcon, BookOpenIcon, ClipboardListIcon, DownloadIcon, FileTextIcon, FolderOpenIcon, SearchIcon, ScanTextIcon } from "lucide-react";
import type { AuditEvent, Entry } from "../../src/reports.ts";
import { CodeBlock, CodeBlockContent, CodeBlockHeader, CodeBlockTitle } from "./ui/code-block";
import { Trace, TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceDescription, TraceIcon, TraceLine, TraceTitle } from "./ui/trace";
import type { SourceRange } from "../../src/evidence.ts";
import { SourceLines } from "./source-lines";

function milestone(event: Extract<AuditEvent, { kind: "accepted" | "prepare" | "review" }>) {
  if (event.kind === "accepted") return { Icon: ClipboardListIcon, title: "Audit queued" };
  if (event.kind === "prepare") return { Icon: FolderOpenIcon, title: event.snapshot ? "Preparing the source snapshot" : "Preparing the submitted function" };
  const location = event.snapshot;
  return { Icon: ScanTextIcon, title: location ? `Review started · ${location.path} · L${location.startLine}–${location.endLine}` : "Review started" };
}

export const snapshotStages = {
  download: "Downloading the source archive", extract: "Extracting the source archive", locate: "Locating the submitted function",
};

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 ** 2).toFixed(2)} MiB`;
}

type ToolEvent = Extract<AuditEvent, { callId: string }>;

type Call = { name: string; args: object; output?: string; error?: boolean; startLine?: number };

function toolDetails(event: ToolEvent): Call {
  if (event.kind === "lookup") {
    const { tool: name, args, result, error } = event.lookup;
    return { name, args, output: result, error, startLine: !error && "startLine" in args ? args.startLine : undefined };
  }
  if (event.kind === "cases") {
    const search = event.search;
    return { name: "search_cases", args: { mode: search.mode, query: search.query }, error: "error" in search,
      output: "error" in search ? search.error : JSON.stringify(search.hits, null, 2) };
  }
  return event;
}

function toolSubject(args: object) {
  if ("query" in args) return String(args.query);
  if ("pattern" in args) return "path" in args ? `${args.pattern} · ${args.path}` : String(args.pattern);
  if ("path" in args && "startLine" in args && "endLine" in args) return `${args.path} · L${args.startLine}–${args.endLine}`;
  return JSON.stringify(args);
}

export function Activity({ entries, active, expanded, setOpen, citation }: {
  entries: Entry[]; active: boolean; expanded: ReadonlySet<string>; setOpen: (id: string, open: boolean) => void;
  citation?: SourceRange & { callId?: string };
}) {
  // Replacing a call with its result keeps it at the position where it started.
  const rows = new Map<string | number, AuditEvent>();
  for (const { seq, event } of entries) rows.set("callId" in event ? event.callId : event.kind === "download" ? -1 : seq, event);
  const latestKind = entries.at(-1)?.event.kind;
  return <Trace aria-label="Audit activity" role="list" className="border-s ps-3">
    {Array.from(rows, ([key, event]) => {
      if (event.kind === "download") {
        const inProgress = active && latestKind === "download";
        return <div role="listitem" key={key} className="flex-col items-start gap-1">
          <TraceLine><TraceIcon><DownloadIcon /></TraceIcon><TraceTitle>Source download</TraceTitle>
            <TraceDescription>{formatBytes(event.bytes)}{event.total && ` / ${formatBytes(event.total)}`}</TraceDescription>
          </TraceLine>
          {inProgress && event.total !== undefined && <progress className="ms-6 w-36" aria-label="Source archive download"
            max={event.total} value={event.bytes} />}
        </div>;
      }
      if (event.kind === "extract" || event.kind === "locate") {
        const Icon = event.kind === "extract" ? ArchiveIcon : SearchIcon;
        return <div role="listitem" key={key}><TraceLine><TraceIcon><Icon /></TraceIcon>
          <TraceTitle>{snapshotStages[event.kind]}</TraceTitle></TraceLine></div>;
      }
      if (!("callId" in event)) {
        const { Icon, title } = milestone(event);
        return <div role="listitem" key={key}><TraceLine><TraceIcon><Icon /></TraceIcon><TraceTitle>{title}</TraceTitle></TraceLine></div>;
      }
      const { callId } = event;
      const call = toolDetails(event);
      const Icon = call.name === "search_cases" ? BookOpenIcon : call.name === "grep" ? SearchIcon : FileTextIcon;
      const waiting = event.kind === "tool";
      const error = call.error;
      const state = waiting ? (active ? "Running" : "Interrupted") : error ? "Failed" : "Returned";
      return <TraceCollapsible key={`tool-${callId}`} role="listitem" open={expanded.has(callId)} onOpenChange={open => setOpen(callId, open)}>
        <TraceCollapsibleTrigger className="w-full justify-between">
          <TraceLine status={waiting && active ? "running" : error || waiting ? "error" : undefined} className="flex-1">
            <TraceIcon><Icon /></TraceIcon><TraceTitle><strong>{call.name}</strong> {toolSubject(call.args)}</TraceTitle>
            <TraceDescription>{state}</TraceDescription>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent className="flex flex-col gap-2">
          <CodeBlock size="sm"><CodeBlockHeader><CodeBlockTitle>Arguments</CodeBlockTitle></CodeBlockHeader>
            <CodeBlockContent className="max-h-64">{JSON.stringify(call.args, null, 2)}</CodeBlockContent>
          </CodeBlock>
          <CodeBlock size="sm" variant={error || (waiting && !active) ? "destructive" : "default"}>
            <CodeBlockHeader><CodeBlockTitle>{error ? "Error" : "Output"}</CodeBlockTitle></CodeBlockHeader>
            {call.startLine !== undefined && call.output !== undefined ? <SourceLines startLine={call.startLine} text={call.output}
              citation={citation?.callId === callId ? citation : undefined} />
              : <CodeBlockContent className="max-h-80">{call.output ?? (active ? "Waiting for a result…" : "No result recorded.")}</CodeBlockContent>}
          </CodeBlock>
        </TraceCollapsibleContent>
      </TraceCollapsible>;
    })}
  </Trace>;
}
