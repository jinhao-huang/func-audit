import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { initializeReports, isProcessAlive, openDatabase } from "./database.ts";
import { configuredEndpoint, configuredModelId } from "./project-api.ts";
import type { CoursePair, Sample } from "./samples.ts";

function configuredCapacity() {
  const value = process.env.FUNC_AUDIT_CONCURRENCY ?? "2";
  const capacity = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(capacity) || capacity < 1) {
    throw new Error("FUNC_AUDIT_CONCURRENCY must be a positive integer.");
  }
  return capacity;
}

// The caller holds BEGIN IMMEDIATE until the owner PID and queued reports are committed together.
function ensureExecutor(db: DatabaseSync, submitting: boolean) {
  const owner = db.prepare("SELECT pid, capacity, endpoint FROM executor").get();
  if (owner) {
    if (isProcessAlive(Number(owner.pid))) {
      if (submitting && configuredEndpoint() !== owner.endpoint) {
        throw new Error("Wait for the current queue to finish before changing the API endpoint.");
      }
      return Number(owner.capacity);
    }
    db.exec(`
      DELETE FROM executor;
      UPDATE reports SET status = 'failed', error = 'The audit process stopped before saving a result.' WHERE status = 'running';
    `);
  }
  const capacity = configuredCapacity();
  const next = db.prepare(`
    SELECT runs.endpoint FROM reports JOIN runs ON reports.runId = runs.id WHERE status = 'queued' ORDER BY reports.id LIMIT 1
  `).get();
  if (next) {
    if (next.endpoint !== configuredEndpoint() || !process.env.FUNC_AUDIT_API_KEY?.trim()) {
      if (submitting) throw new Error("Restore the queued run's API endpoint and project key to resume evaluation.");
      return capacity;
    }
    const log = openSync("data/results/executor.log", "a");
    try {
      const child = spawn(process.execPath, [resolve("src/executor.ts")], {
        detached: true, stdio: ["ignore", log, log],
      });
      child.unref();
      if (!child.pid) throw new Error("Could not start the audit executor.");
      db.prepare("INSERT INTO executor VALUES (1, ?, ?, ?)").run(child.pid, capacity, configuredEndpoint());
    } finally {
      closeSync(log);
    }
  }
  return capacity;
}

export function refreshQueue() {
  using db = openDatabase();
  db.exec("BEGIN IMMEDIATE");
  const capacity = ensureExecutor(db, false);
  db.exec("COMMIT");
  return capacity;
}

export function submitRun(input: CoursePair[] | Sample) {
  if (!process.env.FUNC_AUDIT_API_KEY?.trim()) throw new Error("Set FUNC_AUDIT_API_KEY to the project API key.");
  initializeReports();
  using db = openDatabase();
  db.exec("BEGIN IMMEDIATE");
  const id = Number(db.prepare("INSERT INTO runs(endpoint) VALUES (?)").run(configuredEndpoint()).lastInsertRowid);
  const insert = db.prepare(`
    INSERT INTO reports (runId, idx, source, model, startedAt, target, commitUrl, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'queued')
  `);
  const accepted = db.prepare(`INSERT INTO report_events(reportId, event) VALUES (?, '{"kind":"accepted"}')`);
  const ids = new Map<number, number>();
  const now = new Date().toISOString();
  function enqueue(sample: Sample) {
    const existing = ids.get(sample.idx);
    if (existing !== undefined) return existing;
    const reportId = Number(insert.run(id, sample.idx, sample.func, configuredModelId(), now, sample.target ?? null, sample.commit_url ?? null).lastInsertRowid);
    ids.set(sample.idx, reportId);
    accepted.run(reportId);
    return reportId;
  }
  if (Array.isArray(input)) {
    const pair = db.prepare("INSERT INTO run_pairs VALUES (?, ?, ?, ?)");
    for (const { number, samples: [a, b] } of input) pair.run(id, number, enqueue(a), enqueue(b));
  } else {
    enqueue(input);
  }
  ensureExecutor(db, true);
  db.exec("COMMIT");
  return { id, firstReport: ids.values().next().value!, reports: ids.size, pairs: Array.isArray(input) ? input.length : 0 };
}
