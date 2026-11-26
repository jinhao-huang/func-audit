import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Sample } from "./samples.ts";
import type { reviewFunction } from "./review.ts";
import type { SnapshotMetadata } from "./snapshot.ts";
import type { Lookup } from "./source-tools.ts";
import type { CaseSearch } from "./cases.ts";

export type CaseSearchRecord = CaseSearch | { query: string; error: string };
type AuditContext = { snapshot?: SnapshotMetadata; lookups?: Lookup[]; caseSearches?: CaseSearchRecord[] };
export type Result = Awaited<ReturnType<typeof reviewFunction>>;
export type ReportStatus = "started" | "completed" | "failed";
export type Summary = { id: number; runId: number; idx: number; model: string; startedAt: string; status: ReportStatus; target: number | null; prediction: number | null };
type SavedReport = Summary & { source: string; reason: string | null; error: string | null; evidence: Result["evidence"] | null };
export type AuditEvent =
  | { kind: "accepted"; ownerPid: number }
  | { kind: "prepare"; cases: boolean; snapshot: boolean }
  | { kind: "review"; snapshot?: SnapshotMetadata }
  | { kind: "tool"; callId: string; name: string; args: object }
  | { kind: "lookup"; callId: string; lookup: Lookup }
  | { kind: "cases"; callId: string; search: CaseSearchRecord };
export type Entry = { seq: number; event: AuditEvent };

const databasePath = "data/results/runs.sqlite";

function open(readOnly = false) {
  return new DatabaseSync(databasePath, { readOnly, timeout: 5000 });
}

export function initializeReports() {
  mkdirSync(dirname(databasePath), { recursive: true });
  using db = open();
  db.exec(`
    PRAGMA journal_mode=WAL;
    BEGIN IMMEDIATE;
    CREATE TABLE IF NOT EXISTS runs (id INTEGER PRIMARY KEY, pair INTEGER);
    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY, runId INTEGER NOT NULL REFERENCES runs(id), idx INTEGER NOT NULL, source TEXT NOT NULL, model TEXT NOT NULL,
      startedAt TEXT NOT NULL, status TEXT NOT NULL, target INTEGER, prediction INTEGER, reason TEXT, evidence TEXT, error TEXT
    );
    CREATE TABLE IF NOT EXISTS report_events (
      seq INTEGER PRIMARY KEY, reportId INTEGER NOT NULL REFERENCES reports(id), event TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS reports_by_run ON reports(runId);
    CREATE INDEX IF NOT EXISTS report_events_by_report ON report_events(reportId, seq)
  `);
  db.exec("COMMIT");
}

export function startRun(pair: number | null, samples: Sample[], model: string) {
  initializeReports();
  using db = open();
  db.exec("BEGIN IMMEDIATE");
  const id = Number(db.prepare("INSERT INTO runs (pair) VALUES (?)").run(pair).lastInsertRowid);
  const insert = db.prepare(`
    INSERT INTO reports (runId, idx, source, model, startedAt, target, status) VALUES (?, ?, ?, ?, ?, ?, 'started')
  `);
  const startedAt = new Date().toISOString();
  const jobs = samples.map(sample => {
    const row = insert.run(id, sample.idx, sample.func, model, startedAt, sample.target ?? null);
    const reportId = Number(row.lastInsertRowid);
    insertEvent(db, reportId, { kind: "accepted", ownerPid: process.pid });
    return { id: reportId, sample };
  });
  db.exec("COMMIT");
  return { id, jobs };
}

function insertEvent(db: DatabaseSync, id: number, event: AuditEvent) {
  db.prepare("INSERT INTO report_events (reportId, event) VALUES (?, ?)").run(id, JSON.stringify(event));
}

export function recordEvent(id: number, event: AuditEvent) {
  using db = open();
  insertEvent(db, id, event);
}

export function completeReport(id: number, report: Result) {
  using db = open();
  db.prepare(`
    UPDATE reports SET status = 'completed', model = ?, prediction = ?, reason = ?, evidence = ?
    WHERE id = ? AND status = 'started'
  `).run(report.model, report.prediction, report.reason, JSON.stringify(report.evidence), id);
}

export function failReport(id: number, message: string) {
  using db = open();
  db.prepare("UPDATE reports SET status = 'failed', error = ? WHERE id = ? AND status = 'started'").run(message, id);
}

export function recoverWorkers(reportId?: number) {
  using db = open();
  const owners = db.prepare(`
    SELECT r.id, json_extract(e.event, '$.ownerPid') AS pid FROM reports r
    JOIN report_events e ON e.seq = (SELECT MIN(seq) FROM report_events WHERE reportId = r.id)
    WHERE r.status = 'started' ${reportId === undefined ? "" : "AND r.id = ?"}
  `).all(...(reportId === undefined ? [] : [reportId]));
  for (const { id, pid } of owners) {
    if (pid === null || pid === process.pid) continue;
    try {
      process.kill(Number(pid), 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      failReport(Number(id), "The audit process stopped before saving a result.");
    }
  }
}

export type Run = { id: number; pair: number | null; reports: Summary[] };

export function listRuns(id?: number): Run[] {
  if (!existsSync(databasePath)) return [];
  using db = open(true);
  const rows = db.prepare(`
    SELECT r.id, r.runId, r.idx, r.model, r.startedAt, r.status, r.target, r.prediction, runs.pair
    FROM reports r JOIN runs ON runs.id = r.runId
    ${id === undefined ? "" : "WHERE runs.id = ?"} ORDER BY runs.id DESC, r.id
  `).all(...(id === undefined ? [] : [id])) as (Summary & { pair: number | null })[];
  const runs = new Map<number, Run>();
  for (const { pair, ...report } of rows) {
    let run = runs.get(report.runId);
    if (!run) {
      run = { id: report.runId, pair, reports: [] };
      runs.set(run.id, run);
    }
    run.reports.push(report);
  }
  return Array.from(runs.values());
}

function completedPair(run: Run) {
  if (run.pair === null) throw new Error("Course scoring requires a pair run.");
  if (run.reports.length !== 2 || run.reports.some(report => report.status !== "completed")) {
    throw new Error(`Run ${run.id} needs two completed reports.`);
  }
  return run.reports;
}

export function score(run: Run) {
  const [a, b] = completedPair(run);
  if ([a, b].some(r => (r.target !== 0 && r.target !== 1) || (r.prediction !== 0 && r.prediction !== 1))
      || a.target === b.target) {
    throw new Error(`Run ${run.id} has invalid pair labels or predictions.`);
  }
  if (a.prediction === b.prediction) return a.prediction === 1 ? "P-V" : "P-B";
  return a.prediction === a.target ? "P-C" : "P-R";
}

export function predictions(run: Run) {
  return completedPair(run).map(({ idx, prediction }) => JSON.stringify({ idx, prediction })).join("\n") + "\n";
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
  if (!existsSync(databasePath)) return null;
  using db = open(true);
  db.exec("BEGIN");
  const row = db.prepare("SELECT * FROM reports WHERE id = ?").get(id);
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
