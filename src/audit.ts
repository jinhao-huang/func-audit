import { existsSync } from "node:fs";
import type { CaseQuery, CaseSearch } from "./cases.ts";
import { completeReport, failReport, recordEvent } from "./reports.ts";
import { reviewFunction } from "./review.ts";
import { caseIndexPath, type Sample } from "./samples.ts";
import { prepareSnapshot } from "./snapshot.ts";

export async function runAudit(id: number, sample: Sample, lookupCases: (request: CaseQuery) => Promise<CaseSearch>, signal?: AbortSignal) {
  let snapshot: Awaited<ReturnType<typeof prepareSnapshot>> | undefined;
  try {
    // The OpenAI client merges ambient headers into explicitly configured requests.
    for (const name of Object.keys(process.env)) {
      if (name.startsWith("OPENAI_")) delete process.env[name];
    }
    const cases = existsSync(caseIndexPath);
    recordEvent(id, { kind: "prepare", snapshot: sample.commit_url !== undefined, cases });
    if (sample.commit_url !== undefined) {
      snapshot = await prepareSnapshot(sample.commit_url, sample.target!, sample.func, event => recordEvent(id, event), signal);
    }
    signal?.throwIfAborted();
    recordEvent(id, { kind: "review", snapshot: snapshot?.metadata });
    const report = await reviewFunction(sample.func, snapshot && {
      root: snapshot.root, location: snapshot.metadata,
      onLookup: (lookup, callId) => recordEvent(id, { kind: "lookup", callId, lookup }),
    }, cases ? async (request, callId) => {
      let search;
      try {
        search = await lookupCases(request);
      } catch (cause) {
        recordEvent(id, { kind: "cases", callId, search: { ...request, error: cause instanceof Error ? cause.message : String(cause) } });
        throw cause;
      }
      recordEvent(id, { kind: "cases", callId, search });
      return search;
    } : undefined, (callId, name, args) => recordEvent(id, { kind: "tool", callId, name, args }), signal);
    completeReport(id, report);
  } catch (cause) {
    if (signal?.aborted) return;
    const message = cause instanceof Error ? cause.message : String(cause);
    const diagnostic = `Report ${id} failed: ${message}`;
    try {
      failReport(id, message);
    } catch (saveError) {
      throw new Error(`${diagnostic} (could not save failure: ${String(saveError)})`, { cause });
    }
    throw new Error(diagnostic, { cause });
  } finally {
    await snapshot?.dispose();
  }
}
