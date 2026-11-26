import { existsSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { reviewFunction } from "./review.ts";
import type { SnapshotMetadata } from "./snapshot.ts";
import type { Lookup } from "./source-tools.ts";
import type { CaseSearch } from "./cases.ts";

export type CaseSearchRecord = CaseSearch | { query: string; error: string };
export type AuditContext = { snapshot?: SnapshotMetadata; lookups?: Lookup[]; caseSearches?: CaseSearchRecord[] };
export type Result = Awaited<ReturnType<typeof reviewFunction>>;
export type ReportStatus = "started" | "completed" | "failed";
export type Summary = { id: number; idx: number; model: string; startedAt: string; status: ReportStatus; target: number | null; prediction: number | null };
type SavedReport = Summary & { source: string; reason: string | null; error: string | null; evidence: Result["evidence"] | null };
export type AuditEvent =
  | { kind: "accepted"; ownerPid: number }
  | { kind: "prepare"; cases: boolean; snapshot: boolean }
  | { kind: "review"; snapshot?: SnapshotMetadata }
  | { kind: "tool"; callId: string; name: string; args: object }
  | { kind: "lookup"; callId: string; lookup: Lookup }
  | { kind: "cases"; callId: string; search: CaseSearchRecord };
export type Entry = { seq: number; event: AuditEvent };

const databasePath = ".func-audit.sqlite";

function open(readOnly = false) {
  return new DatabaseSync(databasePath, { readOnly, timeout: 5000 });
}

export function initializeReports() {
  using db = open();
  db.exec(`
    PRAGMA journal_mode=WAL;
    BEGIN IMMEDIATE;
    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY, idx INTEGER NOT NULL, source TEXT NOT NULL, model TEXT NOT NULL,
      startedAt TEXT NOT NULL, status TEXT NOT NULL, target INTEGER, prediction INTEGER, reason TEXT, evidence TEXT, error TEXT
    );
    CREATE TABLE IF NOT EXISTS report_events (
      seq INTEGER PRIMARY KEY, reportId INTEGER NOT NULL REFERENCES reports(id), event TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS report_events_by_report ON report_events(reportId, seq)
  `);
  if (!db.prepare("SELECT 1 FROM pragma_table_info('reports') WHERE name = 'target'").get()) {
    db.exec("ALTER TABLE reports ADD COLUMN target INTEGER");
    const dataset = "data/test.jsonl";
    if (existsSync(dataset)) {
      const match = db.prepare("UPDATE reports SET target = ? WHERE idx = ? AND source = ?");
      for (const line of readFileSync(dataset, "utf8").split(/\r?\n/)) {
        if (!line.trim()) continue;
        let sample;
        try {
          sample = JSON.parse(line);
        } catch {
          continue;
        }
        if ((sample?.target === 0 || sample?.target === 1) && Number.isSafeInteger(sample.idx) && typeof sample.func === "string") {
          match.run(sample.target, sample.idx, sample.func);
        }
      }
    }
  }
  db.exec("COMMIT");
}

export function startReport(idx: number, source: string, model: string, target: number | null = null) {
  initializeReports();
  using db = open();
  db.exec("BEGIN IMMEDIATE");
  const row = db.prepare(`
    INSERT INTO reports (idx, source, model, startedAt, target, status) VALUES (?, ?, ?, ?, ?, 'started')
  `).run(idx, source, model, new Date().toISOString(), target);
  const id = Number(row.lastInsertRowid);
  insertEvent(db, id, { kind: "accepted", ownerPid: process.pid });
  db.exec("COMMIT");
  return id;
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

export function listReports() {
  using db = open();
  return db.prepare(`
    SELECT id, idx, model, startedAt, status, target, prediction,
      status = 'started' AND EXISTS (SELECT 1 FROM report_events WHERE reportId = reports.id) AS live
    FROM reports ORDER BY id DESC
  `).all() as (Summary & { live: number })[];
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
  const hasEvents = db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'report_events'").get();
  const history = hasEvents ? entries(db, id, 0) : [];
  let legacy: AuditContext | undefined;
  if (!history.length && db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'report_context'").get()) {
    const saved = db.prepare("SELECT context FROM report_context WHERE reportId = ?").get(id);
    if (saved) legacy = JSON.parse(String(saved.context));
  }
  return { report, entries: history, legacy };
}

export function readReport(id: number) {
  const detail = reportDetail(id);
  if (!detail) throw new Error(`Report ${id} was not found.`);
  const context: AuditContext = detail.legacy ?? {};
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
