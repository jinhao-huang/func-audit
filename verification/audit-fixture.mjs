import { searchCases } from "../src/cases.ts";
import { caseIndexPath } from "../src/samples.ts";
import { runAudit } from "../src/audit.ts";
import { configuredModelId } from "../src/project-api.ts";
import { readReport } from "../src/reports.ts";

import { initializeReports, openDatabase } from "../src/database.ts";

export async function reviewSample(sample) {
  initializeReports();
  using db = openDatabase();
  const run = db.prepare("INSERT INTO runs DEFAULT VALUES").run().lastInsertRowid;
  const id = Number(db.prepare(`INSERT INTO reports(runId, idx, source, model, startedAt, status)
    VALUES (?, ?, ?, ?, ?, 'running')`).run(run, sample.idx, sample.func, configuredModelId(), new Date().toISOString()).lastInsertRowid);
  await runAudit(id, sample, query => searchCases(caseIndexPath, query));
  return readReport(id);
}
