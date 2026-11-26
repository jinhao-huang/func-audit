import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { reviewFunction } from "./review.ts";
import type { SnapshotMetadata } from "./snapshot.ts";
import type { Lookup } from "./source-tools.ts";

export type SourceContext = { snapshot: SnapshotMetadata; lookups: Lookup[] };

const databasePath = ".func-audit.sqlite";

export function startReport(idx: number, source: string, model: string) {
  using db = new DatabaseSync(databasePath, { timeout: 5000 });
  db.exec(`
    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY,
      idx INTEGER NOT NULL,
      source TEXT NOT NULL,
      model TEXT NOT NULL,
      startedAt TEXT NOT NULL,
      status TEXT NOT NULL,
      prediction INTEGER,
      reason TEXT,
      evidence TEXT,
      error TEXT
    );
    CREATE TABLE IF NOT EXISTS report_context (
      reportId INTEGER PRIMARY KEY REFERENCES reports(id),
      context TEXT NOT NULL
    )
  `);
  const row = db.prepare(`
    INSERT INTO reports (idx, source, model, startedAt, status)
    VALUES (?, ?, ?, ?, 'started')
  `).run(idx, source, model, new Date().toISOString());
  return Number(row.lastInsertRowid);
}

export function saveContext(id: number, context: SourceContext) {
  using db = new DatabaseSync(databasePath, { timeout: 5000 });
  db.prepare("INSERT OR REPLACE INTO report_context (reportId, context) VALUES (?, ?)").run(id, JSON.stringify(context));
}

export function completeReport(id: number, report: Awaited<ReturnType<typeof reviewFunction>>) {
  using db = new DatabaseSync(databasePath, { timeout: 5000 });
  db.prepare(`
    UPDATE reports SET status = 'completed', model = ?, prediction = ?, reason = ?, evidence = ?
    WHERE id = ?
  `).run(report.model, report.prediction, report.reason, JSON.stringify(report.evidence), id);
}

export function failReport(id: number, message: string) {
  using db = new DatabaseSync(databasePath, { timeout: 5000 });
  db.prepare("UPDATE reports SET status = 'failed', error = ? WHERE id = ?")
    .run(message, id);
}

export function readReport(id: number) {
  if (!existsSync(databasePath)) throw new Error("No audit reports have been saved yet.");
  using db = new DatabaseSync(databasePath, { readOnly: true, timeout: 5000 });
  const row = db.prepare("SELECT * FROM reports WHERE id = ?").get(id);
  if (!row) throw new Error(`Report ${id} was not found.`);
  const hasContext = db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'report_context'").get();
  const saved = hasContext && db.prepare("SELECT context FROM report_context WHERE reportId = ?").get(id);
  return { ...row, evidence: row.evidence === null ? null : JSON.parse(String(row.evidence)),
    ...(saved ? { context: JSON.parse(String(saved.context)) } : {}) };
}
