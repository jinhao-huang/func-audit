import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export function openDatabase(readOnly = false) {
  return new DatabaseSync("data/results/runs.sqlite", { readOnly, timeout: 5000 });
}

export function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

export function initializeReports() {
  mkdirSync("data/results", { recursive: true });
  using db = openDatabase();
  db.exec(`
    BEGIN IMMEDIATE;
    CREATE TABLE IF NOT EXISTS runs (id INTEGER PRIMARY KEY, endpoint TEXT);
    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY, runId INTEGER NOT NULL REFERENCES runs(id), idx INTEGER NOT NULL, source TEXT NOT NULL, model TEXT NOT NULL,
      startedAt TEXT NOT NULL, status TEXT NOT NULL, target INTEGER, prediction INTEGER, reason TEXT, evidence TEXT, error TEXT, commitUrl TEXT
    );
    CREATE TABLE IF NOT EXISTS run_pairs (
      runId INTEGER NOT NULL REFERENCES runs(id), number INTEGER NOT NULL,
      firstReport INTEGER NOT NULL REFERENCES reports(id), secondReport INTEGER NOT NULL REFERENCES reports(id),
      PRIMARY KEY (runId, number)
    );
    CREATE TABLE IF NOT EXISTS report_events (
      seq INTEGER PRIMARY KEY, reportId INTEGER NOT NULL REFERENCES reports(id), event TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS executor (id INTEGER PRIMARY KEY CHECK(id = 1), pid INTEGER NOT NULL, capacity INTEGER NOT NULL, endpoint TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS reports_by_run ON reports(runId);
    CREATE INDEX IF NOT EXISTS report_events_by_report ON report_events(reportId, seq);
    CREATE UNIQUE INDEX IF NOT EXISTS latest_download ON report_events(reportId) WHERE json_extract(event, '$.kind') = 'download';
    CREATE INDEX IF NOT EXISTS queued_reports ON reports(id) WHERE status = 'queued';
  `);
  if (db.prepare("SELECT 1 FROM pragma_table_info('runs') WHERE name = 'pair'").get()) {
    const owners = db.prepare(`
      SELECT DISTINCT json_extract(e.event, '$.ownerPid') AS pid FROM report_events e
      JOIN reports r ON r.id = e.reportId
      WHERE r.status = 'started' AND json_extract(e.event, '$.kind') = 'accepted'
    `).all();
    if (owners.some(({ pid }) => typeof pid === "number" && isProcessAlive(pid))) {
      throw new Error("An audit from the previous version is still running. Wait for it to finish before upgrading.");
    }
    db.exec(`
      INSERT INTO run_pairs SELECT runs.id, runs.pair, MIN(r.id), MAX(r.id)
      FROM runs JOIN reports r ON r.runId = runs.id WHERE runs.pair IS NOT NULL GROUP BY runs.id;
      ALTER TABLE runs DROP COLUMN pair;
      ALTER TABLE runs ADD COLUMN endpoint TEXT;
      ALTER TABLE reports ADD COLUMN commitUrl TEXT;
      UPDATE reports SET status = 'failed', error = 'Audit interrupted by the queue upgrade.' WHERE status = 'started';
    `);
  }
  db.exec("COMMIT");
}
