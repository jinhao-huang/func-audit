import { BookOpenIcon, FileTextIcon, SearchIcon } from "lucide-react";
import { CodeBlock, CodeBlockContent, CodeBlockHeader, CodeBlockTitle } from "./ui/code-block";
import { Trace, TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceIcon, TraceLine, TraceTitle } from "./ui/trace";
import type { AuditContext, CaseSearchRecord, Entry } from "../../src/reports.ts";
import type { Lookup } from "../../src/source-tools.ts";

type Call = { name: string; args: object; output?: string; error?: boolean };

function lookupResult(lookup: Lookup): Call {
  return { name: lookup.tool, args: lookup.args, output: lookup.result, error: lookup.error };
}

function caseResult(search: CaseSearchRecord): Call {
  return { name: "search_cases", args: { query: search.query },
    output: "error" in search ? search.error : JSON.stringify(search.hits, null, 2), error: "error" in search };
}

function toolCalls(entries: Entry[], legacy?: AuditContext) {
  if (legacy) return [...(legacy.lookups ?? []).map(lookupResult), ...(legacy.caseSearches ?? []).map(caseResult)];
  const calls = new Map<string, Call>();
  for (const { event } of entries) {
    if (event.kind === "tool") calls.set(event.callId, { name: event.name, args: event.args });
    if (event.kind === "lookup") calls.set(event.callId, lookupResult(event.lookup));
    if (event.kind === "cases") calls.set(event.callId, caseResult(event.search));
  }
  return Array.from(calls.values());
}

export function Activity({ entries, legacy, active }: { entries: Entry[]; legacy?: AuditContext; active: boolean }) {
  const calls = toolCalls(entries, legacy);
  return <section><h2>Tool activity <span className="count">{calls.length}</span></h2>
    {legacy && calls.length > 0 && <p className="hint mt-2">This earlier report groups source lookups and case searches separately.</p>}
    {!calls.length && <p className="hint mt-3">No tool calls recorded.</p>}
    <Trace className="mt-4">{calls.map((call, i) => {
      const Icon = call.name === "search_cases" ? BookOpenIcon : call.name === "grep" ? SearchIcon : FileTextIcon;
      const waiting = call.output === undefined;
      const status = waiting && active ? "running" : call.error || waiting ? "error" : undefined;
      const args = JSON.stringify(call.args);
      return <TraceCollapsible key={i} className="rounded-md border"><TraceCollapsibleTrigger className="w-full justify-between px-3 py-2.5 hover:bg-muted">
        <TraceLine status={status} className="flex-1"><TraceIcon><Icon /></TraceIcon><TraceTitle>
          <strong>{call.name}</strong> {call.error ? "failed · " : waiting ? (active ? "running · " : "interrupted · ") : ""}{args}
        </TraceTitle></TraceLine>
      </TraceCollapsibleTrigger><TraceCollapsibleContent>
        <CodeBlock size="sm" className="mb-2"><CodeBlockHeader><CodeBlockTitle>Arguments</CodeBlockTitle></CodeBlockHeader>
          <CodeBlockContent className="max-h-64">{JSON.stringify(call.args, null, 2)}</CodeBlockContent>
        </CodeBlock>
        <CodeBlock size="sm" variant={status === "error" ? "destructive" : "default"}>
          <CodeBlockHeader><CodeBlockTitle>{call.error ? "Error" : "Output"}</CodeBlockTitle></CodeBlockHeader>
          <CodeBlockContent className="max-h-80">{call.output ?? (active ? "Running…" : "No result recorded.")}</CodeBlockContent>
        </CodeBlock>
      </TraceCollapsibleContent></TraceCollapsible>;
    })}</Trace>
  </section>;
}
