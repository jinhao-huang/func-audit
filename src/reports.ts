import type { DatabaseSync } from "node:sqlite";
import { openDatabase as open } from "./database.ts";
import type { reviewFunction } from "./review.ts";
import type { SnapshotMetadata, SnapshotProgress } from "./snapshot.ts";
import type { Lookup } from "./source-tools.ts";
import type { CaseSearch } from "./cases.ts";

export type CaseSearchRecord = CaseSearch | { query: string; error: string };
type AuditContext = { snapshot?: SnapshotMetadata; lookups?: Lookup[]; caseSearches?: CaseSearchRecord[] };
export type Result = Awaited<ReturnType<typeof reviewFunction>>;
export type ReportStatus = "queued" | "running" | "completed" | "failed" | "canceled";
export type Summary = { id: number; runId: number; idx: number; model: string; startedAt: string; status: ReportStatus; target: number | null; prediction: number | null };
type SavedReport = Summary & { source: string; reason: string | null; error: string | null; evidence: Result["evidence"] | null };
export type AuditEvent =
  | { kind: "accepted" }
  | { kind: "prepare"; cases: boolean; snapshot: boolean }
  | SnapshotProgress
  | { kind: "review"; snapshot?: SnapshotMetadata }
  | { kind: "tool"; callId: string; name: string; args: object }
  | { kind: "lookup"; callId: string; lookup: Lookup }
  | { kind: "cases"; callId: string; search: CaseSearchRecord };
export type Entry = { seq: number; event: AuditEvent };

export function recordEvent(id: number, event: AuditEvent) {
  using db = open();
  // Replacing the download row gives it a new SSE cursor and keeps only the latest byte count.
  db.prepare(`INSERT OR REPLACE INTO report_events (reportId, event)
    SELECT id, ? FROM reports WHERE id = ? AND status = 'running'`).run(JSON.stringify(event), id);
}

export function completeReport(id: number, report: Result) {
  using db = open();
  db.prepare(`
    UPDATE reports SET status = 'completed', model = ?, prediction = ?, reason = ?, evidence = ?
    WHERE id = ? AND status = 'running'
  `).run(report.model, report.prediction, report.reason, JSON.stringify(report.evidence), id);
}

export function failReport(id: number, message: string) {
  using db = open();
  db.prepare("UPDATE reports SET status = 'failed', error = ? WHERE id = ? AND status = 'running'").run(message, id);
}

type PairRow = { number: number; firstReport: number; secondReport: number };
export type Run = { id: number; reports: Summary[]; pairs: PairRow[] };

export function getSavedRun(id: number): Run | null {
  using db = open(true);
  db.exec("BEGIN");
  const reports = db.prepare(`
    SELECT id, runId, idx, model, startedAt, status, target, prediction
    FROM reports WHERE runId = ? ORDER BY id
  `).all(id) as Summary[];
  if (!reports.length) return null;
  const pairs = db.prepare("SELECT number, firstReport, secondReport FROM run_pairs WHERE runId = ? ORDER BY number").all(id) as PairRow[];
  return { id, reports, pairs };
}

export function listRuns() {
  using db = open(true);
  return db.prepare(`
    SELECT r.runId AS id, MIN(r.id) AS firstReport, MIN(r.idx) AS idx, MIN(r.status) AS status, MIN(r.target) AS target, MIN(r.prediction) AS prediction,
      (SELECT COUNT(*) FROM run_pairs WHERE runId = r.runId) AS pairs,
      COUNT(*) AS total, SUM(status NOT IN ('queued','running')) AS finished, SUM(status = 'failed') AS failed, SUM(status = 'canceled') AS canceled
    FROM reports r GROUP BY runId ORDER BY runId DESC
  `).all() as (Pick<Summary, "id" | "idx" | "status" | "target" | "prediction"> & { firstReport: number; pairs: number; total: number; finished: number; failed: number; canceled: number })[];
}

export function pairGrade(a: Summary, b: Summary): "P-C" | "P-R" | "P-V" | "P-B" | "failed" | "canceled" | "pending" {
  if (a.status === "failed" || b.status === "failed") return "failed";
  if (a.status === "canceled" || b.status === "canceled") return "canceled";
  if (a.status !== "completed" || b.status !== "completed") return "pending";
  if ([a, b].some(r => (r.target !== 0 && r.target !== 1) || (r.prediction !== 0 && r.prediction !== 1)) || a.target === b.target) {
    throw new Error("Invalid pair labels or predictions.");
  }
  if (a.prediction === b.prediction) return a.prediction === 1 ? "P-V" : "P-B";
  return a.prediction === a.target ? "P-C" : "P-R";
}

export function score(run: Run) {
  if (!run.pairs.length) throw new Error("Course scoring requires a pair run.");
  const reports = new Map(run.reports.map(r => [r.id, r]));
  const counts = { "P-C": 0, "P-R": 0, "P-V": 0, "P-B": 0, failed: 0, canceled: 0, pending: 0 };
  const pairs = run.pairs.map(({ number, firstReport, secondReport }) => {
    const grade = pairGrade(reports.get(firstReport)!, reports.get(secondReport)!);
    counts[grade]++;
    return { number, grade };
  });
  return { scored: pairs.length - counts.pending - counts.failed - counts.canceled, total: pairs.length, counts, pairs };
}

export function predictions(run: Run) {
  if (!run.pairs.length || run.reports.some(r => r.status !== "completed")) {
    throw new Error("Export requires a course run with all reports completed.");
  }
  return run.reports.map(({ idx, prediction }) => JSON.stringify({ idx, prediction })).join("\n") + "\n";
}

function entries(db: DatabaseSync, id: number, after: number): Entry[] {
  return db.prepare("SELECT seq, event FROM report_events WHERE reportId = ? AND seq > ? ORDER BY seq").all(id, after)
    .map(row => ({ seq: Number(row.seq), event: JSON.parse(String(row.event)) }));
}

export function reportUpdates(id: number, after: number) {
  using db = open();
  db.exec("BEGIN");
  const row = db.prepare("SELECT status FROM reports WHERE id = ?").get(id);
  if (!row) return null;
  return { status: row.status as ReportStatus, entries: entries(db, id, after) };
}

export function reportDetail(id: number) {
  using db = open(true);
  db.exec("BEGIN");
  const row = db.prepare("SELECT id, runId, idx, model, startedAt, status, target, prediction, source, reason, evidence, error FROM reports WHERE id = ?").get(id);
  if (!row) return null;
  const report = { ...row, evidence: row.evidence && JSON.parse(String(row.evidence)) } as SavedReport;
  return { report, entries: entries(db, id, 0) };
}

export function readReport(id: number) {
  const detail = reportDetail(id);
  if (!detail) throw new Error(`Report ${id} was not found.`);
  const context: AuditContext = {};
  for (const { event } of detail.entries) {
    if (event.kind === "prepare" && event.cases) context.caseSearches = [];
    if (event.kind === "review" && event.snapshot) {
      context.snapshot = event.snapshot;
      context.lookups = [];
    }
    if (event.kind === "lookup") context.lookups?.push(event.lookup);
    if (event.kind === "cases") context.caseSearches?.push(event.search);
  }
  return { ...detail.report, ...(Object.keys(context).length ? { context } : {}) };
}
